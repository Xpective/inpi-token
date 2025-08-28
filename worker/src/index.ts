/* Cloudflare Worker: INPI Presale API */
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
    CAP_PER_WALLET_USDC: string;
    EARLY_CLAIM_ENABLED: string;
    EARLY_FLAT_USDC: string;
    TGE_TS: string;
  
    SOLANA_RPC: string;
    ALLOWED_ORIGINS: string;
  }
  
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
    const origins = env.ALLOWED_ORIGINS.split(",").map(s => s.trim());
    return (origin?: string) => ({
      "access-control-allow-origin": origin && origins.includes(origin) ? origin : origins[0] || "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400"
    });
  };
  
  function randomRef(): string {
    // 16 bytes hex
    const arr = crypto.getRandomValues(new Uint8Array(16));
    return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  
  function buildSolanaPayUrl(recipient: string, amount: number, usdcMint: string, memo: string, label = "INPI Presale", message = "INPI Presale Deposit"): string {
    const u = new URL(`solana:${recipient}`);
    u.searchParams.set("amount", amount.toString());
    u.searchParams.set("spl-token", usdcMint);
    u.searchParams.set("label", label);
    u.searchParams.set("message", message);
    u.searchParams.set("memo", memo);
    return u.toString();
  }
  
  async function proxyRpc(env: Env, req: Request, origin: string) {
    // Forward JSON-RPC to Solana (fix CORS)
    const body = await req.text();
    const r = await fetch(env.SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    const corsHeaders = cors(env)(origin);
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json", ...corsHeaders }
    });
  }
  
  export default {
    async fetch(req: Request, env: Env): Promise<Response> {
      const { pathname, searchParams, origin } = new URL(req.url);
      const corsHeaders = cors(env)(req.headers.get("origin") || undefined);
  
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }
  
      // routes
      if (pathname.endsWith("/api/token/config") && req.method === "GET") {
        const data = {
          inpi_mint: env.INPI_MINT,
          usdc_mint: env.USDC_MINT,
          creator: env.CREATOR,
          usdc_vault_ata: env.USDC_VAULT_ATA,
          presale_state: env.PRESALE_STATE,
          presale_price_usdc: parseFloat(env.PRESALE_PRICE_USDC),
          public_price_usdc: parseFloat(env.PUBLIC_PRICE_USDC),
          cap_per_wallet_usdc: parseFloat(env.CAP_PER_WALLET_USDC),
          early_claim_enabled: env.EARLY_CLAIM_ENABLED === "true",
          early_flat_usdc: parseFloat(env.EARLY_FLAT_USDC),
          tge_ts: parseInt(env.TGE_TS, 10),
          inpi_json: "https://inpinity.online/token/inpi.json"
        };
        return json(data, 200, corsHeaders);
      }
  
      if (pathname.endsWith("/api/token/presale/intent") && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { wallet, amount_usdc, kind } = body; // kind: "presale" | "early-claim"
        if (!wallet || !amount_usdc) return json({ error: "wallet & amount_usdc required" }, 400, corsHeaders);
  
        const safeKind = kind === "early-claim" ? "early-claim" : "presale";
        const ref = randomRef();
        const memo = `INPI-${safeKind}-${ref}`;
        const url = buildSolanaPayUrl(env.CREATOR, Number(amount_usdc), env.USDC_MINT, memo);
  
        const record = {
          ref,
          wallet,
          kind: safeKind,
          amount_usdc: Number(amount_usdc),
          created_at: Date.now(),
          memo,
          status: "pending"
        };
        await env.KV_PRESALE.put(`intent:${ref}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 7 }); // 7d
        return json({ ref, url, memo }, 200, corsHeaders);
      }
  
      if (pathname.endsWith("/api/token/presale/check") && req.method === "GET") {
        const ref = searchParams.get("ref") || "";
        if (!ref) return json({ error: "ref required" }, 400, corsHeaders);
  
        const key = `intent:${ref}`;
        const saved = await env.KV_PRESALE.get(key);
        if (!saved) return json({ error: "unknown ref" }, 404, corsHeaders);
        const intend = JSON.parse(saved);
  
        // naive check: scan signatures for vault ATA; fetch tx and look for memo & USDC transfer
        const rpcReq = (method: string, params: any[]) => fetch(env.SOLANA_RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
        }).then(r => r.json());
  
        // 1) latest signatures for vault ATA
        const sigs = await rpcReq("getSignaturesForAddress", [env.USDC_VAULT_ATA, { limit: 40 }]);
        if (!sigs.result) return json({ status: "pending" }, 200, corsHeaders);
  
        // 2) pull tx details and check memo + USDC mint move
        for (const s of sigs.result) {
          const tx = await rpcReq("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0 }]);
          const meta = tx?.result?.meta;
          const log = tx?.result?.meta?.logMessages?.join("\n") || "";
          const inner = tx?.result?.transaction?.message?.instructions || [];
          const memoFound =
            (meta?.logMessages?.some((l: string) => l.includes(intend.memo))) ||
            JSON.stringify(inner).includes(intend.memo);
  
          if (!memoFound) continue;
  
          // quick mint check via pre/post token balances
          const pre = meta?.preTokenBalances || [];
          const post = meta?.postTokenBalances || [];
          const mintOk =
            [...pre, ...post].some((b: any) => b.mint === env.USDC_MINT);
  
          if (mintOk) {
            intend.status = "settled";
            intend.signature = s.signature;
            intend.settled_at = Date.now();
            await env.KV_PRESALE.put(key, JSON.stringify(intend), { expirationTtl: 60 * 60 * 24 * 60 }); // 60d
            return json({ status: "settled", signature: s.signature }, 200, corsHeaders);
          }
        }
  
        return json({ status: "pending" }, 200, corsHeaders);
      }
  
      if (pathname.endsWith("/api/token/early-claim") && req.method === "POST") {
        const { wallet } = await req.json().catch(() => ({}));
        if (!wallet) return json({ error: "wallet required" }, 400, corsHeaders);
  
        const ref = randomRef();
        const memo = `INPI-early-claim-${ref}`;
        const amount = parseFloat(env.EARLY_FLAT_USDC || "1");
        const url = buildSolanaPayUrl(env.CREATOR, amount, env.USDC_MINT, memo, "INPI Early Claim", "INPI Early Claim Fee");
  
        await env.KV_CLAIMS.put(`early:${wallet}`, JSON.stringify({ wallet, ref, memo, amount, status: "pending", created_at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 30 });
        return json({ ref, url, memo, amount_usdc: amount }, 200, corsHeaders);
      }
  
      if (pathname.endsWith("/api/token/rpc") && req.method === "POST") {
        return proxyRpc(env, req, req.headers.get("origin") || "");
      }
  
      return json({ error: "not found" }, 404, corsHeaders);
    }
  };