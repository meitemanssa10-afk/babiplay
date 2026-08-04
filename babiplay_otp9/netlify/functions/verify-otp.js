exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { identifier, code } = JSON.parse(event.body);

    // La table otp_codes contient les codes de connexion : elle ne doit JAMAIS être accessible
    // avec la clé publique (celle-ci est visible dans le JavaScript du site, donc par tout le
    // monde — n'importe qui pourrait lire le code envoyé à une autre adresse et se connecter à
    // sa place). On utilise donc la clé secrète, qui n'est connue que du serveur Netlify.
    const CLE_SERVEUR = process.env.SUPABASE_KEY;

    // Vérifier le code dans Supabase
    // Le code saisi par l'internaute est encodé avant d'être placé dans l'adresse : sans ça, un
    // code contenant des caractères spéciaux pouvait modifier la requête envoyée à la base.
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/otp_codes?identifier=eq.${encodeURIComponent(identifier)}&code=eq.${encodeURIComponent(code)}&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': CLE_SERVEUR,
          'Authorization': `Bearer ${CLE_SERVEUR}`
        }
      }
    );
    const rows = await res.json();

    if (!rows.length) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ valid: false, reason: 'Code incorrect' }) };
    }
    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ valid: false, reason: 'Code expiré' }) };
    }
    // Supprimer le code utilisé
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/otp_codes?id=eq.${row.id}`, {
      method: 'DELETE',
      headers: {
        'apikey': CLE_SERVEUR,
        'Authorization': `Bearer ${CLE_SERVEUR}`
      }
    });
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ valid: true })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
