export interface Env {
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;

  USDC_MINT: string; INPI_MINT: string; CREATOR: string; USDC_VAULT_ATA: string;
  PRESALE_STATE: string; PRESALE_PRICE_USDC: string; PUBLIC_PRICE_USDC: string;
  CAP_PER_WALLET_USDC: string;
  EARLY_CLAIM_ENABLED: string; EARLY_FLAT_USDC: string;
  TGE_TS: string;

  DISCOUNT_BPS?: string;
  GATE_NFT_MINT?: string;

  SUPPLY_TOTAL?: string;
  AIRDROP_BONUS_BPS?: string;

  SOLANA_RPC: string; ALLOWED_ORIGINS: string; PAGES_UPSTREAM: string;
}

/* ---------- utils ---------- */
const json = (obj: any, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "x-content-type-options":"nosniff",
      ...extra
    }
  });

const cors = (env: Env) => {
  const origins = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
  return (origin?: string) => ({
    "access-control-allow-origin": origin && origins.includes(origin) ? origin : origins[0] || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  });
};

function randomRef(): string {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function solanaPay(
  recipient: string, amount: number, usdcMint: string, memo: string,
  label="INPI Presale", message="INPI Presale Deposit"
): string {
  const u = new URL(`solana:${recipient}`);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("spl-token", usdcMint);
  u.searchParams.set("label", label);
  u.searchParams.set("message", message);
  u.searchParams.set("memo", memo);
  return u.toString();
}

function qrUrl(link: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=480x480&data=${encodeURIComponent(link)}`;
}
function phantomUL(link: string){ return `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(link)}`; }
function solflareUL(link: string){ return `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(link)}`; }

/* ---------- RPC ---------- */
async function rpcCall(env: Env, method: string, params: any[]) {
  const r = await fetch(env.SOLANA_RPC, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
  });
  return r.json();
}

async function tokenUiAmount(env: Env, owner: string, mint: string): Promise<number> {
  const r = await rpcCall(env, "getTokenAccountsByOwner",
    [owner, { mint }, { encoding: "jsonParsed" }]);
  const list = r?.result?.value || [];
  let sum = 0;
  for (const it of list) {
    const ui = Number(it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
    sum += ui;
  }
  return sum;
}

/* ---------- proxy Pages (/token*) ---------- */
async function proxyToken(env: Env, req: Request, url: URL): Promise<Response> {
  if (url.pathname === "/token" && req.method === "GET")
    return Response.redirect(url.origin + "/token/", 301);

  const upstream = new URL(env.PAGES_UPSTREAM + url.pathname + url.search);
  const r = await fetch(upstream.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
  });
  const h = new Headers(r.headers);
  if (r.ok && (/\.(?:js|css|png|json|svg|ico)$/i).test(url.pathname)) {
    h.set("cache-control", "public, max-age=600");
    h.set("x-content-type-options", "nosniff");
  }
  return new Response(r.body, { status: r.status, headers: h });
}

/* ---------- API ---------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const corsHeaders = cors(env)(req.headers.get("origin") || undefined);

    if (req.method === "OPTIONS")
      return new Response(null, { headers: corsHeaders });

    // 1) Statische Pages unter /token*
    if (url.pathname === "/token" || url.pathname.startsWith("/token/"))
      return proxyToken(env, req, url);

    // 2) API: /api/token/*
    if (!url.pathname.startsWith("/api/token"))
      return json({ error: "not found" }, 404, corsHeaders);

    // GET /api/token/status
    if (url.pathname.endsWith("/status") && req.method === "GET") {
      const disc = Number(env.DISCOUNT_BPS ?? "1000");
      return json({
        rpc_url: env.SOLANA_RPC,
        inpi_mint: env.INPI_MINT,
        usdc_mint: env.USDC_MINT,

        presale_state: env.PRESALE_STATE,
        tge_ts: Number(env.TGE_TS || 0) || null,

        deposit_usdc_ata: env.USDC_VAULT_ATA,
        deposit_usdc_owner: env.CREATOR,

        presale_min_usdc: null,
        presale_max_usdc: Number(env.CAP_PER_WALLET_USDC || "0") || null,

        presale_price_usdc: Number(env.PRESALE_PRICE_USDC || "0"),
        public_price_usdc: Number(env.PUBLIC_PRICE_USDC || "0"),
        discount_bps: disc,

        early_claim: {
          enabled: env.EARLY_CLAIM_ENABLED === "true",
          flat_usdc: Number(env.EARLY_FLAT_USDC || "1"),
          fee_dest_wallet: env.CREATOR
        },

        airdrop_bonus_bps: Number(env.AIRDROP_BONUS_BPS || "600"),
        supply_total: Number(env.SUPPLY_TOTAL || "3141592653"),

        // Optional: einzelne Distributions-Buckets könntest du hier auch liefern
      }, 200, corsHeaders);
    }

    // GET /api/token/wallet/balances?wallet=...
    if (url.pathname.endsWith("/wallet/balances") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);

      const [usdc, inpi] = await Promise.all([
        tokenUiAmount(env, wallet, env.USDC_MINT).catch(()=>0),
        tokenUiAmount(env, wallet, env.INPI_MINT).catch(()=>0),
      ]);

      // NFT-Gate (Rabatt)
      let gate_ok = false;
      if (env.GATE_NFT_MINT) {
        const nft = await tokenUiAmount(env, wallet, env.GATE_NFT_MINT).catch(()=>0);
        gate_ok = nft > 0;
      }

      return json({
        usdc: { uiAmount: usdc },
        inpi: { uiAmount: inpi },
        gate_ok
      }, 200, corsHeaders);
    }

    // POST /api/token/presale/intent
    if (url.pathname.endsWith("/presale/intent") && req.method === "POST") {
      const { wallet, amount_usdc } = await req.json().catch(()=>({}));
      if (!wallet || !amount_usdc) return json({ ok:false, error:"wallet & amount_usdc required" }, 400, corsHeaders);

      const ref = randomRef();
      const memo = `INPI-presale-${ref}`;
      const splUrl = solanaPay(env.CREATOR, Number(amount_usdc), env.USDC_MINT, memo);
      const qr_contribute = {
        solana_pay_url: splUrl,
        phantom_universal_url: phantomUL(splUrl),
        solflare_universal_url: solflareUL(splUrl),
        qr_url: qrUrl(splUrl)
      };

      await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify({
        ref, wallet, amount_usdc: Number(amount_usdc),
        memo, created_at: Date.now(), status: "pending"
      }), { expirationTtl: 60*60*24*7 });

      return json({ ok:true, ref, qr_contribute }, 200, corsHeaders);
    }

    // GET /api/token/claim/status?wallet=...
    if (url.pathname.endsWith("/claim/status") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);

      // Hier könntest du „pending_inpi“ aus deiner Offchain-Logik/KV berechnen.
      // Wir liefern einen konservativen Default:
      const rec = await env.KV_CLAIMS.get(`claim:${wallet}`);
      const pending_inpi = rec ? JSON.parse(rec).pending_inpi || 0 : 0;

      return json({ pending_inpi }, 200, corsHeaders);
    }

    // POST /api/token/claim/early-intent
    if (url.pathname.endsWith("/claim/early-intent") && req.method === "POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ ok:false, error:"wallet required" }, 400, corsHeaders);
      if (env.EARLY_CLAIM_ENABLED !== "true") return json({ ok:false, error:"early-claim disabled" }, 400, corsHeaders);

      const amount = Number(env.EARLY_FLAT_USDC || "1");
      const ref = randomRef();
      const memo = `INPI-early-claim-${ref}`;
      const splUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");

      await env.KV_CLAIMS.put(`early:${ref}`, JSON.stringify({
        ref, wallet, amount_usdc: amount, memo, status:"pending", created_at: Date.now()
      }), { expirationTtl: 60*60*24*30 });

      return json({
        ok:true,
        ref,
        solana_pay_url: splUrl,
        qr_url: qrUrl(splUrl)
      }, 200, corsHeaders);
    }

    // POST /api/token/claim/confirm   { wallet, fee_signature }
    if (url.pathname.endsWith("/claim/confirm") && req.method === "POST") {
      const { wallet, fee_signature } = await req.json().catch(()=>({}));
      if (!wallet || !fee_signature) return json({ ok:false, error:"wallet & fee_signature required" }, 400, corsHeaders);

      const job_id = randomRef();
      await env.KV_CLAIMS.put(`confirm:${job_id}`, JSON.stringify({
        wallet, fee_signature, created_at: Date.now(), status:"queued"
      }), { expirationTtl: 60*60*24*14 });

      return json({ ok:true, job_id }, 200, corsHeaders);
    }

    return json({ error:"not found" }, 404, corsHeaders);
  }
};