// Récupère nom / description / image / prix depuis le lien d'une fiche produit
// en lisant les balises meta standard (Open Graph, Twitter Card, schema produit).
// Fonctionne sur la plupart des sites e-commerce modernes (BigBuy, Cdiscount, Fnac...).
// Certains sites (Amazon notamment) bloquent ce type de requête : dans ce cas
// la réponse renvoie les champs vides et l'admin doit compléter à la main.

function extractMeta(html, properties) {
  for (const prop of properties) {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${prop}["']`, 'i')
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return decodeHtmlEntities(m[1]);
    }
  }
  return '';
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Certains sites (BigBuy notamment, technologie Next.js) n'affichent la vraie image
// qu'après chargement côté navigateur : la balise og:image ne contient alors qu'un
// logo générique. Ces sites cachent quand même toutes les données réelles de la page
// dans un bloc <script id="__NEXT_DATA__"> présent dès le départ. On y cherche une
// vraie image produit en secours quand og:image semble être un logo générique.
function extractFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return '';
  const urls = m[1].match(/https?:\/\/[^"'\\]+\.(?:jpg|jpeg|png|webp)/gi) || [];
  const reelle = urls.find(u => !/logo|bigbuy-home|placeholder|sprite/i.test(u));
  return reelle || '';
}

function estImageGenerique(url) {
  return !url || /logo|bigbuy-home|placeholder|sprite/i.test(url);
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const url = event.queryStringParameters && event.queryStringParameters.url;
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Paramètre url manquant' }) };
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    if (!resp.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `Le site a répondu ${resp.status}`, nom: '', description: '', image: '', prix: '' }) };
    }

    const html = await resp.text();

    const nom = extractMeta(html, ['og:title', 'twitter:title']) ||
      (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';

    const description = extractMeta(html, ['og:description', 'twitter:description', 'description']);

    const image = extractMeta(html, ['og:image', 'twitter:image']);
    const imageFinale = estImageGenerique(image) ? (extractFromNextData(html) || image) : image;

    const prixBrut = extractMeta(html, ['og:price:amount', 'product:price:amount', 'twitter:data1']);
    const prix = (prixBrut.match(/[\d]+([.,]\d+)?/) || [])[0] || '';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ nom: nom.trim(), description: description.trim(), image: imageFinale.trim(), prix })
    };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: err.message, nom: '', description: '', image: '', prix: '' }) };
  }
};
