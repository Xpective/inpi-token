const PAGES_UPSTREAM = 'https://inpi-token.pages.dev'; // <- dein Pages Preview/Custom-Domain

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) Statische Token-App komplett über Pages ausliefern
    if (url.pathname === '/token') url.pathname = '/token/';
    if (url.pathname.startsWith('/token/')) {
      // Ziel-URL zu Pages bauen (Pfad + Query übernehmen)
      const target = new URL(PAGES_UPSTREAM);
      target.pathname = url.pathname;
      target.search = url.search;

      // Original-Request (Methode/Headers/Body) weiterreichen
      const upstreamReq = new Request(target.toString(), request);
      let upstreamRes = await fetch(upstreamReq);

      // CSP-Header entfernen, damit deine <meta http-equiv="CSP"> gilt
      const res = new Response(upstreamRes.body, upstreamRes);
      res.headers.delete('content-security-policy');

      // sinnvolle Defaults
      res.headers.set('x-content-type-options', 'nosniff');
      if (!res.headers.has('cache-control')) {
        const isAsset = /\.(css|js|mjs|map|png|jpg|jpeg|gif|svg|webp|ico|json|txt|pdf)$/i.test(url.pathname);
        res.headers.set('cache-control', isAsset ? 'public, max-age=600' : 'public, max-age=60');
      }
      return res;
    }

    // 2) ...hier dein bestehendes Routing (API, anderes HTML, etc.)
    // Beispiel: alles andere so lassen wie gehabt:
    return handleApp(request, env, ctx);
  }
};

// Dummy – ersetze durch deine bisherige Logik
async function handleApp(request, env, ctx) {
  // Wenn du bisher überall ein globales CSP gesetzt hast, mach das NUR hier
  const resp = new Response('Not Found', { status: 404 });
  resp.headers.set('content-security-policy',
    "default-src 'self'; script-src 'self' https://esm.sh 'unsafe-inline'; connect-src 'self' https://inpinity.online https://*.workers.dev https://inpi-token.pages.dev; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:");
  return resp;
}