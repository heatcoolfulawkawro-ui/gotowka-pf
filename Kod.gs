// Gotówka PF — backend (Apps Script Web App podpięty do Arkusza).
//
// Wszystko idzie przez POST {action, token, ...} z Content-Type text/plain (bez preflightu CORS).
// Konta: login (skrót) + 4-10-cyfrowy PIN. PIN-u nigdy nie zapisujemy — tylko HMAC(PIN; pepper+sól),
// pepper leży we właściwościach skryptu. PIN ustawia sam właściciel konta przez jednorazowy link
// wysłany mailem (zaproszenie od admina albo „Nie pamiętam PIN-u"). Tokeny sesji i linków są
// zapisywane tylko jako SHA-256. Wzorzec 1:1 z Wydatków domowych (Kod.gs), przycięty do dwóch kont
// (od 28.09.2026 — wcześniej appka miała jeden wspólny PIN dla PF+ZF, patrz niżej).
//
// Dane: jeden wspólny klucz `gotowkaPfState` w zakładce Data (key/value) — pula gotówki i wpisy są
// wspólne dla PF i ZF (to jedna fizyczna gotówka), każdy zalogowany widzi i edytuje to samo. Konta
// dają osobne logowanie/PIN, NIE osobne dane — kto co wpisał, znaczy tag „PF"/„ZF" na wpisie
// (pole `who`, ustawiane w appce, niezależne od tego, kto jest akurat zalogowany).

const APP_URL = 'https://heatcoolfulawkawro-ui.github.io/gotowka-pf/';
const APP_NAME = 'Gotówka PF';
const TZ = 'Europe/Warsaw';

const USERS_SHEET = 'Users';
const USERS_HEADERS = ['id', 'name', 'role', 'email', 'salt', 'hash', 'fails', 'lockUntil', 'active', 'lockCount', 'createdAt'];
const SESSIONS_SHEET = 'Sessions';
const SESSIONS_HEADERS = ['tokenHash', 'userId', 'expires', 'createdAt'];
const LINKS_SHEET = 'Links';
const LINKS_HEADERS = ['tokenHash', 'userId', 'purpose', 'expires', 'used', 'createdAt'];
const AUDIT_SHEET = 'Audit';
const AUDIT_HEADERS = ['time', 'actor', 'action', 'target', 'detail'];

const SESSION_TTL_MS = 60 * 24 * 3600 * 1000;
const LINK_TTL_MS = 48 * 3600 * 1000;
const LINK_MIN_GAP_MS = 60 * 1000; // najwyżej jeden mail z linkiem na minutę na konto
const MAX_FAILS = 5;
const LOCK_BASE_MS = 5 * 60 * 1000;
const LOCK_MAX_MS = 24 * 3600 * 1000;

// ---------- Sync PIN-u konta PF z siostrzanymi appkami ----------
// CELOWO PUSTE od 28.09.2026. Do tego dnia Gotówka miała JEDEN wspólny PIN dla
// całej appki (PF+ZF razem) i była podpięta do rodziny Paliwo/Waga/karta godzin/
// Wydatki — efekt: gdy Zuzia zresetowała ten wspólny PIN, rozjechało się to na
// PIN konta PF we WSZYSTKICH appkach Pawła (realny incydent). Teraz appka ma
// dwa prawdziwe, niezależne konta (PF, ZF) — PIN konta PF tutaj jest znowu
// osobnym sekretem, nie tym samym co PIN Pawła gdzie indziej. Mechanizm sync
// zostaje w kodzie (na wypadek świadomej decyzji, żeby jednak podpiąć PF z
// powrotem), ale SIBLING_URLS ma zostać puste, dopóki ktoś świadomie tego nie
// zmieni — NIE dopisuj tu z automatu URL-i innych appek.
const PF_ID = 'PF';
const SIBLING_URLS = [];

function bootstrapSyncSecret_(b) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SYNC_SECRET')) return fail_('exists');
  const secret = String(b.secret || '');
  if (secret.length < 20) return fail_('bad');
  props.setProperty('SYNC_SECRET', secret);
  return { ok: true };
}

function resetSyncSecret_(b) {
  const pin = validPin_(b.pin);
  if (!pin) return fail_('bad');
  const u = findUser_(PF_ID);
  if (!u || !safeEqual_(hashPin_(pin, u.salt), u.hash)) return fail_('auth');
  const secret = String(b.secret || '');
  if (secret.length < 20) return fail_('bad');
  PropertiesService.getScriptProperties().setProperty('SYNC_SECRET', secret);
  return { ok: true };
}

// Odbiór PIN-u z siostrzanej appki — dotyczy WYŁĄCZNIE konta PF, nie rozsyła dalej.
function syncPinPush_(b) {
  const real = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!real || String(b.secret || '') !== real) return fail_('auth');
  const pin = validPin_(b.newPin);
  if (!pin) return { ok: true }; // inny format PIN-u u siostry — pomijamy, to nie błąd
  const u = findUser_(PF_ID);
  if (!u) return fail_('bad');
  setPin_(u, pin);
  return { ok: true };
}

function syncSelftest_() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret) return fail_('nosecret');
  const results = SIBLING_URLS.map(function (url) {
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'text/plain',
        payload: JSON.stringify({ action: 'sync_ping', secret: secret }),
        muteHttpExceptions: true
      });
      return { url: url, status: res.getResponseCode(), body: res.getContentText().slice(0, 300) };
    } catch (e) {
      return { url: url, error: e.message };
    }
  });
  return { ok: true, results: results };
}

// Wywoływane, gdy PIN konta PF faktycznie się zmienił — rozsyła do sióstr (dziś: nikogo, lista pusta).
function pushPinToSiblings_(pin) {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret) return;
  SIBLING_URLS.forEach(function (url) { pushOneSiblingWithRetry_(url, secret, pin); });
}

function pushOneSiblingWithRetry_(url, secret, newPin) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'text/plain',
        payload: JSON.stringify({ action: 'sync_pin_push', secret: secret, newPin: newPin }),
        muteHttpExceptions: true
      });
      const body = JSON.parse(res.getContentText());
      if (body && body.ok) return;
    } catch (e) { /* spróbuj jeszcze raz niżej */ }
    if (attempt === 0) Utilities.sleep(2000);
  }
}

// ---------- Zmiana PIN-u konta PF: kod z maila + potwierdzenie klikiem w link ----------
// Dwa etapy, oba wymagane: (1) request wysyła 6-cyfrowy kod, (2) confirm z poprawnym
// kodem NIE zmienia PIN-u od razu — dopiero wysyła link, którego kliknięcie (doGet,
// patrz confirmPinLink_) go zatwierdza. Dotyczy WYŁĄCZNIE konta PF; ZF ma zwykłą,
// jednoetapową ścieżkę linkiem (setPinByLink_) — identycznie jak w Wydatkach domowych.
function requestPinResetLegacy_() {
  const props = PropertiesService.getScriptProperties();
  const lastReq = Number(props.getProperty('PIN_RESET_LAST_REQ') || 0);
  if (Date.now() - lastReq < 2 * 60 * 1000) return fail_('Poczekaj chwilę i spróbuj ponownie.');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  props.setProperty('PIN_RESET_CODE', code);
  props.setProperty('PIN_RESET_EXPIRES', String(Date.now() + 10 * 60 * 1000));
  props.setProperty('PIN_RESET_LAST_REQ', String(Date.now()));
  MailApp.sendEmail(ownerEmail_(), 'Kod do zmiany PIN — ' + APP_NAME, 'Twój kod do zmiany PIN: ' + code + '\n\nWażny 10 minut. Jeśli to nie Ty, zignoruj tę wiadomość.');
  return { ok: true };
}

function confirmPinResetLegacy_(code, newPin) {
  const props = PropertiesService.getScriptProperties();
  const storedCode = props.getProperty('PIN_RESET_CODE');
  const expires = Number(props.getProperty('PIN_RESET_EXPIRES') || 0);
  const pin = validPin_(newPin);
  if (!storedCode || String(code) !== storedCode) return fail_('Nieprawidłowy kod');
  if (Date.now() > expires) return fail_('Kod wygasł — poproś o nowy');
  if (!pin) return fail_('PIN to 4-10 cyfr');
  props.deleteProperty('PIN_RESET_CODE');
  props.deleteProperty('PIN_RESET_EXPIRES');
  const token = Utilities.getUuid();
  props.setProperty('PIN_CONFIRM_TOKEN', token);
  props.setProperty('PIN_CONFIRM_NEWPIN', pin);
  props.setProperty('PIN_CONFIRM_EXPIRES', String(Date.now() + 30 * 60 * 1000));
  const url = ScriptApp.getService().getUrl() + '?confirmPin=' + encodeURIComponent(token);
  MailApp.sendEmail(ownerEmail_(), 'Potwierdź zmianę PIN — ' + APP_NAME, 'Kliknij, żeby potwierdzić zmianę PIN-u:\n' + url + '\n\nWażne 30 minut. Jeśli to nie Ty, zignoruj — PIN się nie zmieni.');
  return { ok: true, pending: true };
}

// Wywoływane przez GET po kliknięciu linku z maila (patrz doGet) — bez tokenu sesji,
// bo mail otwiera się często na innym urządzeniu niż to, na którym appka jest otwarta.
function confirmPinLink_(token) {
  const props = PropertiesService.getScriptProperties();
  const storedToken = props.getProperty('PIN_CONFIRM_TOKEN');
  const expires = Number(props.getProperty('PIN_CONFIRM_EXPIRES') || 0);
  const newPin = props.getProperty('PIN_CONFIRM_NEWPIN');
  if (!storedToken || token !== storedToken || Date.now() > expires || !newPin) {
    return htmlPage_('Link nieprawidłowy albo wygasł', 'Poproś o nowy kod w aplikacji i spróbuj ponownie.');
  }
  props.deleteProperty('PIN_CONFIRM_TOKEN');
  props.deleteProperty('PIN_CONFIRM_EXPIRES');
  props.deleteProperty('PIN_CONFIRM_NEWPIN');
  const u = findUser_(PF_ID);
  if (!u) return htmlPage_('Błąd', 'Nie znaleziono konta.');
  setPin_(u, newPin);
  pushPinToSiblings_(newPin);
  return htmlPage_('PIN zmieniony ✓', 'Możesz zamknąć to okno i wrócić do aplikacji.');
}

function htmlPage_(title, msg) {
  return HtmlService.createHtmlOutput(
    '<html><body style="font-family:-apple-system,sans-serif;background:#12181d;color:#e8edf1;padding:40px 20px;text-align:center;">' +
    '<h2>' + title + '</h2><p style="color:#8fa0ab">' + msg + '</p></body></html>'
  );
}

// ---------- wejścia ----------

function doGet(e) {
  if (e && e.parameter.confirmPin) return confirmPinLink_(e.parameter.confirmPin);
  // Ping (światełko połączenia): 200 z pustą treścią. Danych przez GET nie wydajemy.
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let b;
  try {
    b = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'bad' });
  }
  if (!b || typeof b.action !== 'string') return jsonOut_({ ok: false, error: 'bad' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return jsonOut_(dispatch_(b));
  } catch (err) {
    console.error(err && err.stack || err);
    return jsonOut_({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

function fail_(code, extra) {
  return Object.assign({ ok: false, error: code }, extra || {});
}

function dispatch_(b) {
  const action = b.action;
  switch (action) {
    case 'status': return { ok: true, setup: readUsers_().length === 0 };
    case 'bootstrap': return bootstrap_(b);
    case 'login': return login_(b);
    case 'requestLink': return requestLink_(b);
    case 'checkLink': return checkLink_(b);
    case 'setPinByLink': return setPinByLink_(b);
    case 'bootstrap_sync_secret': return bootstrapSyncSecret_(b);
    case 'reset_sync_secret': return resetSyncSecret_(b);
    case 'sync_pin_push': return syncPinPush_(b);
    case 'sync_selftest': return syncSelftest_();
    case 'sync_ping': {
      const real = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
      return { ok: !!real && String(b.secret || '') === real };
    }
  }
  const auth = authenticate_(b.token);
  if (!auth) return fail_('auth');
  const user = auth.user;
  switch (action) {
    case 'me': return { ok: true, user: pub_(user) };
    case 'logout': revokeSessions_(user.id, auth.tokenHash); return { ok: true };
    case 'changePin': return changePin_(user, b);
    case 'requestPinReset':
      if (user.id !== PF_ID) return fail_('forbidden');
      return requestPinResetLegacy_();
    case 'confirmPinReset':
      if (user.id !== PF_ID) return fail_('forbidden');
      return confirmPinResetLegacy_(b.code, b.newPin);
    case 'get': return { ok: true, value: readData_(String(b.key || '')) };
    case 'set': return writeData_(String(b.key || ''), String(b.value == null ? '' : b.value));
  }
  if (action.indexOf('admin.') !== 0) return fail_('bad');
  if (user.role !== 'admin') return fail_('forbidden');
  const res = adminAction_(user, action, b);
  if (res.ok && action !== 'admin.list') audit_(user.id, action, b);
  return res;
}

function adminAction_(admin, action, b) {
  switch (action) {
    case 'admin.list': return { ok: true, users: readUsers_().map(adminView_) };
    case 'admin.createUser': return adminCreateUser_(b);
    case 'admin.sendLink': return adminSendLink_(b);
    case 'admin.setEmail': return adminSetEmail_(b);
    case 'admin.setActive': return adminSetActive_(admin, b);
    case 'admin.unlock': return adminUnlock_(b);
  }
  return fail_('bad');
}

// ---------- dane: jeden wspólny klucz w zakładce Data (pula + wpisy) ----------
// Format niezmieniony od pierwszego wdrożenia appki — tylko dostęp jest teraz
// przez token sesji zamiast surowego PIN-u w każdym zapytaniu.

function getDataSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Data');
  if (!sheet) {
    sheet = ss.insertSheet('Data');
    sheet.appendRow(['key', 'value']);
  }
  return sheet;
}

function readData_(key) {
  if (!key) return '';
  const rows = getDataSheet().getDataRange().getValues();
  for (let i = 0; i < rows.length; i++) if (rows[i][0] === key) return rows[i][1];
  return '';
}

function writeData_(key, value) {
  if (!key) return fail_('bad');
  const sheet = getDataSheet();
  const rows = sheet.getDataRange().getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) { sheet.getRange(i + 1, 2).setValue(value); return { ok: true }; }
  }
  sheet.appendRow([key, value]);
  return { ok: true };
}

// ---------- konta ----------

// Pierwsze uruchomienie (pusta tabela Users): tworzy konto admina i wysyła link do ustawienia
// PIN-u WYŁĄCZNIE na adres właściciela skryptu — obcy, który zna adres /exec, nic nie zyska.
function bootstrap_(b) {
  if (readUsers_().length) return fail_('exists');
  const id = validId_(b.id);
  const name = cleanName_(b.name);
  if (!id || !name) return fail_('bad');
  const email = ownerEmail_();
  if (!email) return fail_('noemail');
  createUser_(id, name, 'admin', email);
  const u = findUser_(id);
  sendLink_(u, 'invite');
  audit_(id, 'bootstrap', { id: id });
  return { ok: true, sentTo: maskEmail_(email) };
}

function login_(b) {
  const id = validId_(b.user);
  const pin = validPin_(b.pin);
  if (!id || !pin) return fail_('bad');
  const u = findUser_(id);
  if (!u || !u.active || !u.hash) return fail_('bad');
  const now = Date.now();
  if (u.lockUntil > now) return fail_('locked', { retryMs: u.lockUntil - now });
  if (!safeEqual_(hashPin_(pin, u.salt), u.hash)) {
    u.fails += 1;
    if (u.fails >= MAX_FAILS) {
      u.lockCount += 1;
      u.lockUntil = now + Math.min(LOCK_BASE_MS * Math.pow(2, u.lockCount - 1), LOCK_MAX_MS);
      u.fails = 0;
    }
    saveUser_(u);
    return u.lockUntil > now ? fail_('locked', { retryMs: u.lockUntil - now }) : fail_('bad');
  }
  u.fails = 0;
  u.lockCount = 0;
  u.lockUntil = 0;
  saveUser_(u);
  return newSession_(u);
}

function newSession_(u) {
  purgeExpired_(SESSIONS_SHEET, SESSIONS_HEADERS, 2);
  const now = Date.now();
  const token = randomToken_();
  const expires = now + SESSION_TTL_MS;
  getSheet_(SESSIONS_SHEET, SESSIONS_HEADERS).appendRow([sha256Hex_(token), u.id, expires, now]);
  return { ok: true, token: token, expires: expires, user: pub_(u) };
}

// „Nie pamiętam PIN-u” / pierwsze logowanie. Odpowiedź jest zawsze taka sama (nie zdradza,
// czy konto istnieje i jaki ma adres), mail idzie tylko na adres zapisany przy koncie.
function requestLink_(b) {
  const id = validId_(b.user);
  const u = id ? findUser_(id) : null;
  if (u && u.active && u.email) {
    const last = lastLinkTime_(u.id);
    if (Date.now() - last > LINK_MIN_GAP_MS) sendLink_(u, u.hash ? 'reset' : 'invite');
  }
  return { ok: true };
}

function checkLink_(b) {
  const link = findLink_(b.link);
  if (!link) return fail_('link');
  const u = findUser_(link.userId);
  if (!u || !u.active) return fail_('link');
  return { ok: true, user: { id: u.id, name: u.name }, purpose: link.purpose };
}

function setPinByLink_(b) {
  const pin = validPin_(b.pin);
  if (!pin) return fail_('bad');
  const link = findLink_(b.link);
  if (!link) return fail_('link');
  const u = findUser_(link.userId);
  if (!u || !u.active) return fail_('link');
  // Konto PF ma osobną, zabezpieczoną ścieżkę NADPISANIA istniejącego PIN-u
  // (kod z maila + potwierdzenie klikiem w DRUGI link — patrz
  // requestPinResetLegacy_/confirmPinResetLegacy_); ten link (jednoetapowy,
  // sam wystarcza) jest dla niego zablokowany, ale TYLKO gdy PIN już
  // istnieje — pierwsze ustawienie świeżego konta (bootstrap albo
  // zaproszenie od admina) nie ma jeszcze czego chronić.
  if (link.userId === PF_ID && u.hash) return fail_('forbidden');
  getSheet_(LINKS_SHEET, LINKS_HEADERS).getRange(link.row, 5).setValue(true);
  setPin_(u, pin);
  audit_(u.id, 'setPinByLink', { id: u.id, purpose: link.purpose });
  return newSession_(findUser_(u.id));
}

function changePin_(user, b) {
  // Patrz komentarz w setPinByLink_ — to samo dotyczy tej prostszej ścieżki
  // (stary PIN -> nowy PIN, bez maila).
  if (user.id === PF_ID) return fail_('forbidden');
  const oldPin = validPin_(b.oldPin);
  const newPin = validPin_(b.newPin);
  if (!oldPin || !newPin) return fail_('bad');
  const u = findUser_(user.id);
  if (!safeEqual_(hashPin_(oldPin, u.salt), u.hash)) return fail_('bad');
  setPin_(u, newPin);
  return newSession_(findUser_(u.id));
}

function adminCreateUser_(b) {
  const id = validId_(b.id);
  const name = cleanName_(b.name);
  const email = validEmail_(b.email);
  if (!id || !name || !email) return fail_('bad');
  if (findUser_(id)) return fail_('exists');
  createUser_(id, name, b.role === 'admin' ? 'admin' : 'user', email);
  const sent = trySendLink_(findUser_(id), 'invite');
  return { ok: true, sent: sent, users: readUsers_().map(adminView_) };
}

function adminSendLink_(b) {
  const u = findUser_(validId_(b.id));
  if (!u || !u.email) return fail_('bad');
  const sent = trySendLink_(u, u.hash ? 'reset' : 'invite');
  return { ok: true, sent: sent, users: readUsers_().map(adminView_) };
}

function adminSetEmail_(b) {
  const u = findUser_(validId_(b.id));
  const email = validEmail_(b.email);
  if (!u || !email) return fail_('bad');
  u.email = email;
  saveUser_(u);
  return { ok: true, users: readUsers_().map(adminView_) };
}

function adminSetActive_(admin, b) {
  const u = findUser_(validId_(b.id));
  if (!u || u.id === admin.id) return fail_('bad');
  u.active = b.active === true;
  saveUser_(u);
  if (!u.active) revokeSessions_(u.id, null);
  return { ok: true, users: readUsers_().map(adminView_) };
}

function adminUnlock_(b) {
  const u = findUser_(validId_(b.id));
  if (!u) return fail_('bad');
  u.fails = 0;
  u.lockCount = 0;
  u.lockUntil = 0;
  saveUser_(u);
  return { ok: true, users: readUsers_().map(adminView_) };
}

// ---------- linki mailowe ----------

function trySendLink_(u, purpose) {
  try {
    sendLink_(u, purpose);
    return true;
  } catch (err) {
    console.error(err && err.stack || err);
    return false;
  }
}

function sendLink_(u, purpose) {
  const token = randomToken_();
  const now = Date.now();
  purgeExpired_(LINKS_SHEET, LINKS_HEADERS, 3);
  getSheet_(LINKS_SHEET, LINKS_HEADERS).appendRow([sha256Hex_(token), u.id, purpose, now + LINK_TTL_MS, false, now]);
  const url = APP_URL + '?pin=' + token;
  const first = purpose === 'invite';
  const subject = APP_NAME + (first ? ' — ustaw swój PIN' : ' — nowy PIN');
  const lines = [
    'Cześć ' + u.name + ',',
    '',
    first ? 'Masz konto w appce ' + APP_NAME + '. Twój login: ' + u.id + '.'
          : 'Ktoś (pewnie Ty) poprosił o ustawienie nowego PIN-u do appki ' + APP_NAME + '. Login: ' + u.id + '.',
    'Otwórz link i ustaw 4-10-cyfrowy PIN:',
    url,
    '',
    'Link działa 48 godzin i tylko raz.',
    first ? '' : 'Jeśli to nie Ty — zignoruj tę wiadomość, stary PIN dalej działa.'
  ];
  const html = '<p>Cześć ' + esc_(u.name) + ',</p><p>' +
    (first ? 'Masz konto w appce <b>' + APP_NAME + '</b>. Twój login: <b>' + esc_(u.id) + '</b>.'
           : 'Ktoś (pewnie Ty) poprosił o ustawienie nowego PIN-u do appki <b>' + APP_NAME + '</b>. Login: <b>' + esc_(u.id) + '</b>.') +
    '</p><p><a href="' + url + '" style="display:inline-block;background:#e8a33d;color:#20140a;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Ustaw PIN</a></p>' +
    '<p style="color:#666;font-size:13px">Link działa 48 godzin i tylko raz.' + (first ? '' : ' Jeśli to nie Ty — zignoruj tę wiadomość, stary PIN dalej działa.') + '</p>';
  MailApp.sendEmail({ to: u.email, subject: subject, body: lines.join('\n'), htmlBody: html, name: APP_NAME });
}

function findLink_(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const h = sha256Hex_(token);
  const rows = getSheet_(LINKS_SHEET, LINKS_HEADERS).getDataRange().getValues();
  const now = Date.now();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== h) continue;
    if (rows[i][4] === true || rows[i][4] === 'TRUE' || Number(rows[i][3]) < now) return null;
    return { row: i + 1, userId: String(rows[i][1]), purpose: String(rows[i][2]) };
  }
  return null;
}

function lastLinkTime_(userId) {
  const rows = getSheet_(LINKS_SHEET, LINKS_HEADERS).getDataRange().getValues();
  let last = 0;
  for (let i = 1; i < rows.length; i++) if (String(rows[i][1]) === userId) last = Math.max(last, Number(rows[i][5]) || 0);
  return last;
}

// ---------- utils ----------

function adminView_(u) {
  return {
    id: u.id, name: u.name, role: u.role, email: u.email, active: u.active,
    hasPin: !!u.hash, locked: u.lockUntil > Date.now(), lockUntil: u.lockUntil
  };
}

function pub_(u) {
  return { id: u.id, name: u.name, role: u.role };
}

function validId_(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{1,6}$/.test(s) ? s : null;
}

function validPin_(v) {
  const s = String(v || '');
  return /^\d{4,10}$/.test(s) ? s : null;
}

function validEmail_(v) {
  const s = String(v || '').trim();
  return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/.test(s) ? s : null;
}

function cleanName_(v) {
  const s = String(v || '').replace(/[<>"]/g, '').trim();
  return s && s.length <= 40 ? s : null;
}

function ownerEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

function maskEmail_(e) {
  const at = e.indexOf('@');
  return at > 1 ? e[0] + '•••' + e.slice(at - 1) : e;
}

function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PEPPER');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PEPPER', p);
  }
  return p;
}

function hashPin_(pin, salt) {
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(pin, getPepper_() + ':' + salt));
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function readUsers_() {
  const rows = getSheet_(USERS_SHEET, USERS_HEADERS).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    out.push({
      row: i + 1, id: String(r[0]), name: String(r[1]), role: String(r[2]), email: String(r[3] || ''),
      salt: String(r[4] || ''), hash: String(r[5] || ''), fails: Number(r[6]) || 0,
      lockUntil: Number(r[7]) || 0, active: r[8] === true || r[8] === 'TRUE',
      lockCount: Number(r[9]) || 0, createdAt: r[10]
    });
  }
  return out;
}

function findUser_(id) {
  if (!id) return null;
  const list = readUsers_();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function userRow_(u) {
  return [u.id, u.name, u.role, u.email, u.salt, u.hash, u.fails, u.lockUntil, u.active, u.lockCount, u.createdAt];
}

function saveUser_(u) {
  getSheet_(USERS_SHEET, USERS_HEADERS).getRange(u.row, 1, 1, USERS_HEADERS.length).setValues([userRow_(u)]);
}

// Konto powstaje bez PIN-u — PIN ustawia właściciel przez link z maila.
function createUser_(id, name, role, email) {
  getSheet_(USERS_SHEET, USERS_HEADERS).appendRow(userRow_({
    id: id, name: name, role: role, email: email, salt: '', hash: '', fails: 0,
    lockUntil: 0, active: true, lockCount: 0, createdAt: Date.now()
  }));
}

function setPin_(u, pin) {
  u.salt = Utilities.getUuid();
  u.hash = hashPin_(pin, u.salt);
  u.fails = 0;
  u.lockCount = 0;
  u.lockUntil = 0;
  saveUser_(u);
  revokeSessions_(u.id, null);
}

function authenticate_(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const tokenHash = sha256Hex_(token);
  const rows = getSheet_(SESSIONS_SHEET, SESSIONS_HEADERS).getDataRange().getValues();
  const now = Date.now();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === tokenHash) {
      if (Number(rows[i][2]) < now) return null;
      const user = findUser_(String(rows[i][1]));
      if (!user || !user.active) return null;
      return { user: user, tokenHash: tokenHash };
    }
  }
  return null;
}

function revokeSessions_(userId, onlyHash) {
  const sheet = getSheet_(SESSIONS_SHEET, SESSIONS_HEADERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    const match = onlyHash ? rows[i][0] === onlyHash : String(rows[i][1]) === userId;
    if (match) sheet.deleteRow(i + 1);
  }
}

// Usuwa wiersze, których termin ważności (kolumna expiresCol, liczona od 0) minął.
function purgeExpired_(name, headers, expiresCol) {
  const sheet = getSheet_(name, headers);
  const rows = sheet.getDataRange().getValues();
  const now = Date.now();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (Number(rows[i][expiresCol]) < now) sheet.deleteRow(i + 1);
  }
}

function audit_(actor, action, b) {
  const detail = {};
  ['id', 'name', 'email', 'active', 'role', 'purpose'].forEach(function (k) {
    if (b && b[k] !== undefined) detail[k] = b[k];
  });
  getSheet_(AUDIT_SHEET, AUDIT_HEADERS).appendRow([
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), actor, action, String(detail.id || ''), JSON.stringify(detail)
  ]);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Uruchom RAZ ręcznie w edytorze Apps Script (Uruchom → autoryzuj), żeby właściciel przyznał
// uprawnienia: Arkusz, wysyłanie maili. Potem wdróż jako aplikację.
function autoryzuj() {
  getSheet_(USERS_SHEET, USERS_HEADERS);
  console.log('Właściciel: ' + ownerEmail_() + ', limit maili na dziś: ' + MailApp.getRemainingDailyQuota());
}
