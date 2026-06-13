exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { identifier, code } = JSON.parse(event.body);

    // Vérifier le code dans Supabase
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/otp_codes?identifier=eq.${encodeURIComponent(identifier)}&code=eq.${code}&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
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
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      }
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ valid: true })
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
};
