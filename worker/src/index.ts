/// <reference types="@cloudflare/workers-types" />

// src/index.ts
export interface Env {
  // KV
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;

  // Token / Accounts
  USDC_MINT: string;
  INPI_MINT: string;
  CREATOR: string;            // Owner, empfängt Solana Pay; Wallet routed zu USDC ATA
  USDC_VAULT_ATA: string;     // Ziel-ATA (für Memo-/Settlement-Check)

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
  EARLY_FLAT_USDC: string;     // "1.0"

  // Misc
  TGE_TS: string;               // Unix Sekunden
  AIRDROP_BONUS_BPS?: string;   // "600" (=6.00%)
  GATE_NFT_MINT?: string;       // NFT-Mint für Rabattgate

  // Infra
  SOLANA_RPC: string;           // z.B. https://rpc.helius.xyz/?api-key=...
  ALLOWED_ORIGINS: string;      // CSV inkl. Wildcards (https://*.inpi-token.pages.dev)
  PAGES_UPSTREAM: string;       // https://inpi-token.pages.dev
}

/* ------------------------ helpers ------------------------ */
const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });

/** CORS mit Wildcard-Support + sauberes Caching via Vary: Origin */
function buildCors(env: Env) {
  const list = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const hasStar = list.includes("*");

  // exakte Origins ODER Wildcards wie https://*.inpi-token.pages.dev
  function matchOrigin(origin?: string): string {
    if (!origin) return hasStar ? "*" : (list[0] || "*");
    if (hasStar) return "*";
    if (list.includes(origin)) return origin;

    try {
      const o = new URL(origin);
      const host = o.hostname.toLowerCase();
      const proto = o.protocol; // "https:"

      for (const pat of list) {
        const m = pat.match(/^(https?:\/\/)?(\*\.)?(.+)$/i);
        if (!m) continue;

        const patProto = (m[1] || "").toLowerCase();
        const hasWildcard = !!m[2];
        const baseHost = m[3].toLowerCase();

        if (patProto && patProto !== proto) continue;

        if (!hasWildcard) {
          if (host === baseHost) return origin;
        } else {
          if (host === baseHost || host.endsWith("." + baseHost)) return origin;
        }
      }
    } catch { /* ignore */ }

    return list[0] || "*";
  }

  return (origin?: string) => {
    const allow = matchOrigin(origin);
    return {
      "access-control-allow-origin": allow,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      "vary": "Origin"
    };
  };
}

function randomRef(): string {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Solana Pay: Empfänger = CREATOR (Owner). Wallet leitet via spl-token zur USDC-ATA.
function solanaPay(
  recipient: string,
  amount: number,
  usdcMint: string,
  memo: string,
  label = "INPI Presale",
  message = "INPI Presale Deposit"
): string {
  const u = new URL(`solana:${recipient}`);
  u.searchParams.set("amount", String(amount));
  u.searchParams.set("spl-token", usdcMint);
  u.searchParams.set("label", label);
  u.searchParams.set("message", message);
  u.searchParams.set("memo", memo);
  return u.toString();
}

function universalLinks(link: string) {
  return {
    solana_pay_url: link,
    phantom_universal_url: `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(link)}`,
    solflare_universal_url: `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(link)}`
  };
}

async function rpcReq(env: Env, method: string, params: unknown[]) {
  const r = await fetch(env.SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const t = await r.text();
  let j: any;
  try { j = JSON.parse(t); } catch { throw new Error(`RPC parse error: ${t}`); }
  if (!r.ok || j?.error) {
    const err = j?.error ? `${j.error.code}: ${j.error.message}` : `HTTP ${r.status}: ${t}`;
    throw new Error(err);
  }
  return j.result;
}

async function getTokenUiAmount(env: Env, owner: string, mint: string): Promise<number> {
  try {
    const res = await rpcReq(env, "getParsedTokenAccountsByOwner",
      [owner, { mint }, { commitment: "confirmed" }]);
    let total = 0;
    for (const v of (res?.value || [])) {
      const amt = v?.account?.data?.parsed?.info?.tokenAmount;
      total += Number(amt?.uiAmount ?? 0);
    }
    return total;
  } catch {
    return 0;
  }
}

async function hasNft(env: Env, owner: string, mint?: string): Promise<boolean> {
  if (!mint) return false;
  const amt = await getTokenUiAmount(env, owner, mint).catch(() => 0);
  return amt > 0;
}

/* ---------- /token Proxy mit HTML-Rewrite + Asset-Fallback ---------- */
async function proxyPages(env: Env, req: Request, url: URL): Promise<Response> {
  // /token → /token/ (für relative Pfade im HTML)
  if (url.pathname === "/token" && req.method === "GET")
    return Response.redirect(url.origin + "/token/", 301);

  const isAsset = (p: string) =>
    /\.(?:js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map|json)$/.test(p);

  // 1) exakter Pfad (mit /token), 2) Root (ohne /token)
  const pathVariants = [
    url.pathname,
    url.pathname.replace(/^\/token/, "") || "/",
  ];

  for (const p of pathVariants) {
    try {
      const target = new URL(p + url.search, env.PAGES_UPSTREAM);
      const r = await fetch(target.toString(), {
        method: req.method,
        headers: req.headers,
        body: ["GET","HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
        redirect: "manual"
      });

      // Redirects umbiegen, damit der Client unter /token/ bleibt
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (loc && loc.startsWith("/")) {
          const h = new Headers(r.headers);
          const newLoc = loc.startsWith("/token") ? loc : "/token" + loc;
          h.set("location", newLoc);
          return new Response(null, { status: r.status, headers: h });
        }
        return r;
      }

      const ct = r.headers.get("content-type") || "";
      const h = new Headers(r.headers);

      // Statische Assets: wenn Upstream HTML (SPA-Fallback) liefert → nächste Variante probieren
      if (r.ok && isAsset(p)) {
        if (ct.includes("text/html")) continue;
        h.set("cache-control", "public, max-age=600");
        return new Response(r.body, { status: r.status, headers: h });
      }

      // HTML: Umschreiben auf /token/
      if (ct.includes("text/html")) {
        let html = await r.text();

        // absolute Upstream-Domain entfernen
        const upstreamOrigin = new URL(env.PAGES_UPSTREAM).origin;
        const esc = upstreamOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp(esc, "g"), "");

        // root-absolute Pfade auf /token/ präfixen
        html = html
          .replace(/(href|src|action)=["']\/(?!token\/)/g, '$1="/token/')
          .replace(/data-(href|src)=["']\/(?!token\/)/g, 'data-$1="/token/');

        // <base href="/token/"> injizieren (falls nicht vorhanden)
        if (html.includes("<head") && !/base\s+href=/i.test(html)) {
          html = html.replace("<head>", '<head><base href="/token/">');
        }

        h.set("content-type", "text/html; charset=utf-8");
        h.delete("content-length");
        return new Response(html, { status: r.status, headers: h });
      }

      // alles andere durchreichen
      return new Response(r.body, { status: r.status, headers: h });
    } catch {
      // nächste Variante probieren
      continue;
    }
  }

  return new Response("Upstream not reachable", { status: 502 });
}

/* ------------------------ worker ------------------------ */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url  = new URL(req.url);
    const cors = buildCors(env);
    const corsHeaders = cors(req.headers.get("origin") || undefined);

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    /* ---- Static unter /token ---- */
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

        // einfache Fallback-Tokenomics
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
        return json({ usdc: { uiAmount: usdc }, inpi: { uiAmount: inpi }, gate_ok: !!gate }, 200, corsHeaders);
      } catch (e: any) {
        // UI soll weiterlaufen
        return json({ usdc: { uiAmount: 0 }, inpi: { uiAmount: 0 }, gate_ok: false, error: String(e?.message || e) }, 200, corsHeaders);
      }
    }

    /* ---- API: claim/status ---- */
    if (url.pathname.endsWith("/api/token/claim/status") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error: "wallet required" }, 400, corsHeaders);
      const raw = await env.KV_CLAIMS.get(`claimable:${wallet}`);
      const pending_inpi = raw ? parseFloat(raw) : 0;
      return json({ pending_inpi }, 200, corsHeaders);
    }

    /* ---- API: presale/intent
       Request-Body:
       { wallet: string, amount_usdc?: number, amount_inpi?: number }
       - Wenn amount_inpi gesetzt ist, wird amount_usdc anhand PRESALE_PRICE_USDC
         berechnet; hat das Wallet das Gate-NFT, wird DISCOUNT_BPS berücksichtigt.
    ------------------------------------------------------------------ */
    if (url.pathname.endsWith("/api/token/presale/intent") && req.method === "POST") {
      const { wallet, amount_usdc, amount_inpi, kind } = await req.json().catch(()=>({}));
      if (!wallet || (!amount_usdc && !amount_inpi))
        return json({ error:"wallet & (amount_usdc|amount_inpi) required" }, 400, corsHeaders);

      const min = env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : null;
      const max = env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : null;
      const presale = parseFloat(env.PRESALE_PRICE_USDC || "0");
      const discBps = parseInt(env.DISCOUNT_BPS || "0", 10);

      // USDC-Betrag bestimmen
      let usdc = typeof amount_usdc === "number" ? Number(amount_usdc) : NaN;
      if (!Number.isFinite(usdc) && Number.isFinite(Number(amount_inpi))) {
        // optional: Rabatt, wenn Gate-NFT vorhanden
        let price = presale;
        if (env.GATE_NFT_MINT && discBps > 0) {
          const gate = await hasNft(env, wallet, env.GATE_NFT_MINT).catch(()=>false);
          if (gate) price = Math.round(presale * (1 - discBps / 10000) * 1e6) / 1e6;
        }
        usdc = Math.round(Number(amount_inpi) * price * 1e6) / 1e6;
      }

      if (!Number.isFinite(usdc) || usdc <= 0) return json({ error:"invalid amount" }, 400, corsHeaders);
      if (min != null && usdc < min) return json({ error:`min ${min} USDC` }, 400, corsHeaders);
      if (max != null && usdc > max) return json({ error:`max ${max} USDC` }, 400, corsHeaders);

      const mode = kind === "early-claim" ? "early-claim" : "presale";
      const ref  = randomRef();
      const memo = `INPI-${mode}-${ref}`;

      // Solana Pay Link (Empfänger = CREATOR, Wallet routed zur USDC-ATA)
      const payUrl = solanaPay(env.CREATOR, usdc, env.USDC_MINT, memo);
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;
      const links  = universalLinks(payUrl);

      await env.KV_PRESALE.put(
        `intent:${ref}`,
        JSON.stringify({
          ref, wallet, kind: mode, amount_usdc: usdc,
          created_at: Date.now(), memo, status:"pending"
        }),
        { expirationTtl: 60*60*24*7 }
      );

      return json({
        ok: true,
        ref,
        memo,
        amount_usdc: usdc,
        qr_contribute: { qr_url, ...links }
      }, 200, corsHeaders);
    }

    /* ---- API: presale/check (Memo-Suche am Vault-ATA) ---- */
    if (url.pathname.endsWith("/api/token/presale/check") && req.method === "GET") {
      const ref = url.searchParams.get("ref") || "";
      if (!ref) return json({ error:"ref required" }, 400, corsHeaders);

      const k = `intent:${ref}`;
      const raw = await env.KV_PRESALE.get(k);
      if (!raw) return json({ error:"unknown ref" }, 404, corsHeaders);
      const intend = JSON.parse(raw);

      try {
        const sigs = await rpcReq(env, "getSignaturesForAddress", [env.USDC_VAULT_ATA, { limit: 50 }]);
        for (const s of (sigs || [])) {
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
            intend.status = "settled";
            intend.signature = s.signature;
            intend.settled_at = Date.now();
            await env.KV_PRESALE.put(k, JSON.stringify(intend), { expirationTtl: 60*60*24*60 });
            return json({ status:"settled", signature: s.signature }, 200, corsHeaders);
          }
        }
        return json({ status:"pending" }, 200, corsHeaders);
      } catch (e:any) {
        return json({ status:"unknown", error:String(e?.message||e) }, 200, corsHeaders);
      }
    }

    /* ---- API: claim/early-intent ---- */
    if (url.pathname.endsWith("/api/token/claim/early-intent") && req.method === "POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);

      const ref = randomRef();
      const memo = `INPI-early-claim-${ref}`;
      const amount = parseFloat(env.EARLY_FLAT_USDC || "1.0");

      const payUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;
      const links  = universalLinks(payUrl);

      await env.KV_CLAIMS.put(
        `early:${wallet}`,
        JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at: Date.now() }),
        { expirationTtl: 60*60*24*30 }
      );

      return json({ ok:true, ref, qr_url, ...links }, 200, corsHeaders);
    }

    /* ---- API: claim/confirm (Job stub) ---- */
    if (url.pathname.endsWith("/api/token/claim/confirm") && req.method === "POST") {
      const { wallet, fee_signature } = await req.json().catch(()=>({}));
      if (!wallet || !fee_signature) return json({ error:"wallet & fee_signature required" }, 400, corsHeaders);

      const job_id = randomRef();
      await env.KV_CLAIMS.put(`job:${job_id}`, JSON.stringify({
        wallet, fee_signature, queued_at: Date.now(), status: "queued"
      }), { expirationTtl: 60*60*24*3 });

      return json({ ok:true, job_id }, 200, corsHeaders);
    }

    /* ---- API: early-claim (Backwards-Compat) ---- */
    if (url.pathname.endsWith("/api/token/early-claim") && req.method === "POST") {
      const { wallet } = await req.json().catch(()=>({}));
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);

      const ref = randomRef();
      const memo = `INPI-early-claim-${ref}`;
      const amount = parseFloat(env.EARLY_FLAT_USDC || "1.0");

      const payUrl = solanaPay(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;
      const links  = universalLinks(payUrl);

      await env.KV_CLAIMS.put(
        `early:${wallet}`,
        JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at: Date.now() }),
        { expirationTtl: 60*60*24*30 }
      );

      return json({ ok:true, ref, qr_url, amount_usdc: amount, ...links }, 200, corsHeaders);
    }

    /* ---- API: generic RPC proxy ---- */
    if (url.pathname.endsWith("/api/token/rpc") && req.method === "POST") {
      const body = await req.text();
      const r = await fetch(env.SOLANA_RPC, { method: "POST", headers: { "content-type":"application/json" }, body });
      return new Response(await r.text(), {
        status: r.status,
        headers: { "content-type":"application/json", ...corsHeaders }
      });
    }

    return json({ error: "not found" }, 404, corsHeaders);
  }
};