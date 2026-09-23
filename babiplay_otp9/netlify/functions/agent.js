// Relais entre le back-office et le bot Render.
//
// Avant : admin.html appelait directement https://babiplay-agent.onrender.com en mettant le
// secret dans l'URL — et ce secret était donc écrit en clair dans la page, visible par
// n'importe qui faisant "Afficher le code source". Quiconque le lisait pouvait déclencher
// un import, un audit ou une réactivation sans être connecté au back-office.
//
// Maintenant : la page appelle cette fonction, qui ajoute le secret côté serveur. Le secret
// vit uniquement dans la variable d'environnement AGENT_SECRET de Netlify.

const AGENT_URL = process.env.AGENT_URL || 'https://babiplay-agent.onrender.com';

// Seules ces actions sont autorisées. Sans cette liste, la fonction deviendrait un passe-plat
// vers n'importe quelle adresse du bot.
const ACTIONS = {
  'check-product': { chemin: '/check-product', confirm: false },
  'audit': { chemin: '/fix-kinguin-products', confirm: true },
  'import': { chemin: '/import-categories', confirm: true },
  'reactiver': { chemin: '/reactivate-false-positives', confirm: true },
  'slider': { chemin: '/update-slider', confirm: true },
};

exports.handler = async (event) => {
  const enTetes = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: enTetes, body: '' };
  }

  const secret = process.env.AGENT_SECRET;
  if (!secret) {
    return {
      statusCode: 500,
      headers: enTetes,
      body: JSON.stringify({ ok: false, erreur: "AGENT_SECRET n'est pas configuré sur Netlify." }),
    };
  }

  const params = event.queryStringParameters || {};
  const action = ACTIONS[params.action];
  if (!action) {
    return {
      statusCode: 400,
      headers: enTetes,
      body: JSON.stringify({ ok: false, erreur: 'Action inconnue.' }),
    };
  }

  // Construction de l'URL vers le bot, avec le secret ajouté ici et non dans le navigateur
  const url = new URL(AGENT_URL + action.chemin);
  url.searchParams.set('secret', secret);
  if (action.confirm) url.searchParams.set('confirm', 'oui');
  if (params.id) url.searchParams.set('id', params.id);

  try {
    const res = await fetch(url.toString());
    const texte = await res.text();

    // Le bot répond soit du JSON (check-product), soit une phrase simple (les autres actions).
    // On renvoie toujours du JSON à la page, pour qu'elle n'ait qu'un seul format à lire.
    try {
      const json = JSON.parse(texte);
      return { statusCode: 200, headers: enTetes, body: JSON.stringify(json) };
    } catch {
      return {
        statusCode: 200,
        headers: enTetes,
        body: JSON.stringify({ ok: res.ok, message: texte }),
      };
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: enTetes,
      body: JSON.stringify({ ok: false, erreur: 'Bot injoignable : ' + e.message }),
    };
  }
};
