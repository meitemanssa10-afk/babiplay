// Relais sécurisé vers l'API Brevo : la clé BREVO_API_KEY reste côté serveur (variable d'environnement
// Netlify), jamais visible dans le code envoyé au navigateur. admin.html envoie ici exactement le
// même contenu (sender, to, subject, htmlContent ou templateId/params) qu'il envoyait avant
// directement à Brevo — seule la clé change d'endroit.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_EMAIL = 'meitemanssa10@gmail.com';

// Seul l'admin connecté AVEC sa double authentification peut envoyer des emails.
// Sans ça, n'importe qui pourrait envoyer des emails signés babiplay.store à n'importe qui.
async function estAdmin(event) {
  const jwt = (event.headers.authorization || '').replace('Bearer ', '');
  if (!jwt) return false;
  const { data, error } = await supabase.auth.getUser(jwt); // vérifie la signature du jeton
  if (error || data?.user?.email !== ADMIN_EMAIL) return false;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return payload.aal === 'aal2';
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode interdite' }) };
  }

  if (!(await estAdmin(event))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non autorisé' }) };
  }

  try {
    const body = event.body;
    console.log('📤 Appel Brevo, clé présente:', !!process.env.BREVO_API_KEY);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body
    });
    const data = await res.json().catch(() => ({}));
    console.log('📥 Réponse Brevo — statut:', res.status, '— contenu:', JSON.stringify(data));
    return { statusCode: res.status, headers, body: JSON.stringify({ ok: res.ok, data }) };
  } catch (err) {
    console.error('❌ Erreur send-email:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
