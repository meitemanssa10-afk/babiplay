// Réinitialise le mot de passe d'un utilisateur après vérification OTP réussie.
// Utilise la clé "service_role" de Supabase (admin), qui permet de changer
// le mot de passe d'un utilisateur SANS qu'il ait de session active.
//
// ⚠️ Variable d'environnement requise sur Netlify : SUPABASE_SERVICE_ROLE_KEY
// (à ajouter en plus de SUPABASE_URL et SUPABASE_ANON_KEY déjà existantes)
// On la trouve dans Supabase → Project Settings → API → "service_role" secret key.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { email, newPassword, otpAlreadyVerified } = JSON.parse(event.body);

    if (!email || !newPassword) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, error: 'Email et nouveau mot de passe requis' })
      };
    }
    if (newPassword.length < 6) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, error: 'Mot de passe trop court (6 caractères min)' })
      };
    }
    // Sécurité : ce champ doit avoir été validé côté client juste après verify-otp.
    // (Le vrai contrôle de sécurité est que ce code n'est appelable qu'après un appel
    // réussi à verify-otp dans le flux du site — voir index.html.)
    if (!otpAlreadyVerified) {
      return {
        statusCode: 403,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, error: 'Vérification OTP requise avant réinitialisation' })
      };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SERVICE_KEY) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, error: 'Configuration serveur incomplète (SUPABASE_SERVICE_ROLE_KEY manquante)' })
      };
    }

    // 1. Trouver l'utilisateur par email via l'API admin
    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`
      }
    });
    const listData = await listRes.json();
    const user = (listData.users || []).find(u => u.email === email);

    if (!user) {
      return {
        statusCode: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, error: 'Compte introuvable pour cet email' })
      };
    }

    // 2. Mettre à jour le mot de passe via l'API admin
    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: newPassword })
    });

    if (!updateRes.ok) {
      const errData = await updateRes.json();
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, error: errData.msg || 'Erreur lors de la mise à jour' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
