/* ===== Mini Presale Front ===== */
const CFG = {
  API_BASE: "https://inpinity.online/api/token",
  RPC: "https://inpinity.online/api/token/rpc",
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WEB3_IIFE: "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js",
  QR_IIFE:   "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js",
  GATE_NFT_MINT: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",
};

const $ = s => document.querySelector(s);
const logBox = $("#logArea");
const log = (...a)=>{ try{ console.log("[INPI]",...a); if(logBox){ logBox.textContent += a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ")+"\n"; logBox.scrollTop = logBox.scrollHeight; } }catch{} };

let Connection=null, QRCodeLib=null;
async function ensureWeb3(){ if(window.solanaWeb3?.Connection){ Connection=window.solanaWeb3.Connection; return true; }
  await new Promise(res=>{ const s=document.createElement("script"); s.src=CFG.WEB3_IIFE+"?v="+encodeURIComponent(window.__INPI_VER__); s.onload=()=>res(true); s.onerror=()=>res(false); document.head.appendChild(s);});
  Connection=window.solanaWeb3?.Connection; return !!Connection;
}
async function ensureQR(){ if(window.QRCode){ QRCodeLib=window.QRCode; return true; }
  await new Promise(res=>{ const s=document.createElement("script"); s.src=CFG.QR_IIFE+"?v="+encodeURIComponent(window.__INPI_VER__); s.onload=()=>res(true); s.onerror=()=>res(false); document.head.appendChild(s);});
  QRCodeLib=window.QRCode; return !!QRCodeLib;
}
async function drawQR(img, text, size=240){ if(!text) return; await ensureQR(); const c=document.createElement("canvas"); c.width=size; c.height=size; c.className=img.className; img.replaceWith(c); await QRCodeLib.toCanvas(c, text, { width:size, margin:1 }); }

const state = {
  rpc_url: CFG.RPC, price_without: null, price_with: null, gate_ok:false,
  deposit_ata:null, presale_state:"open", tge_ts:null, input_mode:"USDC"
};

const btnConnect=$("#btnConnect"), walletAddr=$("#walletAddr"), p0=$("#p0"), gateBadge=$("#gateBadge");
const inpAmount=$("#inpAmount"), expected=$("#expectedInpi"), intentMsg=$("#intentMsg"), payArea=$("#payArea");
const qre=$("#inpi-qr"), depA=$("#depositAddr"), depLink=$("#depositSolscan"), btnCopy=$("#btnCopyDeposit");
const btnIntent=$("#btnPresaleIntent"), btnHowTo=$("#btnHowTo");
let connection=null, provider=null, pubkey=null;

function priceActive(){ return state.gate_ok ? (state.price_with ?? state.price_without) : (state.price_without ?? state.price_with); }
function calcExpected(v){
  const pr = priceActive(); if(!v||!pr) return "–";
  return state.input_mode==="USDC" ? `${Math.floor(v/pr).toLocaleString("de-DE")} INPI` : `~ ${(v*pr).toFixed(6)} USDC`;
}

async function loadStatus(){
  const r = await fetch(`${CFG.API_BASE}/status?t=${Date.now()}`); const j=await r.json(); log("status",j);
  state.rpc_url = j.rpc_url || CFG.RPC;
  state.presale_state = j.presale_state || "open";
  state.deposit_ata = j.deposit_usdc_ata || null;
  state.price_without = Number(j.presale_price_usdc)||null;
  // Clientseitig: „mit NFT“ Preis = Rabatt
  const disc = Number(j.discount_bps||0); state.price_with = state.price_without? Math.round(state.price_without*(1-disc/10000)*1e6)/1e6 : null;

  $("#presaleState").textContent = state.presale_state;
  if (depA) depA.textContent = state.deposit_ata || "—";
  if (depLink){ if(state.deposit_ata){ depLink.href=`https://solscan.io/account/${state.deposit_ata}`; depLink.style.display="inline"; } }
  updatePriceRow();
}
function updatePriceRow(){
  const act=priceActive(); p0.textContent = act? `${act.toFixed(6)} USDC` : "—";
  gateBadge.textContent = state.gate_ok ? "NFT-Rabatt aktiv ✓" : "kein NFT-Rabatt";
  if (expected && inpAmount) expected.textContent = calcExpected(Number(inpAmount.value||"0"));
}

function getProvider(){ if (window.phantom?.solana?.isPhantom) return window.phantom.solana; if (window.solana?.isPhantom) return window.solana; return null; }

async function refreshGate(){
  if (!(connection && pubkey)) return;
  try{
    const owner = pubkey, mint = new window.solanaWeb3.PublicKey(CFG.GATE_NFT_MINT);
    const res1 = await connection.getParsedTokenAccountsByOwner(owner, { mint }, { commitment:"confirmed" });
    let amt = 0; for (const v of (res1?.value||[])) amt += Number(v?.account?.data?.parsed?.info?.tokenAmount?.uiAmount??0);
    if (amt<=0){
      const prog2022 = new window.solanaWeb3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
      const res2 = await connection.getParsedTokenAccountsByOwner(owner, { programId: prog2022 }, { commitment:"confirmed" });
      for (const v of (res2?.value||[])){ const info=v?.account?.data?.parsed?.info; if (info?.mint===CFG.GATE_NFT_MINT) amt+=Number(info?.tokenAmount?.uiAmount??0); }
    }
    state.gate_ok = amt>0; updatePriceRow();
  }catch(e){ log("gate check err", e?.message||e); }
}

let inFlight=false, popup=null;
function openPopup(){ if(!popup || popup.closed) popup=window.open("/pages/token/intent-popup.html?v="+encodeURIComponent(window.__INPI_VER__),"inpi_intent","width=420,height=640,noopener"); return popup; }
function postPopup(msg){ try{ popup && !popup.closed && popup.postMessage(msg, location.origin); }catch{} }

async function doIntent(){
  if(inFlight) return;
  if(!pubkey) return alert("Bitte erst Phantom verbinden.");
  if(state.presale_state==="closed") return alert("Presale ist geschlossen.");

  const v=Number(inpAmount?.value||"0"); if(!v||v<=0) return alert("Bitte gültigen Betrag angeben.");
  openPopup(); // synchron gegen Popup-Blocker

  inFlight=true;
  try{
    intentMsg.textContent = "Erzeuge QR…";
    // Server ruft nur 1x
    const body = { wallet: pubkey.toBase58() };
    if (state.input_mode==="USDC") body.amount_usdc = v; else body.amount_inpi = v;

    const r = await fetch(`${CFG.API_BASE}/presale/intent?t=${Date.now()}`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); log("intent", j);
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    const link = j.qr_contribute?.solana_pay_url;
    if (link){
      payArea.style.display="block";
      await drawQR(qre, link, 240);
      postPopup({ type:"final_qr", url: link, cache: { wallet: pubkey.toBase58(), amount: v }});
      intentMsg.textContent = "✅ QR bereit. Mit Wallet scannen und USDC senden.";
    } else {
      intentMsg.textContent = "Kein QR erhalten.";
    }
  }catch(e){ log("intent error", e?.message||e); intentMsg.textContent = "Intent fehlgeschlagen."; alert(String(e?.message||e)); }
  finally{ inFlight=false; }
}

async function init(){
  window.addEventListener("error", e=>log("err",e.message));
  await ensureWeb3(); await ensureQR();
  await loadStatus();

  // Connection nach Status (CORS-safe RPC via Proxy)
  connection = new window.solanaWeb3.Connection(state.rpc_url, "confirmed");

  // Phantom
  provider = getProvider();
  if (provider?.isPhantom){
    btnConnect.disabled=false; btnConnect.textContent="Verbinden";
    btnConnect.onclick = async ()=> {
      try{ const { publicKey } = await provider.connect(); pubkey = publicKey; walletAddr.textContent = publicKey.toBase58(); await refreshGate(); }
      catch(e){ alert("Verbindung abgebrochen."); }
    };
  } else {
    btnConnect.textContent="Phantom installieren";
    btnConnect.onclick=()=> window.open("https://phantom.app","_blank","noopener");
  }

  // Inputs
  inpAmount.addEventListener("input", ()=> expected.textContent = calcExpected(Number(inpAmount.value||"0")));
  btnHowTo.onclick = ()=> alert("1) Phantom verbinden\n2) Betrag wählen\n3) Intent & QR → mit Wallet scannen\n4) Fertig.");
  btnIntent.onclick = doIntent;

  // Copy deposit
  btnCopy.onclick = async ()=> { const t=(depA?.textContent||"").trim(); if(!t) return; await navigator.clipboard.writeText(t).catch(()=>{}); btnCopy.textContent="Kopiert ✓"; setTimeout(()=>btnCopy.textContent="Kopieren",900); };

  log("ready");
}
window.addEventListener("DOMContentLoaded", ()=>init());