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

  const Connection = window.solanaWeb3?.Connection;
  let conn=null, provider=null, pubkey=null;

  async function loadCfg(){
    const r = await fetch("./app-cfg.json?v="+(window.__INPI_VER__||Date.now()));
    const c = await r.json();
    CFG.API  = c.API_BASE;
    CFG.INPI = c.INPI_MINT;
    CFG.USDC = c.USDC_MINT;
    CFG.GATE = c.GATE_NFT_MINT || c.GATE_MINT || "";
    // marketplace links
    el("lnTensor").href = "https://www.tensor.trade/item/"+encodeURIComponent(CFG.GATE);
    el("lnME").href     = "https://magiceden.io/item-details/"+encodeURIComponent(CFG.GATE);
    el("lnInpiSS").href = "https://solscan.io/token/"+encodeURIComponent(CFG.INPI);
    el("lnUsdcSS").href = "https://solscan.io/token/"+encodeURIComponent(CFG.USDC);
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

    el("st").textContent = STATE.presale;
    el("ata").textContent = STATE.deposit_ata || "—";
    el("owner").textContent = STATE.deposit_owner || "—";

    renderPrice();
    renderTGE();
    renderTokenomics();
    el("early").style.display = STATE.early.enabled ? "block" : "none";
  }

  function renderPrice(){
    const active = STATE.gate ? (STATE.pWith ?? STATE.pWo) : (STATE.pWo ?? STATE.pWith);
    const txt = [
      "mit NFT:", STATE.pWith? STATE.pWith.toFixed(6)+" USDC":"–",
      "• ohne NFT:", STATE.pWo? STATE.pWo.toFixed(6)+" USDC":"–",
      "• aktiv:", active? active.toFixed(6)+" USDC":"–"
    ].join(" ");
    el("price").textContent = txt;
    el("gateBadge").textContent = STATE.gate ? "(NFT-Rabatt aktiv ✓)" : "(kein NFT-Rabatt)";
  }
  function renderTGE(){
    const n = el("tge");
    if (!STATE.tge){ n.textContent="tbd"; return; }
    const secs = Math.max(0, STATE.tge - now());
    const d=Math.floor(secs/86400), h=Math.floor(secs%86400/3600), m=Math.floor(secs%3600/60), s=secs%60;
    n.textContent = `${d}d ${h}h ${m}m ${s}s`;
  }
  setInterval(()=>STATE.tge && renderTGE(), 1000);

  function renderTokenomics(){
    el("tot").textContent = fmti(STATE.supply);
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
    el("trows").innerHTML = html;
    el("pres").textContent = `${fmti(pres)} INPI (${(STATE.dist.presale/100).toFixed(2)}%)`;
  }

  // Phantom
  function getProvider(){
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
    return null;
  }

  // QR
  async function drawQR(canvas, text){
    if (!text) return;
    await window.QRCode.toCanvas(canvas, text, { width: 240, margin:1 });
  }

  function currentPrice(){
    const a = STATE.gate ? (STATE.pWith ?? STATE.pWo) : (STATE.pWo ?? STATE.pWith);
    return a || 0;
  }
  function updateExpected(){
    const v = Number(el("amt").value || "0");
    const mode = el("mode").value;
    const p = currentPrice();
    if (!v || !p){ el("exp").textContent="–"; return; }
    el("exp").textContent = mode==="USDC" ? `${fmt(v/p,0)} INPI` : `~ ${fmt(v*p,6)} USDC`;
  }

  // Balances + Gate (leichtgew.)
  async function refreshBalances(){
    if (!pubkey) return;
    try{
      const r = await fetch(`${CFG.API}/wallet/balances?wallet=${pubkey.toBase58()}&t=${Date.now()}`);
      const j = await r.json();
      STATE.gate = !!j.gate_ok;
      renderPrice();
    }catch{ STATE.gate = false; renderPrice(); }
  }

  // Intent Flow (ohne Popup)
  async function onIntent(){
    if (!pubkey) return alert("Bitte Wallet verbinden.");
    if (STATE.presale==="closed") return alert("Presale ist geschlossen.");

    const v = Number(el("amt").value||"0");
    const mode = el("mode").value;
    if (!v || v<=0) return alert(`Bitte gültigen Betrag (${mode}) eingeben.`);
    if (mode==="USDC"){
      if (STATE.min!=null && v<STATE.min) return alert(`Mindestens ${STATE.min} USDC.`);
      if (STATE.max!=null && v>STATE.max) return alert(`Maximal ${STATE.max} USDC.`);
    }

    el("msg").textContent = "Erzeuge QR …";
    el("payRow").style.display = "block";

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
        el("msg").textContent = "QR bereit – bestätige Betrag vom Server …";
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
      el("msg").textContent = used!=null ? `✅ Intent registriert. Bitte ${used} USDC senden.` : "✅ Intent registriert.";

      // optional Early-Fee QR inline
      if (j.qr_early_fee?.solana_pay_url){
        el("early").style.display = "block"; // sicherstellen
        el("earRow").style.display = "block";
        await drawQR(el("qrEarly"), j.qr_early_fee.solana_pay_url);
        el("emsg").textContent = `Optional: 1 USDC Early-Fee scannen.`;
      }
    }catch(e){
      el("msg").textContent = "Intent fehlgeschlagen.";
      alert(String(e?.message||e));
    }
  }

  // Early flow (separat)
  async function startEarly(){
    if (!pubkey) return alert("Bitte Wallet verbinden.");
    if (!STATE.early.enabled) return alert("Early-Claim ist deaktiviert.");
    el("earRow").style.display = "block";
    el("emsg").textContent = "Erzeuge Early-QR …";
    const r = await fetch(`${CFG.API}/claim/early-intent?t=${Date.now()}`, {
      method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58() })
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) { alert(j?.error||"Fehler"); return; }
    await drawQR(el("qrEarly"), j.solana_pay_url);
    el("emsg").textContent = `Sende ${STATE.early.flat} USDC und bestätige unten die Signatur.`;
  }
  async function confirmEarly(){
    if (!pubkey) return alert("Wallet verbinden.");
    const sig = (el("feeSig").value||"").trim();
    if (!sig) return alert("Bitte Fee-Transaktions-Signatur eintragen.");
    el("emsg").textContent = "Prüfe Zahlung & queue Claim …";
    const r = await fetch(`${CFG.API}/claim/confirm?t=${Date.now()}`, {
      method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), fee_signature: sig })
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) { alert(j?.error||"Fehler"); el("emsg").textContent="Fehler bei Bestätigung."; return; }
    el("emsg").textContent = `✅ Claim eingereiht (Job ${j.job_id||"n/a"}).`;
  }

  function bindUI(){
    el("btnHow").onclick = ()=> alert("Kurz: 1) Wallet verbinden  2) Betrag eingeben  3) QR scannen (USDC)  4) optional: Early-Fee 1 USDC scannen & Signatur bestätigen.");
    el("btnIntent").onclick = onIntent;
    el("btnEarly").onclick  = startEarly;
    el("btnConfirm").onclick= confirmEarly;
    el("amt").oninput = updateExpected;
    el("mode").onchange = updateExpected;
  }

  async function connectIfPossible(){
    provider = getProvider();
    if (!provider){
      el("btnConnect").textContent = "Phantom installieren";
      el("btnConnect").onclick = ()=> window.open("https://phantom.app","_blank","noopener");
      return;
    }
    el("btnConnect").disabled=false;
    el("btnConnect").textContent="Verbinden";
    el("btnConnect").onclick = async ()=>{
      try{
        const { publicKey } = await provider.connect();
        pubkey = publicKey;
        el("waddr").textContent = publicKey.toBase58();
        await refreshBalances();
      }catch(e){ alert("Wallet-Verbindung abgebrochen."); }
    };
    // try silent
    try{
      const res = await provider.connect({ onlyIfTrusted:true }).catch(()=>null);
      if (res?.publicKey){
        pubkey = res.publicKey;
        el("waddr").textContent = pubkey.toBase58();
        await refreshBalances();
      }
    }catch{}
    provider?.on?.("accountChanged", pk=>{ if(!pk){ pubkey=null; el("waddr").textContent="—"; } else { pubkey=pk; el("waddr").textContent=pk.toBase58(); refreshBalances(); }});
    provider?.on?.("disconnect", ()=>{ pubkey=null; el("waddr").textContent="—"; });
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
    if (STATE.min!=null) el("amt").min = String(STATE.min);
    if (STATE.max!=null) el("amt").max = String(STATE.max);
    updateExpected();
  }

  window.addEventListener("DOMContentLoaded", ()=> boot().catch(e=>alert(String(e?.message||e))));
})();