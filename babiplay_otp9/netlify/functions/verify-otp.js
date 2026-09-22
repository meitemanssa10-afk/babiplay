const { createClient } = require('@supabase/supabase-js');

// La table otp_codes contient les codes de connexion : elle n'est accessible qu'avec la clé
// secrète (jamais avec la clé publique visible dans le site).
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Au-delà de 5 mauvais essais, le code est détruit : il faut en redemander un.
// Sans cette limite, quelqu'un pouvait essayer des milliers de codes en 10 minutes.
const MAX_ESSAIS = 5;

const headers = { 'Access-Control-Allow-Origin': '*' };
const repondre = (obj) => ({ statusCode: 200, headers, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { identifier, code } = JSON.parse(event.body || '{}');
    if (!identifier || !code) return repondre({ valid: false, reason: 'Code incorrect' });

    // On ne regarde que le DERNIER code envoyé à cette adresse
    const { data: rows, error } = await supabase
      .from('otp_codes')
      .select('id, code, expires_at, tentatives')
      .eq('identifier', identifier)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

    const row = rows && rows[0];
    if (!row) return repondre({ valid: false, reason: 'Aucun code en cours. Redemandez un code.' });

    const detruire = () => supabase.from('otp_codes').delete().eq('id', row.id);

    if (new Date(row.expires_at) < new Date()) {
      await detruire();
      return repondre({ valid: false, reason: 'Code expiré. Redemandez un code.' });
    }
    if ((row.tentatives || 0) >= MAX_ESSAIS) {
      await detruire();
      return repondre({ valid: false, reason: "Trop d'essais. Redemandez un nouveau code." });
    }

    if (String(code).trim() !== String(row.code)) {
      const essais = (row.tentatives || 0) + 1;
      const restants = MAX_ESSAIS - essais;
      if (restants <= 0) {
        await detruire();
        return repondre({ valid: false, reason: "Trop d'essais. Redemandez un nouveau code." });
      }
      await supabase.from('otp_codes').update({ tentatives: essais }).eq('id', row.id);
      return repondre({ valid: false, reason: `Code incorrect (${restants} essai${restants > 1 ? 's' : ''} restant${restants > 1 ? 's' : ''})` });
    }

    // Bon code : il ne doit servir qu'une fois
    await detruire();
    return repondre({ valid: true });
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
