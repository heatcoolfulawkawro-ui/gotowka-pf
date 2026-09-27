// Musi być identyczna wartość początkowa jak w index.html (jeśli tam też jest
// zapisana) — to tylko PIN startowy, zanim ktokolwiek go zmieni albo zanim
// rodzina appek nadpisze go przez sync. Po pierwszej zmianie/synchronizacji
// prawdziwy PIN żyje tylko w PropertiesService, ta stała już nie ma znaczenia.
const PIN_INITIAL = '7848890052';
const PIN_RESET_EMAIL = 'heatcoolfulawkawro@gmail.com';
// Zwracany zamiast danych z fetch(GET), gdy PIN się nie zgadza — pusty
// string ('') już oznacza "brak takiego klucza", więc potrzebny jest
// osobny, jednoznaczny sygnał, którego żadna prawdziwa wartość nigdy
// nie przyjmie.
const AUTH_FAIL_TEXT = '__BRAK_AUTORYZACJI__';

// ---------- Sync PIN-u z siostrzanymi appkami (ten sam PF/admin) ----------
// Żeby dołożyć kolejną appkę do tej samej "rodziny" jednego kodu:
//   1) w NOWEJ appce wklej dokładnie ten sam blok kodu (SIBLING_URLS,
//      bootstrapSyncSecret, syncPinPush, pushPinToSiblings) i dopisz wywołanie
//      pushPinToSiblings(newPin) na końcu jej confirmPinReset — patrz niżej.
//   2) do SIBLING_URLS TEJ appki i wszystkich pozostałych już istniejących
//      dopisz URL nowej appki (i dopisz URL-e istniejących do listy nowej).
//   3) zbootstrapuj w nowej appce TEN SAM sekret co reszta rodziny (jednym
//      POST-em z action:'bootstrap_sync_secret' — działa tylko raz, dopóki
//      SYNC_SECRET jest puste).
const SIBLING_URLS = [
  'https://script.google.com/macros/s/AKfycbwp2qGgpobvHRCOurqA614AxnIA5ozdLlv_EsIr1Ve8t3vNp3Qur8ZfashMQpSZFuM/exec', // Paliwo PF
  'https://script.google.com/macros/s/AKfycbz3-nc9P2jTv3pX2_aiP6Ne7A67QXtZHObP53BU3GNMIjgrThQSJtfaOCnBbGSGSRQI/exec', // Waga PF
  'https://script.google.com/macros/s/AKfycby09rSaJwoPPl6KeFn80xCOTiOzYM4EZyKy5XuJ0pBA28-x051wB9HXg_osSqUrjoHA/exec', // Karta godzin (konto PF)
  'https://script.google.com/macros/s/AKfycby-n1t8ehXtz9sNEByK-dZbObSAs39RKOovANpGIefLbs2-spAlx1iwdFb9CUK5fVZH/exec' // Wydatki domowe (konto PF)
];

function bootstrapSyncSecret(secret) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SYNC_SECRET')) return jsonOut({ ok: false, error: 'Sekret już ustawiony' });
  if (!secret || String(secret).length < 20) return jsonOut({ ok: false, error: 'Za krótki sekret' });
  props.setProperty('SYNC_SECRET', String(secret));
  return jsonOut({ ok: true });
}

// Rozszerzenie rodziny appek o kolejnego członka: nadpisuje sekret, gated
// znajomością aktualnego PIN-u (nie samego sekretu, bo część appek go już ma
// ustawionego i nie da się go odczytać z powrotem).
function resetSyncSecret(pin, secret) {
  if (String(pin) !== currentPin()) return jsonOut({ ok: false, error: 'Brak autoryzacji' });
  if (!secret || String(secret).length < 20) return jsonOut({ ok: false, error: 'Za krótki sekret' });
  PropertiesService.getScriptProperties().setProperty('SYNC_SECRET', String(secret));
  return jsonOut({ ok: true });
}

// Odbiór PIN-u z siostrzanej appki — NIE rozsyła dalej (jeden przeskok,
// żeby appki nie wołały się w kółko).
function syncPinPush(secret, newPin) {
  const real = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!real || String(secret) !== real) return jsonOut({ ok: false, error: 'Brak autoryzacji' });
  if (!/^\d{4,12}$/.test(String(newPin))) return jsonOut({ ok: false, error: 'Zły format PIN' });
  PropertiesService.getScriptProperties().setProperty('APP_PIN', String(newPin));
  return jsonOut({ ok: true });
}

// Diagnostyka: sprawdza, czy ta appka faktycznie dobija się (POST, nie GET
// po przekierowaniu) do każdej appki z SIBLING_URLS i czy sekret się zgadza —
// bez dotykania PIN-u. sync_ping po drugiej stronie tylko potwierdza sekret.
function syncSelftest() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret) return jsonOut({ ok: false, error: 'Brak SYNC_SECRET — najpierw bootstrap' });
  const results = SIBLING_URLS.map(function (url) {
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'text/plain',
        payload: JSON.stringify({ action: 'sync_ping', secret: secret }),
        muteHttpExceptions: true,
        followRedirects: true
      });
      return { url: url, status: res.getResponseCode(), body: res.getContentText().slice(0, 300) };
    } catch (e) {
      return { url: url, error: e.message };
    }
  });
  return jsonOut({ ok: true, results: results });
}

// Wywoływane PO stronie appki, w której PIN faktycznie się zmienił —
// rozsyła nowy PIN do sióstr. Najlepszego wysiłku: appka, która akurat nie
// odpowie, dogoni przy najbliższym auth-fail (pokaże błąd, pójdzie reset mailem).
function pushPinToSiblings(newPin) {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!secret) return;
  SIBLING_URLS.forEach(function (url) {
    try {
      UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'text/plain',
        payload: JSON.stringify({ action: 'sync_pin_push', secret: secret, newPin: newPin }),
        muteHttpExceptions: true
      });
    } catch (e) { /* best-effort — patrz komentarz wyżej */ }
  });
}

function currentPin() {
  return PropertiesService.getScriptProperties().getProperty('APP_PIN') || PIN_INITIAL;
}

function doGet(e) {
  if (String(e.parameter.pin) !== currentPin()) {
    return ContentService.createTextOutput(AUTH_FAIL_TEXT).setMimeType(ContentService.MimeType.JSON);
  }
  const key = e.parameter.key;
  const sheet = getDataSheet();
  const rows = sheet.getDataRange().getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) {
      return ContentService.createTextOutput(rows[i][1])
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  if (body.action === 'request_pin_reset') return requestPinReset();
  if (body.action === 'confirm_pin_reset') return confirmPinReset(body.code, body.newPin);
  if (body.action === 'sync_pin_push') return syncPinPush(body.secret, body.newPin);
  if (body.action === 'bootstrap_sync_secret') return bootstrapSyncSecret(body.secret);
  if (body.action === 'reset_sync_secret') return resetSyncSecret(body.pin, body.secret);
  if (body.action === 'sync_selftest') return syncSelftest();
  if (body.action === 'sync_ping') {
    const real = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
    return jsonOut({ ok: !!real && String(body.secret) === real });
  }

  if (String(body.pin) !== currentPin()) {
    return jsonOut({ ok: false, error: 'Brak autoryzacji' });
  }

  const key = body.key;
  const value = body.value;
  const sheet = getDataSheet();
  const rows = sheet.getDataRange().getValues();
  let found = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      found = true;
      break;
    }
  }
  if (!found) sheet.appendRow([key, value]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDataSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Data');
  if (!sheet) {
    sheet = ss.insertSheet('Data');
    sheet.appendRow(['key', 'value']);
  }
  return sheet;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- PIN: zmiana / przypomnienie przez kod z maila ----------
// Bez tokenu — to jedyna para akcji dostępna komuś, kto NIE zna aktualnego
// PIN-u (inaczej "zapomniałem PIN-u" nie dałoby się obsłużyć). Limit czasowy
// między żądaniami to jedyna ochrona przed zasypaniem skrzynki e-mail.
function requestPinReset() {
  const props = PropertiesService.getScriptProperties();
  const lastReq = Number(props.getProperty('PIN_RESET_LAST_REQ') || 0);
  if (Date.now() - lastReq < 2 * 60 * 1000) {
    return jsonOut({ ok: false, error: 'Poczekaj chwilę i spróbuj ponownie.' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  props.setProperty('PIN_RESET_CODE', code);
  props.setProperty('PIN_RESET_EXPIRES', String(Date.now() + 10 * 60 * 1000));
  props.setProperty('PIN_RESET_LAST_REQ', String(Date.now()));
  MailApp.sendEmail(PIN_RESET_EMAIL, 'Kod do zmiany PIN — Gotówka PF', 'Twój kod do zmiany PIN: ' + code + '\n\nWażny 10 minut. Jeśli to nie Ty, zignoruj tę wiadomość.');
  return jsonOut({ ok: true });
}

function confirmPinReset(code, newPin) {
  const props = PropertiesService.getScriptProperties();
  const storedCode = props.getProperty('PIN_RESET_CODE');
  const expires = Number(props.getProperty('PIN_RESET_EXPIRES') || 0);
  if (!storedCode || String(code) !== storedCode) return jsonOut({ ok: false, error: 'Nieprawidłowy kod' });
  if (Date.now() > expires) return jsonOut({ ok: false, error: 'Kod wygasł — poproś o nowy' });
  if (!/^\d{4,12}$/.test(String(newPin))) return jsonOut({ ok: false, error: 'PIN musi mieć od 4 do 12 cyfr' });
  props.setProperty('APP_PIN', String(newPin));
  props.deleteProperty('PIN_RESET_CODE');
  props.deleteProperty('PIN_RESET_EXPIRES');
  pushPinToSiblings(String(newPin));
  return jsonOut({ ok: true });
}
