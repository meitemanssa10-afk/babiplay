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

async function obtenirProduitKinguinParId(productId) {
  const res = await fetch(`${KINGUIN_BASE}/v1/products/${productId}`, {
    headers: { 'X-Api-Key': KINGUIN_KEY }
  });
  if (!res.ok) throw new Error(`Produit Kinguin introuvable pour l'ID ${productId} (status ${res.status})`);
  return await res.json();
}

async function chercherProduitKinguin(nomProduit) {
  const url = `${KINGUIN_BASE}/v1/products?name=${encodeURIComponent(nomProduit)}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': KINGUIN_KEY } });
  if (!res.ok) throw new Error(`Kinguin search error: ${res.status}`);
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error(`Aucun produit Kinguin trouvé pour "${nomProduit}"`);
  return data.results.sort((a, b) => (a.price || 999999) - (b.price || 999999))[0];
}

async function passerCommandeKinguin(productId, prix) {
  const res = await fetch(`${KINGUIN_BASE}/v2/order`, {
    method: 'POST',
    headers: { 'X-Api-Key': KINGUIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ products: [{ productId, qty: 1, price: prix }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Erreur commande Kinguin: ${JSON.stringify(data)}`);
  return data;
}

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
        const keyRes = await fetch(`${KINGUIN_BASE}/v2/order/${orderId}/keys/return`, {
          method: 'POST',
          headers: { 'X-Api-Key': KINGUIN_KEY }
        });
        const keyData = await keyRes.json();
        if (Array.isArray(keyData) && keyData.length) return keyData[0].serial;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Délai dépassé : clé non livrée par Kinguin');
}

async function acheterViaKinguin(produitNom, kinguinProductId) {
  let produit;
  if (kinguinProductId) {
    console.log(`🔗 Utilisation de l'ID Kinguin configuré : ${kinguinProductId}`);
    produit = await obtenirProduitKinguinParId(kinguinProductId);
    produit.productId = kinguinProductId;
  } else {
    console.log(`⚠️ Aucun ID Kinguin configuré pour "${produitNom}" — recherche par nom`);
    produit = await chercherProduitKinguin(produitNom);
  }
  console.log(`📦 Produit trouvé : ${produit.name} — ${produit.price}€`);
  const commande = await passerCommandeKinguin(produit.productId || produit.kinguinId, produit.price);
  console.log(`✅ Commande Kinguin créée : ${commande.orderId}`);
  const code = await recupererCleCommande(commande.orderId);
  console.log('✅ Clé récupérée !');
  return code;
}

async function envoyerCodeParEmail(clientEmail, clientNom, produitNom, code) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'BabiPlay <noreply@babiplay.store>',
    to: clientEmail,
    subject: `✅ Votre code ${produitNom} - BabiPlay`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h1 style="color:#f5a623;">🎮 BabiPlay</h1>
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

async function traiterCommande(commande) {
  console.log(`🔄 Traitement commande ${commande.id}...`);
  try {
    await supabase.from('commandes').update({ statut: 'en_cours' }).eq('id', commande.id);
    let kinguinProductId = null;
    const produitId = commande.product_id || commande.produit_id;
    if (produitId) {
      const { data: produitBabiPlay } = await supabase
        .from('products').select('kinguin_product_id').eq('id', produitId).single();
      kinguinProductId = produitBabiPlay?.kinguin_product_id || null;
    }
    const code = await acheterViaKinguin(commande.produit_nom || commande.nom_produit, kinguinProductId);
    if (commande.client_email) {
      await envoyerCodeParEmail(commande.client_email, commande.client_nom || 'Client', commande.produit_nom || commande.nom_produit, code);
    }
    await supabase.from('commandes').update({
      statut: 'livree', livraison_auto: true,
      livre_le: new Date().toISOString(), codes_livres: [code], code_jeu: code
    }).eq('id', commande.id);
    console.log(`✅ Commande ${commande.id} livrée avec succès !`);
  } catch (err) {
    console.error(`❌ Erreur commande ${commande.id}:`, err.message);
    await supabase.from('commandes').update({ statut: 'erreur', erreur_message: err.message }).eq('id', commande.id);
  }
}

async function checkCommandes() {
  try {
    const { data: commandes, error } = await supabase
      .from('commandes').select('*').eq('statut', 'payee').eq('livraison_auto', false);
    if (error) throw error;
    if (commandes && commandes.length > 0) {
      console.log(`📦 ${commandes.length} commande(s) à traiter...`);
      for (const commande of commandes) await traiterCommande(commande);
    } else {
      console.log('✅ Aucune commande en attente.');
    }
  } catch (err) {
    console.error('Erreur checkCommandes:', err.message);
  }
}

checkCommandes();
setInterval(checkCommandes, 30000);

// ─────────────────────────────────────────────
// Auto-ping : empêche Render (plan gratuit) de s'endormir
// ─────────────────────────────────────────────
setInterval(async () => {
  try {
    await fetch('https://babiplay-agent.onrender.com');
    console.log('🏓 Auto-ping OK — service maintenu éveillé');
  } catch (e) {
    console.log('⚠️ Auto-ping échoué:', e.message);
  }
}, 4 * 60 * 1000);

// ═════════════════════════════════════════════════════════════
// IMPORT EN MASSE DU CATALOGUE KINGUIN (vendable en France)
// ═════════════════════════════════════════════════════════════
const IMPORT_SECRET = crypto.randomBytes(8).toString('hex');
console.log(`🔐 Code secret import/fix : ${IMPORT_SECRET}`);
console.log(`👉 Import : https://babiplay-agent.onrender.com/import-kinguin-products?secret=${IMPORT_SECRET}`);
console.log(`👉 Fix    : https://babiplay-agent.onrender.com/fix-kinguin-products?secret=${IMPORT_SECRET}`);

const KINGUIN_PRODUCTS_BASE = 'https://gateway.kinguin.net/esa/api/v1';
const PAGE_LIMIT = 100;
const MARGIN = parseFloat(process.env.MARGIN || '0.25');
const EUR_TO_XOF = 655.957;

// Prix minimum acceptable en EUR pour éviter les données aberrantes
// (précommandes sans prix fixé, produits épuisés avec prix à 0, etc.)
const PRIX_MIN_EUR = 0.5;

let importEnCours = false;
let fixEnCours = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isSellableInFrance(product) {
  return !(product.countryLimitation || []).includes('FR');
}

// Récupère la meilleure image disponible :
// priorité à cover.url, sinon premier screenshot, sinon vide
function getImageUrl(product) {
  if (product.images?.cover?.url) return product.images.cover.url;
  if (product.images?.screenshots?.[0]?.url) return product.images.screenshots[0].url;
  return '';
}

function mapPlatform(kinguinPlatform, productName) {
  const p = (kinguinPlatform || '').toLowerCase();
  const n = (productName || '').toLowerCase();
  if (p.includes('playstation') || p.includes('psn'))
    return { plateforme: 'psn', categorie: n.includes('ps5') ? 'PS5' : 'PS4' };
  if (p.includes('xbox'))
    return { plateforme: 'xbox', categorie: p.includes('series') || n.includes('series') ? 'Xbox Series X|S' : 'Xbox One' };
  if (p.includes('nintendo') || p.includes('switch') || p === '2ds' || p === '3ds')
    return { plateforme: 'nintendo', categorie: 'Switch' };
  let categorie = 'Steam';
  if (p.includes('epic')) categorie = 'Epic Games';
  else if (p.includes('battle.net') || p.includes('battlenet')) categorie = 'Battle.net';
  else if (p.includes('ubisoft')) categorie = 'Ubisoft Connect';
  else if (p.includes('ea app') || p.includes('origin')) categorie = 'EA App';
  else if (p.includes('rockstar')) categorie = 'Rockstar Games';
  else if (p.includes('gog')) categorie = 'GOG';
  else if (p.includes('microsoft store')) categorie = 'Microsoft Store';
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

function genererDescriptionFR(plateforme, categorie, sousCategorie) {
  const storeLabel = { psn: 'PlayStation Store', xbox: 'Xbox', pc: categorie || 'PC', nintendo: 'Nintendo eShop' }[plateforme] || 'la plateforme';
  if (sousCategorie === 'Cartes cadeaux')
    return `Carte cadeau numérique ${storeLabel} — le code est envoyé par email immédiatement après le paiement. À utiliser sur un compte enregistré dans la région correspondante.`;
  if (sousCategorie === 'Game Pass')
    return `Abonnement Xbox Game Pass — accès à la bibliothèque de jeux Xbox et PC. Code d'activation envoyé par email après achat.`;
  if (sousCategorie === 'Abonnements')
    return `Abonnement premium ${storeLabel} — profitez du jeu en ligne et d'avantages exclusifs. Code envoyé par email après achat.`;
  return `Clé d'activation officielle pour ${storeLabel}. Téléchargement et activation immédiats après réception du code par email.`;
}

function priceToFCFA(eurPrice) {
  return Math.round(eurPrice * (1 + MARGIN) * EUR_TO_XOF);
}

async function fetchKinguinPage(page) {
  const url = `${KINGUIN_PRODUCTS_BASE}/products?page=${page}&limit=${PAGE_LIMIT}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': KINGUIN_KEY } });
  if (!res.ok) throw new Error(`Kinguin API erreur ${res.status} sur la page ${page}`);
  return res.json();
}

async function getExistingKinguinIds() {
  const { data, error } = await supabase.from('products').select('kinguin_product_id').not('kinguin_product_id', 'is', null);
  if (error) throw new Error('Impossible de lire les produits existants: ' + error.message);
  return new Set((data || []).map(r => r.kinguin_product_id).filter(Boolean));
}

async function insertProducts(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from('products').insert(rows);
  if (error) throw new Error('Erreur insertion Supabase: ' + error.message);
}

async function runImportKinguin() {
  if (importEnCours) { console.log('⚠️ Import déjà en cours.'); return; }
  importEnCours = true;
  console.log(`🚀 Import Kinguin | marge: ${MARGIN * 100}% | taux: 1€ = ${EUR_TO_XOF} FCFA | prix min: ${PRIX_MIN_EUR}€`);
  try {
    const existingIds = await getExistingKinguinIds();
    console.log(`   ${existingIds.size} produit(s) déjà en base.`);
    let page = 1, totalCount = null, totalImported = 0, totalSkippedFR = 0, totalSkippedDoublon = 0, totalSkippedPrix = 0;
    while (true) {
      let data;
      try { data = await fetchKinguinPage(page); }
      catch (e) { console.error(`⚠️ Erreur page ${page}: ${e.message} — retry dans 5s`); await sleep(5000); continue; }
      if (totalCount === null) { totalCount = data.item_count; console.log(`📦 ${totalCount} produits au total chez Kinguin.`); }
      const results = data.results || [];
      if (!results.length) break;
      const rowsToInsert = [];
      for (const product of results) {
        if (!isSellableInFrance(product)) { totalSkippedFR++; continue; }
        if (!product.productId || existingIds.has(product.productId)) { totalSkippedDoublon++; continue; }
        // Filtrer les prix aberrants (0, négatifs, ou inférieurs au minimum)
        const eurPrice = product.price || 0;
        if (eurPrice < PRIX_MIN_EUR) { totalSkippedPrix++; continue; }
        const { plateforme, categorie } = mapPlatform(product.platform, product.name);
        const sousCategorie = guessSousCategorie(product);
        const prix = priceToFCFA(eurPrice);
        rowsToInsert.push({
          nom: product.name || 'Produit Kinguin', plateforme, categorie, sous_categorie: sousCategorie,
          description: genererDescriptionFR(plateforme, categorie, sousCategorie),
          prix,
          image_url: getImageUrl(product),
          video_url: '',
          est_slider: false, slider_ordre: 1, est_populaire: false, est_actif: true,
          kinguin_product_id: product.productId, stock: 999
        });
        existingIds.add(product.productId);
      }
      if (rowsToInsert.length) {
        try { await insertProducts(rowsToInsert); totalImported += rowsToInsert.length; }
        catch (e) { console.error(`⚠️ Erreur insertion page ${page}: ${e.message}`); }
      }
      console.log(`Page ${page} — importés: ${totalImported} | exclus FR: ${totalSkippedFR} | prix invalides: ${totalSkippedPrix} | doublons: ${totalSkippedDoublon}`);
      if (page * PAGE_LIMIT >= totalCount) break;
      page++;
      await sleep(300);
    }
    console.log(`✅ Import terminé ! Importés: ${totalImported} | Exclus FR: ${totalSkippedFR} | Prix invalides: ${totalSkippedPrix} | Doublons: ${totalSkippedDoublon}`);
  } catch (e) {
    console.error('❌ Erreur fatale import Kinguin:', e);
  } finally {
    importEnCours = false;
  }
}

// ─────────────────────────────────────────────
// CORRECTION : description FR + vraies photos + prix corrigés
// ─────────────────────────────────────────────
async function runFixKinguinProducts() {
  if (fixEnCours) { console.log('⚠️ Correction déjà en cours.'); return; }
  fixEnCours = true;
  console.log('🛠️ Correction des produits Kinguin (description FR + photos + prix)...');
  try {
    const { data, error } = await supabase.from('products').select('id, kinguin_product_id, image_url, prix').not('kinguin_product_id', 'is', null);
    if (error) throw new Error('Lecture produits: ' + error.message);
    const existingMap = new Map((data || []).map(r => [r.kinguin_product_id, r]));
    console.log(`   ${existingMap.size} produit(s) à corriger.`);
    let page = 1, totalCount = null, totalCorriges = 0;
    while (true) {
      let pageData;
      try { pageData = await fetchKinguinPage(page); }
      catch (e) { console.error(`⚠️ Erreur page ${page}: ${e.message} — retry dans 5s`); await sleep(5000); continue; }
      if (totalCount === null) { totalCount = pageData.item_count; console.log(`📦 ${totalCount} produits chez Kinguin.`); }
      const results = pageData.results || [];
      if (!results.length) break;
      for (const product of results) {
        const row = existingMap.get(product.productId);
        if (!row) continue;
        const { plateforme, categorie } = mapPlatform(product.platform, product.name);
        const sousCategorie = guessSousCategorie(product);
        const fields = { description: genererDescriptionFR(plateforme, categorie, sousCategorie) };
        // Corriger l'image
        const nouvelleImage = getImageUrl(product);
        if (nouvelleImage && nouvelleImage !== row.image_url) fields.image_url = nouvelleImage;
        // Corriger le prix si aberrant
        const eurPrice = product.price || 0;
        if (eurPrice >= PRIX_MIN_EUR) {
          const nouveauPrix = priceToFCFA(eurPrice);
          if (nouveauPrix !== row.prix) fields.prix = nouveauPrix;
        }
        const { error: updateErr } = await supabase.from('products').update(fields).eq('id', row.id);
        if (!updateErr) totalCorriges++;
      }
      console.log(`Page ${page} traitée — corrigés: ${totalCorriges}`);
      if (page * PAGE_LIMIT >= totalCount) break;
      page++;
      await sleep(300);
    }
    console.log(`✅ Correction terminée ! ${totalCorriges} produits mis à jour.`);
  } catch (e) {
    console.error('❌ Erreur fatale correction:', e);
  } finally {
    fixEnCours = false;
  }
}

// ─────────────────────────────────────────────
// Serveur HTTP
// ─────────────────────────────────────────────
const http = require('http');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const secret = url.searchParams.get('secret');

  if (url.pathname === '/import-kinguin-products') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (importEnCours) { res.writeHead(200); res.end('Import déjà en cours — voir logs Render.'); return; }
    runImportKinguin();
    res.writeHead(200);
    res.end('✅ Import démarré ! Va dans Render → Logs pour suivre la progression.');
    return;
  }

  if (url.pathname === '/fix-kinguin-products') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (fixEnCours) { res.writeHead(200); res.end('Correction déjà en cours — voir logs Render.'); return; }
    runFixKinguinProducts();
    res.writeHead(200);
    res.end('✅ Correction démarrée ! Va dans Render → Logs pour suivre la progression.');
    return;
  }

  res.writeHead(200);
  res.end('BabiPlay Agent (Kinguin) OK');
}).listen(process.env.PORT || 3000);
