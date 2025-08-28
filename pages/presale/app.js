/* INPI Presale Frontend (Phantom + Solana Pay) */
import { Connection, PublicKey, Transaction, SystemProgram } from "https://esm.sh/@solana/web3.js@1.95.4";
import { getAssociatedTokenAddress, createTransferCheckedInstruction } from "https://esm.sh/@solana/spl-token@0.4.6";
import QRCode from "https://esm.sh/qrcode@1.5.3";

const API = "/api/token";
const RPC = "/api/token/rpc"; // Worker RPC-Proxy

const $ = (id) => document.getElementById(id);
const ui = {
  btnConnect: $("btnConnect"),
  walletAddr: $("walletAddr"),
  configJson: $("configJson"),
  amount: $("amount"),
  btnPayWallet: $("btnPayWallet"),
  btnPayQR: $("btnPayQR"),
  qrBox: $("qrBox"),
  ref: $("ref"),
  btnCheck: $("btnCheck"),
  status: $("status"),
  btnEarly: $("btnEarly"),
  qrEarly: $("qrEarly")
};

let CFG = null;
let wallet = null;
let conn = null;

async function getConfig() {
  const r = await fetch(`${API}/config`);
  CFG = await r.json();
  ui.configJson.textContent = JSON.stringify(CFG, null, 2);

  // Connection über Worker-Proxy
  conn = new Connection(window.location.origin + RPC, "confirmed");
}

function short(pk) { return pk.slice(0,4) + "…" + pk.slice(-4); }

async function connectPhantom() {
  if (!window.solana || !window.solana.isPhantom) {
    alert("Phantom Wallet nicht gefunden.");
    return;
  }
  const res = await window.solana.connect();
  wallet = res.publicKey.toBase58();
  ui.walletAddr.textContent = short(wallet);
  ui.btnConnect.textContent = "Verbunden";
}

async function createIntent(kind, amount) {
  const r = await fetch(`${API}/presale/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, amount_usdc: amount, kind })
  });
  if (!r.ok) throw new Error("Intent fehlgeschlagen");
  return r.json();
}

async function payWithWallet(amount) {
  if (!wallet) await connectPhantom();
  if (!wallet) return;

  // 1) Intent => Memo/Ref
  const { ref, memo } = await createIntent("presale", amount);
  ui.ref.value = ref;

  // 2) Build USDC transfer + Memo
  const payer = new PublicKey(wallet);
  const usdcMint = new PublicKey(CFG.usdc_mint);
  const payerATA = await getAssociatedTokenAddress(usdcMint, payer);
  const destATA = new PublicKey(CFG.usdc_vault_ata);

  // USDC hat 6 Decimals
  const decimals = 6;
  const rawAmount = BigInt(Math.round(Number(amount) * 10 ** decimals));

  const ix = createTransferCheckedInstruction(
    payerATA,        // source
    usdcMint,        // mint
    destATA,         // destination
    payer,           // owner
    Number(rawAmount),
    decimals
  );

  // Memo via program (11111111111111111111111111111111) geht nicht; echte Memo-ID:
  const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const memoIx = {
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: new TextEncoder().encode(memo)
  };

  const { result: { value: { blockhash } } } = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] })
  }).then(r => r.json());

  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  tx.add(ix);
  tx.add(memoIx);

  const signed = await window.solana.signAndSendTransaction(tx);
  ui.status.textContent = "gesendet: " + short(signed.signature);
}

async function payWithQR(amount) {
  const { ref, url } = await createIntent("presale", amount);
  ui.ref.value = ref;
  ui.qrBox.innerHTML = "";
  await QRCode.toCanvas(document.createElement("canvas"), url, { width: 220 }, (err, canvas) => {
    if (err) { console.error(err); return; }
    ui.qrBox.appendChild(canvas);
  });
}

async function checkStatus() {
  const ref = ui.ref.value.trim();
  if (!ref) return;
  const r = await fetch(`${API}/presale/check?ref=${encodeURIComponent(ref)}`);
  const j = await r.json();
  ui.status.textContent = j.status ? j.status : JSON.stringify(j);
}

async function earlyClaim() {
  if (!wallet) await connectPhantom();
  const r = await fetch(`${API}/early-claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
  const j = await r.json();
  ui.qrEarly.innerHTML = "";
  await QRCode.toCanvas(document.createElement("canvas"), j.url, { width: 220 }, (err, canvas) => {
    if (!err) ui.qrEarly.appendChild(canvas);
  });
}

ui.btnConnect.onclick = connectPhantom;
ui.btnPayWallet.onclick = () => payWithWallet(Number(ui.amount.value));
ui.btnPayQR.onclick = () => payWithQR(Number(ui.amount.value));
ui.btnCheck.onclick = checkStatus;
ui.btnEarly.onclick = earlyClaim;

getConfig();