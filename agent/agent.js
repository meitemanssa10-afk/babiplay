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
  const res = await fetch(`${KINGUIN_BASE}/v2/products/${productId}`, {
    headers: { 'X-Api-Key': KINGUIN_KEY }
  });
  if (!res.ok) {
    const err = new Error(`Produit Kinguin introuvable pour l'ID ${productId} (status ${res.status})`);
    err.kinguinStatus = res.status;
    err.estDefinitif = (res.status === 404);
    throw err;
  }
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
        const keyRes = await fetch(`${KINGUIN_BASE}/v2/order/${orderId}/keys?page=1&limit=10`, {
          headers: { 'X-Api-Key': KINGUIN_KEY }
        });
        const keyData = await keyRes.json();
        if (Array.isArray(keyData) && keyData.length && keyData[0].serial) return keyData[0].serial;
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
  const commandeKinguin = await passerCommandeKinguin(produit.productId || produit.kinguinId, produit.price);
  console.log(`✅ Commande Kinguin créée : ${commandeKinguin.orderId}`);
  const code = await recupererCleCommande(commandeKinguin.orderId);
  console.log('✅ Clé récupérée !');
  return { code, kinguinOrderId: commandeKinguin.orderId };
}

function instructionsActivation(produitNom) {
  const n = (produitNom || '').toLowerCase();
  if (n.includes('psn') || n.includes('playstation') || n.includes('ps4') || n.includes('ps5')) {
    return {
      titre: '🎮 Comment activer sur PlayStation',
      etapes: [
        'Allumez votre PS4/PS5 et connectez-vous à votre compte PSN.',
        'Allez dans le PlayStation Store, puis ouvrez le menu (icône profil en haut à droite).',
        'Sélectionnez "Utiliser un code".',
        'Entrez le code reçu et validez — le contenu s\'ajoute directement à votre compte.'
      ]
    };
  }
  if (n.includes('xbox') || n.includes('game pass')) {
    return {
      titre: '🕹️ Comment activer sur Xbox',
      etapes: [
        'Allumez votre Xbox (ou ouvrez l\'appli Xbox sur PC/mobile) et connectez-vous à votre compte.',
        'Allez dans le Microsoft Store.',
        'Sélectionnez "Utiliser un code" (ou "Redeem" en anglais).',
        'Entrez le code reçu et validez.'
      ]
    };
  }
  if (n.includes('steam')) {
    return {
      titre: '💻 Comment activer sur Steam',
      etapes: [
        'Ouvrez l\'application Steam et connectez-vous.',
        'Cliquez sur "Jeux" (en haut) puis "Activer un produit sur Steam...".',
        'Suivez les instructions et entrez le code reçu.',
        'Le jeu/produit apparaît directement dans votre bibliothèque Steam.'
      ]
    };
  }
  if (n.includes('nintendo') || n.includes('eshop') || n.includes('switch')) {
    return {
      titre: '🎮 Comment activer sur Nintendo',
      etapes: [
        'Sur votre console, ouvrez le Nintendo eShop.',
        'Sélectionnez votre profil, puis "Ajouter du crédit / Saisir un code".',
        'Entrez le code reçu et validez.'
      ]
    };
  }
  if (n.includes('netflix') || n.includes('disney') || n.includes('crunchyroll') || n.includes('spotify') || n.includes('subscription') || n.includes('abonnement')) {
    return {
      titre: '📺 Comment activer votre abonnement',
      etapes: [
        'Rendez-vous sur le site officiel du service (ex : netflix.com, disneyplus.com...).',
        'Connectez-vous à votre compte, ou créez-en un si besoin.',
        'Allez dans les paramètres du compte, section "Carte cadeau / Redeem a gift card".',
        'Entrez le code reçu pour créditer votre abonnement.'
      ]
    };
  }
  if (n.includes('google play')) {
    return {
      titre: '📱 Comment activer sur Google Play',
      etapes: [
        'Ouvrez l\'application Google Play Store sur votre téléphone.',
        'Appuyez sur votre photo de profil, puis "Utiliser un code cadeau".',
        'Entrez le code reçu et validez.'
      ]
    };
  }
  return {
    titre: '🔑 Comment utiliser votre code',
    etapes: [
      'Connectez-vous à la plateforme correspondant à votre produit.',
      'Cherchez l\'option "Utiliser un code" / "Redeem code" dans les paramètres de votre compte.',
      'Entrez le code reçu et validez.'
    ]
  };
}

async function envoyerCodeParEmail(clientEmail, clientNom, produitNom, code) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const instructions = instructionsActivation(produitNom);
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
        <div style="background:#f7f7f9;border:1px solid #e5e5ea;border-radius:10px;padding:18px;margin-top:20px;">
          <p style="margin:0 0 10px;font-weight:bold;color:#1a1a2e;">${instructions.titre}</p>
          <ol style="margin:0;padding-left:18px;color:#333;">
            ${instructions.etapes.map(e => `<li style="margin-bottom:6px;">${e}</li>`).join('')}
          </ol>
        </div>
        <p>Merci pour votre achat sur BabiPlay ! 🚀</p>
      </div>
    `
  });
  console.log(`📧 Code envoyé à ${clientEmail}`);
}

const WHATSAPP_SUPPORT = '2250797659178';

async function envoyerEmailEchec(clientEmail, clientNom, produitNom) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'BabiPlay <noreply@babiplay.store>',
    to: clientEmail,
    subject: `⚠️ Un souci avec votre commande ${produitNom} - BabiPlay`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h1 style="color:#f5a623;">🎮 BabiPlay</h1>
        <h2>Bonjour ${clientNom || 'Client'} !</h2>
        <p>Votre paiement pour <strong>${produitNom}</strong> a bien été reçu, mais nous rencontrons un souci technique passager pour vous livrer votre code.</p>
        <p>Notre équipe a été notifiée. Pour un traitement immédiat, contactez-nous directement sur WhatsApp :</p>
        <p style="text-align:center">
          <a href="https://wa.me/${WHATSAPP_SUPPORT}" style="background:#25D366;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block">💬 Contacter le support WhatsApp</a>
        </p>
        <p>Toutes nos excuses pour la gêne occasionnée.</p>
      </div>
    `
  });
  console.log(`📧 Email d'échec envoyé à ${clientEmail}`);
}

async function traiterCommande(commande) {
  console.log(`🔄 Traitement commande ${commande.id}...`);
  try {
    await supabase.from('commandes').update({ statut: 'en_cours' }).eq('id', commande.id);
    if (commande.order_id) await supabase.from('orders').update({ statut: 'en_cours' }).eq('id', commande.order_id);
    let kinguinProductId = null;
    const produitId = commande.product_id || commande.produit_id;
    if (produitId) {
      const { data: produitBabiPlay } = await supabase
        .from('products').select('kinguin_product_id').eq('id', produitId).single();
      kinguinProductId = produitBabiPlay?.kinguin_product_id || null;
    }
    const { code, kinguinOrderId } = await acheterViaKinguin(commande.produit_nom || commande.nom_produit, kinguinProductId);
    if (!code) throw new Error(`Code Kinguin vide/invalide pour la commande Kinguin ${kinguinOrderId}`);
    if (commande.client_email) {
      await envoyerCodeParEmail(commande.client_email, commande.client_nom || 'Client', commande.produit_nom || commande.nom_produit, code);
    }
    await supabase.from('commandes').update({
      statut: 'livree', livraison_auto: true,
      livre_le: new Date().toISOString(), codes_livres: [code], code_jeu: code, kinguin_order_id: kinguinOrderId
    }).eq('id', commande.id);
    if (commande.order_id) {
      await supabase.from('orders').update({ statut: 'code_envoye', code_jeu: code, kinguin_order_id: kinguinOrderId }).eq('id', commande.order_id);
      const { data: orderRow } = await supabase.from('orders').select('user_id, points_gagnes').eq('id', commande.order_id).single();
      if (orderRow?.user_id) {
        const { data: profil } = await supabase.from('profiles').select('points, total_commandes').eq('id', orderRow.user_id).single();
        if (profil) {
          const nouveauxPoints = (profil.points || 0) + (orderRow.points_gagnes || 10);
          const nouveauTotal = (profil.total_commandes || 0) + 1;
          await supabase.from('profiles').update({ points: nouveauxPoints, total_commandes: nouveauTotal }).eq('id', orderRow.user_id);
          console.log(`⭐ Points crédités : +${orderRow.points_gagnes || 10} (total ${nouveauxPoints}) pour ${orderRow.user_id}`);
        }
      }
    }
    console.log(`✅ Commande ${commande.id} livrée avec succès !`);
  } catch (err) {
    console.error(`❌ Erreur commande ${commande.id}:`, err.message);
    await supabase.from('commandes').update({ statut: 'erreur', erreur_message: err.message }).eq('id', commande.id);
    if (commande.order_id) await supabase.from('orders').update({ statut: 'erreur' }).eq('id', commande.order_id);
    if (commande.client_email) {
      try {
        await envoyerEmailEchec(commande.client_email, commande.client_nom, commande.produit_nom || commande.nom_produit);
      } catch (emailErr) {
        console.error(`⚠️ Échec envoi email d'alerte pour la commande ${commande.id}:`, emailErr.message);
      }
    }
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

setInterval(async () => {
  try {
    await fetch('https://babiplay-agent.onrender.com');
    console.log('🏓 Auto-ping OK — service maintenu éveillé');
  } catch (e) {
    console.log('⚠️ Auto-ping échoué:', e.message);
  }
}, 4 * 60 * 1000);

const IMPORT_SECRET = process.env.IMPORT_SECRET || crypto.randomBytes(8).toString('hex');
console.log(`🔐 Code secret import/fix : ${IMPORT_SECRET}`);
console.log(`👉 Import par catégories : https://babiplay-agent.onrender.com/import-categories?secret=${IMPORT_SECRET}  (ajoute &confirm=oui à la fin pour vraiment lancer)`);
console.log(`👉 Fix produits existants : https://babiplay-agent.onrender.com/fix-kinguin-products?secret=${IMPORT_SECRET}  (ajoute &confirm=oui à la fin pour vraiment lancer)`);
console.log(`👉 Réactiver faux positifs : https://babiplay-agent.onrender.com/reactivate-false-positives?secret=${IMPORT_SECRET}  (ajoute &confirm=oui à la fin pour vraiment lancer)`);

const KINGUIN_PRODUCTS_BASE = 'https://gateway.kinguin.net/esa/api/v1';
const PAGE_LIMIT = 100;
const MARGIN = parseFloat(process.env.MARGIN || '0.12');
const MARGIN_POPULAIRE = parseFloat(process.env.MARGIN_POPULAIRE || '0.20');
const EUR_TO_XOF = 655.957;
const PRIX_MIN_EUR = 0.5;
const CAP_PAR_CATEGORIE = parseInt(process.env.CAP_PAR_CATEGORIE || '100', 10);

const CATEGORIES = [
  { plateforme: 'psn',      sousCategorie: 'Cartes cadeaux', label: 'PSN — Cartes cadeaux' },
  { plateforme: 'psn',      sousCategorie: 'Abonnements',    label: 'PSN — Abonnements (PS Plus)' },
  { plateforme: 'psn',      sousCategorie: 'Points',         label: 'PSN — Points (monnaies de jeu)' },
  { plateforme: 'psn',      sousCategorie: '',                label: 'PSN — Jeux' },
  { plateforme: 'xbox',     sousCategorie: 'Cartes cadeaux', label: 'Xbox — Cartes cadeaux' },
  { plateforme: 'xbox',     sousCategorie: 'Game Pass',      label: 'Xbox — Game Pass' },
  { plateforme: 'xbox',     sousCategorie: 'Points',         label: 'Xbox — Points (monnaies de jeu)' },
  { plateforme: 'xbox',     sousCategorie: '',                label: 'Xbox — Jeux' },
  { plateforme: 'pc',       sousCategorie: 'Cartes cadeaux', label: 'PC — Cartes cadeaux (Steam Wallet...)' },
  { plateforme: 'pc',       sousCategorie: 'Points',         label: 'PC — Points (monnaies de jeu)' },
  { plateforme: 'pc',       sousCategorie: '',                label: 'PC — Jeux (Steam/Epic/...)' },
  { plateforme: 'nintendo', sousCategorie: 'Cartes cadeaux', label: 'Nintendo — Cartes eShop' },
  { plateforme: 'nintendo', sousCategorie: 'Points',         label: 'Nintendo — Points (monnaies de jeu)' },
  { plateforme: 'nintendo', sousCategorie: '',                label: 'Nintendo — Jeux' },
  { plateforme: 'streaming', sousCategorie: 'Cartes cadeaux', label: 'Streaming — Cartes cadeaux (Netflix, Disney+...)' },
  { plateforme: 'streaming', sousCategorie: 'Abonnements',    label: 'Streaming — Abonnements (Spotify, Crunchyroll...)' },
];

const MOTS_CLES_POPULAIRES = [
  'gta', 'grand theft auto', 'fifa', 'fc 24', 'fc 25', 'fc 26', 'fc 27', 'ea sports fc',
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
let reactivationEnCours = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function estCompatibleEurope(product) {
  const rl = (product.regionalLimitations || '').toLowerCase().trim();
  if (rl.includes('region free') || rl.includes('worldwide')) return true;
  if (rl.includes('europe')) return true;

  const liste = product.countryLimitation || [];
  if (rl === '' && liste.length === 0) return true;
  return liste.includes('FR');
}

function contientDeviseNonEuro(nom) {
  const n = (nom || '').toLowerCase();
  const aAutreDevise = /\busd\b|\$\s*\d|\d\s*\$|\bgbp\b|£|\btry\b|\bpln\b/.test(n);
  const aEuro = n.includes('eur') || n.includes('€');
  return aAutreDevise && !aEuro;
}

const CODES_PAYS_NON_FRANCE = [
  'US','UK','GB','CA','AU','NZ','JP','KR','CN','HK','TW','IN','BR','MX','ZA','TR','PL','CZ','HU','RO',
  'SK','SI','HR','BG','GR','PT','ES','IT','DE','NL','BE','AT','CH','SE','NO','DK','FI','IE','IS','AE',
  'SA','QA','KW','BH','OM','EG','MA','TN','DZ','RU','UA','IL','TH','SG','MY','PH','ID','VN','PK','AR',
  'CL','CO','PE','QAT','LU','CY','EE','LV','LT','MT'
];
const CODES_DEVISE_NON_EURO = ['usd','gbp','aed','mad','try','pln','czk','huf','ron','sek','nok','dkk','zar','inr','jpy','cny','hkd','cad','aud','nzd','brl','mxn','sar','qar','kwd','bhd','omr','egp','dirham','chf'];

function estCarteFrance(nomOriginal) {
  const n = (nomOriginal || '').trim();
  const nLower = n.toLowerCase();
  if (/\bFR\b/.test(n)) return true;
  for (const code of CODES_PAYS_NON_FRANCE) {
    if (new RegExp('\\b' + code + '\\b').test(n)) return false;
  }
  const aDeviseNonEuro = CODES_DEVISE_NON_EURO.some(c => nLower.includes(c)) || /\$|£|₺|₹|¥|₩|₪|kr\b/.test(n);
  const aEuro = nLower.includes('eur') || n.includes('€');
  if (aDeviseNonEuro && !aEuro) return false;
  return true;
}

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

  if (n.includes('netflix')) return { plateforme: 'streaming', categorie: 'Netflix' };
  if (n.includes('spotify')) return { plateforme: 'streaming', categorie: 'Spotify' };
  if (n.includes('disney')) return { plateforme: 'streaming', categorie: 'Disney+' };
  if (n.includes('crunchyroll')) return { plateforme: 'streaming', categorie: 'Crunchyroll' };

  if (p.includes('playstation') || p.includes('psn')) {
    let categorie = '';
    if (n.includes('ps5')) categorie = 'PS5';
    else if (n.includes('ps4')) categorie = 'PS4';
    return { plateforme: 'psn', categorie };
  }
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

function estCompteExclu(product) {
  const n = (product.name || '').toLowerCase();
  return n.includes('account') || n.includes('compte partagé') || n.includes('login details');
}

function guessSousCategorie(product, plateforme) {
  const tags = product.tags || [];
  const name = (product.name || '').toLowerCase().trim();
  if (name.includes('game pass')) return 'Game Pass';
  const motsAbonnement = ['subscription', 'membership', 'switch online', 'ea play', 'ubisoft+', 'xbox live gold'];
  if (motsAbonnement.some(k => name.includes(k)) || (name.includes('plus') && (name.includes('xbox') || name.includes('playstation') || name.includes('psn')))) return 'Abonnements';

  if (name.includes('gift card') || name.includes('wallet')) return 'Cartes cadeaux';

  if (name.includes('points') || name.includes('v-bucks') || name.includes('vbucks')) return 'Points';

  const marquesParPlateforme = {
    psn: ['playstation', 'psn'],
    xbox: ['xbox'],
    nintendo: ['nintendo'],
    pc: ['steam', 'epic games', 'battle.net', 'ubisoft connect', 'ea app', 'origin', 'gog', 'rockstar games', 'microsoft store'],
  };
  const marques = marquesParPlateforme[plateforme] || [];
  const commenceParMarque = marques.some(m => name.startsWith(m));
  if (tags.includes('prepaid') && commenceParMarque) return 'Cartes cadeaux';

  return '';
}

function genererDescriptionFR(plateforme, categorie, sousCategorie) {
  const storeLabel = { psn: 'PlayStation Store', xbox: 'Xbox', pc: categorie || 'PC', nintendo: 'Nintendo eShop', streaming: categorie || 'streaming' }[plateforme] || 'la plateforme';
  if (sousCategorie === 'Cartes cadeaux')
    return `Carte cadeau numérique ${storeLabel} — le code est envoyé par email immédiatement après le paiement. À utiliser sur un compte enregistré dans la région correspondante.`;
  if (sousCategorie === 'Game Pass')
    return `Abonnement Xbox Game Pass — accès à la bibliothèque de jeux Xbox et PC. Code d'activation envoyé par email après achat.`;
  if (sousCategorie === 'Abonnements')
    return `Abonnement premium ${storeLabel} — profitez du jeu en ligne et d'avantages exclusifs. Code envoyé par email après achat.`;
  if (sousCategorie === 'Points')
    return `Monnaie virtuelle à usage interne au jeu (utilisable uniquement dans ce jeu, pas sur l'ensemble de la boutique ${storeLabel}). Code envoyé par email après achat.`;
  return `Clé d'activation officielle pour ${storeLabel}. Téléchargement et activation immédiats après réception du code par email.`;
}

function priceToFCFA(eurPrice, nom) {
  const marge = estPopulaire(nom) ? MARGIN_POPULAIRE : MARGIN;
  return Math.round(eurPrice * (1 + marge) * EUR_TO_XOF);
}

function joinField(val) {
  if (Array.isArray(val)) return val.filter(Boolean).join(', ');
  return val || '';
}

function extraireMontantFacial(nom) {
  const m = (nom || '').match(/(\d{1,4})\s*(?:€|eur|euros?)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

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

async function runImportParCategories() {
  if (importEnCours) { console.log('⚠️ Import déjà en cours.'); return; }
  importEnCours = true;
  console.log(`🗂️ Import par catégories | marge standard: ${MARGIN * 100}% | marge titres populaires: ${MARGIN_POPULAIRE * 100}% | taux: 1€ = ${EUR_TO_XOF} FCFA | plafond: ${CAP_PAR_CATEGORIE}/catégorie`);
  try {
    const existingIds = await getExistingKinguinIds();
    console.log(`   ${existingIds.size} produit(s) déjà en base (ignorés).`);

    const buckets = {};
    for (const cat of CATEGORIES) buckets[catKey(cat)] = { populaires: new Map(), autres: new Map() };

    let page = 1, totalCount = null;
    while (true) {
      let data;
      let tentative = 0;
      let dernierErreur = null;
      while (tentative < 5) {
        try { data = await fetchKinguinPage(page); dernierErreur = null; break; }
        catch (e) {
          dernierErreur = e;
          tentative++;
          console.error(`⚠️ Erreur page ${page}: ${e.message} — tentative ${tentative}/5, retry dans 5s`);
          await sleep(5000);
        }
      }
      if (dernierErreur) {
        console.error(`🛑 Page ${page} inaccessible après 5 tentatives (${dernierErreur.message}) — arrêt de l'import à cette page.`);
        break;
      }
      if (totalCount === null) { totalCount = data.item_count; console.log(`📦 ${totalCount} produits au total chez Kinguin — analyse en cours...`); }
      const results = data.results || [];
      if (!results.length) break;

      for (const product of results) {
        if (estCompteExclu(product)) continue;
        if (contientDeviseNonEuro(product.name)) continue;
        if (!estCompatibleEurope(product)) continue;
        if (!product.productId || existingIds.has(product.productId)) continue;
        const eurPrice = product.price || 0;
        if (eurPrice < PRIX_MIN_EUR) continue;

        const imageUrl = getImageUrl(product);
        if (!imageUrl) continue;

        const { plateforme, categorie } = mapPlatform(product.platform, product.name);
        const sousCategorie = guessSousCategorie(product, plateforme);

        if ((sousCategorie === 'Cartes cadeaux' || sousCategorie === 'Abonnements' || sousCategorie === 'Points') && !estCarteFrance(product.name)) continue;

        if (sousCategorie === 'Cartes cadeaux') {
          const montant = extraireMontantFacial(product.name);
          if (montant) {
            const prixCalcule = priceToFCFA(eurPrice, product.name);
          }
        }

        const key = plateforme + '|' + sousCategorie;
        const bucket = buckets[key];
        if (!bucket) continue;

        const item = { product, plateforme, categorie, sousCategorie, imageUrl };
        const nomCle = (product.name || '').trim().toLowerCase();
        if (estPopulaire(product.name)) {
          const existant = bucket.populaires.get(nomCle);
          if (!existant || eurPrice < (existant.product.price || Infinity)) bucket.populaires.set(nomCle, item);
        } else if (bucket.autres.size < CAP_PAR_CATEGORIE * 3 || bucket.autres.has(nomCle)) {
          const existant = bucket.autres.get(nomCle);
          if (!existant || eurPrice < (existant.product.price || Infinity)) bucket.autres.set(nomCle, item);
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
      const trouves = bucket.populaires.size + bucket.autres.size;
      const selection = [...bucket.populaires.values(), ...bucket.autres.values()].slice(0, CAP_PAR_CATEGORIE);

      const rows = selection.map(({ product, plateforme, categorie, sousCategorie, imageUrl }) => ({
        nom: nomAffiche(product, plateforme, categorie, sousCategorie),
        plateforme,
        categorie,
        sous_categorie: sousCategorie,
        description: genererDescriptionFR(plateforme, categorie, sousCategorie),
        prix: priceToFCFA(product.price, product.name),
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
        est_precommande: !!product.isPreorder,
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
      console.log(`   ✅ ${cat.label} : ${rows.length} importés (sur ${trouves} trouvés, dont ${bucket.populaires.size} reconnus comme populaires)`);
    }

    console.log(`\n🎉 Import terminé ! ${totalImportes} produits importés au total (max ${CAP_PAR_CATEGORIE} × ${CATEGORIES.length} catégories).`);
    await marquerSliderPourHomepage();
  } catch (e) {
    console.error('❌ Erreur fatale import par catégories:', e);
  } finally {
    importEnCours = false;
  }
}

async function marquerSliderPourHomepage() {
  const PLATEFORMES = ['psn', 'xbox', 'pc', 'nintendo'];
  let ordre = 1;
  for (const plateforme of PLATEFORMES) {
    const { data: precommandes, error: err1 } = await supabase.from('products')
      .select('id')
      .eq('plateforme', plateforme)
      .eq('est_precommande', true)
      .eq('est_actif', true)
      .order('id', { ascending: true })
      .limit(2);
    if (err1) console.error(`   ⚠️ Erreur sélection précommandes (${plateforme}):`, err1.message);
    let choisis = precommandes || [];

    if (choisis.length < 2) {
      const idsExclus = choisis.map(c => c.id);
      let requete = supabase.from('products')
        .select('id')
        .eq('plateforme', plateforme)
        .eq('est_populaire', true)
        .eq('est_actif', true)
        .order('id', { ascending: true })
        .limit(2 - choisis.length);
      if (idsExclus.length) requete = requete.not('id', 'in', `(${idsExclus.join(',')})`);
      const { data: populaires, error: err2 } = await requete;
      if (err2) console.error(`   ⚠️ Erreur sélection populaires (${plateforme}):`, err2.message);
      choisis = choisis.concat(populaires || []);
    }

    for (const row of choisis) {
      await supabase.from('products').update({ est_slider: true, slider_ordre: ordre }).eq('id', row.id);
      ordre++;
    }
  }
  console.log(`🎞️ ${ordre - 1} produit(s) mis en avant dans le slider (précommandes en priorité).`);
}

async function runFixKinguinProducts() {
  if (fixEnCours) { console.log('⚠️ Correction déjà en cours.'); return; }
  fixEnCours = true;
  console.log('🛠️ Correction des produits Kinguin (images + prix + descriptions FR)...');
  try {
    const { data: comptesResiduels, error: errResiduels } = await supabase.from('products')
      .update({ est_actif: false }).ilike('nom', '%account%').eq('est_actif', true).select('id');
    if (errResiduels) console.error('⚠️ Erreur nettoyage comptes résiduels:', errResiduels.message);
    else if (comptesResiduels?.length) console.log(`🧹 ${comptesResiduels.length} produit(s) "compte partagé" résiduel(s) désactivé(s).`);

    const { data: cartesNonFrance, error: errCartesNonFrance } = await supabase.from('products')
      .select('id, nom').eq('est_actif', true).in('sous_categorie', ['Cartes cadeaux', 'Abonnements', 'Points']);
    if (errCartesNonFrance) console.error('⚠️ Erreur lecture cartes cadeaux/abonnements:', errCartesNonFrance.message);
    else {
      const idsNonFrance = (cartesNonFrance || []).filter(r => !estCarteFrance(r.nom)).map(r => r.id);
      if (idsNonFrance.length) {
        for (let i = 0; i < idsNonFrance.length; i += 200) {
          await supabase.from('products').update({ est_actif: false }).in('id', idsNonFrance.slice(i, i + 200));
        }
        console.log(`🧹 ${idsNonFrance.length} carte(s) cadeau/abonnement/points non-française(s) désactivée(s).`);
      }
    }

    const { data: fauxesCartes, error: errFaussesCartes } = await supabase.from('products')
      .select('id, nom, plateforme').eq('est_actif', true).eq('sous_categorie', 'Cartes cadeaux');
    if (errFaussesCartes) console.error('⚠️ Erreur lecture cartes cadeaux:', errFaussesCartes.message);
    else {
      const marquesParPlateformeCheck = {
        psn: /^(playstation|psn)/i, xbox: /^xbox/i, nintendo: /^nintendo/i,
        pc: /^(steam|epic games|battle\.net|ubisoft connect|ea app|origin|gog|rockstar games|microsoft store)/i,
      };
      const idsVersPoints = [], idsVersJeux = [];
      for (const r of (fauxesCartes || [])) {
        const n = (r.nom || '').toLowerCase();
        if (n.includes('gift card') || n.includes('wallet')) continue;
        const regexMarque = marquesParPlateformeCheck[r.plateforme];
        if (regexMarque && regexMarque.test(r.nom || '')) continue;
        if (n.includes('points') || n.includes('v-bucks') || n.includes('vbucks')) idsVersPoints.push(r.id);
        else idsVersJeux.push(r.id);
      }
      for (let i = 0; i < idsVersPoints.length; i += 200) {
        await supabase.from('products').update({ sous_categorie: 'Points' }).in('id', idsVersPoints.slice(i, i + 200));
      }
      for (let i = 0; i < idsVersJeux.length; i += 200) {
        await supabase.from('products').update({ sous_categorie: '' }).in('id', idsVersJeux.slice(i, i + 200));
      }
      if (idsVersPoints.length) console.log(`🔀 ${idsVersPoints.length} produit(s) reclassé(s) de "Cartes cadeaux" vers "Points".`);
      if (idsVersJeux.length) console.log(`🔀 ${idsVersJeux.length} produit(s) reclassé(s) de "Cartes cadeaux" vers "Jeux".`);
    }

    let data = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data: pageRows, error: pageErr } = await supabase.from('products')
          .select('id, nom, kinguin_product_id, image_url, prix')
          .not('kinguin_product_id', 'is', null)
          .neq('kinguin_product_id', '')
          .order('id', { ascending: true }).range(from, from + pageSize - 1);
        if (pageErr) throw new Error('Lecture produits: ' + pageErr.message);
        if (!pageRows || !pageRows.length) break;
        data = data.concat(pageRows);
        if (pageRows.length < pageSize) break;
        from += pageSize;
      }
    }
    const existingGroups = new Map();
    for (const r of (data || [])) {
      if (!existingGroups.has(r.kinguin_product_id)) existingGroups.set(r.kinguin_product_id, []);
      existingGroups.get(r.kinguin_product_id).push(r);
    }
    const nombreFichesSuivies = (data || []).length;
    console.log(`   ${nombreFichesSuivies} produit(s) à corriger (${existingGroups.size} ID Kinguin distinct(s)).`);
    const petitesCartesASurveiller = [];
    const produitsIntrouvables = [];
    const erreursTemporaires = [];
    const idsValidesConfirmes = [];
    let totalCorriges = 0;
    let compteur = 0;

    for (const [kinguinId, rows] of existingGroups) {
      compteur++;
      let product = null;
      let confirmeCasse = false;
      let tentative = 0;
      const maxTentatives = 5;
      while (tentative < maxTentatives) {
        try { product = await obtenirProduitKinguinParId(kinguinId); break; }
        catch (e) {
          if (e.estDefinitif) { confirmeCasse = true; break; }
          tentative++;
          if (tentative >= maxTentatives) break;
          await sleep(1500 * tentative);
        }
      }
      if (!product) {
        if (confirmeCasse) {
          produitsIntrouvables.push(...rows);
        } else {
          erreursTemporaires.push({ kinguinId, rows });
        }
        continue;
      }
      idsValidesConfirmes.push(kinguinId);
      for (const row of rows) {
        if (estCompteExclu(product) || contientDeviseNonEuro(product.name)) {
          await supabase.from('products').update({ est_actif: false }).eq('id', row.id);
          totalCorriges++;
          continue;
        }
        const { plateforme, categorie } = mapPlatform(product.platform, product.name);
        const sousCategorie = guessSousCategorie(product, plateforme);

        if ((sousCategorie === 'Cartes cadeaux' || sousCategorie === 'Abonnements' || sousCategorie === 'Points') && !estCarteFrance(product.name)) {
          await supabase.from('products').update({ est_actif: false }).eq('id', row.id);
          totalCorriges++;
          continue;
        }

        if (sousCategorie === 'Cartes cadeaux') {
          const montant = extraireMontantFacial(product.name);
          if (montant) {
            const eurPriceCheck = product.price || 0;
            const prixCalcule = priceToFCFA(eurPriceCheck, product.name);
            const valeurFacialeFCFA = montant * EUR_TO_XOF;
            const ratio = prixCalcule / valeurFacialeFCFA;
            if (ratio < 0.75 || ratio > 1.05) {
              await supabase.from('products').update({ est_actif: false }).eq('id', row.id);
              totalCorriges++;
              continue;
            }
            if (montant <= 5) {
              petitesCartesASurveiller.push({ id: row.id, nom: product.name, montant_facial_eur: montant, prix_kinguin_eur: eurPriceCheck, prix_vente_fcfa: prixCalcule });
            }
          }
        }

        const fields = {
          nom: nomAffiche(product, plateforme, categorie, sousCategorie),
          sous_categorie: sousCategorie,
          description: genererDescriptionFR(plateforme, categorie, sousCategorie),
          developpeur: joinField(product.developers),
          editeur: joinField(product.publishers),
          genres: joinField(product.genres),
          date_sortie: product.releaseDate || '',
          note_metacritic: product.metacriticScore || null,
          est_precommande: !!product.isPreorder,
        };
        const nouvelleImage = getImageUrl(product);
        if (nouvelleImage && nouvelleImage !== row.image_url) fields.image_url = nouvelleImage;
        const eurPrice = product.price || 0;
        if (eurPrice >= PRIX_MIN_EUR) {
          const nouveauPrix = priceToFCFA(eurPrice, product.name);
          if (nouveauPrix !== row.prix) fields.prix = nouveauPrix;
        }
        const { error: updateErr } = await supabase.from('products').update(fields).eq('id', row.id);
        if (!updateErr) totalCorriges++;
      }
      if (compteur % 100 === 0) console.log(`${compteur}/${existingGroups.size} ID vérifiés — corrigés: ${totalCorriges}, introuvables: ${produitsIntrouvables.length}, erreurs temporaires (ignorées): ${erreursTemporaires.length}`);
      await sleep(250);
    }

    if (produitsIntrouvables.length) {
      for (let i = 0; i < produitsIntrouvables.length; i += 200) {
        const lot = produitsIntrouvables.slice(i, i + 200).map(p => p.id);
        await supabase.from('products').update({ est_actif: false }).in('id', lot);
      }
      console.log(`🚫 ${produitsIntrouvables.length} produit(s) avec un ID Kinguin introuvable — désactivé(s).`);
    }

    let produitsActifs = [];
    let errDoublons = null;
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase.from('products')
          .select('id, nom, plateforme, prix').eq('est_actif', true)
          .not('kinguin_product_id', 'is', null)
          .neq('kinguin_product_id', '')
          .order('id', { ascending: true }).range(from, from + pageSize - 1);
        if (error) { errDoublons = error; break; }
        if (!data || !data.length) break;
        produitsActifs = produitsActifs.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
    }
    let nombreDoublons = 0;
    if (errDoublons) console.error('⚠️ Erreur lecture doublons:', errDoublons.message);
    else {
      const groupes = new Map();
      for (const p of (produitsActifs || [])) {
        const cle = p.plateforme + '|' + (p.nom || '').trim().toLowerCase();
        if (!groupes.has(cle)) groupes.set(cle, []);
        groupes.get(cle).push(p);
      }
      const idsADesactiver = [];
      for (const [, produits] of groupes) {
        if (produits.length < 2) continue;
        produits.sort((a, b) => a.prix - b.prix);
        for (let i = 1; i < produits.length; i++) idsADesactiver.push(produits[i].id);
      }
      for (let i = 0; i < idsADesactiver.length; i += 200) {
        await supabase.from('products').update({ est_actif: false }).in('id', idsADesactiver.slice(i, i + 200));
      }
      nombreDoublons = idsADesactiver.length;
      if (nombreDoublons) console.log(`🧹 ${nombreDoublons} doublon(s) désactivé(s) (même nom, on garde le moins cher).`);
      else console.log('✅ Aucun doublon détecté.');
    }

    const produitsValidesEchantillon = idsValidesConfirmes.slice(0, 50)
      .flatMap(id => existingGroups.get(id))
      .map(p => ({ id: p.id, nom: p.nom, kinguin_product_id: p.kinguin_product_id }));

    await supabase.from('audit_rapports').insert({
      total_verifies: nombreFichesSuivies,
      introuvables_count: produitsIntrouvables.length,
      desactives_count: totalCorriges,
      corriges_count: totalCorriges,
      doublons_count: nombreDoublons,
      produits_introuvables: produitsIntrouvables.map(p => ({ id: p.id, nom: p.nom, kinguin_product_id: p.kinguin_product_id, prix_actuel_fcfa: p.prix })),
      petites_cartes_a_surveiller: petitesCartesASurveiller,
      produits_valides_echantillon: produitsValidesEchantillon
    });
    console.log(`📋 Rapport d'audit enregistré : ${nombreDoublons} doublon(s), ${produitsIntrouvables.length} introuvable(s) (404 confirmé), ${erreursTemporaires.length} erreur(s) temporaire(s) ignorée(s) (seront re-testés au prochain passage), ${petitesCartesASurveiller.length} petite(s) carte(s) à surveiller.`);

    console.log(`✅ Correction terminée ! ${totalCorriges} produits mis à jour.`);
  } catch (e) {
    console.error('❌ Erreur fatale correction:', e);
  } finally {
    fixEnCours = false;
  }
}

async function runReactivateFalsePositives() {
  if (reactivationEnCours) return;
  reactivationEnCours = true;
  try {
    console.log('🔁 Réactivation des faux positifs — recherche des produits inactifs à re-tester...');
    let inactifs = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('id, kinguin_product_id, nom')
        .eq('est_actif', false)
        .not('kinguin_product_id', 'is', null)
        .neq('kinguin_product_id', '')
        .range(from, from + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      inactifs.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
    console.log(`🔎 ${inactifs.length} produit(s) inactif(s) avec ID Kinguin à re-tester.`);

    const parId = new Map();
    for (const p of inactifs) {
      if (!parId.has(p.kinguin_product_id)) parId.set(p.kinguin_product_id, []);
      parId.get(p.kinguin_product_id).push(p);
    }

    let reactives = 0;
    let confirmesCasses = 0;
    let compteur = 0;
    for (const [kinguinId, rows] of parId) {
      compteur++;
      let product = null;
      let confirmeCasse = false;
      let tentative = 0;
      const maxTentatives = 5;
      while (tentative < maxTentatives) {
        try { product = await obtenirProduitKinguinParId(kinguinId); break; }
        catch (e) {
          if (e.estDefinitif) { confirmeCasse = true; break; }
          tentative++;
          if (tentative >= maxTentatives) break;
          await sleep(1500 * tentative);
        }
      }
      if (product) {
        const ids = rows.map(r => r.id);
        await supabase.from('products').update({ est_actif: true }).in('id', ids);
        reactives += ids.length;
      } else if (confirmeCasse) {
        confirmesCasses += rows.length;
      }
      if (compteur % 50 === 0) console.log(`${compteur}/${parId.size} ID re-testés — réactivés: ${reactives}, confirmés cassés: ${confirmesCasses}`);
      await sleep(400);
    }
    console.log(`✅ Réactivation terminée : ${reactives} produit(s) remis actif(s), ${confirmesCasses} confirmé(s) réellement cassé(s) (laissés inactifs).`);
  } catch (e) {
    console.error('❌ Erreur fatale réactivation:', e);
  } finally {
    reactivationEnCours = false;
  }
}

const http = require('http');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const secret = url.searchParams.get('secret');

  if (url.pathname === '/import-categories') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (url.searchParams.get('confirm') !== 'oui') {
      res.writeHead(200);
      res.end(`⚠️ Ceci va lancer un import réel. Pour confirmer, ouvre : ${url.pathname}?secret=${secret}&confirm=oui`);
      return;
    }
    if (importEnCours) { res.writeHead(200); res.end('Import déjà en cours — voir logs Render.'); return; }
    runImportParCategories();
    res.writeHead(200);
    res.end(`✅ Import par catégories démarré (max ${CAP_PAR_CATEGORIE}/catégorie, ${CATEGORIES.length} catégories) ! Va dans Render → Logs pour suivre la progression.`);
    return;
  }

  if (url.pathname === '/update-slider') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (url.searchParams.get('confirm') !== 'oui') {
      res.writeHead(200);
      res.end(`⚠️ Ceci va lancer une action réelle. Pour confirmer, ouvre : ${url.pathname}?secret=${secret}&confirm=oui`);
      return;
    }
    marquerSliderPourHomepage();
    res.writeHead(200);
    res.end('✅ Mise à jour du slider démarrée ! Va dans Render → Logs.');
    return;
  }

  if (url.pathname === '/fix-kinguin-products') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (url.searchParams.get('confirm') !== 'oui') {
      res.writeHead(200);
      res.end(`⚠️ Ceci va lancer une correction réelle. Pour confirmer, ouvre : ${url.pathname}?secret=${secret}&confirm=oui`);
      return;
    }
    if (fixEnCours) { res.writeHead(200); res.end('Correction déjà en cours — voir logs Render.'); return; }
    runFixKinguinProducts();
    res.writeHead(200);
    res.end('✅ Correction démarrée ! Va dans Render → Logs pour suivre la progression.');
    return;
  }

  if (url.pathname === '/check-product') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    const kinguinId = url.searchParams.get('id');
    if (!kinguinId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Paramètre id manquant.' })); return; }
    obtenirProduitKinguinParId(kinguinId)
      .then(produit => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, nom: produit.name, prix: produit.price }));
      })
      .catch(err => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erreur: err.message }));
      });
    return;
  }

  if (url.pathname === '/reactivate-false-positives') {
    if (secret !== IMPORT_SECRET) { res.writeHead(403); res.end('Code secret invalide.'); return; }
    if (url.searchParams.get('confirm') !== 'oui') {
      res.writeHead(200);
      res.end(`⚠️ Ceci va lancer une réactivation réelle. Pour confirmer, ouvre : ${url.pathname}?secret=${secret}&confirm=oui`);
      return;
    }
    if (reactivationEnCours) { res.writeHead(200); res.end('Réactivation déjà en cours — voir logs Render.'); return; }
    runReactivateFalsePositives();
    res.writeHead(200);
    res.end('✅ Réactivation des faux positifs démarrée ! Va dans Render → Logs pour suivre la progression.');
    return;
  }

  res.writeHead(200);
  res.end('BabiPlay Agent (Kinguin) OK');
}).listen(process.env.PORT || 3000);

runFixKinguinProducts();
setInterval(runFixKinguinProducts, 60 * 60 * 1000);

setTimeout(() => {
  runImportParCategories();
  setInterval(runImportParCategories, 7 * 24 * 60 * 60 * 1000);
}, 5 * 60 * 1000);
