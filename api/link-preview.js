/* api/link-preview.js — fetches basic Open Graph metadata for a URL so the
   app can render a link-preview card in posts, DMs, and bios, the same way
   iMessage/WhatsApp/Twitter do. No API key needed — just fetches the page's
   <head> and reads its meta tags. */

const https = require('https');
const http  = require('http');

const MAX_BYTES  = 500 * 1024; // stop reading after ~500kb, plenty for <head>
const TIMEOUT_MS = 5000;

module.exports = async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    res.status(400).json({ error: 'Missing or invalid url parameter' });
    return;
  }
  try {
    const meta = await fetchMeta(target, 3); // allow up to 3 redirects
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(meta);
  } catch (err) {
    // Fail soft — the frontend just won't render a card if this is empty.
    res.status(200).json({ url: target, title: null, description: null, image: null, siteName: null });
  }
};

function fetchMeta(targetUrl, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'http:' ? http : https;

    const req = lib.get(parsed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XClubLinkPreview/1.0)' },
      timeout: TIMEOUT_MS,
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsLeft > 0) {
        r.resume();
        const nextUrl = new URL(r.headers.location, parsed).toString();
        return resolve(fetchMeta(nextUrl, redirectsLeft - 1));
      }
      let data = '', size = 0;
      r.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { r.destroy(); return; }
        data += chunk;
      });
      r.on('end', () => resolve(parseMeta(data, parsed.toString())));
      r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function parseMeta(html, baseUrl) {
  const get = (re) => { const m = html.match(re); return m ? decodeEntities(m[1].trim()) : null; };

  const title =
    get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i) ||
    get(/<title[^>]*>([^<]*)<\/title>/i);

  const description =
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i) ||
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);

  let image =
    get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:image["']/i);
  if (image && !/^https?:\/\//i.test(image)) {
    try { image = new URL(image, baseUrl).toString(); } catch (e) { image = null; }
  }

  let siteName = get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  if (!siteName) { try { siteName = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch (e) {} }

  return { url: baseUrl, title, description, image, siteName };
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
}
