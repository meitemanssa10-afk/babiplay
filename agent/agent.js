const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const KINGUIN_KEY = process.env.KINGUIN_API_KEY;
const KINGUIN_BASE = 'https://gateway.kinguin.net/esa/api';

console.log('🤖 BabiPlay Agent (Kinguin API) démarré...');

// ─────────────────────────────────────────────
// 1. Rechercher un produit sur Kinguin par nom
// ─────────────────────────────────────────────
async function chercherProduitKinguin(nomProduit) {
  const url = `${KINGUIN_BASE}/v1/products?name=${encodeURIComponent(nomProduit)}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': KINGUIN_KEY }
  });
  if (!res.ok) throw new Error(`Kinguin search error: ${res.status}`);
  const data = await res.json();
  if (!data.results || !data.results.length) {
    throw new Error(`Aucun produit Kinguin trouvé pour "${nomProduit}"`);
  }
  // Prendre le moins cher disponible
  const produit = data.results.sort((a, b) => (a.price || 999999) - (b.price || 999999))[0];
  return produit;
}

// ─────────────────────────────────────────────
// 2. Passer une commande sur Kinguin
// ─────────────────────────────────────────────
async function passerCommandeKinguin(productId, prix) {
  const res = await fetch(`${KINGUIN_BASE}/v2/order`, {
    method: 'POST',
    headers: {
      'X-Api-Key': KINGUIN_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      products: [{ productId, qty: 1, price: prix }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Erreur commande Kinguin: ${JSON.stringify(data)}`);
  return data; // contient orderId
}

// ─────────────────────────────────────────────
// 3. Récupérer la clé une fois livrée
// ─────────────────────────────────────────────
async function recupererCleCommande(orderId, tentativesMax = 10) {
  for (let i = 0; i < tentativesMax; i++) {
    const res = await fetch(`${KINGUIN_BASE}/v1/order?orderId=${orderId}`, {
      headers: { 'X-Api-Key': KINGUIN_KEY }
    });
    const data = await res.json();
    const order = data.results && data.results[0];
    if (order && order.products) {
      const keys = order.products.flatMap(p => p.keys || []);
      const delivered = keys.find(k => k.status === 'DELIVERED');
      if (delivered) {
        // Récupérer le contenu réel de la clé
        const keyRes = await fetch(`${KINGUIN_BASE}/v2/order/${orderId}/keys/return`, {
          method: 'POST',
          headers: { 'X-Api-Key': KINGUIN_KEY }
        });
        const keyData = await keyRes.json();
        if (Array.isArray(keyData) && keyData.length) {
          return keyData[0].serial;
        }
      }
    }
    await new Promise(r => setTimeout(r, 3000)); // attendre 3s avant nouvelle tentative
  }
  throw new Error('Délai dépassé : clé non livrée par Kinguin');
}

// ─────────────────────────────────────────────
// 4. Acheter automatiquement via Kinguin
// ─────────────────────────────────────────────
async function acheterViaKinguin(produitNom) {
  console.log(`🔍 Recherche Kinguin : ${produitNom}`);
  const produit = await chercherProduitKinguin(produitNom);
  console.log(`📦 Produit trouvé : ${produit.name} — ${produit.price}€`);

  console.log('🛒 Passage de commande...');
  const commande = await passerCommandeKinguin(produit.productId || produit.kinguinId, produit.price);
  console.log(`✅ Commande Kinguin créée : ${commande.orderId}`);

  console.log('🔑 Récupération de la clé...');
  const code = await recupererCleCommande(commande.orderId);
  console.log('✅ Clé récupérée !');

  return code;
}

// ─────────────────────────────────────────────
// 5. Envoyer le code au client par email
// ─────────────────────────────────────────────
async function envoyerCodeParEmail(clientEmail, clientNom, produitNom, code) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'BabiPlay <noreply@babiplay.store>',
    to: clientEmail,
    subject: `✅ Votre code ${produitNom} - BabiPlay`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h1 style="color:#6c63ff;">🎮 BabiPlay</h1>
        <h2>Bonjour ${clientNom} !</h2>
        <p>Voici votre code d'activation :</p>
        <div style="background:#1a1a2e;color:#fff;padding:20px;border-radius:10px;text-align:center;font-size:24px;letter-spacing:3px;font-weight:bold;">
          ${code}
        </div>
        <p>Produit : <strong>${produitNom}</strong></p>
        <p>Merci pour votre achat sur BabiPlay ! 🚀</p>
      </div>
    `
  });
  console.log(`📧 Code envoyé à ${clientEmail}`);
}

// ─────────────────────────────────────────────
// 6. Traiter une commande BabiPlay
// ─────────────────────────────────────────────
async function traiterCommande(commande) {
  console.log(`🔄 Traitement commande ${commande.id}...`);
  try {
    await supabase.from('commandes').update({ statut: 'en_cours' }).eq('id', commande.id);

    const code = await acheterViaKinguin(commande.produit_nom || commande.nom_produit);

    if (commande.client_email) {
      await envoyerCodeParEmail(
        commande.client_email,
        commande.client_nom || 'Client',
        commande.produit_nom || commande.nom_produit,
        code
      );
    }

    await supabase.from('commandes').update({
      statut: 'livree',
      livraison_auto: true,
      livre_le: new Date().toISOString(),
      codes_livres: [code],
      code_jeu: code
    }).eq('id', commande.id);

    console.log(`✅ Commande ${commande.id} livrée avec succès !`);
  } catch (err) {
    console.error(`❌ Erreur commande ${commande.id}:`, err.message);
    await supabase.from('commandes').update({
      statut: 'erreur',
      erreur_message: err.message
    }).eq('id', commande.id);
  }
}

// ─────────────────────────────────────────────
// 7. Boucle de vérification
// ─────────────────────────────────────────────
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
    console.error('Erreur checkCommandes:', err.message);
  }
}

checkCommandes();
setInterval(checkCommandes, 30000);

const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BabiPlay Agent (Kinguin) OK');
}).listen(process.env.PORT || 3000);
