// Relais sécurisé vers l'API Brevo : la clé BREVO_API_KEY reste côté serveur (variable d'environnement
// Netlify), jamais visible dans le code envoyé au navigateur. admin.html envoie ici exactement le
// même contenu (sender, to, subject, htmlContent ou templateId/params) qu'il envoyait avant
// directement à Brevo — seule la clé change d'endroit.
exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode interdite' }) };
  }

  try {
    const body = event.body;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body
    });
    const data = await res.json().catch(() => ({}));
    return { statusCode: res.status, headers, body: JSON.stringify({ ok: res.ok, data }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
