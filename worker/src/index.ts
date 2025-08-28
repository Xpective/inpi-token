/// <reference types="@cloudflare/workers-types" />

/**
 * Inpinity Presale Worker (ein Projekt, zwei Routen):
 *  - /token*           → Proxy zu Cloudflare Pages (PAGES_UPSTREAM), mit HTML-Rewrite auf /token/
 *  - /api/token/*      → JSON-API (Status, Wallet-Balances, Presale-Intent inkl. QR, Early-Claim, RPC-Proxy)
 *
 * wrangler.toml (Auszug):
 *   main = "src/index.ts"
 *   compatibility_flags = ["nodejs_compat"]
 *   routes = [
 *     { pattern = "inpinity.online/api/token/*", zone_name = "inpinity.online" },
 *     { pattern = "inpinity.online/token*",      zone_name = "inpinity.online" }
 *   ]
 *   [vars]
 *     SOLANA_RPC = "https://mainnet.helius-rpc.com/?api-key=DEIN_HELIUS_KEY,https://api.mainnet-beta.solana.com"
 *     PAGES_UPSTREAM = "https://inpi-token.pages.dev"
 *     ALLOWED_ORIGINS = "https://inpinity.online,https://inpi-token.pages.dev,https://*.inpi-token.pages.dev"
 */

export interface Env {
  // KV
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;

  // Token / Accounts
  USDC_MINT: string;          // EPjF...
  INPI_MINT: string;          // GBfE...
  CREATOR: string;            // Owner/Empfänger des USDC-ATAs
  USDC_VAULT_ATA: string;     // Ziel-ATA (USDC)

  // Presale / Pricing
  PRESALE_STATE: string;      // "pre" | "open" | "closed"
  PRESALE_PRICE_USDC: string; // z.B. "0.00031415" (Basispreis)
  PUBLIC_PRICE_USDC: string;  // optional (nicht nötig für Intent)
  DISCOUNT_BPS?: string;      // "1000" (=10%)

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
  SOLANA_RPC: string;           // CSV: erster probiert, rest Fallback
  ALLOWED_ORIGINS: string;      // CSV-Liste, kann Wildcards enthalten (https://*.inpi-token.pages.dev)
  PAGES_UPSTREAM: string;       // https://inpi-token.pages.dev
}

/* ------------------------------ Utils ------------------------------ */

const JSON_OK = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });

/** Wildcard-fähige Origin-Matches (z.B. https://*.inpi-token.pages.dev) */
function matchOrigin(origin: string, patterns: string[]): boolean {
  try {
    const u = new URL(origin);
    const oHost = u.host;
    const oProto = u.protocol; // "https:"
    for (const p of patterns) {
      if (p === "*") return true;

      // Schema prüfen
      const scheme = p.startsWith("http://") ? "http:" : p.startsWith("https://") ? "https:" : "";
      if (scheme && scheme !== oProto) continue;

      // Host-Pattern extrahieren
      const host = p.replace(/^https?:\/\//, "");
      const reHost = new RegExp(
        "^" +
          host
            .replace(/\./g, "\\.")
            .replace(/\*/g, "[^.]+") + // '*' → genau ein Label
          "$"
      );
      if (reHost.test(oHost)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const buildCors = (env: Env) => {
  const patterns = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  return (originHeader?: string | null) => {
    const origin = originHeader || "";
    const allowed =
      patterns.length === 0
        ? "*"
        : origin && matchOrigin(origin, patterns)
        ? origin
        : (patterns[0] === "*" ? "*" : patterns[0]);

    const base: Record<string, string> = {
      "access-control-allow-origin": allowed,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      "vary": "Origin"
    };
    return base;
  };
};

function randomRef(): string {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Solana Pay URL für Token-Transfer (USDC) */
function solanaPayURL(
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

/** Deep-Links für Wallets (Universal links) */
function walletLinks(solanaPay: string) {
  return {
    phantom_universal_url: `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(solanaPay)}`,
    solflare_universal_url: `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(solanaPay)}`
  };
}

/** Rundet auf 6 Dezimalstellen (USDC) */
function roundUsdc(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/* --------------------------- RPC Helpers --------------------------- */

// Mehrere RPCs per CSV erlauben; erster ist „primary“, Rest Fallback
function parseRpcList(s?: string) {
  return (s || "https://api.mainnet-beta.solana.com")
    .split(",").map(x => x.trim()).filter(Boolean);
}
function primaryRpc(s?: string) {
  return parseRpcList(s)[0] || "https://api.mainnet-beta.solana.com";
}

async function rpcReqAny(env: Env, method: string, params: unknown[]) {
  const urls = parseRpcList(env.SOLANA_RPC);
  let lastErr: any = null;

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });

      const t = await r.text();
      let j: any;
      try { j = JSON.parse(t); } catch { throw new Error(`RPC parse error @ ${url}: ${t}`); }

      if (!r.ok || j?.error) {
        const msg = j?.error ? `${j.error.code}: ${j.error.message}` : `HTTP ${r.status}: ${t}`;
        throw new Error(`RPC ${url} → ${msg}`);
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      // bei 403/429/5xx → nächsten RPC probieren
      continue;
    }
  }
  throw lastErr || new Error("No RPC available");
}

async function getTokenUiAmount(env: Env, owner: string, mint: string): Promise<number> {
  try {
    const res = await rpcReqAny(env, "getParsedTokenAccountsByOwner",
      [owner, { mint }, { commitment: "confirmed" }]);
    let total = 0;
    for (const v of (res?.value || [])) {
      const amt = v?.account?.data?.parsed?.info?.tokenAmount;
      total += Number(amt?.uiAmount ?? 0);
    }
    return total;
  } catch {
    return 0; // UI soll weiterlaufen
  }
}

async function hasNft(env: Env, owner: string, mint?: string): Promise<boolean> {
  if (!mint) return false;
  const amt = await getTokenUiAmount(env, owner, mint).catch(() => 0);
  return amt > 0;
}

/* ------------------------ Pages Proxy (/token) ------------------------ */

const STATIC_RE = /\.(?:js|mjs|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map|json|txt|pdf)(?:\?.*)?$/i;
function isStaticPath(p: string) { return STATIC_RE.test(p); }

async function fetchUpstream(url: string, req: Request) {
  return fetch(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET","HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
    redirect: "manual"
  });
}

async function serveTokenFromPages(env: Env, req: Request, url: URL): Promise<Response> {
  // /token → /token/
  if (url.pathname === "/token" && req.method === "GET")
    return Response.redirect(url.origin + "/token/", 301);

  const upstream = new URL(env.PAGES_UPSTREAM);
  const upstreamOrigin = upstream.origin;

  // Wir probieren 2 Pfad-Varianten: mit /token und ohne
  const keep = url.pathname;                                      // /token/...
  const strip = url.pathname.replace(/^\/token(?=\/|$)/, "") || "/"; // /...

  // Statische Assets: versuche beide; nimm den ersten, der kein HTML ist
  if (isStaticPath(url.pathname)) {
    const candidates = [keep, strip];
    for (let i=0; i<candidates.length; i++) {
      const target = new URL(candidates[i] + url.search, env.PAGES_UPSTREAM);
      const r = await fetchUpstream(target.toString(), req);
      const ct = (r.headers.get("content-type") || "").toLowerCase();

      // CSP entfernen, damit deine <meta http-equiv="CSP"> greift
      const h = new Headers(r.headers);
      h.delete("content-security-policy");

      if (r.ok && !ct.includes("text/html")) {
        if (STATIC_RE.test(candidates[i])) h.set("cache-control", "public, max-age=600");
        h.set("x-content-type-options", "nosniff");
        return new Response(r.body, { status: r.status, headers: h });
      }

      // Redirect → auf /token/... zurückbiegen
      if (r.status>=300 && r.status<400) {
        const loc = r.headers.get("location");
        if (loc && loc.startsWith("/")) {
          h.set("location", "/token" + (loc.startsWith("/token") ? loc.slice(6) : loc));
          return new Response(null, { status: r.status, headers: h });
        }
      }

      // Letzte Chance → reiche durch
      if (i === candidates.length-1) return new Response(r.body, { status: r.status, headers: h });
    }
  }

  // HTML/sonstige: "keep" bevorzugen; Redirects umbiegen; HTML umschreiben
  const target = new URL(keep + url.search, env.PAGES_UPSTREAM);
  let r = await fetchUpstream(target.toString(), req);

  const h = new Headers(r.headers);
  h.delete("content-security-policy"); // CSP-Header vom Upstream entfernen
  h.set("x-content-type-options", "nosniff");

  if (r.status>=300 && r.status<400) {
    const loc = r.headers.get("location");
    if (loc && loc.startsWith("/")) {
      h.set("location", "/token" + (loc.startsWith("/token") ? loc.slice(6) : loc));
      return new Response(null, { status: r.status, headers: h });
    }
    return new Response(r.body, { status: r.status, headers: h });
  }

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) {
    let html = await r.text();

    // Upstream-Origin entfernen, damit root-absolute erkannt werden
    const esc = upstreamOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(esc, "g"), "");

    // Root-absolute → /token/... (wenn nicht schon /token/)
    html = html
      .replace(/(href|src|action)=["']\/(?!token\/)/g, '$1="/token/')
      .replace(/data-(href|src)=["']\/(?!token\/)/g, 'data-$1="/token/');

    // <base href="/token/"> injizieren, falls nicht vorhanden
    if (html.includes("<head") && !/base\s+href=/i.test(html)) {
      html = html.replace("<head>", '<head><base href="/token/">');
    }

    h.set("content-type", "text/html; charset=utf-8");
    h.delete("content-length");
    if (!h.has("cache-control")) h.set("cache-control", "public, max-age=60");
    return new Response(html, { status: r.status, headers: h });
  }

  // Statisches sonstiges
  if (r.ok) {
    if (isStaticPath(keep) && !h.has("cache-control")) h.set("cache-control", "public, max-age=600");
    return new Response(r.body, { status: r.status, headers: h });
  }

  return new Response(await r.text(), { status: r.status, headers: h });
}

/* ----------------------------- API Layer ---------------------------- */

async function handleStatus(env: Env, corsHeaders: Record<string,string>) {
  const presale = parseFloat(env.PRESALE_PRICE_USDC || "0");
  const discount_bps = parseInt(env.DISCOUNT_BPS || "1000", 10);

  return JSON_OK({
    rpc_url: primaryRpc(env.SOLANA_RPC),
    inpi_mint: env.INPI_MINT,
    usdc_mint: env.USDC_MINT,

    presale_state: env.PRESALE_STATE || "pre",
    tge_ts: parseInt(env.TGE_TS || "0", 10) || null,

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
  }, 200, corsHeaders);
}

async function handleBalances(env: Env, url: URL, corsHeaders: Record<string,string>) {
  const wallet = url.searchParams.get("wallet") || "";
  if (!wallet) return JSON_OK({ error: "wallet required" }, 400, corsHeaders);

  try {
    // minimale Base58-Validierung (grobe Form)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(wallet)) {
      return JSON_OK({ usdc:{uiAmount:0}, inpi:{uiAmount:0}, gate_ok:false, error:"invalid wallet" }, 200, corsHeaders);
    }

    const [usdc, inpi, gate] = await Promise.all([
      getTokenUiAmount(env, wallet, env.USDC_MINT),
      getTokenUiAmount(env, wallet, env.INPI_MINT),
      hasNft(env, wallet, env.GATE_NFT_MINT)
    ]);
    return JSON_OK({ usdc: { uiAmount: usdc }, inpi: { uiAmount: inpi }, gate_ok: !!gate }, 200, corsHeaders);
  } catch (e: any) {
    // WICHTIG: nie 500 – immer 200 mit erklärendem Feld
    return JSON_OK({
      usdc:{ uiAmount: 0 },
      inpi:{ uiAmount: 0 },
      gate_ok:false,
      server_error: String(e?.message || e)
    }, 200, corsHeaders);
  }
}

async function handleClaimStatus(env: Env, url: URL, corsHeaders: Record<string,string>) {
  const wallet = url.searchParams.get("wallet") || "";
  if (!wallet) return JSON_OK({ error:"wallet required" }, 400, corsHeaders);
  const raw = await env.KV_CLAIMS.get(`claimable:${wallet}`);
  return JSON_OK({ pending_inpi: raw ? parseFloat(raw) : 0 }, 200, corsHeaders);
}

/**
 * Presale-Intent:
 *  - Body akzeptiert:
 *      { wallet, amount_usdc } ODER { wallet, amount_inpi }
 *    Wenn amount_inpi angegeben → USDC wird serverseitig berechnet (inkl. optionalem NFT-Rabatt).
 *  - Antwort enthält ZWEI QR-Pakete:
 *      1) qr_contribute  (USDC-Betrag für den Presale)
 *      2) qr_early_fee   (1 USDC Early-Claim-Fee; nur nützlich, wenn der User sofort claimen will)
 */
async function handlePresaleIntent(env: Env, req: Request, corsHeaders: Record<string,string>) {
  const body = await req.json().catch(()=>({}));
  const wallet = String(body?.wallet || "");
  let amount_usdc = Number(body?.amount_usdc || 0);
  const amount_inpi = Number(body?.amount_inpi || 0);
  const kind = String(body?.kind || "presale");

  if (!wallet) return JSON_OK({ error:"wallet required" }, 400, corsHeaders);
  if (amount_usdc <= 0 && amount_inpi <= 0) return JSON_OK({ error:"amount_usdc or amount_inpi required" }, 400, corsHeaders);

  // Preis ermitteln
  const base = parseFloat(env.PRESALE_PRICE_USDC || "0");
  const discBps = parseInt(env.DISCOUNT_BPS || "1000", 10);
  const hasGate = await hasNft(env, wallet, env.GATE_NFT_MINT).catch(()=>false);
  const price_active = Number.isFinite(base) && base > 0
    ? roundUsdc( base * (hasGate ? (1 - (discBps||0)/10000) : 1) )
    : NaN;

  // amount_usdc aus amount_inpi berechnen, wenn nötig
  if (amount_usdc <= 0 && Number.isFinite(price_active)) {
    amount_usdc = roundUsdc(amount_inpi * price_active);
  }
  if (!Number.isFinite(amount_usdc) || amount_usdc <= 0) {
    return JSON_OK({ error:"invalid amount_usdc" }, 400, corsHeaders);
  }

  // Caps prüfen
  const minCap = env.PRESALE_MIN_USDC ? parseFloat(env.PRESALE_MIN_USDC) : null;
  const maxCap = env.PRESALE_MAX_USDC ? parseFloat(env.PRESALE_MAX_USDC) : null;
  if (minCap != null && amount_usdc < minCap) return JSON_OK({ error:`min ${minCap} USDC` }, 400, corsHeaders);
  if (maxCap != null && amount_usdc > maxCap) return JSON_OK({ error:`max ${maxCap} USDC` }, 400, corsHeaders);

  // Referenz + Memo
  const mode = kind === "early-claim" ? "early-claim" : "presale";
  const ref = randomRef();
  const memo_contrib = `INPI-${mode}-${ref}`;

  // 1) Hauptzahlung (Presale) → Solana Pay URL + QR
  const payUrl = solanaPayURL(env.CREATOR, amount_usdc, env.USDC_MINT, memo_contrib, "INPI Presale", "INPI Presale Deposit");
  const qr_contribute = {
    solana_pay_url: payUrl,
    qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`,
    ...walletLinks(payUrl),
    amount_usdc: amount_usdc
  };

  // 2) Early-Claim-Fee (optional) – gleich mitliefern
  const feeAmount = parseFloat(env.EARLY_FLAT_USDC || "1.0");
  const memo_fee = `INPI-early-claim-${ref}`;
  const feeUrl = solanaPayURL(env.CREATOR, feeAmount, env.USDC_MINT, memo_fee, "INPI Early Claim", "INPI Early Claim Fee");
  const qr_early_fee = {
    solana_pay_url: feeUrl,
    qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(feeUrl)}`,
    ...walletLinks(feeUrl),
    amount_usdc: feeAmount
  };

  // Intent speichern
  await env.KV_PRESALE.put(
    `intent:${ref}`,
    JSON.stringify({
      ref,
      wallet,
      kind: mode,
      amount_usdc,
      price_used_usdc: Number.isFinite(price_active) ? price_active : null,
      gate_ok: hasGate,
      created_at: Date.now(),
      memo: memo_contrib,
      status: "pending"
    }),
    { expirationTtl: 60*60*24*7 }
  );

  return JSON_OK({ ok:true, ref, memo: memo_contrib, qr_contribute, qr_early_fee }, 200, corsHeaders);
}

async function handlePresaleCheck(env: Env, url: URL, corsHeaders: Record<string,string>) {
  const ref = url.searchParams.get("ref") || "";
  if (!ref) return JSON_OK({ error:"ref required" }, 400, corsHeaders);

  const k = `intent:${ref}`;
  const raw = await env.KV_PRESALE.get(k);
  if (!raw) return JSON_OK({ error:"unknown ref" }, 404, corsHeaders);
  const intend = JSON.parse(raw);

  try {
    const sigs = await rpcReqAny(env, "getSignaturesForAddress", [env.USDC_VAULT_ATA, { limit: 80 }]);
    for (const s of (sigs || [])) {
      const tx = await rpcReqAny(env, "getTransaction", [s.signature, { maxSupportedTransactionVersion: 0 }]).catch(()=>null);
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
        return JSON_OK({ status:"settled", signature: s.signature }, 200, corsHeaders);
      }
    }
    return JSON_OK({ status:"pending" }, 200, corsHeaders);
  } catch (e:any) {
    return JSON_OK({ status:"unknown", error:String(e?.message||e) }, 200, corsHeaders);
  }
}

async function handleEarlyIntent(env: Env, req: Request, corsHeaders: Record<string,string>) {
  const { wallet } = await req.json().catch(()=>({}));
  if (!wallet) return JSON_OK({ error:"wallet required" }, 400, corsHeaders);

  const ref = randomRef();
  const memo = `INPI-early-claim-${ref}`;
  const amount = parseFloat(env.EARLY_FLAT_USDC || "1.0");
  const payUrl = solanaPayURL(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
  const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;

  await env.KV_CLAIMS.put(
    `early:${wallet}`,
    JSON.stringify({ wallet, ref, memo, amount, status:"pending", created_at: Date.now() }),
    { expirationTtl: 60*60*24*30 }
  );

  return JSON_OK({ ok:true, ref, qr_url, solana_pay_url: payUrl, ...walletLinks(payUrl) }, 200, corsHeaders);
}

async function handleClaimConfirm(env: Env, req: Request, corsHeaders: Record<string,string>) {
  const { wallet, fee_signature } = await req.json().catch(()=>({}));
  if (!wallet || !fee_signature) return JSON_OK({ error:"wallet & fee_signature required" }, 400, corsHeaders);

  const job_id = randomRef();
  await env.KV_CLAIMS.put(
    `job:${job_id}`,
    JSON.stringify({ wallet, fee_signature, queued_at: Date.now(), status: "queued" }),
    { expirationTtl: 60*60*24*3 }
  );

  return JSON_OK({ ok:true, job_id }, 200, corsHeaders);
}

async function handleRpcProxy(env: Env, req: Request, corsHeaders: Record<string,string>) {
  const body = await req.text();
  // für Proxy nehmen wir den PRIMARY
  const url = primaryRpc(env.SOLANA_RPC);
  const r = await fetch(url, { method: "POST", headers: { "content-type":"application/json" }, body });
  return new Response(await r.text(), { status: r.status, headers: { "content-type":"application/json", ...corsHeaders } });
}

/* ------------------------------ Worker ------------------------------ */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const corsHeaders = buildCors(env)(req.headers.get("origin"));

    // CORS Preflight (für API)
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Static mount (Pages unter /token)
    if (url.pathname === "/token" || url.pathname.startsWith("/token/")) {
      return serveTokenFromPages(env, req, url);
    }

    // ---- API Routing ----
    if (url.pathname.startsWith("/api/token/")) {
      try {
        if (url.pathname.endsWith("/api/token/status") && req.method === "GET")
          return await handleStatus(env, corsHeaders);

        if (url.pathname.endsWith("/api/token/wallet/balances") && req.method === "GET")
          return await handleBalances(env, url, corsHeaders);

        if (url.pathname.endsWith("/api/token/claim/status") && req.method === "GET")
          return await handleClaimStatus(env, url, corsHeaders);

        if (url.pathname.endsWith("/api/token/presale/intent") && req.method === "POST")
          return await handlePresaleIntent(env, req, corsHeaders);

        if (url.pathname.endsWith("/api/token/presale/check") && req.method === "GET")
          return await handlePresaleCheck(env, url, corsHeaders);

        if (url.pathname.endsWith("/api/token/claim/early-intent") && req.method === "POST")
          return await handleEarlyIntent(env, req, corsHeaders);

        if (url.pathname.endsWith("/api/token/claim/confirm") && req.method === "POST")
          return await handleClaimConfirm(env, req, corsHeaders);

        if (url.pathname.endsWith("/api/token/early-claim") && req.method === "POST")
          return await handleEarlyIntent(env, req, corsHeaders); // Back-Compat Alias

        if (url.pathname.endsWith("/api/token/rpc") && req.method === "POST")
          return await handleRpcProxy(env, req, corsHeaders);

        return JSON_OK({ error: "not found" }, 404, corsHeaders);
      } catch (e: any) {
        // nur der API-Fallback darf mal 500 sein – einzelne Handler liefern selbst 200 mit Fehlern
        return JSON_OK({ error: String(e?.message || e) }, 500, corsHeaders);
      }
    }

    // Fallback
    return new Response("Not Found", { status: 404 });
  }
};