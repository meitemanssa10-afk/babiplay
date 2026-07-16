exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { type, email, phone, name } = JSON.parse(event.body);
    const identifiant = email || phone;

    // Anti-spam : sans cette limite, n'importe qui pouvait appeler cette fonction en boucle et
    // épuiser le quota Resend gratuit (bloquant TOUS les emails, y compris les codes de jeux déjà
    // payés par de vrais clients) ou remplir la table otp_codes à l'infini.
    const recentsRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/otp_codes?identifier=eq.${encodeURIComponent(identifiant)}&order=created_at.desc&limit=5`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        }
      }
    );
    const recents = await recentsRes.json().catch(() => []);
    const maintenant = Date.now();

    if (Array.isArray(recents) && recents.length) {
      const dernierEnvoi = new Date(recents[0].created_at).getTime();
      if (maintenant - dernierEnvoi < 60 * 1000) {
        return {
          statusCode: 429,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Merci de patienter avant de redemander un code (1 minute entre chaque envoi).' })
        };
      }
      const recentsQuinzeMin = recents.filter(r => maintenant - new Date(r.created_at).getTime() < 15 * 60 * 1000);
      if (recentsQuinzeMin.length >= 5) {
        return {
          statusCode: 429,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' })
        };
      }
    }

    // Générer code OTP 6 chiffres
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Stocker dans Supabase
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/otp_codes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ identifier: identifiant, code: otp, expires_at: expires, type: type || 'login' })
    });

    // Envoyer par email via Resend API (fetch, pas de npm)
    if (email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'BabiPlay <noreply@babiplay.store>',
          to: [email],
          subject: `🎮 Votre code BabiPlay : ${otp}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0d0d0d;color:#fff;padding:30px;border-radius:12px">
              <h2 style="color:#f5c518;text-align:center">🎮 BabiPlay</h2>
              <p style="text-align:center">Bonjour ${name || ''} !</p>
              <p style="text-align:center">Voici votre code de vérification :</p>
              <div style="background:#1a1a1a;border:2px solid #f5c518;border-radius:12px;padding:20px;text-align:center;margin:20px 0">
                <span style="font-size:40px;font-weight:bold;letter-spacing:10px;color:#f5c518">${otp}</span>
              </div>
              <p style="text-align:center;color:#888;font-size:12px">Ce code expire dans <strong>10 minutes</strong></p>
              <p style="text-align:center;color:#888;font-size:12px">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
            </div>
          `
        })
      });
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
      body: JSON.stringify({ error: err.message })
    };
  }
};
