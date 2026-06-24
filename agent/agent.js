const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const KINGUIN_KEY = process.env.KINGUIN_API_KEY;
const KINGUIN_BASE = 'https://gateway.kinguin.net/esa/api';

console.log('🤖 BabiPlay Agent (Kinguin API) démarré...');

// ─────────────────────────────────────────────
// 1. Récupérer le détail d'un produit Kinguin par son ID exact
// ─────────────────────────────────────────────
async function obtenirProduitKinguinParId(productId) {
  const res = await fetch(`${KINGUIN_BASE}/v1/products/${productId}`, {
    headers: { 'X-Api-Key': KINGUIN_KEY }
  });
  if (!res.ok) throw new Error(`Produit Kinguin introuvable pour l'ID ${productId} (status ${res.status})`);
  return await res.json();
}

// ─────────────────────────────────────────────
// 1b. Rechercher un produit sur Kinguin par nom (fallback si pas d'ID configuré)
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
//    Utilise l'ID Kinguin exact configuré sur le produit BabiPlay si dispo,
//    sinon retombe sur une recherche par nom (moins fiable).
// ─────────────────────────────────────────────
async function acheterViaKinguin(produitNom, kinguinProductId) {
  let produit;
  if (kinguinProductId) {
    console.log(`🔗 Utilisation de l'ID Kinguin configuré : ${kinguinProductId}`);
    produit = await obtenirProduitKinguinParId(kinguinProductId);
    produit.productId = kinguinProductId;
  } else {
    console.log(`⚠️ Aucun ID Kinguin configuré pour "${produitNom}" — recherche par nom (moins fiable)`);
    produit = await chercherProduitKinguin(produitNom);
  }
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

    // Récupérer le produit BabiPlay lié pour avoir son kinguin_product_id
    let kinguinProductId = null;
    const produitId = commande.product_id || commande.produit_id;
    if (produitId) {
      const { data: produitBabiPlay } = await supabase
        .from('products')
        .select('kinguin_product_id')
        .eq('id', produitId)
        .single();
      kinguinProductId = produitBabiPlay?.kinguin_product_id || null;
    }

    const code = await acheterViaKinguin(commande.produit_nom || commande.nom_produit, kinguinProductId);

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

// ═════════════════════════════════════════════════════════════
// IMPORT EN MASSE DU CATALOGUE KINGUIN (vendable en France)
// Déclenché une seule fois via une URL secrète (voir tout en bas).
// ═════════════════════════════════════════════════════════════
const IMPORT_SECRET = crypto.randomBytes(8).toString('hex');
console.log(`🔐 Code secret pour lancer l'import Kinguin : ${IMPORT_SECRET}`);
console.log(`👉 Visite : https://babiplay-agent.onrender.com/import-kinguin-products?secret=${IMPORT_SECRET}`);

const KINGUIN_PRODUCTS_BASE = 'https://gateway.kinguin.net/esa/api/v1';
const PAGE_LIMIT = 100;
const MARGIN = parseFloat(process.env.MARGIN || '0.25');
const EUR_TO_XOF = 655.957; // taux fixe officiel CFA/EUR

let importEnCours = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isSellableInFrance(product) {
  const excluded = product.countryLimitation || [];
  return !excluded.includes('FR');
}

function mapPlatform(kinguinPlatform, productName) {
  const p = (kinguinPlatform || '').toLowerCase();
  const n = (productName || '').toLowerCase();
  if (p.includes('playstation') || p.includes('psn')) {
    return { plateforme: 'psn', categorie: n.includes('ps5') ? 'PS5' : 'PS4' };
  }
  if (p.includes('xbox')) {
    return { plateforme: 'xbox', categorie: p.includes('series') || n.includes('series') ? 'Xbox Series X|S' : 'Xbox One' };
  }
  if (p.includes('nintendo') || p.includes('switch') || p === '2ds' || p === '3ds') {
    return { plateforme: 'nintendo', categorie: 'Switch' };
  }
  let categorie = 'Steam';
  if (p.includes('epic')) categorie = 'Epic Games';
  else if (p.includes('battle.net') || p.includes('battlenet')) categorie = 'Battle.net';
  else if (p.includes('ubisoft')) categorie = 'Ubisoft Connect';
  else if (p.includes('ea app') || p.includes('origin')) categorie = 'EA App';
  else if (p.includes('rockstar')) categorie = 'Rockstar Games';
  else if (p.includes('gog')) categorie = 'GOG';
  else if (p.includes('microsoft store')) categorie = 'Microsoft Store';
  else if (p.includes('steam')) categorie = 'Steam';
  return { plateforme: 'pc', categorie };
}

function guessSousCategorie(product) {
  const tags = product.tags || [];
  const name = (product.name || '').toLowerCase();
  if (tags.includes('prepaid') || name.includes('gift card') || name.includes('wallet') || name.includes('points')) return 'Cartes cadeaux';
  if (name.includes('game pass')) return 'Game Pass';
  if (name.includes('plus') && (name.includes('xbox') || name.includes('playstation') || name.includes('psn'))) return 'Abonnements';
  return '';
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '').slice(0, 2000);
}

function priceToFCFA(eurPrice) {
  const withMargin = eurPrice * (1 + MARGIN);
  return Math.round(withMargin * EUR_TO_XOF);
}

async function fetchKinguinPage(page) {
  const url = `${KINGUIN_PRODUCTS_BASE}/products?page=${page}&limit=${PAGE_LIMIT}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': KINGUIN_KEY } });
  if (!res.ok) throw new Error(`Kinguin API erreur ${res.status} sur la page ${page}`);
  return res.json();
}

async function getExistingKinguinIds() {
  const { data, error } = await supabase
    .from('products')
    .select('kinguin_product_id')
    .not('kinguin_product_id', 'is', null);
  if (error) throw new Error('Impossible de lire les produits existants: ' + error.message);
  return new Set((data || []).map(r => r.kinguin_product_id).filter(Boolean));
}

async function insertProducts(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from('products').insert(rows);
  if (error) throw new Error('Erreur insertion Supabase: ' + error.message);
}

async function runImportKinguin() {
  if (importEnCours) {
    console.log('⚠️ Import déjà en cours, requête ignorée.');
    return;
  }
  importEnCours = true;
  console.log(`🚀 Import Kinguin → Supabase | marge: ${MARGIN * 100}% | taux: 1€ = ${EUR_TO_XOF} FCFA`);

  try {
    console.log('📥 Lecture des produits déjà importés...');
    const existingIds = await getExistingKinguinIds();
    console.log(`   ${existingIds.size} produit(s) déjà en base.`);

    let page = 1;
    let totalCount = null;
    let totalImported = 0;
    let totalSkippedExclu = 0;
    let totalSkippedDoublon = 0;

    while (true) {
      let data;
      try {
        data = await fetchKinguinPage(page);
      } catch (e) {
        console.error(`⚠️ Erreur page ${page}: ${e.message} — nouvelle tentative dans 5s`);
        await sleep(5000);
        continue;
      }

      if (totalCount === null) {
        totalCount = data.item_count;
        console.log(`📦 ${totalCount} produits au total chez Kinguin.`);
      }

      const results = data.results || [];
      if (!results.length) break;

      const rowsToInsert = [];
      for (const product of results) {
        if (!isSellableInFrance(product)) { totalSkippedExclu++; continue; }
        if (!product.productId || existingIds.has(product.productId)) { totalSkippedDoublon++; continue; }

        const { plateforme, categorie } = mapPlatform(product.platform, product.name);
        const prix = priceToFCFA(product.price || 0);
        if (!prix || prix <= 0) continue;

        rowsToInsert.push({
          nom: product.name || 'Produit Kinguin',
          plateforme,
          categorie,
          sous_categorie: guessSousCategorie(product),
          description: stripHtml(product.description),
          prix,
          image_url: product.images?.cover?.url || '',
          video_url: '',
          est_slider: false,
          slider_ordre: 1,
          est_populaire: false,
          est_actif: true,
          kinguin_product_id: product.productId,
          stock: 999
        });
        existingIds.add(product.productId);
      }

      if (rowsToInsert.length) {
        try {
          await insertProducts(rowsToInsert);
          totalImported += rowsToInsert.length;
        } catch (e) {
          console.error(`⚠️ Erreur insertion page ${page}: ${e.message}`);
        }
      }

      console.log(`Page ${page} traitée — importés: ${totalImported} | exclus FR: ${totalSkippedExclu} | doublons: ${totalSkippedDoublon}`);

      if (page * PAGE_LIMIT >= totalCount) break;
      page++;
      await sleep(300);
    }

    console.log('✅ Import Kinguin terminé !');
    console.log(`   Produits importés : ${totalImported}`);
    console.log(`   Exclus (non vendables en France) : ${totalSkippedExclu}`);
    console.log(`   Déjà existants (ignorés) : ${totalSkippedDoublon}`);
  } catch (e) {
    console.error('❌ Erreur fatale import Kinguin:', e);
  } finally {
    importEnCours = false;
  }
}

// ─────────────────────────────────────────────
// Serveur HTTP (santé Render + déclencheur d'import)
// ─────────────────────────────────────────────
const http = require('http');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/import-kinguin-products') {
    const secret = url.searchParams.get('secret');
    if (secret !== IMPORT_SECRET) {
      res.writeHead(403);
      res.end('Code secret invalide.');
      return;
    }
    if (importEnCours) {
      res.writeHead(200);
      res.end('Un import est déjà en cours — regarde les logs Render pour suivre la progression.');
      return;
    }
    runImportKinguin(); // lancé en arrière-plan, pas attendu ici
    res.writeHead(200);
    res.end('✅ Import démarré ! Va dans Render → Logs pour suivre la progression en direct.');
    return;
  }
  res.writeHead(200);
  res.end('BabiPlay Agent (Kinguin) OK');
}).listen(process.env.PORT || 3000);
