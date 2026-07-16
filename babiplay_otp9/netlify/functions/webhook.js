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
    const body = JSON.parse(event.body);
    console.log('📥 Webhook PayDunya reçu:', JSON.stringify(body));

    const statut = body.status || body.data?.status;
    if (statut !== 'completed') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Statut ignoré' }) };
    }

    // custom_data revient tel qu'on l'a envoyé au moment de créer la facture (voir checkout() côté
    // site) — c'est notre source fiable pour savoir QUELS produits exacts ont été achetés.
    const customData = body.custom_data || body.data?.custom_data || {};
    const clientEmail = customData.client_email || body.customer?.email || null;
    const clientNom = customData.client_nom || body.customer?.name || 'Client';
    const adresseLivraison = customData.adresse_livraison || null;
    const telephoneLivraison = customData.telephone_livraison || null;
    const token = body.token || body.data?.token || null;

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
          prix: body.amount || body.data?.amount || 0
        }] : []);

    if (!articles.length) {
      console.error('⚠️ Aucun article trouvé dans custom_data');
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Aucun article à traiter' }) };
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
