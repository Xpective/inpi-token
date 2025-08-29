(function(){
  const CFG = { API: null, INPI:null, USDC:null, GATE:null };
  const $ = s=>document.querySelector(s);
  const el = id=>document.getElementById(id);
  const fmt = (n,d=2)=> Number(n||0).toLocaleString("de-DE",{maximumFractionDigits:d});
  const fmti= n=> Number(n||0).toLocaleString("de-DE");
  const now = ()=> Math.floor(Date.now()/1000);

  let STATE = {
    rpc: null, inpi: null, usdc: null,
    presale: "pre", tge: null,
    min:null, max:null,
    pWith:null, pWo:null, gate:false,
    early:{enabled:false, flat:1, fee_dest:null},
    airdrop_bps: 600,
    supply: 3141592653, dist: {},
    deposit_ata:null, deposit_owner:null
  };

  let conn=null, provider=null, pubkey=null;

  async function loadCfg(){
    const r = await fetch("./app-cfg.json?v="+(window.__INPI_VER__||Date.now()));
    const c = await r.json();
    CFG.API  = c.API_BASE;
    CFG.INPI = c.INPI_MINT;
    CFG.USDC = c.USDC_MINT;
    CFG.GATE = c.GATE_NFT_MINT || c.GATE_MINT || "";

    // marketplace / explorer links
    const lnTensor = el("lnTensor"); if (lnTensor) lnTensor.href = "https://www.tensor.trade/item/"+encodeURIComponent(CFG.GATE);
    const lnME     = el("lnME");     if (lnME)     lnME.href     = "https://magiceden.io/item-details/"+encodeURIComponent(CFG.GATE);
    const lnInpiSS = el("lnInpiSS"); if (lnInpiSS) lnInpiSS.href = "https://solscan.io/token/"+encodeURIComponent(CFG.INPI);
    const lnUsdcSS = el("lnUsdcSS"); if (lnUsdcSS) lnUsdcSS.href = "https://solscan.io/token/"+encodeURIComponent(CFG.USDC);
  }

  async function status(){
    const r = await fetch(`${CFG.API}/status?t=${Date.now()}`);
    const j = await r.json();
    STATE.rpc = j.rpc_url;
    STATE.inpi= j.inpi_mint || CFG.INPI;
    STATE.usdc= j.usdc_mint || CFG.USDC;
    STATE.presale = j.presale_state || "pre";
    STATE.tge = j.tge_ts || null;
    STATE.deposit_ata = j.deposit_usdc_ata || null;
    STATE.deposit_owner = j.deposit_usdc_owner || null;
    STATE.min = j.presale_min_usdc ?? null;
    STATE.max = j.presale_max_usdc ?? null;

    const base = Number(j.presale_price_usdc || 0);
    const disc = Number(j.discount_bps || 0);
    STATE.pWo = base || null;
    STATE.pWith = base ? Math.round(base*(1-disc/10000)*1e6)/1e6 : null;

    STATE.early.enabled = !!(j.early_claim?.enabled);
    STATE.early.flat    = Number(j.early_claim?.flat_usdc || 1);
    STATE.early.fee_dest= j.early_claim?.fee_dest_wallet || STATE.deposit_ata || null;
    STATE.airdrop_bps   = Number(j.airdrop_bonus_bps || 600);

    STATE.supply = Number(j.supply_total || 3141592653);
    STATE.dist = {
      presale: j.dist_presale_bps || 1000,
      dex:     j.dist_dex_liquidity_bps || 2000,
      staking: j.dist_staking_bps || 700,
      eco:     j.dist_ecosystem_bps || 2000,
      tre:     j.dist_treasury_bps || 1500,
      team:    j.dist_team_bps || 1000,
      aird:    j.dist_airdrop_nft_bps || 1000,
      buy:     j.dist_buyback_reserve_bps || 800
    };

    const st = el("st");     if (st) st.textContent = STATE.presale;
    const ata = el("ata");   if (ata) ata.textContent = STATE.deposit_ata || "—";
    const own = el("owner"); if (own) own.textContent = STATE.deposit_owner || "—";

    renderPrice();
    renderTGE();
    renderTokenomics();
    const earlyBox = el("early"); if (earlyBox) earlyBox.style.display = STATE.early.enabled ? "block" : "none";
  }

  function renderPrice(){
    const active = currentPrice();
    const txt = [
      "mit NFT:", STATE.pWith? STATE.pWith.toFixed(6)+" USDC":"–",
      "• ohne NFT:", STATE.pWo? STATE.pWo.toFixed(6)+" USDC":"–",
      "• aktiv:", active? active.toFixed(6)+" USDC":"–"
    ].join(" ");
    const p = el("price"); if (p) p.textContent = txt;
    const badge = el("gateBadge");
    if (badge) badge.textContent = STATE.gate ? "(NFT-Rabatt aktiv ✓)" : "(kein NFT-Rabatt)";
  }

  function renderTGE(){
    const n = el("tge");
    if (!n) return;
    if (!STATE.tge){ n.textContent="tbd"; return; }
    const secs = Math.max(0, STATE.tge - now());
    const d=Math.floor(secs/86400), h=Math.floor(secs%86400/3600), m=Math.floor(secs%3600/60), s=secs%60;
    n.textContent = `${d}d ${h}h ${m}m ${s}s`;
  }
  setInterval(()=>STATE.tge && renderTGE(), 1000);

  function renderTokenomics(){
    const t = el("tot"); if (t) t.textContent = fmti(STATE.supply);
    const rows = [
      ["Presale", STATE.dist.presale],
      ["DEX Liquidity", STATE.dist.dex],
      ["Staking", STATE.dist.staking],
      ["Ecosystem", STATE.dist.eco],
      ["Treasury", STATE.dist.tre],
      ["Team", STATE.dist.team],
      ["Airdrop (NFT)", STATE.dist.aird],
      ["Buyback Reserve", STATE.dist.buy]
    ];
    let pres=0, html="";
    rows.forEach(([name,bps])=>{
      const pct = (bps/100).toFixed(2)+"%";
      const inpi = Math.floor(STATE.supply*(bps/10000));
      if (name==="Presale") pres=inpi;
      html += `<tr><td>${name}</td><td>${fmti(bps)}</td><td>${pct}</td><td>${fmti(inpi)}</td></tr>`;
    });
    const tbody = el("trows");
    if (tbody) tbody.innerHTML = html;
    const presTxt = el("pres");
    if (presTxt) presTxt.textContent = `${fmti(pres)} INPI (${(STATE.dist.presale/100).toFixed(2)}%)`;
  }

  // Phantom
  function getProvider(){
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
    return null;
  }

  // QR
  async function drawQR(canvas, text){
    if (!canvas || !text) return;
    await window.QRCode.toCanvas(canvas, text, { width: 240, margin:1 });
  }

  // ======= NEW: On-chain helpers (SPL + Token-2022 Fallback) =======
  async function getTokenUiAmountOnChain(ownerStr, mintStr){
    if (!conn) return 0;
    try{
      const owner = new window.solanaWeb3.PublicKey(ownerStr);
      const mint  = new window.solanaWeb3.PublicKey(mintStr);
      let total = 0;

      // klassisches SPL via mint
      const res1 = await conn.getParsedTokenAccountsByOwner(owner, { mint }, { commitment: "confirmed" });
      for (const v of (res1?.value||[])){
        const amt = v?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        total += Number(amt || 0);
      }
      if (total > 0) return total;

      // Token-2022 via programId + Filter auf mint
      const prog2022 = new window.solanaWeb3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
      const res2 = await conn.getParsedTokenAccountsByOwner(owner, { programId: prog2022 }, { commitment: "confirmed" });
      for (const v of (res2?.value||[])){
        const info = v?.account?.data?.parsed?.info;
        if (info?.mint === mintStr){
          total += Number(info?.tokenAmount?.uiAmount || 0);
        }
      }
      return total;
    } catch { return 0; }
  }
  async function hasNftOnChain(ownerStr, nftMintStr){
    if (!ownerStr || !nftMintStr) return false;
    const amt = await getTokenUiAmountOnChain(ownerStr, nftMintStr).catch(()=>0);
    return amt > 0;
  }

  // ======= NEW: robustere Preiswahl (mit/ohne NFT) =======
  function currentPrice(){
    const w  = STATE.pWith; // Preis mit NFT
    const wo = STATE.pWo;   // Preis ohne NFT
    return STATE.gate
      ? (Number.isFinite(w)  ? w  : wo)
      : (Number.isFinite(wo) ? wo : w);
  }

  function updateExpected(){
    const amtEl = el("amt"), modeEl = el("mode"), expEl = el("exp");
    if (!amtEl || !modeEl || !expEl) return;
    const v = Number(amtEl.value || "0");
    const mode = modeEl.value;
    const p = currentPrice();
    if (!v || !p){ expEl.textContent="–"; return; }
    expEl.textContent = mode==="USDC" ? `${fmt(v/p,0)} INPI` : `~ ${fmt(v*p,6)} USDC`;
  }

  // ======= NEW: Balances + Gate (on-chain first, API fallback) =======
  async function refreshBalances(){
    if (!pubkey) return;

    const usdcNode = el("usdcBal") || el("usdc");
    const inpiNode = el("inpiBal") || el("inpi");

    // 1) On-chain first
    try{
      const usdcMint = STATE.usdc || CFG.USDC;
      const inpiMint = STATE.inpi || CFG.INPI;

      const [usdcOC, inpiOC] = await Promise.all([
        getTokenUiAmountOnChain(pubkey.toBase58(), usdcMint),
        getTokenUiAmountOnChain(pubkey.toBase58(), inpiMint),
      ]);

      if (usdcNode) usdcNode.textContent = fmt(usdcOC, 2);
      if (inpiNode) inpiNode.textContent = fmt(inpiOC, 0);

      // NFT-Gate check on-chain
      const gate = await hasNftOnChain(pubkey.toBase58(), CFG.GATE).catch(()=>false);
      STATE.gate = !!gate;

      renderPrice();
      updateExpected();
      return; // fertig
    } catch(e){
      // weiter zum API-Fallback
    }

    // 2) Fallback: API
    try{
      const url = `${CFG.API}/wallet/balances?wallet=${encodeURIComponent(pubkey.toBase58())}&t=${Date.now()}`;
      const r = await fetch(url, { headers:{accept:"application/json"}});
      const j = await r.json();

      const usdc = Number(j?.usdc?.uiAmount ?? 0);
      const inpi = Number(j?.inpi?.uiAmount ?? 0);
      if (usdcNode) usdcNode.textContent = fmt(usdc,2);
      if (inpiNode) inpiNode.textContent = fmt(inpi,0);

      STATE.gate = !!j?.gate_ok;
      renderPrice();
      updateExpected();
    } catch(e){
      // leise scheitern
    }
  }

  // Intent Flow (ohne Popup)
  async function onIntent(){
    if (!pubkey) return alert("Bitte Wallet verbinden.");
    if (STATE.presale==="closed") return alert("Presale ist geschlossen.");

    const amtEl = el("amt"), modeEl = el("mode"), msg = el("msg"), payRow = el("payRow");
    if (!amtEl || !modeEl) return;
    const v = Number(amtEl.value||"0");
    const mode = modeEl.value;
    if (!v || v<=0) return alert(`Bitte gültigen Betrag (${mode}) eingeben.`);
    if (mode==="USDC"){
      if (STATE.min!=null && v<STATE.min) return alert(`Mindestens ${STATE.min} USDC.`);
      if (STATE.max!=null && v>STATE.max) return alert(`Maximal ${STATE.max} USDC.`);
    }

    if (msg) msg.textContent = "Erzeuge QR …";
    if (payRow) payRow.style.display = "block";

    // 1) Optimistic QR (lokal)
    try{
      const recipient = STATE.deposit_owner || null;
      const price = currentPrice();
      const usdcAmount = mode==="USDC" ? v : Math.round((price*v)*1e6)/1e6;
      if (recipient && usdcAmount>0){
        const memo = "INPI-presale-pre-"+Math.random().toString(16).slice(2,10);
        const u = new URL(`solana:${recipient}`);
        u.searchParams.set("amount", String(usdcAmount));
        u.searchParams.set("spl-token", STATE.usdc);
        u.searchParams.set("label", "INPI Presale");
        u.searchParams.set("message", "INPI Presale Deposit");
        u.searchParams.set("memo", memo);
        await drawQR(el("qr"), u.toString());
        if (msg) msg.textContent = "QR bereit – bestätige Betrag vom Server …";
      }
    }catch{}

    // 2) Server-Intent
    try{
      const body = { wallet: pubkey.toBase58() };
      if (mode==="USDC") body.amount_usdc = Number(v);
      else body.amount_inpi = Number(v);

      const r = await fetch(`${CFG.API}/presale/intent?t=${Date.now()}`, {
        method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);

      // finaler QR
      const link = j.qr_contribute?.solana_pay_url || null;
      if (link) await drawQR(el("qr"), link);
      const used = j.qr_contribute?.amount_usdc ?? body.amount_usdc ?? null;
      if (msg) msg.textContent = used!=null ? `✅ Intent registriert. Bitte ${used} USDC senden.` : "✅ Intent registriert.";

      // optional Early-Fee QR inline
      if (j.qr_early_fee?.solana_pay_url){
        const earlyBox = el("early"); if (earlyBox) earlyBox.style.display = "block";
        const earRow = el("earRow");  if (earRow) earRow.style.display = "block";
        await drawQR(el("qrEarly"), j.qr_early_fee.solana_pay_url);
        const emsg = el("emsg"); if (emsg) emsg.textContent = `Optional: 1 USDC Early-Fee scannen.`;
      }
    }catch(e){
      if (msg) msg.textContent = "Intent fehlgeschlagen.";
      alert(String(e?.message||e));
    }
  }

  // Early flow (separat)
  async function startEarly(){
    if (!pubkey) return alert("Bitte Wallet verbinden.");
    if (!STATE.early.enabled) return alert("Early-Claim ist deaktiviert.");
    const earRow = el("earRow"); if (earRow) earRow.style.display = "block";
    const emsg = el("emsg"); if (emsg) emsg.textContent = "Erzeuge Early-QR …";
    const r = await fetch(`${CFG.API}/claim/early-intent?t=${Date.now()}`, {
      method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58() })
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) { alert(j?.error||"Fehler"); return; }
    await drawQR(el("qrEarly"), j.solana_pay_url);
    if (emsg) emsg.textContent = `Sende ${STATE.early.flat} USDC und bestätige unten die Signatur.`;
  }
  async function confirmEarly(){
    if (!pubkey) return alert("Wallet verbinden.");
    const sigEl = el("feeSig"); const emsg = el("emsg");
    const sig = (sigEl?.value||"").trim();
    if (!sig) return alert("Bitte Fee-Transaktions-Signatur eintragen.");
    if (emsg) emsg.textContent = "Prüfe Zahlung & queue Claim …";
    const r = await fetch(`${CFG.API}/claim/confirm?t=${Date.now()}`, {
      method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), fee_signature: sig })
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) { alert(j?.error||"Fehler"); if (emsg) emsg.textContent="Fehler bei Bestätigung."; return; }
    if (emsg) emsg.textContent = `✅ Claim eingereiht (Job ${j.job_id||"n/a"}).`;
  }

  function bindUI(){
    const btnHow = el("btnHow"); if (btnHow) btnHow.onclick = ()=> alert("Kurz: 1) Wallet verbinden  2) Betrag eingeben  3) QR scannen (USDC)  4) optional: Early-Fee 1 USDC scannen & Signatur bestätigen.");
    const btnIntent = el("btnIntent"); if (btnIntent) btnIntent.onclick = onIntent;
    const btnEarly  = el("btnEarly");  if (btnEarly)  btnEarly.onclick  = startEarly;
    const btnConfirm= el("btnConfirm");if (btnConfirm)btnConfirm.onclick= confirmEarly;
    const amt = el("amt"); if (amt) amt.oninput = updateExpected;
    const mode = el("mode"); if (mode) mode.onchange = updateExpected;
  }

  async function connectIfPossible(){
    provider = getProvider();
    const btn = el("btnConnect");
    const waddr = el("waddr");
    if (!provider){
      if (btn){ btn.textContent = "Phantom installieren"; btn.onclick = ()=> window.open("https://phantom.app","_blank","noopener"); }
      return;
    }
    if (btn){
      btn.disabled=false; btn.textContent="Verbinden";
      btn.onclick = async ()=>{
        try{
          const { publicKey } = await provider.connect();
          pubkey = publicKey;
          if (waddr) waddr.textContent = publicKey.toBase58();
          await refreshBalances();
        }catch(e){ alert("Wallet-Verbindung abgebrochen."); }
      };
    }
    // silent connect
    try{
      const res = await provider.connect({ onlyIfTrusted:true }).catch(()=>null);
      if (res?.publicKey){
        pubkey = res.publicKey;
        if (waddr) waddr.textContent = pubkey.toBase58();
        await refreshBalances();
      }
    }catch{}
    provider?.on?.("accountChanged", pk=>{
      if(!pk){ pubkey=null; if (waddr) waddr.textContent="—"; }
      else { pubkey=pk; if (waddr) waddr.textContent=pk.toBase58(); refreshBalances(); }
    });
    provider?.on?.("disconnect", ()=>{ pubkey=null; if (waddr) waddr.textContent="—"; });
  }

  async function boot(){
    bindUI();
    await loadCfg();
    await status();
    if (window.solanaWeb3?.Connection && STATE.rpc){
      conn = new window.solanaWeb3.Connection(STATE.rpc, "confirmed");
    }
    await connectIfPossible();

    // min/max Hinweise für USDC-Eingabe
    const amt = el("amt");
    if (amt){
      if (STATE.min!=null) amt.min = String(STATE.min);
      if (STATE.max!=null) amt.max = String(STATE.max);
    }
    updateExpected();
  }

  window.addEventListener("DOMContentLoaded", ()=> boot().catch(e=>alert(String(e?.message||e))));
})();