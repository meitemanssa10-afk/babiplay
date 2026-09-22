const { createClient } = require('@supabase/supabase-js');

// Création de compte côté serveur.
// Avant : le navigateur créait lui-même le compte (sb.auth.signUp) APRÈS avoir vérifié le code
// OTP. Comme la clé publique est visible dans le site, n'importe qui pouvait appeler signUp
// directement, sans code et sans nom. Maintenant, le code ET la création du compte sont faits
// ici, avec la clé secrète : impossible de créer un compte sans un code valide.
// (Les inscriptions publiques sont ensuite désactivées dans Supabase ; la clé secrète, elle,
// peut toujours créer des comptes.)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const headers = { 'Access-Control-Allow-Origin': '*' };
const repondre = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return repondre(405, { success: false, error: 'Méthode interdite' });

  try {
    const { email, password, prenom, nom, telephone, code } = JSON.parse(event.body || '{}');
    const emailPropre = (email || '').trim().toLowerCase();

    if (!emailPropre || !prenom || !nom || !code) {
      return repondre(200, { success: false, error: 'Remplissez tous les champs' });
    }
    if (!password || password.length < 8) {
      return repondre(200, { success: false, error: 'Mot de passe : 8 caractères minimum' });
    }

    // 1. Vérifier le code OTP envoyé à cette adresse
    const { data: codes, error: errCode } = await supabase
      .from('otp_codes')
      .select('id, expires_at')
      .eq('identifier', email.trim())
      .eq('code', String(code).trim())
      .order('created_at', { ascending: false })
      .limit(1);

    if (errCode) return repondre(500, { success: false, error: 'Erreur de vérification' });
    if (!codes || !codes.length) return repondre(200, { success: false, error: 'Code incorrect' });
    if (new Date(codes[0].expires_at) < new Date()) {
      return repondre(200, { success: false, error: 'Code expiré' });
    }

    // 2. Créer le compte (confirmé d'office : l'email vient d'être prouvé par le code)
    const { data: cree, error: errCreation } = await supabase.auth.admin.createUser({
      email: emailPropre,
      password,
      email_confirm: true,
      user_metadata: { prenom, nom }
    });
    if (errCreation) {
      const dejaPris = /already|registered|exists/i.test(errCreation.message || '');
      return repondre(200, {
        success: false,
        error: dejaPris ? 'Un compte existe déjà avec cet email' : errCreation.message
      });
    }

    // 3. Enregistrer le profil (nom, prénom, téléphone)
    await supabase.from('profiles').upsert({
      id: cree.user.id,
      email: emailPropre,
      nom,
      prenom,
      telephone: telephone || null
    });

    // 4. Le code ne doit servir qu'une fois
    await supabase.from('otp_codes').delete().eq('id', codes[0].id);

    return repondre(200, { success: true });
  } catch (err) {
    return repondre(500, { success: false, error: err.message });
  }
};
