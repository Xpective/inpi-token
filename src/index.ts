export interface Env {
  PAGES_UPSTREAM: string;
  SOLANA_RPC: string;             // CSV ok
  USDC_MINT: string;
  INPI_MINT: string;
  CREATOR: string;                // Empfänger (Ziel-Pubkey, kein ATA)
  PRESALE_STATE?: string;         // "open" | "pre" | "closed"
  PRESALE_PRICE_USDC?: string;
  PUBLIC_PRICE_USDC?: string;
  DISCOUNT_BPS?: string;
  PRESALE_MIN_USDC?: string;
  PRESALE_MAX_USDC?: string;
  EARLY_CLAIM_ENABLED?: string;   // "true" | "false"
  EARLY_FLAT_USDC?: string;       // "1.0"
  GATE_NFT_MINT?: string;
  AIRDROP_BONUS_BPS?: string;
  TGE_TS?: string;
  USDC_VAULT_ATA?: string;
  ALLOWED_ORIGINS?: string;       // CSV
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;
}

const TOKEN_2022_PROG = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const json = (obj: any, status = 200, extra: Record<string,string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...extra }
  });

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

const randomRef = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,"0")).join("");

const solanaPay = (recipient: string, amount: number, usdcMint: string, memo: string, label="INPI Presale", message="INPI Presale Deposit") => {
  const u = new URL(`solana:${recipient}`);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("spl-token", usdcMint);
  u.searchParams.set("label", label);
  u.searchParams.set("message", message);
  u.searchParams.set("memo", memo);
  return u.toString();
};

const splitRpc = (env: Env) => String(env.SOLANA_RPC||"").split(",").map(s=>s.trim()).filter(Boolean);

const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

async function rpc(env: Env, method: string, params: any[]) {
  const endpoints = splitRpc(env);
  if (!endpoints.length) throw new Error("SOLANA_RPC not configured");
  let lastErr: any = null;
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.error) throw new Error(`${j.error.code}: ${j.error.message}`);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`RPC failed: ${String(lastErr)}`);
}

async function getTokenUiAmount(env: Env, owner: string, mint: string) {
  let total = 0;
  try {
    const res1 = await rpc(env, "getParsedTokenAccountsByOwner", [owner, { mint }, { commitment:"confirmed" }]);
    for (const v of (res1?.value||[])) total += Number(v?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
    if (total>0) return total;
  } catch {}
  try {
    const res2 = await rpc(env, "getParsedTokenAccountsByOwner", [owner, { programId: TOKEN_2022_PROG }, { commitment:"confirmed" }]);
    for (const v of (res2?.value||[])) {
      const info = v?.account?.data?.parsed?.info;
      if (info?.mint === mint) total += Number(info?.tokenAmount?.uiAmount ?? 0);
    }
  } catch {}
  return total;
}
const hasNft = (env: Env, owner: string, gateMint?: string) =>
  !gateMint ? Promise.resolve(false) : getTokenUiAmount(env, owner, gateMint).then(x=>x>0).catch(()=>false);

async function proxyPages(env: Env, req: Request, url: URL) {
  if (url.pathname === "/token" && req.method === "GET") {
    return Response.redirect(url.origin + "/token/", 301);
  }
  const subpath = url.pathname.replace(/^\/token(\/|$)/, "/");
  const upstreamUrl = new URL(subpath + url.search, new URL(env.PAGES_UPSTREAM));
  const r = await fetch(upstreamUrl.toString(), {
    method: req.method,
    headers: new Headers(Object.fromEntries([...req.headers].filter(([k])=>k.toLowerCase()!=="host"))),
    body: (req.method==="GET"||req.method==="HEAD") ? undefined : await req.arrayBuffer()
  });
  const h = new Headers(r.headers);
  if (r.ok && /\.(js|css|png|jpg|svg|json|webp|woff2?)$/i.test(subpath)) h.set("cache-control","public, max-age=600");
  else h.set("cache-control","no-store");
  h.set("x-content-type-options","nosniff");
  h.set("referrer-policy","no-referrer");
  return new Response(r.body, { status:r.status, headers:h });
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const cors = makeCORS(env)(req.headers.get("origin"));
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // Static under /token/*
    if (url.pathname === "/token" || url.pathname.startsWith("/token/")) {
      return proxyPages(env, req, url);
    }

    // GET /api/token/status
    if (url.pathname.endsWith("/api/token/status") && req.method==="GET") {
      const presale = parseFloat(env.PRESALE_PRICE_USDC || "0");
      const discBps = parseInt(env.DISCOUNT_BPS || "1000", 10);
      const tgeTs = env.TGE_TS ? parseInt(env.TGE_TS,10) : null;
      const airdrop = env.AIRDROP_BONUS_BPS!=null ? parseInt(env.AIRDROP_BONUS_BPS,10) : 600;
      const rpcProxy = `${url.origin}/api/token/rpc`;
      return json({
        rpc_url: rpcProxy,
        inpi_mint: env.INPI_MINT,
        usdc_mint: env.USDC_MINT,
        presale_state: env.PRESALE_STATE || "pre",
        tge_ts: Number.isFinite(tgeTs as any) ? tgeTs : null,
        deposit_usdc_ata: env.USDC_VAULT_ATA || null,
        deposit_usdc_owner: env.CREATOR || null,
        presale_min_usdc: env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : null,
        presale_max_usdc: env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : null,
        presale_price_usdc: Number.isFinite(presale) ? presale : null,
        public_price_usdc: env.PUBLIC_PRICE_USDC ? parseFloat(env.PUBLIC_PRICE_USDC) : null,
        discount_bps: Number.isFinite(discBps) ? discBps : 0,
        early_claim: {
          enabled: env.EARLY_CLAIM_ENABLED === "true",
          flat_usdc: parseFloat(env.EARLY_FLAT_USDC || "1"),
          fee_dest_wallet: env.CREATOR || null
        },
        airdrop_bonus_bps: Number.isFinite(airdrop) ? airdrop : 600,
        // Tokenomics (Default/Fallbacks)
        supply_total: 3141592653,
        dist_presale_bps: 1000,
        dist_dex_liquidity_bps: 2000,
        dist_staking_bps: 700,
        dist_ecosystem_bps: 2000,
        dist_treasury_bps: 1500,
        dist_team_bps: 1000,
        dist_airdrop_nft_bps: 1000,
        dist_buyback_reserve_bps: 800
      }, 200, cors);
    }

    // GET /api/token/wallet/balances?wallet=...
    if (url.pathname.endsWith("/api/token/wallet/balances") && req.method==="GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error:"wallet required" }, 400, cors);
      try {
        const [usdc, inpi, gate] = await Promise.all([
          getTokenUiAmount(env, wallet, env.USDC_MINT),
          getTokenUiAmount(env, wallet, env.INPI_MINT),
          hasNft(env, wallet, env.GATE_NFT_MINT)
        ]);
        return json({ usdc:{ uiAmount:usdc }, inpi:{ uiAmount:inpi }, gate_ok:!!gate }, 200, cors);
      } catch (e:any) { return json({ error:String(e?.message||e) }, 500, cors); }
    }

    // GET /api/token/claim/status?wallet=...
    if (url.pathname.endsWith("/api/token/claim/status") && req.method==="GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error:"wallet required" }, 400, cors);
      const raw = await env.KV_CLAIMS.get(`claimable:${wallet}`);
      return json({ pending_inpi: raw ? parseFloat(raw) : 0 }, 200, cors);
    }

    // POST /api/token/presale/intent
    if (url.pathname.endsWith("/api/token/presale/intent") && req.method==="POST") {
      const body = await req.json().catch(()=>({}));
      const wallet = String(body.wallet||"");
      const aUSDC = body.amount_usdc;
      const aINPI = body.amount_inpi;
      if (!wallet || (!aUSDC && !aINPI)) return json({ error:"wallet & (amount_usdc | amount_inpi) required" }, 400, cors);
      if ((env.PRESALE_STATE||"open")==="closed") return json({ error:"presale closed" }, 400, cors);

      const base = parseFloat(env.PRESALE_PRICE_USDC || "0");
      const discBps = parseInt(env.DISCOUNT_BPS || "0", 10);
      if (!Number.isFinite(base) || base<=0) return json({ error:"price not configured" }, 500, cors);

      const gated = await hasNft(env, wallet, env.GATE_NFT_MINT).catch(()=>false);
      const price = gated ? Math.round(base*(1-discBps/10000)*1e6)/1e6 : base;

      let usdc = Number.isFinite(Number(aUSDC)) ? Number(aUSDC) : Number(aINPI) * price;
      usdc = Math.round(usdc*1e6)/1e6;

      const min = env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : undefined;
      const max = env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : undefined;
      if (min!=null && usdc<min) return json({ error:`min ${min} USDC` }, 400, cors);
      if (max!=null && usdc>max) return json({ error:`max ${max} USDC` }, 400, cors);

      const ref = randomRef();
      const memo = `INPI-presale-${ref}`;
      const payUrl = solanaPay(env.CREATOR, usdc, env.USDC_MINT, memo);

      await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify({
        ref, wallet, amount_usdc:usdc, gated, memo, created_at:Date.now(), status:"pending"
      }), { expirationTtl: 60*60*24*7 });

      // Early-QR gleich mitgeben (1 USDC Flat, optional)
      let qr_early_fee: any = undefined;
      if (env.EARLY_CLAIM_ENABLED==="true") {
        const fee = parseFloat(env.EARLY_FLAT_USDC || "1");
        const memo2 = `INPI-early-claim-${randomRef()}`;
        const pay2 = solanaPay(env.CREATOR, fee, env.USDC_MINT, memo2, "INPI Early Claim", "INPI Early Claim Fee");
        qr_early_fee = { solana_pay_url: pay2, amount_usdc: fee };
      }

      return json({ ok:true, ref, qr_contribute:{ solana_pay_url: payUrl, amount_usdc: usdc }, qr_early_fee }, 200, cors);
    }

    // POST /api/token/claim/early-intent
    if (url.pathname.endsWith("/api/token/claim/early-intent") && req.method==="POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ error:"wallet required" }, 400, cors);
      const ref = randomRef();
      const amount = parseFloat(env.EARLY_FLAT_USDC || "1.0");
      const memo = `INPI-early-claim-${ref}`;
      const payUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
      await env.KV_CLAIMS.put(`early:${wallet}`, JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at:Date.now() }), { expirationTtl: 60*60*24*30 });
      return json({ ok:true, ref, solana_pay_url: payUrl }, 200, cors);
    }

    // POST /api/token/claim/confirm
    if (url.pathname.endsWith("/api/token/claim/confirm") && req.method==="POST") {
      const { wallet, fee_signature } = await req.json().catch(()=>({}));
      if (!wallet || !fee_signature) return json({ error:"wallet & fee_signature required" }, 400, cors);
      const job_id = randomRef();
      await env.KV_CLAIMS.put(`job:${job_id}`, JSON.stringify({ wallet, fee_signature, queued_at:Date.now(), status:"queued" }), { expirationTtl: 60*60*24*3 });
      return json({ ok:true, job_id }, 200, cors);
    }

    // POST /api/token/rpc  (CSP-freundlicher Proxy)
    if (url.pathname.endsWith("/api/token/rpc") && req.method==="POST") {
      const bodyTxt = await req.text();
      const reqJson = safeJson(bodyTxt);
      if (!reqJson || typeof reqJson !== "object")
        return json({ jsonrpc:"2.0", id:1, error:{ code:-32600, message:"Invalid Request" } }, 400, cors);
      const id = reqJson.id ?? 1;
      try {
        const result = await rpc(env, reqJson.method, Array.isArray(reqJson.params)? reqJson.params : []);
        return new Response(JSON.stringify({ jsonrpc:"2.0", id, result }), { status:200, headers:{ "content-type":"application/json", ...cors }});
      } catch (e:any) {
        return new Response(JSON.stringify({ jsonrpc:"2.0", id, error:{ code:-32000, message:String(e?.message||e) } }), { status:200, headers:{ "content-type":"application/json", ...cors }});
      }
    }

    return json({ error:"not found" }, 404, cors);
  }
};