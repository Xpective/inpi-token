export interface Env {
  PAGES_UPSTREAM: string;
  SOLANA_RPC: string;
  USDC_MINT: string;
  INPI_MINT: string;
  CREATOR: string;
  PRESALE_STATE?: string;
  PRESALE_PRICE_USDC?: string;
  DISCOUNT_BPS?: string;
  PRESALE_MIN_USDC?: string;
  PRESALE_MAX_USDC?: string;
  GATE_NFT_MINT?: string;
  TGE_TS?: string;
  USDC_VAULT_ATA?: string;
  ALLOWED_ORIGINS?: string;
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;
}

const TOKEN_2022_PROG = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const json = (obj: any, status = 200, extra: Record<string,string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...extra }});

const makeCORS = (env: Env) => {
  const list = (env.ALLOWED_ORIGINS || "*").split(",").map(s=>s.trim()).filter(Boolean);
  const allowAll = list.includes("*");
  return (origin?: string|null) => ({
    "access-control-allow-origin": allowAll ? "*" : (origin && list.includes(origin) ? origin : (list[0] || "*")),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
    "vary": "origin"
  });
};

const splitRpc = (env: Env) => String(env.SOLANA_RPC||"").split(",").map(s=>s.trim()).filter(Boolean);

async function rpc(env: Env, method: string, params: any[]) {
  const eps = splitRpc(env);
  if (!eps.length) throw new Error("SOLANA_RPC not configured");
  let last: any = null;
  for (const ep of eps) {
    try {
      const r = await fetch(ep, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.error) throw new Error(`${j.error.code}: ${j.error.message}`);
      return j.result;
    } catch (e) { last = e; }
  }
  throw new Error(`RPC failed: ${String(last)}`);
}

const randomRef = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,"0")).join("");
const solanaPay = (recipient: string, amount: number, usdcMint: string, memo: string) => {
  const u = new URL(`solana:${recipient}`);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("spl-token", usdcMint);
  u.searchParams.set("label", "INPI Presale");
  u.searchParams.set("message", "INPI Presale Deposit");
  u.searchParams.set("memo", memo);
  return u.toString();
};

async function proxyPages(env: Env, req: Request, url: URL) {
  if (url.pathname === "/token" && req.method === "GET") return Response.redirect(url.origin + "/token/", 301);
  const sub = url.pathname.replace(/^\/token(\/|$)/, "/");
  const upstreamUrl = new URL(sub + url.search, new URL(env.PAGES_UPSTREAM));
  const r = await fetch(upstreamUrl.toString(), { method: req.method, headers: req.headers, body: (req.method==="GET"||req.method==="HEAD") ? undefined : await req.arrayBuffer() });
  const h = new Headers(r.headers);
  if (r.ok && /\.(js|css|png|jpg|svg|json|webp|woff2?)$/i.test(sub)) h.set("cache-control","public, max-age=600"); else h.set("cache-control","no-store");
  h.set("x-content-type-options","nosniff"); h.set("referrer-policy","no-referrer");
  return new Response(r.body, { status: r.status, headers: h });
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const cors = makeCORS(env)(req.headers.get("origin"));
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/token" || url.pathname.startsWith("/token/")) {
      return proxyPages(env, req, url);
    }

    // --- Status (nur das Nötigste)
    if (url.pathname.endsWith("/api/token/status") && req.method === "GET") {
      const presale = parseFloat(env.PRESALE_PRICE_USDC || "0");
      const disc    = parseInt(env.DISCOUNT_BPS || "0", 10);
      const tgeTs   = env.TGE_TS ? parseInt(env.TGE_TS, 10) : null;
      return json({
        rpc_url: `${url.origin}/api/token/rpc`,
        inpi_mint: env.INPI_MINT,
        usdc_mint: env.USDC_MINT,
        presale_state: env.PRESALE_STATE || "open",
        tge_ts: Number.isFinite(tgeTs as any) ? tgeTs : null,
        deposit_usdc_ata: env.USDC_VAULT_ATA || null,
        deposit_usdc_owner: env.CREATOR || null,
        presale_min_usdc: env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : null,
        presale_max_usdc: env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : null,
        presale_price_usdc: Number.isFinite(presale) ? presale : null,
        discount_bps: Number.isFinite(disc) ? disc : 0
      }, 200, cors);
    }

    // --- Intent (einmaliger POST)
    if (url.pathname.endsWith("/api/token/presale/intent") && req.method === "POST") {
      const body = await req.json().catch(()=>({}));
      const wallet = String(body.wallet || "");
      const aUSDC  = body.amount_usdc;
      const aINPI  = body.amount_inpi;
      if (!wallet || (!aUSDC && !aINPI)) return json({ error:"wallet & (amount_usdc|amount_inpi) required" }, 400, cors);
      if ((env.PRESALE_STATE || "open") === "closed") return json({ error:"presale closed" }, 400, cors);

      const base = parseFloat(env.PRESALE_PRICE_USDC || "0");
      if (!(base>0)) return json({ error:"price not configured" }, 500, cors);
      const disc = parseInt(env.DISCOUNT_BPS || "0", 10);
      const price = Math.round(base*(1 - (disc/10000))*1e6)/1e6; // wir rechnen Rabatt clientseitig korrekt weiter oben aus; hier neutral möglich

      let usdc = Number.isFinite(Number(aUSDC)) ? Number(aUSDC) : Number(aINPI) * base;
      usdc = Math.round(usdc*1e6)/1e6;

      const min = env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : undefined;
      const max = env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : undefined;
      if (min!=null && usdc<min) return json({ error:`min ${min} USDC` }, 400, cors);
      if (max!=null && usdc>max) return json({ error:`max ${max} USDC` }, 400, cors);

      const ref = randomRef();
      const memo = `INPI-presale-${ref}`;
      const payUrl = solanaPay(env.CREATOR, usdc, env.USDC_MINT, memo);

      await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify({ ref, wallet, amount_usdc: usdc, memo, created_at: Date.now(), status:"pending" }), { expirationTtl: 60*60*24*7 });

      return json({ ok:true, ref, qr_contribute: { solana_pay_url: payUrl, amount_usdc: usdc } }, 200, cors);
    }

    // --- RPC Proxy (CSP/CORS-sicher)
    if (url.pathname.endsWith("/api/token/rpc") && req.method === "POST") {
      const payload = await req.text();
      let reqJson: any = null; try{ reqJson = JSON.parse(payload);}catch{}
      if (!reqJson || typeof reqJson !== "object") return json({ jsonrpc:"2.0", id:1, error:{ code:-32600, message:"Invalid Request" } }, 400, cors);
      const id = reqJson.id ?? 1, method = reqJson.method, params = Array.isArray(reqJson.params)? reqJson.params : [];
      try{
        const result = await rpc(env, method, params);
        return new Response(JSON.stringify({ jsonrpc:"2.0", id, result }), { status:200, headers:{ "content-type":"application/json", ...cors }});
      }catch(e:any){
        return new Response(JSON.stringify({ jsonrpc:"2.0", id, error:{ code:-32000, message:String(e?.message||e) } }), { status:200, headers:{ "content-type":"application/json", ...cors }});
      }
    }

    return json({ error:"not found" }, 404, cors);
  }
};