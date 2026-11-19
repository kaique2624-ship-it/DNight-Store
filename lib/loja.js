/* DNight Store — lógica do servidor (Vercel e local)
   Dados: Firestore · Arquivos dos jogos: Vercel Blob · Pix: Mercado Pago · Contas: Firebase Authentication */
"use strict";
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const ROOT = path.join(__dirname, "..");
const env = k => (process.env[k] || "").trim();
const MP_TOKEN = env("MERCADOPAGO_ACCESS_TOKEN");
const MP_API = (env("MERCADOPAGO_API_URL") || "https://api.mercadopago.com").replace(/\/$/, "");
const PIX_MINUTES = Math.max(30, +env("PIX_MINUTOS") || 60);
const PUBLIC_URL = env("PUBLIC_URL").replace(/\/$/, "");
const ADMIN_PASSWORD = env("ADMIN_PASSWORD");
const BLOB_ON = !!env("BLOB_READ_WRITE_TOKEN");
const FILES = path.join(ROOT, "data", "files"); /* só no modo local, sem Vercel Blob */

/* ---------- conta de serviço do Firebase: variável de ambiente (Vercel) ou arquivo (local) ---------- */
let SA = null;
{
  const raw = env("FIREBASE_SERVICE_ACCOUNT");
  if (raw) { for (const t of [raw, (() => { try { return Buffer.from(raw, "base64").toString("utf8") } catch (e) { return "" } })()]) { try { const j = JSON.parse(t); if (j.private_key) { SA = j; break } } catch (e) {} } }
  if (!SA) {
    const nomes = [env("FIREBASE_CONTA_SERVICO"), "firebase-conta-servico.json"].filter(Boolean);
    try { nomes.push(...fs.readdirSync(ROOT).filter(f => /firebase-adminsdk.*\.json$/i.test(f))) } catch (e) {}
    for (const n of nomes) { try { const j = JSON.parse(fs.readFileSync(path.resolve(ROOT, n), "utf8")); if (j.private_key && j.client_email) { SA = j; break } } catch (e) {} }
  }
  if (SA && SA.private_key && SA.private_key.includes("\\n")) SA.private_key = SA.private_key.replace(/\\n/g, "\n");
}
const FB_PROJECT = (SA && SA.project_id) || env("FIREBASE_PROJECT_ID");
let FB_KEY = env("FIREBASE_API_KEY");
const IDTK = (env("FIREBASE_IDTK_URL") || "https://identitytoolkit.googleapis.com").replace(/\/$/, "");
const FBM = (env("FIREBASE_MGMT_URL") || "https://firebase.googleapis.com").replace(/\/$/, "");
const FS_API = (env("FIRESTORE_URL") || "https://firestore.googleapis.com").replace(/\/$/, "");
const TOKEN_URI = env("GOOGLE_TOKEN_URL") || (SA && SA.token_uri) || "https://oauth2.googleapis.com/token";
const SESSION_SECRET = env("SESSION_SECRET") || crypto.createHash("sha256").update("dn-sess|" + ((SA && SA.private_key) || ADMIN_PASSWORD || "x")).digest("hex");

const rnd = (n = 4) => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[crypto.randomInt(32)]).join("");
const b64u = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

/* ---------- token do Google assinado com a conta de serviço (sem bibliotecas) ---------- */
let gTok = { t: "", exp: 0 };
async function googleToken() {
  if (!SA) throw httpErr(503, "Firebase não configurado: falta a variável FIREBASE_SERVICE_ACCOUNT.");
  if (gTok.t && Date.now() < gTok.exp - 60000) return gTok.t;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: SA.private_key_id }));
  const claim = b64u(JSON.stringify({ iss: SA.client_email, scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase", aud: SA.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.sign("RSA-SHA256", Buffer.from(head + "." + claim), SA.private_key));
  const r = await fetch(TOKEN_URI, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + sig }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw httpErr(503, "O Google recusou a conta de serviço do Firebase: " + (j.error_description || j.error || r.status));
  gTok = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return gTok.t;
}
async function gfetch(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { "Authorization": "Bearer " + await googleToken(), "Content-Type": "application/json", ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(((j.error && j.error.message) || r.status) + ""); return j;
}

/* ---------- Firestore (REST) ---------- */
const DOCS = () => `projects/${FB_PROJECT}/databases/(default)/documents`;
async function fsReq(method, p, body) {
  const r = await fetch(`${FS_API}/v1/${p}`, { method, headers: { "Authorization": "Bearer " + await googleToken(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const er = Array.isArray(j) ? j[0] && j[0].error : j.error, msg = (er && er.message) || "";
    let texto = "Erro no banco de dados (" + r.status + "): " + msg.slice(0, 200), status = r.status >= 500 ? 502 : r.status;
    if (/database.*does not exist|datastore\/setup/i.test(msg)) { texto = "O banco de dados ainda não foi criado. No Firebase, abra Firestore Database e clique em Criar banco de dados."; status = 503 }
    else if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) { texto = "A API do Cloud Firestore está desativada no projeto. Abra o Firebase → Firestore Database e crie o banco (isso ativa a API)."; status = 503 }
    const e = httpErr(status, texto);
    e.fsStatus = er && er.status; e.raw = msg; throw e;
  }
  return j;
}
const conflict = e => ["FAILED_PRECONDITION", "ABORTED", "ALREADY_EXISTS"].includes(e.fsStatus) || e.status === 409;
async function getDoc(p) { try { return await fsReq("GET", `${DOCS()}/${p}`) } catch (e) { if (e.status === 404) return null; throw e } }
const S = v => ({ stringValue: String(v == null ? "" : v) });
const fieldStr = (d, k = "dados") => d && d.fields && d.fields[k] && d.fields[k].stringValue;
const docWrite = (p, fields, pre) => { const w = { update: { name: `${DOCS()}/${p}`, fields } }; if (pre) w.currentDocument = pre; return w };
const commit = writes => fsReq("POST", `${DOCS()}:commit`, { writes });

/* estado da loja: produtos, estoque, configurações, compras e vendas (um documento) */
function normState(d) {
  d = d && typeof d === "object" ? d : {};
  const s = { products: Array.isArray(d.products) ? d.products : [], purchases: Array.isArray(d.purchases) ? d.purchases : [], sales: Array.isArray(d.sales) ? d.sales : [], cfg: Object.assign({ mode: "pix", pix: "" }, d.cfg || {}), seq: d.seq || 0 };
  if (s.cfg.mode !== "manual") s.cfg.mode = "pix";
  s.products.forEach(p => { p.k = Array.isArray(p.k) ? p.k : []; p.s = (p.s === undefined || p.s === null || p.s === "") ? p.k.length : Math.max(0, parseInt(p.s) || 0) });
  return s;
}
async function loadState() { const d = await getDoc("loja/estado"); return d ? { S: normState(JSON.parse(fieldStr(d) || "{}")), ut: d.updateTime } : { S: normState({}), ut: null } }
function stateWrite(st, ut) {
  const json = JSON.stringify(st);
  if (Buffer.byteLength(json) > 1000000) throw httpErr(413, "Os dados da loja passaram do limite de 1 MB do Firestore. Apague vendas/compras antigas ou chaves não usadas.");
  return docWrite("loja/estado", { dados: S(json) }, ut ? { updateTime: ut } : { exists: false });
}
/* pedidos: um documento por pedido (id = código do pedido) */
const orderFields = o => ({ dados: S(JSON.stringify(o)), at: S(o.at), uid: S(o.uid || ""), token: S(o.token), mpId: S(o.mpId || ""), email: S((o.email || "").toLowerCase()) });
async function getOrder(code) { const d = await getDoc("pedidos/" + code); return d ? { o: JSON.parse(fieldStr(d)), ut: d.updateTime } : null }
async function queryOrders(where, limit = 50, order = true) {
  const q = { from: [{ collectionId: "pedidos" }], limit };
  if (where) q.where = { fieldFilter: { field: { fieldPath: where[0] }, op: "EQUAL", value: S(where[1]) } };
  else if (order) q.orderBy = [{ field: { fieldPath: "at" }, direction: "DESCENDING" }];
  const j = await fsReq("POST", `${DOCS()}:runQuery`, { structuredQuery: q });
  return j.filter(x => x.document).map(x => ({ o: JSON.parse(fieldStr(x.document)), ut: x.document.updateTime }));
}

/* ---------- entrega ---------- */
const isUrl = c => /^https?:\/\/\S+$/i.test(c);
const isFile = c => typeof c === "string" && c.startsWith("arquivo:");
function deliver(st, o) {
  if (o.status === "entregue") return o.status;
  const need = {}; o.items.forEach(i => need[i.id] = (need[i.id] || 0) + i.q);
  for (const id in need) {
    const p = st.products.find(x => x.id == id);
    if (!p || (p.k.length < need[id] && !p.u && !p.fid)) { o.status = "sem_chaves"; o.paidAt = o.paidAt || new Date().toISOString(); return o.status }
  }
  const at = new Date().toISOString();
  o.keys = o.items.map(i => {
    const p = st.products.find(x => x.id == i.id);
    const codes = p.k.length >= i.q ? p.k.splice(0, i.q) : [p.fid ? "arquivo:" + p.fid : p.u];
    p.s = Math.max(0, p.s - i.q);
    st.sales.push({ id: Date.now() + i.id, pid: p.id, q: i.q, price: i.p, who: "Pedido " + o.code, at });
    return { name: p.n, codes, fn: p.fn || "" };
  });
  o.status = "entregue"; o.paidAt = at; return o.status;
}
/* entrega com proteção contra duas gravações ao mesmo tempo */
async function deliverTx(code, before) {
  for (let t = 0; t < 6; t++) {
    const [st, rec] = await Promise.all([loadState(), getOrder(code)]);
    if (!rec) return null;
    if (rec.o.status === "entregue") return rec;
    const o = rec.o; if (before) before(o);
    deliver(st.S, o);
    try { await commit([stateWrite(st.S, st.ut), docWrite("pedidos/" + code, orderFields(o), { updateTime: rec.ut })]); return { o } }
    catch (e) { if (!conflict(e)) throw e; await sleep(80 * (t + 1) + crypto.randomInt(120)) }
  }
  throw httpErr(503, "Muitas alterações ao mesmo tempo. Tente de novo.");
}
async function updateOrder(code, fn) {
  for (let t = 0; t < 4; t++) {
    const rec = await getOrder(code); if (!rec) return null;
    if (fn(rec.o) === false) return rec;
    try { await commit([docWrite("pedidos/" + code, orderFields(rec.o), { updateTime: rec.ut })]); return rec }
    catch (e) { if (!conflict(e)) throw e; await sleep(100) }
  }
  return null;
}
function pubOrder(o, st) {
  const pend = o.status === "pendente";
  return {
    code: o.code, status: o.status, total: o.total, at: o.at, mode: o.mode,
    qr: pend && o.qr || "", qr64: pend && o.qr64 || "", expires: pend && o.expires || "",
    pix: pend && o.mode === "manual" && st ? st.cfg.pix : "",
    entregas: (o.keys || []).map((g, gi) => ({
      name: g.name,
      keys: g.codes.filter(c => !isUrl(c) && !isFile(c)),
      downloads: g.codes.map((c, ci) => (isUrl(c) || isFile(c)) ? `/api/download/${o.token}/${gi}/${ci}` : null).filter(Boolean)
    }))
  };
}

/* ---------- Mercado Pago (Pix) ---------- */
async function mp(method, route, body, idem) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const h = { "Authorization": "Bearer " + MP_TOKEN, "Accept": "application/json" };
    if (body) h["Content-Type"] = "application/json";
    if (idem) h["X-Idempotency-Key"] = idem;
    const r = await fetch(MP_API + route, { method, signal: ctl.signal, headers: h, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt) } catch (e) { j = { raw: txt } }
    if (!r.ok) { const e = new Error("Mercado Pago respondeu " + r.status + ": " + (j.message || j.error || txt).toString().slice(0, 300)); e.data = j; throw e }
    return j;
  } finally { clearTimeout(t) }
}
let MP_TEST_ACCOUNT = null;
async function mpIsTest() {
  if (MP_TEST_ACCOUNT !== null) return MP_TEST_ACCOUNT;
  try { const u = await mp("GET", "/users/me"); MP_TEST_ACCOUNT = /@testuser\.com$/i.test(u.email || "") || /^test_?user/i.test(u.nickname || "") || (Array.isArray(u.tags) && u.tags.includes("test_user")) } catch (e) { return false }
  return MP_TEST_ACCOUNT;
}
async function mpErro(e) {
  const d = e.data || {}, txt = (JSON.stringify(d) + " " + e.message).toLowerCase();
  if (e.name === "AbortError" || /fetch failed|enotfound|econnrefused|etimedout|certificate/.test(txt + " " + String(e.cause || "").toLowerCase()))
    return "O servidor da loja não conseguiu se conectar ao Mercado Pago. Tente de novo em instantes.";
  if (/live credentials/.test(txt)) return (await mpIsTest())
    ? "O token configurado é de uma CONTA DE TESTE do Mercado Pago, que não recebe Pix de verdade. Use o Access Token de produção da sua conta real."
    : "As credenciais de produção do Mercado Pago ainda não foram ativadas (Mercado Pago Developers → sua aplicação → Credenciais de produção).";
  if (/without key enabled|key enabled for qr|qr render/.test(txt)) return "A conta do Mercado Pago da loja não tem chave Pix cadastrada.";
  if (/payer.*collector|collector.*payer|same user|invalid users involved|payer email forbidden|cannot pay yourself/.test(txt)) return "O e-mail do comprador não pode ser o mesmo da conta do Mercado Pago da loja. Use outro e-mail.";
  if (/unauthorized|invalid.*token|invalid_token|401|forbidden|403/.test(txt)) return "O Mercado Pago recusou o token configurado (MERCADOPAGO_ACCESS_TOKEN).";
  if (/email/.test(txt)) return "O Mercado Pago recusou o e-mail informado. Confira o e-mail e tente de novo.";
  const msg = d.message || (d.cause && d.cause[0] && (d.cause[0].description || d.cause[0].code)) || e.message;
  return "Mercado Pago recusou o Pix: " + String(msg).slice(0, 160);
}
const lastCheck = new Map();
async function checkPaid(rec, force) {
  const o = rec.o;
  if (o.status !== "pendente" || o.mode !== "pix" || !o.mpId) return rec;
  const now = Date.now(); if (!force && now - (lastCheck.get(o.code) || 0) < 3000) return rec; lastCheck.set(o.code, now);
  try {
    const j = await mp("GET", "/v1/payments/" + encodeURIComponent(o.mpId));
    if (j.status === "approved" && String(j.external_reference) === o.code && +j.transaction_amount >= o.total - 0.01) {
      let novo = false;
      const r = await deliverTx(o.code, x => { x.capture = "pix"; x.paidAmount = j.transaction_amount; novo = true });
      if (novo) console.log("✔ Pedido", o.code, "pago no Pix"); return r || rec;
    }
    if (["cancelled", "rejected", "refunded", "charged_back"].includes(j.status)) return (await updateOrder(o.code, x => { if (x.status !== "pendente") return false; x.status = "expirado" })) || rec;
  } catch (e) { console.error("Consulta do Pix falhou para", o.code, "-", e.message) }
  return rec;
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
}

/* ---------- utilidades HTTP ---------- */
function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(b) }
async function readJson(req, max = 4e6) {
  if (req.body !== undefined && req.body !== null) { /* a Vercel já leu o corpo */
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body;
  }
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw httpErr(413, "Dados grandes demais."); chunks.push(c) }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") } catch (e) { throw httpErr(400, "JSON inválido.") }
}
const passOk = v => { const a = Buffer.from(String(v || "")), b = Buffer.from(ADMIN_PASSWORD); return !!ADMIN_PASSWORD && a.length === b.length && crypto.timingSafeEqual(a, b) };
const isAdmin = req => passOk(req.headers["x-admin"]);
function directUrl(u) {
  try {
    const x = new URL(u), h = x.hostname;
    const m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || (/(^|\.)google\.com$/.test(h) && x.searchParams.get("id") ? [0, x.searchParams.get("id")] : null);
    if (m) return "https://drive.usercontent.google.com/download?id=" + encodeURIComponent(m[1]) + "&export=download&confirm=t";
    if (/(^|\.)dropbox\.com$/.test(h)) { x.searchParams.set("dl", "1"); return x.href }
    if (h === "github.com" && x.pathname.includes("/blob/")) return "https://raw.githubusercontent.com" + x.pathname.replace("/blob/", "/");
    return u;
  } catch (e) { return u }
}
const cleanName = s => String(s || "download").replace(/[\\/:*?"<>|\r\n]+/g, "").trim() || "download";
const disposition = n => `attachment; filename="${cleanName(n).replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(cleanName(n))}`;
const publicProduct = p => ({ id: p.id, n: p.n, d: p.d, dl: p.dl, p: p.p, c: p.c, e: p.e, c1: p.c1, c2: p.c2, f: p.f, s: p.s });
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* fotos dos produtos: guardadas no Firestore (cada foto é um documento) */
function parseDataUrl(u) { const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(u || ""); return m ? { mime: m[1], b64: m[2].replace(/\s/g, "") } : null }
function photoWrite(u) {
  const d = parseDataUrl(u); if (!d) return null;
  if (d.b64.length > 1300000) throw httpErr(413, "Foto grande demais. Use uma imagem menor.");
  const id = crypto.createHash("sha256").update(d.b64).digest("hex").slice(0, 32);
  return { id, url: "/api/foto/" + id, write: docWrite("fotos/" + id, { mime: S(d.mime), b64: { bytesValue: d.b64 } }) };
}

/* ---------- contas de clientes (Firebase Authentication) ---------- */
async function findApiKey() {
  if (FB_KEY || !SA) return FB_KEY;
  try {
    const apps = (await gfetch(`${FBM}/v1beta1/projects/${FB_PROJECT}/webApps`)).apps || [];
    for (const a of apps) { const c = await gfetch(`${FBM}/v1beta1/projects/${FB_PROJECT}/webApps/${a.appId}/config`); if (c.apiKey) { FB_KEY = c.apiKey; break } }
  } catch (e) { console.error("Não consegui buscar a chave web do Firebase:", e.message) }
  return FB_KEY;
}
const FB_ERR = {
  EMAIL_EXISTS: "Já existe uma conta com esse e-mail. Use Entrar.", EMAIL_NOT_FOUND: "E-mail ou senha incorretos.", INVALID_PASSWORD: "E-mail ou senha incorretos.",
  INVALID_LOGIN_CREDENTIALS: "E-mail ou senha incorretos.", USER_DISABLED: "Esta conta foi desativada.", INVALID_EMAIL: "E-mail inválido.", MISSING_PASSWORD: "Digite a senha.", MISSING_EMAIL: "Digite o e-mail.",
  TOO_MANY_ATTEMPTS_TRY_LATER: "Muitas tentativas. Espere alguns minutos e tente de novo.", WEAK_PASSWORD: "A senha precisa ter pelo menos 6 caracteres.",
  OPERATION_NOT_ALLOWED: "O login por e-mail e senha está desligado no Firebase (Authentication → Método de login).", CONFIGURATION_NOT_FOUND: "O Authentication ainda não foi ativado no Firebase."
};
async function idtk(route, body) {
  const key = await findApiKey(); if (!key) throw httpErr(503, "Login indisponível: falta a Chave de API da Web do Firebase (variável FIREBASE_API_KEY).");
  const r = await fetch(`${IDTK}/v1/${route}?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "", code = msg.split(/[ :]/)[0];
    if (!FB_ERR[code]) console.error("Firebase:", msg || r.status);
    throw httpErr(400, FB_ERR[code] || (/API key/i.test(msg) ? "A chave de API do Firebase é inválida." : "Não foi possível entrar agora. Tente de novo."));
  }
  return j;
}
function makeSession(u) {
  const p = b64u(JSON.stringify({ uid: u.uid, email: u.email, name: u.name || "", exp: Date.now() + 30 * 864e5 }));
  return p + "." + b64u(crypto.createHmac("sha256", SESSION_SECRET).update(p).digest());
}
function getUser(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)dn_sess=([^;]+)/); if (!m) return null;
  const [p, s] = m[1].split("."); if (!p || !s) return null;
  const good = b64u(crypto.createHmac("sha256", SESSION_SECRET).update(p).digest());
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const u = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); return u.exp > Date.now() ? u : null } catch (e) { return null }
}
function setSession(req, res, u) {
  const secure = /^https/.test(PUBLIC_URL) || String(req.headers["x-forwarded-proto"] || "").startsWith("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", u ? `dn_sess=${makeSession(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}` : `dn_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
const authOn = () => !!(SA || FB_KEY);
const tries = new Map();
function slow(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 600000);
  t.push(now); tries.set(ip, t); return t.length > 30;
}

/* ---------- rotas ---------- */
async function route(req, res) {
  const url = new URL(req.url, "http://x"), M = req.method;
  let P = url.pathname; const pp = url.searchParams.get("__p"); if (pp) { P = pp; url.searchParams.delete("__p") }

  /* contas */
  if (P === "/api/auth/me" && M === "GET") return send(res, 200, { user: getUser(req), auth: authOn() });
  if ((P === "/api/auth/login" || P === "/api/auth/signup") && M === "POST") {
    if (slow(req)) return send(res, 429, { error: "Muitas tentativas. Espere alguns minutos." });
    const b = await readJson(req, 1e4), email = String(b.email || "").trim().toLowerCase(), password = String(b.password || ""), name = String(b.name || "").trim().slice(0, 60);
    if (!emailOk(email)) return send(res, 400, { error: "Digite um e-mail válido." });
    if (password.length < 6) return send(res, 400, { error: "A senha precisa ter pelo menos 6 caracteres." });
    if (P === "/api/auth/signup" && !name) return send(res, 400, { error: "Digite seu nome." });
    const j = P === "/api/auth/signup"
      ? await idtk("accounts:signUp", { email, password, displayName: name, returnSecureToken: true })
      : await idtk("accounts:signInWithPassword", { email, password, returnSecureToken: true });
    const u = { uid: j.localId, email: j.email || email, name: name || j.displayName || "" };
    setSession(req, res, u); return send(res, 200, { user: u });
  }
  if (P === "/api/auth/reset" && M === "POST") {
    if (slow(req)) return send(res, 429, { error: "Muitas tentativas. Espere alguns minutos." });
    const b = await readJson(req, 1e4), email = String(b.email || "").trim().toLowerCase();
    if (!emailOk(email)) return send(res, 400, { error: "Digite o e-mail da sua conta." });
    try { await idtk("accounts:sendOobCode", { requestType: "PASSWORD_RESET", email }) } catch (e) { if (e.status === 503) throw e }
    return send(res, 200, { ok: true });
  }
  if (P === "/api/auth/logout" && M === "POST") { setSession(req, res, null); return send(res, 200, { ok: true }) }
  if (P === "/api/me/orders" && M === "GET") {
    const u = getUser(req); if (!u) return send(res, 401, { error: "Entre na sua conta." });
    const list = (await queryOrders(["uid", u.uid], 300)).map(r => r.o).sort((a, b) => b.at < a.at ? -1 : 1);
    return send(res, 200, { orders: list.map(o => Object.assign(pubOrder(o), { token: o.token, items: o.items.map(i => ({ id: i.id, n: i.n, q: i.q })) })) });
  }

  /* loja */
  if (P === "/api/store" && M === "GET") {
    const { S: st } = await loadState();
    const sold = {}; st.sales.forEach(r => sold[r.pid] = (sold[r.pid] || 0) + r.q);
    return send(res, 200, { products: st.products.filter(p => p.a).map(publicProduct), sold, mode: st.cfg.mode });
  }
  let m;
  if ((m = P.match(/^\/api\/foto\/([a-f0-9]{32})$/)) && M === "GET") {
    const d = await getDoc("fotos/" + m[1]);
    if (!d) { res.writeHead(404); return res.end() }
    const buf = Buffer.from(d.fields.b64.bytesValue, "base64");
    res.writeHead(200, { "Content-Type": fieldStr(d, "mime") || "image/jpeg", "Content-Length": buf.length, "Cache-Control": "public, max-age=31536000, immutable" });
    return res.end(buf);
  }
  if (P === "/api/checkout" && M === "POST") {
    const b = await readJson(req, 1e5);
    const user = getUser(req);
    if (authOn() && !user) return send(res, 401, { error: "Entre na sua conta para comprar." });
    const email = user ? user.email : String(b.email || "").trim();
    if (!emailOk(email)) return send(res, 400, { error: "Informe um e-mail válido." });
    const { S: st } = await loadState();
    const want = {}; for (const it of Array.isArray(b.items) ? b.items : []) { const q = parseInt(it.q); if (q > 0) want[+it.id] = (want[+it.id] || 0) + q }
    const items = []; let total = 0;
    for (const id in want) {
      const p = st.products.find(x => x.id === +id);
      if (!p || !p.a) return send(res, 400, { error: "Um produto do carrinho não está mais disponível." });
      if (p.s < want[id]) return send(res, 400, { error: "Estoque insuficiente para " + p.n + "." });
      items.push({ id: p.id, n: p.n, q: want[id], p: p.p }); total += want[id] * p.p;
    }
    if (!items.length) return send(res, 400, { error: "Carrinho vazio." });
    total = Math.round(total * 100) / 100;
    const mode = st.cfg.mode;
    const o = { id: Date.now(), code: rnd(6), token: crypto.randomBytes(16).toString("hex"), uid: user ? user.uid : "", name: user ? user.name : "", email, total, status: "pendente", at: new Date().toISOString(), items, mode };
    if (mode === "pix") {
      if (!MP_TOKEN) return send(res, 500, { error: "Pagamento não configurado (falta MERCADOPAGO_ACCESS_TOKEN)." });
      const base = baseUrl(req);
      const body = {
        transaction_amount: total,
        description: ("DNight Store - " + items.map(i => i.q + "x " + i.n).join(", ")).slice(0, 250),
        payment_method_id: "pix",
        payer: { email },
        external_reference: o.code,
        date_of_expiration: new Date(Date.now() + PIX_MINUTES * 60000 - 3 * 3600000).toISOString().replace("Z", "-03:00")
      };
      if (/^https:\/\//.test(base)) body.notification_url = `${base}/api/webhook/mercadopago`;
      try {
        const j = await mp("POST", "/v1/payments", body, o.token);
        const td = (j.point_of_interaction || {}).transaction_data || {};
        o.mpId = String(j.id || ""); o.qr = td.qr_code || ""; o.qr64 = td.qr_code_base64 || ""; o.expires = j.date_of_expiration || body.date_of_expiration;
        if (!o.mpId || !o.qr) throw new Error("O Mercado Pago não devolveu o QR Code: " + JSON.stringify(j).slice(0, 300));
      } catch (e) {
        console.error("Erro ao gerar Pix:", e.message, e.data ? JSON.stringify(e.data) : "", e.cause ? String(e.cause) : "");
        return send(res, 502, { error: await mpErro(e) });
      }
    }
    await commit([docWrite("pedidos/" + o.code, orderFields(o), { exists: false })]);
    return send(res, 200, Object.assign(pubOrder(o, st), { token: o.token }));
  }
  if ((m = P.match(/^\/api\/order\/([A-Z0-9]{6})$/)) && M === "GET") {
    let rec = await getOrder(m[1]);
    if (!rec || rec.o.token !== url.searchParams.get("t")) return send(res, 404, { error: "Pedido não encontrado." });
    if (rec.o.status === "sem_chaves") rec = (await deliverTx(rec.o.code)) || rec;
    rec = await checkPaid(rec);
    return send(res, 200, pubOrder(rec.o, rec.o.mode === "manual" ? (await loadState()).S : null));
  }
  if (P === "/api/order/lookup" && M === "POST") {
    const b = await readJson(req, 1e4), code = String(b.code || "").trim().toUpperCase();
    let rec = /^[A-Z0-9]{6}$/.test(code) ? await getOrder(code) : null;
    if (!rec || rec.o.email.toLowerCase() !== String(b.email || "").trim().toLowerCase()) return send(res, 404, { error: "Pedido não encontrado. Confira o e-mail e o código." });
    if (rec.o.status === "sem_chaves") rec = (await deliverTx(rec.o.code)) || rec;
    rec = await checkPaid(rec);
    return send(res, 200, Object.assign(pubOrder(rec.o, rec.o.mode === "manual" ? (await loadState()).S : null), { token: rec.o.token }));
  }
  if (P === "/api/webhook/mercadopago" && (M === "POST" || M === "GET")) {
    let b = {}; if (M === "POST") { try { b = await readJson(req, 1e6) } catch (e) { b = {} } }
    const id = String((b.data && b.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
    /* na Vercel o trabalho precisa terminar antes da resposta; o aviso pode ser falso, então a entrega só acontece depois de consultar o pagamento */
    if (/^\d+$/.test(id)) { const rec = (await queryOrders(["mpId", id], 1))[0]; if (rec) await checkPaid(rec, true) }
    return send(res, 200, { ok: true });
  }
  if ((m = P.match(/^\/api\/download\/([a-f0-9]{32})\/(\d+)\/(\d+)$/)) && (M === "GET" || M === "HEAD")) {
    const rec = (await queryOrders(["token", m[1]], 1))[0], o = rec && rec.o;
    const g = o && o.status === "entregue" && o.keys && o.keys[+m[2]], c = g && g.codes[+m[3]];
    if (!c || !(isUrl(c) || isFile(c))) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Download não encontrado.") }
    const ref = isFile(c) ? c.slice(8) : c;
    if (isUrl(ref)) { /* Vercel Blob (ou link externo): o navegador baixa direto do armazenamento, sem sair da loja */
      let dest = directUrl(ref);
      if (/\.blob\.vercel-storage\.com\//.test(dest)) dest += (dest.includes("?") ? "&" : "?") + "download=1";
      res.writeHead(302, { Location: dest, "Cache-Control": "private, no-store" }); return res.end();
    }
    const fid = ref.replace(/[^a-z0-9]/gi, ""), fp = path.join(FILES, fid); /* modo local */
    let stt; try { stt = await fsp.stat(fp) } catch (e) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Arquivo não está mais no servidor.") }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": stt.size, "Content-Disposition": disposition(g.fn || g.name), "Cache-Control": "private, no-store" });
    if (M === "HEAD") return res.end();
    return pipeline(fs.createReadStream(fp), res).catch(() => {});
  }
  /* envio do arquivo do jogo direto do navegador do admin para o Vercel Blob (sem o limite de 4,5 MB) */
  if (P === "/api/blob" && M === "POST") {
    if (!BLOB_ON) return send(res, 503, { error: "Vercel Blob não configurado: crie um Blob store no painel da Vercel e conecte ao projeto." });
    const body = await readJson(req, 1e6);
    const { handleUpload } = await import("@vercel/blob/client");
    try {
      const j = await handleUpload({
        body, request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (!passOk(clientPayload)) throw new Error("Senha do admin incorreta.");
          return { addRandomSuffix: true, tokenPayload: "" };
        },
        onUploadCompleted: async () => {}
      });
      return send(res, 200, j);
    } catch (e) { return send(res, 400, { error: e.message }) }
  }

  /* admin */
  if (P.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Senha do admin incorreta." });
    if (P === "/api/admin/db" && M === "GET") {
      const [st, orders] = await Promise.all([loadState(), queryOrders(null, 500)]);
      return send(res, 200, { db: Object.assign({}, st.S, { orders: orders.map(r => r.o) }), rev: st.ut || "novo", ip: !!MP_TOKEN, blob: BLOB_ON });
    }
    if (P === "/api/admin/db" && M === "PUT") {
      const b = await readJson(req);
      const st = normState(b.db), writes = [];
      for (const p of st.products) p.f = (Array.isArray(p.f) ? p.f : []).map(u => { const w = photoWrite(u); if (w) { writes.push(w.write); return w.url } return u });
      writes.push(stateWrite(st, b.rev === "novo" ? null : b.rev));
      try { const j = await commit(writes); return send(res, 200, { rev: j.writeResults[j.writeResults.length - 1].updateTime }) }
      catch (e) { if (conflict(e)) return send(res, 409, { error: "Os dados mudaram. Tente de novo." }); throw e }
    }
    if (P === "/api/admin/foto" && M === "POST") {
      const b = await readJson(req, 2e6), w = photoWrite(b.data);
      if (!w) return send(res, 400, { error: "Imagem inválida." });
      await commit([w.write]); return send(res, 200, { url: w.url });
    }
    if (P === "/api/admin/clientes" && M === "GET") {
      if (!SA) return send(res, 503, { error: "Firebase não configurado (FIREBASE_SERVICE_ACCOUNT)." });
      const users = []; let page = 0, offset = 0;
      try {
        while (page++ < 20) {
          const j = await gfetch(`${IDTK}/v1/projects/${FB_PROJECT}/accounts:query`, { method: "POST", body: JSON.stringify({ returnUserInfo: true, limit: "500", offset: String(offset) }) });
          const list = j.userInfo || []; users.push(...list); offset += list.length; if (list.length < 500) break;
        }
      } catch (e) { return send(res, 502, { error: "Não consegui listar as contas no Firebase: " + e.message }) }
      const stats = {}; (await queryOrders(null, 1000)).forEach(({ o }) => { if (!o.uid) return; const s = stats[o.uid] || (stats[o.uid] = { n: 0, total: 0 }); if (o.status === "entregue") { s.n++; s.total += o.total } });
      return send(res, 200, { clientes: users.map(u => ({ uid: u.localId, email: u.email || "", nome: u.displayName || "", criado: +u.createdAt || 0, ultimo: +u.lastLoginAt || 0, desativado: !!u.disabled, compras: (stats[u.localId] || {}).n || 0, gasto: (stats[u.localId] || {}).total || 0 })).sort((a, b) => b.criado - a.criado) });
    }
    if (P === "/api/admin/upload" && M === "POST") { /* só no modo local, sem Vercel Blob */
      fs.mkdirSync(FILES, { recursive: true });
      const fid = "f" + Date.now().toString(36) + crypto.randomBytes(6).toString("hex"), fp = path.join(FILES, fid);
      try { await pipeline(req, fs.createWriteStream(fp)) } catch (e) { fsp.unlink(fp).catch(() => {}); return send(res, 500, { error: "Falha ao receber o arquivo." }) }
      const stt = await fsp.stat(fp); return send(res, 200, { fid, fz: stt.size });
    }
    if ((m = P.match(/^\/api\/admin\/deliver\/([A-Z0-9]{6})$/)) && M === "POST") {
      const r = await deliverTx(m[1], o => { o.paidManual = true });
      if (!r) return send(res, 404, { error: "Pedido não encontrado." });
      return send(res, 200, { status: r.o.status });
    }
    return send(res, 404, { error: "Rota não encontrada." });
  }
  return send(res, 404, { error: "Rota não encontrada." });
}

async function handle(req, res) {
  try { await route(req, res) }
  catch (e) {
    if (!e.status || e.status >= 500) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Erro no servidor. Tente de novo." }); else res.end();
  }
}

/* diagnóstico (usado pelo servidor local ao ligar) */
async function diagnose() {
  const out = [];
  if (!ADMIN_PASSWORD) out.push("✖ Falta ADMIN_PASSWORD.");
  if (!MP_TOKEN) out.push("✖ Falta MERCADOPAGO_ACCESS_TOKEN.");
  else { try { const u = await mp("GET", "/users/me"); out.push((await mpIsTest()) ? `✖ Mercado Pago: token de CONTA DE TESTE (${u.email || u.nickname}).` : `✔ Mercado Pago: conta ${u.email || u.nickname || u.id}`) } catch (e) { out.push("✖ Mercado Pago: " + await mpErro(e)) } }
  if (!SA) out.push("✖ Falta FIREBASE_SERVICE_ACCOUNT.");
  else {
    try { await loadState(); out.push(`✔ Firestore conectado (projeto ${FB_PROJECT})`) } catch (e) { out.push("✖ Firestore: " + e.message) }
    out.push((await findApiKey()) ? "✔ Firebase Authentication: chave web encontrada" : "✖ Firebase: não achei a Chave de API da Web (FIREBASE_API_KEY).");
  }
  out.push(BLOB_ON ? "✔ Vercel Blob configurado" : "• Vercel Blob não configurado (local: arquivos ficam na pasta data/files)");
  return out;
}

module.exports = { handle, diagnose };
