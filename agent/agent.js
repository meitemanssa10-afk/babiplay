const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

console.log('🤖 BabiPlay Agent démarré...');

async function acheterSurInstantGaming(produitNom) {
  console.log(`🛒 Achat en cours : ${produitNom}`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // 1. Connexion
    await page.goto('https://www.instant-gaming.com/fr/login/', { waitUntil: 'networkidle2' });
    await page.type('#email', process.env.INSTANT_GAMING_EMAIL);
    await page.type('#password', process.env.INSTANT_GAMING_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('✅ Connecté !');

    // 2. Recherche
    await page.goto(`https://www.instant-gaming.com/fr/recherche/?query=${encodeURIComponent(produitNom)}`, { waitUntil: 'networkidle2' });
    const premierProduit = await page.$('.item-inner a');
    if (!premierProduit) throw new Error('Produit non trouvé');
    const urlProduit = await page.evaluate(el => el.href, premierProduit);

    // 3. Page produit
    await page.goto(urlProduit, { waitUntil: 'networkidle2' });
    const btnAcheter = await page.$('.buying-btn');
    if (!btnAcheter) throw new Error('Bouton achat non trouvé');
    await btnAcheter.click();
    await new Promise(r => setTimeout(r, 2000));

    // 4. Panier → Paiement
    await page.goto('https://www.instant-gaming.com/fr/panier/', { waitUntil: 'networkidle2' });
    const btnCommander = await page.$('.checkout-btn');
    if (!btnCommander) throw new Error('Bouton commander non trouvé');
    await btnCommander.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 5. PayPal
    const paypalOption = await page.$('[data-payment="paypal"]');
    if (paypalOption) await paypalOption.click();
    await new Promise(r => setTimeout(r, 1000));
    const btnConfirmer = await page.$('.confirm-order');
    if (!btnConfirmer) throw new Error('Bouton confirmer non trouvé');
    await btnConfirmer.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    // 6. Récupérer le code
    await page.goto('https://www.instant-gaming.com/fr/mes-achats/', { waitUntil: 'networkidle2' });
    const code = await page.evaluate(() => {
      const el = document.querySelector('.serial-key, .game-key, .key-value');
      return el ? el.textContent.trim() : null;
    });
    if (!code) throw new Error('Code non trouvé');
    
    return code;

  } finally {
    await browser.close();
  }
}

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

async function traiterCommande(commande) {
  try {
    await supabase.from('commandes').update({ statut: 'en_cours' }).eq('id', commande.id);
    const code = await acheterSurInstantGaming(commande.produit_nom);
    await envoyerCodeParEmail(commande.client_email, commande.client_nom, commande.produit_nom, code);
    await supabase.from('commandes').update({
      statut: 'livree',
      livraison_auto: true,
      livre_le: new Date().toISOString(),
      codes_livres: [code]
    }).eq('id', commande.id);
    console.log(`✅ Commande ${commande.id} livrée !`);
  } catch (err) {
    console.error(`❌ Erreur:`, err.message);
    await supabase.from('commandes').update({ statut: 'erreur', erreur_message: err.message }).eq('id', commande.id);
  }
}

async function checkCommandes() {
  try {
    const { data: commandes, error } = await supabase
      .from('commandes').select('*')
      .eq('statut', 'payee').eq('livraison_auto', false);
    if (error) throw error;
    if (commandes && commandes.length > 0) {
      for (const commande of commandes) await traiterCommande(commande);
    } else {
      console.log('✅ Aucune commande en attente.');
    }
  } catch (err) {
    console.error('Erreur:', err.message);
  }
}

checkCommandes();
setInterval(checkCommandes, 30000);

const http = require('http');
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);
