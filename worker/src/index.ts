/* =======================================================================
   FILE: worker/src/index.ts
   Desc: Worker – API + /token Pages-Proxy + RPC failover (incl. Helius)
   ======================================================================= */

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  KV_PRESALE: KVNamespace;
  KV_CLAIMS: KVNamespace;

  USDC_MINT: string;
  INPI_MINT: string;
  CREATOR: string;
  USDC_VAULT_ATA: string;

  PRESALE_STATE: string;
  PRESALE_PRICE_USDC: string;
  PUBLIC_PRICE_USDC: string;
  DISCOUNT_BPS?: string;

  PRESALE_MIN_USDC?: string;
  PRESALE_MAX_USDC?: string;

  EARLY_CLAIM_ENABLED: string;
  EARLY_FLAT_USDC: string;

  TGE_TS: string;
  AIRDROP_BONUS_BPS?: string;
  GATE_NFT_MINT?: string;

  SOLANA_RPC: string;
  SOLANA_RPC_FALLBACKS?: string;   // Komma-separiert
  HELIUS_API_KEY?: string;         // optional, generiert zusätzlichen Fallback

  ALLOWED_ORIGINS: string;
  PAGES_UPSTREAM: string; // z.B. https://inpi-token.pages.dev (oder Preview)
}

/* ---------------- helpers ---------------- */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": "no-store", ...extra }
  });

/* ---- CORS mit Wildcards (z.B. https://*.inpi-token.pages.dev) ---- */
function originMatches(origin: string, pattern: string): boolean {
  if (pattern === "*") return true;
  try {
    const u = new URL(origin);
    const p = new URL(pattern.replace("*.", "TEMPSTAR.")); // Dummy für Schema/Host
    // Gleiche Schemes erzwingen
    if (u.protocol !== p.protocol) return false;
    const hostPat = pattern.split("://")[1] || pattern;
    if (hostPat.startsWith("*.")) {
      const suffix = hostPat.slice(1); // ".inpi-token.pages.dev"
      return u.hostname.endsWith(suffix);
    }
    return u.hostname === p.hostname;
  } catch { return false; }
}
const cors = (env: Env) => {
  const patterns = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(s=>s.trim())
    .filter(Boolean);
  return (origin?: string) => {
    if (!origin || patterns.includes("*")) {
      return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
    }
    const ok = patterns.some(p => originMatches(origin, p));
    return {
      "access-control-allow-origin": ok ? origin : patterns[0] || "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400"
    };
  };
};

function randomRef(): string {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map(b=>b.toString(16).padStart(2,"0")).join("");
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

/* ---- RPC mit Failover (env.SOLANA_RPC → SOLANA_RPC_FALLBACKS → Helius/Key) ---- */
function rpcCandidates(env: Env): string[] {
  const list: string[] = [];
  if (env.SOLANA_RPC) list.push(env.SOLANA_RPC);
  if (env.SOLANA_RPC_FALLBACKS) {
    for (const u of env.SOLANA_RPC_FALLBACKS.split(",").map(s=>s.trim()).filter(Boolean)) list.push(u);
  }
  if (env.HELIUS_API_KEY) list.push(`https://rpc.helius.xyz/?api-key=${env.HELIUS_API_KEY}`);
  // zum Schluss noch public RPC
  list.push("https://api.mainnet-beta.solana.com");
  // Deduplizieren, Reihenfolge beibehalten
  return Array.from(new Set(list));
}
async function rpcTry(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: JSON_HEADERS as any,
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
  });
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch {
    throw new Error(`RPC parse error (${url}): ${t.slice(0,200)}`);
  }
  if (!r.ok || j?.error) {
    throw new Error(j?.error ? `${j.error.code}: ${j.error.message}` : `HTTP ${r.status}: ${t.slice(0,200)}`);
  }
  return j.result;
}
async function rpcReq(env: Env, method: string, params: unknown[]) {
  const candidates = rpcCandidates(env);
  let lastErr: any = null;
  for (const url of candidates){
    try { return await rpcTry(url, method, params); }
    catch (e){ lastErr = e; }
  }
  throw lastErr || new Error("All RPC candidates failed");
}

async function getTokenUiAmount(env: Env, owner: string, mint: string): Promise<number> {
  try{
    const res = await rpcReq(env, "getParsedTokenAccountsByOwner", [owner, { mint }, { commitment:"confirmed" }]);
    let total = 0;
    for (const v of (res?.value || [])) {
      const amt = v?.account?.data?.parsed?.info?.tokenAmount;
      total += Number(amt?.uiAmount ?? 0);
    }
    return total;
  } catch { return 0; }
}

async function hasNft(env: Env, owner: string, mint?: string): Promise<boolean> {
  if (!mint) return false;
  return (await getTokenUiAmount(env, owner, mint)) > 0;
}

/* ------------- Proxy: /token → Pages (Dual-Pfad + MIME-Schutz) ------------- */
const STATIC_RE = /\.(?:js|css|json|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)(?:\?.*)?$/i;
const MIME_BY_EXT: Record<string,string> = {
  ".js":  "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg":"image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp":"image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff":"font/woff",
  ".woff2":"font/woff2"
};
function extname(path: string){
  const m = path.match(/(\.[a-z0-9]+)(?:\?.*)?$/i);
  return m ? m[1].toLowerCase() : "";
}
function isStatic(path: string){ return STATIC_RE.test(path); }

async function fetchUpstream(url: string, req: Request) {
  return fetch(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET","HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
    redirect: "manual"
  });
}
async function chooseStatic(env: Env, req: Request, origPath: string, search: string): Promise<Response> {
  // Kandidaten: keep (/token/..) und strip (/..)
  const keep = origPath;
  const strip = origPath.replace(/^\/token(?=\/|$)/, "") || "/";
  const candidates = [keep, strip];
  for (let i=0;i<candidates.length;i++){
    const target = new URL(candidates[i] + search, env.PAGES_UPSTREAM);
    const r = await fetchUpstream(target.toString(), req);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const ext = extname(candidates[i]);

    // HTML? Dann ist es vermutlich der SPA-Fallback → weiter probieren
    if (ct.includes("text/html")) {
      if (i < candidates.length-1) continue;
      // letzte Chance: wenn Body tatsächlich kein HTML (falsch getaggter MIME)
      const buf = await r.arrayBuffer();
      const textStart = new TextDecoder().decode(new Uint8Array(buf).slice(0, 32)).trim();
      const looksHtml = textStart.startsWith("<");
      if (looksHtml) return r; // echtes HTML → zurückgeben
      const h = new Headers(r.headers);
      h.set("content-type", MIME_BY_EXT[ext] || "application/octet-stream");
      h.set("cache-control", "public, max-age=600");
      return new Response(buf, { status: r.status, headers: h });
    }

    // Nicht-HTML: sauberen MIME setzen (falls CDN Mist liefert)
    const h = new Headers(r.headers);
    h.set("content-type", MIME_BY_EXT[ext] || h.get("content-type") || "application/octet-stream");
    h.set("cache-control", "public, max-age=600");
    return new Response(r.body, { status: r.status, headers: h });
  }
  // sollte nie hier landen
  return new Response("Not found", { status:404 });
}

async function proxyPages(env: Env, req: Request, url: URL): Promise<Response> {
  // /token → /token/ (damit relative Pfade in HTML stimmen)
  if (url.pathname === "/token" && req.method === "GET")
    return Response.redirect(url.origin + "/token/", 301);

  // Statische Assets immer streng behandeln
  if (isStatic(url.pathname)) {
    return chooseStatic(env, req, url.pathname, url.search);
  }

  // HTML/sonstige: keep-Pfad + Umschreiben
  const target = new URL(url.pathname + url.search, env.PAGES_UPSTREAM);
  let r = await fetchUpstream(target.toString(), req);

  if (r.status>=300 && r.status<400) {
    const loc = r.headers.get("location");
    if (loc && loc.startsWith("/")) {
      const h = new Headers(r.headers);
      h.set("location", "/token" + (loc.startsWith("/token") ? loc.slice(6) : loc));
      return new Response(null, { status: r.status, headers: h });
    }
    return r;
  }

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const h = new Headers(r.headers);

  if (ct.includes("text/html")) {
    let html = await r.text();

    // Root-absolute → /token/… (wenn nicht schon /token/)
    html = html
      .replace(/(href|src|action)=["']\/(?!token\/)/g, '$1="/token/')
      .replace(/data-(href|src)=["']\/(?!token\/)/g, 'data-$1="/token/');

    // <base href="/token/"> injizieren, falls nicht vorhanden
    if (html.includes("<head") && !/base\s+href=/i.test(html)) {
      html = html.replace("<head>", '<head><base href="/token/">');
    }

    h.set("content-type", "text/html; charset=utf-8");
    h.delete("content-length");
    return new Response(html, { status: r.status, headers: h });
  }

  // Non-HTML (selten) → liefern
  if (r.ok) {
    return new Response(r.body, { status: r.status, headers: h });
  }
  return r;
}

/* ---------------- worker ---------------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const corsHeaders = cors(env)(req.headers.get("origin") || undefined);

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // Static mount
    if (url.pathname === "/token" || url.pathname.startsWith("/token/"))
      return proxyPages(env, req, url);

    // ---- API: status
    if (url.pathname.endsWith("/api/token/status") && req.method === "GET") {
      const presale = parseFloat(env.PRESALE_PRICE_USDC || "0");
      const discount_bps = parseInt(env.DISCOUNT_BPS || "1000", 10);
      return json({
        // Wichtig: gib Primary aus; Fallbacks handled Frontend + Worker intern
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
      }, 200, corsHeaders);
    }

    // ---- API: wallet/balances
    if (url.pathname.endsWith("/api/token/wallet/balances") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);
      try {
        const [usdc, inpi, gate] = await Promise.all([
          getTokenUiAmount(env, wallet, env.USDC_MINT),
          getTokenUiAmount(env, wallet, env.INPI_MINT),
          hasNft(env, wallet, env.GATE_NFT_MINT)
        ]);
        return json({ usdc:{ uiAmount: usdc }, inpi:{ uiAmount: inpi }, gate_ok: !!gate }, 200, corsHeaders);
      } catch (e:any) {
        return json({ usdc:{ uiAmount: 0 }, inpi:{ uiAmount: 0 }, gate_ok:false, error:String(e?.message||e) }, 200, corsHeaders);
      }
    }

    // ---- API: claim/status
    if (url.pathname.endsWith("/api/token/claim/status") && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return json({ error:"wallet required" }, 400, corsHeaders);
      const raw = await env.KV_CLAIMS.get(`claimable:${wallet}`);
      return json({ pending_inpi: raw ? parseFloat(raw) : 0 }, 200, corsHeaders);
    }

    // ---- API: presale/intent
    if (url.pathname.endsWith("/api/token/presale/intent") && req.method === "POST") {
      const { wallet, amount_usdc, kind } = await req.json().catch(()=>({}));
      if (!wallet || !amount_usdc) return json({ error:"wallet & amount_usdc required" }, 400, corsHeaders);
      const mode = kind === "early-claim" ? "early-claim" : "presale";
      const ref = randomRef(); const memo = `INPI-${mode}-${ref}`;
      const payUrl = solanaPay(env.CREATOR, Number(amount_usdc), env.USDC_MINT, memo);
      await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify({
        ref, wallet, kind: mode, amount_usdc: Number(amount_usdc), created_at: Date.now(), memo, status:"pending"
      }), { expirationTtl: 60*60*24*7 });
      const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payUrl)}`;
      return json({ ok:true, ref, memo, qr_contribute:{ qr_url, solana_pay_url: payUrl } }, 200, corsHeaders);
    }

    // ---- API: presale/check
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
            intend.status = "settled"; intend.signature = s.signature; intend.settled_at = Date.now();
            await env.KV_PRESALE.put(k, JSON.stringify(intend), { expirationTtl: 60*60*24*60 });
            return json({ status:"settled", signature: s.signature }, 200, corsHeaders);
          }
        }
        return json({ status:"pending" }, 200, corsHeaders);
      } catch (e:any) {
        return json({ status:"unknown", error:String(e?.message||e) }, 200, corsHeaders);
      }
    }

    // ---- API: claim/early-intent
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

    // ---- API: claim/confirm
    if (url.pathname.endsWith("/api/token/claim/confirm") && req.method === "POST") {
      const { wallet, fee_signature } = await req.json().catch(()=>({}));
      if (!wallet || !fee_signature) return json({ error:"wallet & fee_signature required" }, 400, corsHeaders);
      const job_id = randomRef();
      await env.KV_CLAIMS.put(`job:${job_id}`, JSON.stringify({ wallet, fee_signature, queued_at: Date.now(), status: "queued" }), { expirationTtl: 60*60*24*3 });
      return json({ ok:true, job_id }, 200, corsHeaders);
    }

    // ---- API: backward compat
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

    // ---- API: generic RPC proxy
    if (url.pathname.endsWith("/api/token/rpc") && req.method === "POST") {
      const body = await req.text();
      // Versuche alle Kandidaten nacheinander
      const candidates = rpcCandidates(env);
      for (let i=0;i<candidates.length;i++){
        try{
          const r = await fetch(candidates[i], { method:"POST", headers: JSON_HEADERS as any, body });
          const text = await r.text();
          return new Response(text, { status: r.status, headers: { ...JSON_HEADERS, ...corsHeaders } });
        }catch{/* try next */}
      }
      return json({ error:"All RPC candidates failed" }, 500, corsHeaders);
    }

    return json({ error:"not found" }, 404, corsHeaders);
  }
};
