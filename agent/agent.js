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

// ═════════════════════════════════════════════════════════════
// TRAITEMENT DES COMMANDES (achat + livraison auto)
// ═════════════════════════════════════════════════════════════
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
// IMPORT DU CATALOGUE — PLAFONNÉ PAR CATÉGORIE (100 max chacune)
// ═════════════════════════════════════════════════════════════
const IMPORT_SECRET = crypto.randomBytes(8).toString('hex');
console.log(`🔐 Code secret import/fix : ${IMPORT_SECRET}`);
console.log(`👉 Import par catégories : https://babiplay-agent.onrender.com/import-categories?secret=${IMPORT_SECRET}`);
console.log(`👉 Fix produits existants : https://babiplay-agent.onrender.com/fix-kinguin-products?secret=${IMPORT_SECRET}`);

const KINGUIN_PRODUCTS_BASE = 'https://gateway.kinguin.net/esa/api/v1';
const PAGE_LIMIT = 100;
const MARGIN = parseFloat(process.env.MARGIN || '0.25');
const EUR_TO_XOF = 655.957;
const PRIX_MIN_EUR = 0.5;
const CAP_PAR_CATEGORIE = parseInt(process.env.CAP_PAR_CATEGORIE || '100', 10);

// Les 10 catégories suivies. Facile à modifier : ajoute/retire une ligne pour changer la sélection.
const CATEGORIES = [
  { plateforme: 'psn',      sousCategorie: 'Cartes cadeaux', label: 'PSN — Cartes cadeaux' },
  { plateforme: 'psn',      sousCategorie: 'Abonnements',    label: 'PSN — Abonnements (PS Plus)' },
  { plateforme: 'psn',      sousCategorie: '',                label: 'PSN — Jeux' },
  { plateforme: 'xbox',     sousCategorie: 'Cartes cadeaux', label: 'Xbox — Cartes cadeaux' },
  { plateforme: 'xbox',     sousCategorie: 'Game Pass',      label: 'Xbox — Game Pass' },
  { plateforme: 'xbox',     sousCategorie: '',                label: 'Xbox — Jeux' },
  { plateforme: 'pc',       sousCategorie: 'Cartes cadeaux', label: 'PC — Cartes cadeaux (Steam Wallet...)' },
  { plateforme: 'pc',       sousCategorie: '',                label: 'PC — Jeux (Steam/Epic/...)' },
  { plateforme: 'nintendo', sousCategorie: 'Cartes cadeaux', label: 'Nintendo — Cartes eShop' },
  { plateforme: 'nintendo', sousCategorie: '',                label: 'Nintendo — Jeux' },
];

// Titres/services connus → mis en avant dans chaque catégorie (proxy de "popularité",
// Kinguin ne fournit pas de note/bestseller sur cette API vendeur).
const MOTS_CLES_POPULAIRES = [
  'gta', 'grand theft auto', 'fifa', 'fc 24', 'fc 25', 'ea sports fc',
  'call of duty', 'modern warfare', 'fortnite', 'v-bucks', 'minecraft',
  'cyberpunk', 'elden ring', 'spider-man', 'hogwarts legacy', 'mortal kombat',
  'nba 2k', 'red dead', 'zelda', 'mario', 'god of war', 'battlefield',
  "assassin's creed", 'resident evil', 'final fantasy', 'playstation plus',
  'ps plus', 'game pass', 'apex legends', 'valorant', 'league of legends',
  'counter-strike', 'pubg', 'diablo', 'overwatch'
];

function estPopulaire(nom) {
  const n = (nom || '').toLowerCase();
  return MOTS_CLES_POPULAIRES.some(k => n.includes(k));
}

let importEnCours = false;
let fixEnCours = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Kinguin fournit "regionalLimitations" (ex: "Region free", "Europe", "United States"...)
// et "countryLimitation" qui est la LISTE DES PAYS OÙ LE PRODUIT FONCTIONNE (pas une liste d'exclusion).
function estCompatibleEurope(product) {
  const rl = (product.regionalLimitations || '').toLowerCase().trim();
  if (rl.includes('region free') || rl.includes('worldwide')) return true;
  if (rl.includes('europe')) return true;

  const liste = product.countryLimitation || [];
  if (rl === '' && liste.length === 0) return true; // aucune info de restriction → considéré compatible
  return liste.includes('FR');
}

// Récupère la meilleure image disponible en testant tous les champs possibles de l'API Kinguin
function getImageUrl(product) {
  if (product.coverImageOriginal) return product.coverImageOriginal;
  if (product.coverImage) return product.coverImage;
  if (product.images?.cover?.url) return product.images.cover.url;
  if (Array.isArray(product.screenshots) && product.screenshots[0]) return product.screenshots[0];
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

// Joint un tableau (développeurs, éditeurs, genres) en texte lisible, ou renvoie tel quel si déjà une chaîne
function joinField(val) {
  if (Array.isArray(val)) return val.filter(Boolean).join(', ');
  return val || '';
}

// Extrait le montant nominal d'une carte cadeau depuis son nom Kinguin (ex: "PSN Card 20 EUR" -> 20)
function extraireMontantFacial(nom) {
  const m = (nom || '').match(/(\d{1,4})\s*(?:€|eur|euros?)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Nom propre et uniforme pour les cartes cadeaux (ex: "Carte PSN 20€"). Pour tout le reste, on garde le nom Kinguin.
function nomAffiche(product, plateforme, categorie, sousCategorie) {
  if (sousCategorie === 'Cartes cadeaux') {
    const montant = extraireMontantFacial(product.name);
    if (montant) {
      const label = {
        psn: 'Carte PSN', xbox: 'Carte Xbox', nintendo: 'Carte eShop Nintendo'
      }[plateforme] || `Carte ${categorie || 'cadeau'}`;
      return `${label} ${montant}€`;
    }
  }
  return product.name || 'Produit Kinguin';
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

function catKey(cat) { return cat.plateforme + '|' + cat.sousCategorie; }

// ─────────────────────────────────────────────
// IMPORT PAR CATÉGORIES (100 max chacune, connus en priorité)
// ─────────────────────────────────────────────
async function runImportParCategories() {
  if (importEnCours) { console.log('⚠️ Import déjà en cours.'); return; }
  importEnCours = true;
  console.log(`🗂️ Import par catégories | marge: ${MARGIN * 100}% | taux: 1€ = ${EUR_TO_XOF} FCFA | plafond: ${CAP_PAR_CATEGORIE}/catégorie`);
  try {
    const existingIds = await getExistingKinguinIds();
    console.log(`   ${existingIds.size} produit(s) déjà en base (ignorés).`);

    const buckets = {};
    for (const cat of CATEGORIES) buckets[catKey(cat)] = { populaires: [], autres: [] };

    let page = 1, totalCount = null;
    while (true) {
      let data;
      try { data = await fetchKinguinPage(page); }
      catch (e) { console.error(`⚠️ Erreur page ${page}: ${e.message} — retry dans 5s`); await sleep(5000); continue; }
      if (totalCount === null) { totalCount = data.item_count; console.log(`📦 ${totalCount} produits au total chez Kinguin — analyse en cours...`); }
      const results = data.results || [];
      if (!results.length) break;

      for (const product of results) {
        if (!estCompatibleEurope(product)) continue;
        if (!product.productId || existingIds.has(product.productId)) continue;
        const eurPrice = product.price || 0;
        if (eurPrice < PRIX_MIN_EUR) continue;

        const imageUrl = getImageUrl(product);
        if (!imageUrl) continue; // pas de photo trouvée → produit ignoré (jamais de produit sans image sur le site)

        const { plateforme, categorie } = mapPlatform(product.platform, product.name);
        const sousCategorie = guessSousCategorie(product);

        // Pour les cartes cadeaux : le prix doit rester cohérent avec la valeur faciale (ex: une carte
        // "20€" ne doit pas ressortir à 700 FCFA). Pour les jeux, les prix très variables sont normaux.
        if (sousCategorie === 'Cartes cadeaux') {
          const montant = extraireMontantFacial(product.name);
          if (montant) {
            const prixCalcule = priceToFCFA(eurPrice);
            const valeurFacialeFCFA = montant * EUR_TO_XOF;
            const ratio = prixCalcule / valeurFacialeFCFA;
            if (ratio < 0.5 || ratio > 1.2) continue; // prix aberrant vs la valeur faciale → on ignore
          }
        }

        const key = plateforme + '|' + sousCategorie;
        const bucket = buckets[key];
        if (!bucket) continue; // catégorie non suivie, on ignore

        const item = { product, plateforme, categorie, sousCategorie, imageUrl };
        if (estPopulaire(product.name)) {
          bucket.populaires.push(item);
        } else if (bucket.autres.length < CAP_PAR_CATEGORIE * 3) {
          // on garde une petite marge (x3) pour avoir de quoi compléter, sans exploser la mémoire
          bucket.autres.push(item);
        }
      }

      if (page % 20 === 0 || page * PAGE_LIMIT >= totalCount) {
        console.log(`   Page ${page}/${Math.ceil(totalCount / PAGE_LIMIT)} analysée...`);
      }
      if (page * PAGE_LIMIT >= totalCount) break;
      page++;
      await sleep(300);
    }

    console.log('🧮 Analyse terminée — sélection et insertion...');
    let totalImportes = 0;

    for (const cat of CATEGORIES) {
      const key = catKey(cat);
      const bucket = buckets[key];
      const trouves = bucket.populaires.length + bucket.autres.length;
      const selection = [...bucket.populaires, ...bucket.autres].slice(0, CAP_PAR_CATEGORIE);

      const rows = selection.map(({ product, plateforme, categorie, sousCategorie, imageUrl }) => ({
        nom: nomAffiche(product, plateforme, categorie, sousCategorie),
        plateforme,
        categorie,
        sous_categorie: sousCategorie,
        description: genererDescriptionFR(plateforme, categorie, sousCategorie),
        prix: priceToFCFA(product.price),
        image_url: imageUrl,
        video_url: '',
        developpeur: joinField(product.developers),
        editeur: joinField(product.publishers),
        genres: joinField(product.genres),
        date_sortie: product.releaseDate || '',
        note_metacritic: product.metacriticScore || null,
        est_slider: false,
        slider_ordre: 1,
        est_populaire: estPopulaire(product.name),
        est_actif: true,
        kinguin_product_id: product.productId,
        stock: 999
      }));

      if (rows.length) {
        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await supabase.from('products').insert(rows.slice(i, i + 200));
          if (error) console.error(`   ⚠️ Erreur insertion "${cat.label}":`, error.message);
        }
      }
      totalImportes += rows.length;
      console.log(`   ✅ ${cat.label} : ${rows.length} importés (sur ${trouves} trouvés, dont ${bucket.populaires.length} reconnus comme populaires)`);
    }

    console.log(`\n🎉 Import terminé ! ${totalImportes} produits importés au total (max ${CAP_PAR_CATEGORIE} × ${CATEGORIES.length} catégories).`);
    await marquerSliderPourHomepage();
  } catch (e) {
    console.error('❌ Erreur fatale import par catégories:', e);
  } finally {
    importEnCours = false;
  }
}

// ─────────────────────────────────────────────
// CORRECTION : description FR + vraies photos + prix corrigés (produits déjà importés)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SLIDER DE LA PAGE D'ACCUEIL : met en avant 2 produits populaires par plateforme
// ─────────────────────────────────────────────
async function marquerSliderPourHomepage() {
  const PLATEFORMES = ['psn', 'xbox', 'pc', 'nintendo'];
  let ordre = 1;
  for (const plateforme of PLATEFORMES) {
    const { data, error } = await supabase.from('products')
      .select('id')
      .eq('plateforme', plateforme)
      .eq('est_populaire', true)
      .eq('est_actif', true)
      .order('id', { ascending: true })
      .limit(2);
    if (error) { console.error(`   ⚠️ Erreur sélection slider (${plateforme}):`, error.message); continue; }
    for (const row of data || []) {
      await supabase.from('products').update({ est_slider: true, slider_ordre: ordre }).eq('id', row.id);
      ordre++;
    }
  }
  console.log(`🎞️ ${ordre - 1} produit(s) mis en avant dans le slider de la page d'accueil.`);
}

async function runFixKinguinProducts() {
  if (fixEnCours) { console.log('⚠️ Correction déjà en cours.'); return; }
  fixEnCours = true;
  console.log('🛠️ Correction des produits Kinguin (images + prix + descriptions FR)...');
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
        const fields = {
          description: genererDescriptionFR(plateforme, categorie, sousCategorie),
          developpeur: joinField(product.developers),
          editeur: joinField(product.publishers),
          genres: joinField(product.genres),
          date_sortie: product.releaseDate || '',
          note_metacritic: product.metacriticScore || null,
        };
        const nouvelleImage = getImageUrl(product);
        if (nouvelleImage && nouvelleImage !== row.image_url) fields.image_url = nouvelleImage;
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

  if (url.pathname === '/import-categories') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (importEnCours) { res.writeHead(200); res.end('Import déjà en cours — voir logs Render.'); return; }
    runImportParCategories();
    res.writeHead(200);
    res.end(`✅ Import par catégories démarré (max ${CAP_PAR_CATEGORIE}/catégorie, ${CATEGORIES.length} catégories) ! Va dans Render → Logs pour suivre la progression.`);
    return;
  }

  if (url.pathname === '/update-slider') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    marquerSliderPourHomepage();
    res.writeHead(200);
    res.end('✅ Mise à jour du slider démarrée ! Va dans Render → Logs.');
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
