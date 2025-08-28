export interface Env {
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;
  USDC_MINT: string; INPI_MINT: string; CREATOR: string; USDC_VAULT_ATA: string;
  PRESALE_STATE: string; PRESALE_PRICE_USDC: string; PUBLIC_PRICE_USDC: string;
  CAP_PER_WALLET_USDC: string; EARLY_CLAIM_ENABLED: string; EARLY_FLAT_USDC: string; TGE_TS: string;
  SOLANA_RPC: string; ALLOWED_ORIGINS: string; PAGES_UPSTREAM: string;
}

const json = (obj: any, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type":"application/json; charset=utf-8","cache-control":"no-store", ...extra } });

const cors = (env: Env) => {
  const origins = env.ALLOWED_ORIGINS.split(",").map(s => s.trim());
  return (origin?: string) => ({
    "access-control-allow-origin": origin && origins.includes(origin) ? origin : origins[0] || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  });
};

function randomRef(): string { const a = crypto.getRandomValues(new Uint8Array(16)); return [...a].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function solanaPay(recipient: string, amount: number, usdcMint: string, memo: string, label="INPI Presale", message="INPI Presale Deposit"): string {
  const u = new URL(`solana:${recipient}`); u.searchParams.set("amount", String(amount));
  u.searchParams.set("spl-token", usdcMint); u.searchParams.set("label", label);
  u.searchParams.set("message", message); u.searchParams.set("memo", memo); return u.toString();
}
async function rpc(env: Env, req: Request, origin: string) {
  const body = await req.text();
  const r = await fetch(env.SOLANA_RPC, { method: "POST", headers: { "content-type":"application/json" }, body });
  return new Response(await r.text(), { status: r.status, headers: { "content-type":"application/json" } });
}

async function proxyToken(env: Env, req: Request, url: URL): Promise<Response> {
  // /token → /token/ Redirect
  if (url.pathname === "/token" && req.method === "GET") return Response.redirect(url.origin + "/token/", 301);
  const upstream = new URL(env.PAGES_UPSTREAM + url.pathname + url.search);
  // Statische Files aus Pages laden (inkl. index.html bei /token/)
  const r = await fetch(upstream.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
  });
  // leichte Cache-Verbesserung für statische Assets
  const h = new Headers(r.headers);
  if (r.ok && (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".png") || url.pathname.endsWith(".json"))) {
    h.set("cache-control", "public, max-age=600");
  }
  return new Response(r.body, { status: r.status, headers: h });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const corsHeaders = cors(env)(req.headers.get("origin") || undefined);

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // 1) Mount der statischen Pages unter /token*
    if (url.pathname === "/token" || url.pathname.startsWith("/token/")) {
      return proxyToken(env, req, url);
    }

    // 2) API-Routen
    if (url.pathname.endsWith("/api/token/config") && req.method === "GET") {
      return json({
        inpi_mint: env.INPI_MINT, usdc_mint: env.USDC_MINT, creator: env.CREATOR, usdc_vault_ata: env.USDC_VAULT_ATA,
        presale_state: env.PRESALE_STATE, presale_price_usdc: parseFloat(env.PRESALE_PRICE_USDC),
        public_price_usdc: parseFloat(env.PUBLIC_PRICE_USDC), cap_per_wallet_usdc: parseFloat(env.CAP_PER_WALLET_USDC),
        early_claim_enabled: env.EARLY_CLAIM_ENABLED === "true", early_flat_usdc: parseFloat(env.EARLY_FLAT_USDC),
        tge_ts: parseInt(env.TGE_TS,10), inpi_json: "https://inpinity.online/token/inpi.json"
      }, 200, corsHeaders);
    }

    if (url.pathname.endsWith("/api/token/presale/intent") && req.method === "POST") {
      const { wallet, amount_usdc, kind } = await req.json().catch(()=>({}));
      if (!wallet || !amount_usdc) return json({ error:"wallet & amount_usdc required" }, 400, corsHeaders);
      const mode = kind === "early-claim" ? "early-claim" : "presale";
      const ref = randomRef(); const memo = `INPI-${mode}-${ref}`;
      const payUrl = solanaPay(env.CREATOR, Number(amount_usdc), env.USDC_MINT, memo);
      await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify({ ref, wallet, kind: mode, amount_usdc: Number(amount_usdc), created_at: Date.now(), memo, status:"pending" }), { expirationTtl: 60*60*24*7 });
      return json({ ref, url: payUrl, memo }, 200, corsHeaders);
    }

    if (url.pathname.endsWith("/api/token/presale/check") && req.method === "GET") {
      const ref = url.searchParams.get("ref") || "";
      if (!ref) return json({ error:"ref required" }, 400, corsHeaders);
      const k = `intent:${ref}`; const raw = await env.KV_PRESALE.get(k); if (!raw) return json({ error:"unknown ref" }, 404, corsHeaders);
      const intend = JSON.parse(raw);

      const rpcReq = (method: string, params: any[]) => fetch(env.SOLANA_RPC, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }) }).then(r=>r.json());
      const sigs = await rpcReq("getSignaturesForAddress", [env.USDC_VAULT_ATA, { limit: 40 }]);
      if (!sigs.result) return json({ status:"pending" }, 200, corsHeaders);

      for (const s of sigs.result) {
        const tx = await rpcReq("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0 }]);
        const meta = tx?.result?.meta; const inner = tx?.result?.transaction?.message?.instructions || [];
        const log = meta?.logMessages?.join("\n") || "";
        const memoFound = (log.includes(intend.memo)) || JSON.stringify(inner).includes(intend.memo);
        if (!memoFound) continue;
        const pre = meta?.preTokenBalances || []; const post = meta?.postTokenBalances || [];
        const mintOk = [...pre, ...post].some((b:any)=> b.mint === env.USDC_MINT);
        if (mintOk) {
          intend.status = "settled"; intend.signature = s.signature; intend.settled_at = Date.now();
          await env.KV_PRESALE.put(k, JSON.stringify(intend), { expirationTtl: 60*60*24*60 });
          return json({ status:"settled", signature: s.signature }, 200, corsHeaders);
        }
      }
      return json({ status:"pending" }, 200, corsHeaders);
    }

    if (url.pathname.endsWith("/api/token/early-claim") && req.method === "POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);
      const ref = randomRef(); const memo = `INPI-early-claim-${ref}`;
      const amount = parseFloat(process.env?.EARLY_FLAT_USDC ?? "1.0");
      const payUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
      await env.KV_CLAIMS.put(`early:${wallet}`, JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at: Date.now() }), { expirationTtl: 60*60*24*30 });
      return json({ ref, url: payUrl, memo, amount_usdc: amount }, 200, corsHeaders);
    }

    if (url.pathname.endsWith("/api/token/rpc") && req.method === "POST") {
      return rpc(env, req, url.origin);
    }

    return json({ error: "not found" }, 404, corsHeaders);
  }
};