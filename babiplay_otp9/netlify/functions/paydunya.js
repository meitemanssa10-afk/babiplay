// Création de la facture PayDunya — TOUT est recalculé ici, côté serveur.
// Le navigateur n'envoie plus que les numéros de commande : il ne peut plus choisir le prix.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const reponse = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reponse(405, { error: 'Méthode interdite' });

  try {
    // 1. Qui appelle ? On vérifie la session Supabase du client.
    const jwt = (event.headers.authorization || '').replace('Bearer ', '');
    const { data: auth, error: errAuth } = await supabase.auth.getUser(jwt);
    const user = auth?.user;
    if (errAuth || !user) return reponse(401, { error: 'Session expirée, reconnectez-vous' });

    const { order_ids, livraison } = JSON.parse(event.body || '{}');
    if (!Array.isArray(order_ids) || !order_ids.length || order_ids.length > 20) {
      return reponse(400, { error: 'Commande invalide' });
    }

    // 2. Uniquement les commandes de CE client, encore en attente.
    const { data: orders } = await supabase.from('orders')
      .select('id, product_id, prix_paye, promo_code')
      .in('id', order_ids).eq('user_id', user.id).eq('statut', 'en_attente');
    if (!orders || orders.length !== order_ids.length) {
      return reponse(400, { error: 'Commande introuvable ou déjà payée' });
    }

    // 3. Prix réels lus dans products (jamais ceux envoyés par le navigateur).
    const ids = [...new Set(orders.map(o => o.product_id))];
    const { data: produits } = await supabase.from('products')
      .select('id, nom, plateforme, prix, est_actif').in('id', ids);
    const parId = Object.fromEntries((produits || []).map(p => [p.id, p]));

    const articles = [];
    for (const o of orders) {
      const p = parId[o.product_id];
      if (!p || !p.est_actif) return reponse(400, { error: "Un produit de cette commande n'est plus disponible" });
      if (Number(o.prix_paye) !== Number(p.prix)) {
        return reponse(409, { error: `Le prix de « ${p.nom} » a changé. Annulez cette commande et recommandez.` });
      }
      articles.push({ order_id: o.id, product_id: p.id, produit_nom: p.nom, plateforme: p.plateforme, prix: Number(p.prix) });
    }

    // 4. Code promo revérifié ici (s'il n'est plus actif, pas de réduction).
    let total = articles.reduce((s, a) => s + a.prix, 0);
    const code = orders[0].promo_code;
    if (code) {
      const { data: promo } = await supabase.from('promo_codes')
        .select('reduction_pct, reduction_fcfa').eq('code', code).eq('est_actif', true).maybeSingle();
      if (promo) {
        total = promo.reduction_pct > 0
          ? Math.round(total * (1 - promo.reduction_pct / 100))
          : Math.max(0, total - (promo.reduction_fcfa || 0));
      }
    }
    if (total < 100) return reponse(400, { error: 'Montant trop faible pour un paiement' });

    // 5. Nom du client
    const { data: profil } = await supabase.from('profiles').select('prenom, nom').eq('id', user.id).maybeSingle();
    const clientNom = `${profil?.prenom || ''} ${profil?.nom || ''}`.trim() || user.email;

    const customData = { articles, client_email: user.email, client_nom: clientNom };
    if (livraison && livraison.nom && livraison.adresse) {
      customData.adresse_livraison = `${String(livraison.nom).slice(0, 80)} — ${String(livraison.adresse).slice(0, 200)}`;
      customData.telephone_livraison = String(livraison.telephone || '').slice(0, 30);
    }

    // 6. Création de la facture
    const res = await fetch('https://app.paydunya.com/api/v1/checkout-invoice/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
        'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
        'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN
      },
      body: JSON.stringify({
        invoice: { total_amount: total, description: articles.map(a => a.produit_nom).join(', ').slice(0, 200) },
        store: { name: 'BabiPlay CI', tagline: 'Cartes gaming en FCFA', postal_address: 'Abidjan CI', phone_number: '0700000000', logo_url: 'https://babiplay.store', website_url: 'https://babiplay.store' },
        actions: {
          cancel_url: 'https://babiplay.store/compte.html',
          return_url: 'https://babiplay.store/compte.html',
          callback_url: 'https://babiplay.store/.netlify/functions/webhook'
        },
        customer: { name: clientNom, email: user.email },
        custom_data: customData
      })
    });
    const data = await res.json();
    const url = data.invoice_url || data.response_text;
    if (data.response_code !== '00' || !url || !String(url).startsWith('http')) {
      return reponse(502, { error: data.response_text || 'PayDunya indisponible' });
    }

    // 7. On garde le jeton de la facture sur les commandes
    await supabase.from('orders').update({ transaction_id: data.token || '' }).in('id', order_ids);

    return reponse(200, { url });
  } catch (err) {
    console.error('❌ paydunya.js :', err.message);
    return reponse(500, { error: 'Erreur serveur' });
  }
};
