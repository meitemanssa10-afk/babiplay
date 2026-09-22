const { createClient } = require('@supabase/supabase-js');

// Création de compte côté serveur.
// Avant : le navigateur créait lui-même le compte (sb.auth.signUp) APRÈS avoir vérifié le code
// OTP. Comme la clé publique est visible dans le site, n'importe qui pouvait appeler signUp
// directement, sans code et sans nom. Maintenant, le code ET la création du compte sont faits
// ici, avec la clé secrète : impossible de créer un compte sans un code valide.
// (Les inscriptions publiques sont ensuite désactivées dans Supabase ; la clé secrète, elle,
// peut toujours créer des comptes.)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Au-delà de 5 mauvais essais, le code est détruit : il faut en redemander un.
const MAX_ESSAIS = 5;

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

    // 1. Vérifier le DERNIER code envoyé à cette adresse, avec 5 essais maximum
    const { data: codes, error: errCode } = await supabase
      .from('otp_codes')
      .select('id, code, expires_at, tentatives')
      .eq('identifier', email.trim())
      .order('created_at', { ascending: false })
      .limit(1);

    if (errCode) return repondre(500, { success: false, error: 'Erreur de vérification' });
    const ligne = codes && codes[0];
    if (!ligne) return repondre(200, { success: false, error: 'Aucun code en cours. Redemandez un code.' });

    const detruireCode = () => supabase.from('otp_codes').delete().eq('id', ligne.id);

    if (new Date(ligne.expires_at) < new Date()) {
      await detruireCode();
      return repondre(200, { success: false, error: 'Code expiré. Redemandez un code.' });
    }
    if ((ligne.tentatives || 0) >= MAX_ESSAIS) {
      await detruireCode();
      return repondre(200, { success: false, error: "Trop d'essais. Redemandez un nouveau code." });
    }
    if (String(code).trim() !== String(ligne.code)) {
      const essais = (ligne.tentatives || 0) + 1;
      const restants = MAX_ESSAIS - essais;
      if (restants <= 0) {
        await detruireCode();
        return repondre(200, { success: false, error: "Trop d'essais. Redemandez un nouveau code." });
      }
      await supabase.from('otp_codes').update({ tentatives: essais }).eq('id', ligne.id);
      return repondre(200, { success: false, error: `Code incorrect (${restants} essai${restants > 1 ? 's' : ''} restant${restants > 1 ? 's' : ''})` });
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
    await detruireCode();

    return repondre(200, { success: true });
  } catch (err) {
    return repondre(500, { success: false, error: err.message });
  }
};
