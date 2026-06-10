const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

console.log('🤖 BabiPlay Agent démarré...');

async function checkCommandes() {
  try {
    const { data: commandes, error } = await supabase
      .from('commandes')
      .select('*')
      .eq('statut', 'payee')
      .eq('livraison_auto', false);

    if (error) throw error;

    if (commandes && commandes.length > 0) {
      console.log(`📦 ${commandes.length} commande(s) à traiter...`);
      for (const commande of commandes) {
        await traiterCommande(commande);
      }
    } else {
      console.log('✅ Aucune commande en attente.');
    }
  } catch (err) {
    console.error('Erreur:', err.message);
  }
}

async function traiterCommande(commande) {
  try {
    const { data: codes, error } = await supabase
      .from('codes')
      .select('*')
      .eq('produit_id', commande.produit_id)
      .eq('statut', 'disponible')
      .limit(commande.quantite);

    if (error) throw error;

    if (!codes || codes.length < commande.quantite) {
      await supabase.from('commandes').update({ statut: 'en_attente_stock' }).eq('id', commande.id);
      return;
    }

    for (const code of codes) {
      await supabase.from('codes').update({
        statut: 'vendu',
        commande_id: commande.id,
        vendu_le: new Date().toISOString()
      }).eq('id', code.id);
    }

    await supabase.from('commandes').update({
      statut: 'livree',
      livraison_auto: true,
      livre_le: new Date().toISOString(),
      codes_livres: codes.map(c => c.code)
    }).eq('id', commande.id);

    console.log(`✅ Commande ${commande.id} livrée.`);
  } catch (err) {
    console.error('Erreur:', err.message);
  }
}

checkCommandes();
setInterval(checkCommandes, 30000);

const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BabiPlay Agent OK');
}).listen(process.env.PORT || 3000);
