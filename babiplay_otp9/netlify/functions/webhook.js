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

    const customData = body.custom_data || body.data?.custom_data || {};
    const clientEmail = customData.client_email || body.customer?.email;
    const clientNom = customData.client_nom || body.customer?.name || 'Client';
    const produitNom = customData.produit_nom || 'Produit Gaming';
    const montant = body.amount || body.data?.amount || 0;
    const token = body.token || body.data?.token;

    const { data, error } = await supabase.from('commandes').insert({
      statut: 'payee',
      livraison_auto: false,
      client_email: clientEmail,
      client_nom: clientNom,
      produit_nom: produitNom,
      montant: montant,
      paydunya_token: token,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

    console.log(`✅ Commande créée : ${data.id}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, commande_id: data.id }) };

  } catch (err) {
    console.error('❌ Erreur webhook:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
