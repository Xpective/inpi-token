export interface Env {
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;

  // Token / Accounts
  USDC_MINT: string;
  INPI_MINT: string;
  CREATOR: string;            // Empfänger-Pubkey (Owner, der die USDC-ATA kontrolliert)
  USDC_VAULT_ATA: string;     // USDC-ATA (Ziel)

  // Presale / Pricing
  PRESALE_STATE: string;      // "pre" | "open" | "closed"
  PRESALE_PRICE_USDC: string; // z.B. "0.00031415"
  PUBLIC_PRICE_USDC: string;  // optional
  DISCOUNT_BPS?: string;      // z.B. "1000" (=10%)

  // Caps (optional)
  PRESALE_MIN_USDC?: string;  // z.B. "10"
  PRESALE_MAX_USDC?: string;  // z.B. "1000"

  // Early Claim
  EARLY_CLAIM_ENABLED: string; // "true"/"false"
  EARLY_FLAT_USDC: string;     // z.B. "1.0"

  // Misc
  TGE_TS: string;               // Unix Sek
  AIRDROP_BONUS_BPS?: string;   // z.B. "600" (=6.00%)
  GATE_NFT_MINT?: string;       // NFT-Mint für Rabattgate

  // Infra
  SOLANA_RPC: string;           // z.B. https://api.mainnet-beta.solana.com  (besser: Helius/QuickNode)
  ALLOWED_ORIGINS: string;      // CSV: https://inpinity.online,https://inpi-token.pages.dev
  PAGES_UPSTREAM: string;       // https://inpi-token.pages.dev
}

/* ------------------------ helpers ------------------------ */
const json = (obj: any, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });

const cors = (env: Env) => {
  const origins = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  return (origin?: string) => ({
    "access-control-allow-origin": origin && origins.includes(origin) ? origin : (origins[0] || "*"),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  });
};

function randomRef(): string {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

function solanaPay(recipient: string, amount: number, usdcMint: string, memo: string, label="INPI Presale", message="INPI Presale Deposit"): string {
  const u = new URL(`solana:${recipient}`);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("spl-token", usdcMint);
  u.searchParams.set("label", label);
  u.searchParams.set("message", message);
  u.searchParams.set("memo", memo);
  return u.toString();
}

async function rpcReq(env: Env, method: string, params: any[]) {
  const r = await fetch(env.SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const t = await r.text();
  let j: any;
  try { j = JSON.parse(t); } catch { throw new Error(`RPC parse error: ${t}`); }
  if (j?.error) throw new Error(`${j.error.code}: ${j.error.message}`);
  return j.result;
}

async function getTokenUiAmount(env: Env, owner: string, mint: string): Promise<number> {
  const res = await rpcReq(env, "getParsedTokenAccountsByOwner", [owner, { mint }]);
  let total = 0;
  for (const v of (res?.value || [])) {
    const amt = v?.account?.data?.parsed?.info?.tokenAmount;
    total += Number(amt?.uiAmount ?? 0);
  }
  return total;
}

async function hasNft(env: Env, owner: string, mint?: string): Promise<boolean> {
  if (!mint) return false;
  const amt = await getTokenUiAmount(env, owner, mint).catch(() => 0);
  return amt > 0;
}

async function proxyPages(env: Env, req: Request, url: URL): Promise<Response> {
  if (url.pathname === "/token" && req.method === "GET")
    return Response.redirect(url.origin + "/token/", 301);

  const upstream = new URL(env.PAGES_UPSTREAM + url.pathname + url.search);
  const r = await fetch(upstream.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
  });
  const h = new Headers(r.headers);
  if (r.ok && (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".png") || url.pathname.endsWith(".json"))) {
    h.set("cache-control", "public, max-age=600");
  }
  return new Response(r.body, { status: r.status, headers: h });
}

/* ------------------------ worker ------------------------ */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url  = new URL(req.url);
    const corsHeaders = cors(env)(req.headers.get("origin") || undefined);

    if (req.method === "OPTIONS")
      return new Response(null, { headers: corsHeaders });

    /* ---- Static under /token ---- */
    if (url.pathname === "/token" || url.pathname.startsWith("/token/"))
      return proxyPages(env, req, url);

    /* ---- API: status (für app.js refreshStatus) ---- */
    if (url.pathname.endsWith("/api/token/status") && req.method === "GET") {
      const presale = parseFloat(env.PRESALE_PRICE_USDC || "0");
      const discount_bps = parseInt(env.DISCOUNT_BPS || "1000", 10);
      const body = {
        rpc_url: env.SOLANA_RPC,
        inpi_mint: env.INPI_MINT,
        usdc_mint: env.USDC_MINT,

        presale_state: env.PRESALE_STATE || "pre",
        tge_ts: parseInt(env.TGE_TS, 10) || null,

        deposit_usdc_ata: env.USDC_VAULT_ATA || null,
        deposit_usdc_owner: env.CREATOR || null,

        presale_min_usdc: env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : null,
        presale_max_usdc: env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : null,

        presale_price_usdc: Number.isFinite(presale) ? presale : null,
        public_price_usdc: env.PUBLIC_PRICE_USDC ? parseFloat(env.PUBLIC_PRICE_USDC) : null,
        discount_bps,

        early_claim: {
          enabled: env.EARLY_CLAIM_ENABLED === "true",
          flat_usdc: parseFloat(env.EARLY_FLAT_USDC || "1"),
          fee_dest_wallet: env.CREATOR || null
        },

        airdrop_bonus_bps: env.AIRDROP_BONUS_BPS ? parseInt(env.AIRDROP_BONUS_BPS, 10) : 600,

        // Optional: Tokenomics (fallbacks – hier keine DB)
        supply_total: 3141592653,
        dist_presale_bps:        1000,
        dist_dex_liquidity_bps:  2000,
        dist_staking_bps:         700,
        dist_ecosystem_bps:      2000,
        dist_treasury_bps:       1500,
        dist_team_bps:           1000,
        dist_airdrop_nft_bps:    1000,
        dist_buyback_reserve_bps: 800
      };
      return json(body, 200, corsHeaders);
    }

    /* ---- API: wallet/balances (für app.js refreshBalances) ---- */
    if (url.pathname.endsWith("/api/token/wallet/balances") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error: "wallet required" }, 400, corsHeaders);
      try {
        const [usdc, inpi, gate] = await Promise.all([
          getTokenUiAmount(env, wallet, env.USDC_MINT),
          getTokenUiAmount(env, wallet, env.INPI_MINT),
          hasNft(env, wallet, env.GATE_NFT_MINT)
        ]);
        return json({
          usdc: { uiAmount: usdc },
          inpi: { uiAmount: inpi },
          gate_ok: !!gate
        }, 200, corsHeaders);
      } catch (e: any) {
        return json({ error: String(e?.message || e) }, 500, corsHeaders);
      }
    }

    /* ---- API: claim/status (für app.js refreshClaimStatus) ----
       Simple Stub: liest optional einen gespeicherten Wert, sonst 0.
       Du kannst hier später echte Logik integrieren (z. B. Summen aus settled Intents).
    */
    if (url.pathname.endsWith("/api/token/claim/status") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error: "wallet required" }, 400, corsHeaders);
      const raw = await env.KV_CLAIMS.get(`claimable:${wallet}`);
      const pending_inpi = raw ? parseFloat(raw) : 0;
      return json({ pending_inpi }, 200, corsHeaders);
    }

    /* ---- API: presale/intent (bereits vorhanden in deiner Vorlage) ---- */
    if (url.pathname.endsWith("/api/token/presale/intent") && req.method === "POST") {
      const { wallet, amount_usdc, kind } = await req.json().catch(()=>({}));
      if (!wallet || !amount_usdc) return json({ error:"wallet & amount_usdc required" }, 400, corsHeaders);
      const mode = kind === "early-claim" ? "early-claim" : "presale";
      const ref = randomRef(); const memo = `INPI-${mode}-${ref}`;
      const payUrl = solanaPay(env.CREATOR, Number(amount_usdc), env.USDC_MINT, memo);
      await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify({ ref, wallet, kind: mode, amount_usdc: Number(amount_usdc), created_at: Date.now(), memo, status:"pending" }), { expirationTtl: 60*60*24*7 });

      // QR-Link der Page-QR-API
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;
      return json({ ok:true, ref, memo, qr_contribute: { qr_url, solana_pay_url: payUrl } }, 200, corsHeaders);
    }

    /* ---- API: presale/check (bereits vorhanden – leicht angepasst) ---- */
    if (url.pathname.endsWith("/api/token/presale/check") && req.method === "GET") {
      const ref = url.searchParams.get("ref") || "";
      if (!ref) return json({ error:"ref required" }, 400, corsHeaders);
      const k = `intent:${ref}`;
      const raw = await env.KV_PRESALE.get(k); if (!raw) return json({ error:"unknown ref" }, 404, corsHeaders);
      const intend = JSON.parse(raw);

      const sigs = await rpcReq(env, "getSignaturesForAddress", [env.USDC_VAULT_ATA, { limit: 40 }]).catch(()=>null);
      if (!sigs?.length && !sigs?.result) return json({ status:"pending" }, 200, corsHeaders);
      const list = Array.isArray(sigs) ? sigs : (sigs.result || []);

      for (const s of list) {
        const tx = await rpcReq(env, "getTransaction", [s.signature, { maxSupportedTransactionVersion: 0 }]).catch(()=>null);
        const meta = tx?.meta;
        const logs = meta?.logMessages?.join("\n") || "";
        const inner = tx?.transaction?.message?.instructions || [];
        const memoFound = (logs.includes(intend.memo)) || JSON.stringify(inner).includes(intend.memo);
        if (!memoFound) continue;

        const pre  = meta?.preTokenBalances || [];
        const post = meta?.postTokenBalances || [];
        const mintOk = [...pre, ...post].some((b:any)=> b.mint === env.USDC_MINT);
        if (mintOk) {
          intend.status = "settled"; intend.signature = s.signature; intend.settled_at = Date.now();
          await env.KV_PRESALE.put(k, JSON.stringify(intend), { expirationTtl: 60*60*24*60 });
          return json({ status:"settled", signature: s.signature }, 200, corsHeaders);
        }
      }
      return json({ status:"pending" }, 200, corsHeaders);
    }

    /* ---- API: claim/early-intent (Alias für /early-claim) ---- */
    if (url.pathname.endsWith("/api/token/claim/early-intent") && req.method === "POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);

      const ref = randomRef();
      const memo = `INPI-early-claim-${ref}`;
      const amount = parseFloat(env.EARLY_FLAT_USDC || "1.0");
      const payUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;

      await env.KV_CLAIMS.put(`early:${wallet}`, JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at: Date.now() }), { expirationTtl: 60*60*24*30 });

      return json({ ok:true, ref, qr_url, solana_pay_url: payUrl }, 200, corsHeaders);
    }

    /* ---- API: claim/confirm (Job „queued“) ---- */
    if (url.pathname.endsWith("/api/token/claim/confirm") && req.method === "POST") {
      const { wallet, fee_signature } = await req.json().catch(()=>({}));
      if (!wallet || !fee_signature) return json({ error:"wallet & fee_signature required" }, 400, corsHeaders);

      // (Optional) hier könnte man die Tx prüfen. Wir legen einen Job an:
      const job_id = randomRef();
      await env.KV_CLAIMS.put(`job:${job_id}`, JSON.stringify({
        wallet, fee_signature, queued_at: Date.now(), status: "queued"
      }), { expirationTtl: 60*60*24*3 });

      return json({ ok:true, job_id }, 200, corsHeaders);
    }

    /* ---- API: early-claim (bestehen lassen für Backwards-Compat) ---- */
    if (url.pathname.endsWith("/api/token/early-claim") && req.method === "POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);

      const ref = randomRef();
      const memo = `INPI-early-claim-${ref}`;
      const amount = parseFloat(env.EARLY_FLAT_USDC || "1.0");
      const payUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;

      await env.KV_CLAIMS.put(`early:${wallet}`, JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at: Date.now() }), { expirationTtl: 60*60*24*30 });

      return json({ ok:true, ref, qr_url, solana_pay_url: payUrl, amount_usdc: amount }, 200, corsHeaders);
    }

    /* ---- API: generic RPC proxy ---- */
    if (url.pathname.endsWith("/api/token/rpc") && req.method === "POST") {
      const body = await req.text();
      const r = await fetch(env.SOLANA_RPC, { method: "POST", headers: { "content-type":"application/json" }, body });
      return new Response(await r.text(), { status: r.status, headers: { "content-type":"application/json", ...corsHeaders } });
    }

    return json({ error: "not found" }, 404, corsHeaders);
  }
};