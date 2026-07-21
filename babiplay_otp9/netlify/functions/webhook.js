const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode interdite' }) };
  }

  try {
    // La documentation PayDunya indique que leur notification de paiement (callback IPN) arrive
    // en application/x-www-form-urlencoded, mais certains comptes/versions renvoient du JSON —
    // on gère les deux pour ne jamais planter silencieusement sur un vrai paiement reçu.
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    console.log('📥 Webhook PayDunya reçu — content-type:', contentType);
    console.log('📥 Corps brut reçu:', event.body);

    let body;
    if (contentType.includes('application/json')) {
      body = JSON.parse(event.body);
    } else {
      // Parse le format x-www-form-urlencoded, avec des clés imbriquées à profondeur libre
      // (ex: "data[invoice][token]=xxx" doit devenir body.data.invoice.token = "xxx").
      const params = new URLSearchParams(event.body);
      body = {};
      for (const [key, value] of params.entries()) {
        const parts = key.match(/[^\[\]]+/g); // ex: "data[invoice][token]" -> ["data","invoice","token"]
        if (!parts) continue;
        let cursor = body;
        for (let i = 0; i < parts.length - 1; i++) {
          cursor[parts[i]] = cursor[parts[i]] || {};
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = value;
      }
      // Si tout le corps était en fait un unique bloc JSON envoyé avec ce content-type, on retente en JSON
      if (Object.keys(body).length === 0 && event.body) {
        try { body = JSON.parse(event.body); } catch (e) { /* on garde body tel quel */ }
      }
    }
    console.log('📥 Corps interprété:', JSON.stringify(body));

    const statut = body.status || body.data?.status;
    if (statut !== 'completed') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Statut ignoré' }) };
    }

    // Le jeton de transaction est niché sous data.invoice.token dans la vraie réponse PayDunya
    // (leur documentation officielle le confirme) — on garde aussi les anciens emplacements en
    // secours, au cas où le format évoluerait encore.
    const token = body.token || body.data?.token || body.data?.invoice?.token || body.invoice?.token || null;

    // Sans cette étape, n'importe qui connaissant l'adresse de ce webhook pourrait envoyer une
    // fausse notification "paiement réussi" et recevoir un vrai code gratuitement. On ne fait
    // jamais confiance au contenu reçu tel quel : on redemande directement à PayDunya, avec nos
    // propres clés secrètes, si CE jeton précis correspond réellement à un paiement confirmé.
    if (!token) {
      console.error('⚠️ Webhook reçu sans jeton de transaction — ignoré par sécurité');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Jeton manquant, ignoré' }) };
    }
    const confirmRes = await fetch(`https://app.paydunya.com/api/v1/checkout-invoice/confirm/${token}`, {
      headers: {
        'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
        'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
        'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN
      }
    });
    const confirmData = await confirmRes.json().catch(() => ({}));
    if (confirmData.status !== 'completed') {
      console.error(`⚠️ PayDunya ne confirme pas ce paiement (jeton ${token}) — statut réel: ${confirmData.status}. Notification ignorée, possible tentative frauduleuse.`);
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Paiement non confirmé par PayDunya, ignoré' }) };
    }

    // custom_data revient tel qu'on l'a envoyé au moment de créer la facture (voir checkout() côté
    // site) — c'est notre source fiable pour savoir QUELS produits exacts ont été achetés.
    const customData = body.custom_data || body.data?.custom_data || {};
    const clientEmail = customData.client_email || body.customer?.email || null;
    const clientNom = customData.client_nom || body.customer?.name || 'Client';
    const adresseLivraison = customData.adresse_livraison || null;
    const telephoneLivraison = customData.telephone_livraison || null;

    // Un panier peut contenir plusieurs articles (numériques et/ou physiques) : on traite chacun
    // séparément, avec sa propre commande de traitement, plutôt qu'un seul article pour tout le
    // panier (ancien comportement — le reste du panier payé n'était jamais enregistré).
    // La liste "articles" est le format actuel ; le fallback gère d'anciens paiements en cours
    // qui utilisaient encore l'ancien format à un seul article.
    const articles = Array.isArray(customData.articles) && customData.articles.length
      ? customData.articles
      : (customData.order_id ? [{
          order_id: customData.order_id,
          product_id: customData.product_id,
          produit_nom: customData.produit_nom,
          prix: body.amount || body.data?.amount || body.data?.invoice?.total_amount || 0
        }] : []);

    if (!articles.length) {
      console.error('⚠️ Aucun article trouvé dans custom_data');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Aucun article à traiter' }) };
    }

    // PayDunya peut renvoyer la même confirmation de paiement plusieurs fois (retry réseau côté
    // PayDunya) — sans cette vérification, on créerait plusieurs commandes pour un seul paiement
    // réel du client (double achat chez Kinguin, double livraison physique). On vérifie si ce
    // jeton de transaction a déjà été traité avant de continuer.
    if (token) {
      const { data: dejaTraite } = await supabase.from('commandes').select('id').eq('paydunya_token', token).limit(1);
      if (dejaTraite && dejaTraite.length) {
        console.log(`↪️ Paiement déjà traité (token ${token}), doublon ignoré`);
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Paiement déjà traité, doublon ignoré' }) };
      }
    }

    const commandesCreees = [];

    for (const article of articles) {
      const produitId = article.product_id || null;
      const orderId = article.order_id || null;
      const produitNom = article.produit_nom || 'Produit Gaming';
      const montant = article.prix || 0;

      // Un produit physique (manette, console, PC gamer) ne doit jamais entrer dans la boucle
      // d'achat automatique Kinguin de agent.js : on lui donne un statut différent dès le départ,
      // pour qu'il en soit exclu naturellement (agent.js ne traite que statut = 'payee').
      let estPhysique = false;
      if (produitId) {
        const { data: produit } = await supabase.from('products').select('est_physique').eq('id', produitId).single();
        estPhysique = !!produit?.est_physique;
      }
      const statutInitial = estPhysique ? 'a_approvisionner' : 'payee';

      const { data, error } = await supabase.from('commandes').insert({
        statut: statutInitial,
        livraison_auto: false,
        client_email: clientEmail,
        client_nom: clientNom,
        produit_nom: produitNom,
        produit_id: produitId,
        montant: montant,
        paydunya_token: token,
        adresse_livraison: adresseLivraison,
        telephone_livraison: telephoneLivraison,
        order_id: orderId,
        created_at: new Date().toISOString()
      }).select().single();

      if (error) { console.error('❌ Erreur insertion commande:', error.message); continue; }
      commandesCreees.push(data.id);

      // Ferme la boucle avec la commande d'origine (table "orders", celle que le client voit dans
      // son espace compte) pour CET article précis.
      if (orderId) {
        const { error: errOrder } = await supabase.from('orders')
          .update({ statut: estPhysique ? 'a_approvisionner' : 'paye' })
          .eq('id', orderId);
        if (errOrder) console.error('⚠️ Erreur mise à jour orders:', errOrder.message);
      }

      console.log(`✅ Commande créée : ${data.id} (${estPhysique ? 'physique — en attente d\'approvisionnement' : 'numérique'})`);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, commandes_ids: commandesCreees }) };

  } catch (err) {
    console.error('❌ Erreur webhook:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
