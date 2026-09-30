# Gotówka PF — pamięć projektu

Mobilna appka webowa do śledzenia puli gotówki domowej (RA-STER) — ile
zostało, ile wykorzystano %, i w jakim rytmie (dzień/tydzień/miesiąc) bierze
się kasę. Dwie osoby (Paweł, Zuzia), każda z własnym kontem/PIN-em (jak
karta-godzin/wydatki-domowe), ale WSPÓLNA pula i lista wpisów — to jedna
fizyczna gotówka, konta dają tylko osobne logowanie, nie osobne dane. Z
użytkownikiem rozmawiaj po polsku; to inżynier, nie programista — tłumacz
krótko pojęcia przy pierwszym użyciu i rób sam wszystko, co nie wymaga jego
logowania.

## Gdzie co leży

- **Frontend**: `index.html` (jeden plik: HTML + CSS + JS, bez frameworków,
  bez build stepu) → GitHub Pages:
  https://heatcoolfulawkawro-ui.github.io/gotowka-pf/
- **Backend**: `Kod.gs` + `appsscript.json` → Google Apps Script podpięty do
  Arkusza „Gotówka PF — dane". Zakładki: `Data` (pula+wpisy, jeden wspólny
  klucz `gotowkaPfState`, kolumny `key`/`value`), `Users`/`Sessions`/`Links`/
  `Audit` — konta, tokeny sesji (tylko SHA-256), jednorazowe linki mailowe,
  dziennik zmian admina. Wzorzec 1:1 z Wydatków domowych, przycięty do dwóch
  kont — patrz sekcja „Konta" niżej.
- **Web App URL** (stała `GAS_URL` w `index.html`) — NIE MOŻE się zmienić.
- `.clasp.json` / `.claspignore` — konfiguracja clasp (wypychane są tylko
  `Kod.gs` i `appsscript.json`).

## Wdrażanie — wszystko przez `git push` na `main`

- **Frontend**: push → GitHub Pages publikuje samo (~1 min, cache 10 min).
  Appka sama wykrywa nową wersję: porównuje `document.lastModified` TEJ
  strony z `last-modified` z `HEAD` (skrypt na górze `index.html`) i
  przeładowuje się raz na `?v=…` (strażnik w sessionStorage), a przy okazji
  odświeża kopię spod gołego adresu (`fetch(…, {cache:'reload'})`) — to ją
  otwierają rozdzielacze. Do 30.09.2026 porównanie szło z wersją zapamiętaną
  w localStorage (wspólną dla wszystkich adresów) i stara kopia spod
  `/gotowka-pf/` zostawała na telefonie Zuzi; klucz `gotowkapf_page_version`
  trzyma teraz stałą wartość, żeby takie stare kopie same przeskakiwały.
  Widoczny znacznik „wersja strony: DD.MM GG:MM" = wersja TEJ strony
  (klikalny), plus przycisk ↻ w nagłówku po zalogowaniu.
- **Backend**: push zmieniający `Kod.gs` lub `appsscript.json` uruchamia
  `.github/workflows/deploy-gas.yml`: `clasp push -f` + `clasp deploy
  --deploymentId <istniejące>` (sekret `CLASPRC_JSON`). Nigdy nie wdrażaj bez
  `--deploymentId` — powstałby nowy URL. Przepis i pułapki:
  `.claude/skills/gas-clasp-autodeploy/SKILL.md` (skopiowany z karty godzin).
- Po wdrożeniu backendu sprawdź: `gh run watch`, w logu `Deployed … @N` pod
  tym samym ID, oraz `GET <GAS_URL>` → HTTP 200 z pustą treścią (appka nie
  wydaje już niczego przez GET bez sesji — to sukces, nie błąd).
- `appsscript.json` pochodzi z `clasp pull` — nie edytuj z głowy; pola
  `webapp.access`/`executeAs` sterują dostępem do appki.

## Konta (od 28.09.2026, v2 — było: jeden wspólny PIN)

- Dwa konta: **PF** (Paweł, admin) i **ZF** (Zuzia, zwykły użytkownik).
  Login (skrót) + PIN 4–10 cyfr, PIN-u nigdy nie zapisujemy — tylko
  HMAC(PIN; pepper+sól) w zakładce `Users`. Sesja = token 60 dni
  (`localStorage['gotowkaPfAuth_v1']`), zapisany po stronie serwera tylko
  jako SHA-256 (`Sessions`). Konto zakłada admin w Panelu admina (login,
  imię, e-mail) — właściciel konta sam ustawia PIN przez jednorazowy link
  mailem (48 h, jednorazowy); admin NIGDY nie widzi/ustawia surowego PIN-u
  poza swoim.
- Dane (pula + wpisy pod `gotowkaPfState`) są WSPÓLNE dla PF i ZF — konta
  to tylko osobne logowanie, nie osobne dane. Kto zrobił wpis, mówi
  przełącznik „PF/ZF" w formularzu (pole `who`, patrz niżej) — domyślnie
  ten, kto jest zalogowany, ale zawsze można zmienić ręcznie.
- Zapomniany PIN (ZF i inni zwykli użytkownicy): „Nie pamiętam PIN-u" na
  ekranie logowania → jednorazowy link mailem → appka sama ustawia nowy PIN
  i loguje.
- Konto **PF** ma dodatkowo utwardzoną ścieżkę zmiany PIN-u (dwa etapy: kod
  z maila + osobny link do potwierdzenia klikiem — `requestPinResetLegacy_`/
  `confirmPinResetLegacy_`/`confirmPinLink_` w `Kod.gs`), identyczną jak w
  karta-godzin/wydatki-domowe/Paliwo-PF/Waga-PF — bo to ten sam mechanizm
  „rodziny" PIN-u PF, patrz niżej. Zwykły jednoetapowy link (`setPinByLink_`)
  jest dla PF zablokowany, ale TYLKO gdy PIN już istnieje — pierwsze
  ustawienie świeżego konta (bootstrap/zaproszenie) nim może iść, bo nie ma
  jeszcze czego chronić.
- **Rodzina PIN-u PF — z powrotem podpięta od 28.09.2026** (`SIBLING_URLS` w
  `Kod.gs` znów zawiera Paliwo-PF/Waga-PF/karta-godzin/Wydatki). Historia
  tego samego dnia: appka startowo (v1.0) miała JEDEN wspólny PIN dla całej
  appki (bez osobnych kont) i BYŁA podpięta do tej rodziny — efekt: gdy
  Zuzia zresetowała ten wspólny PIN, rozjechało się to na PIN konta PF we
  WSZYSTKICH appkach Pawła (realny incydent), więc appka została chwilowo
  odłączona. Zaraz potem appka dostała prawdziwe, niezależne konta (PF/ZF) —
  PIN konta PF jest tu znowu TYLKO PIN-em Pawła (reset PIN-u przez Zuzię
  dotyczy wyłącznie jej konta ZF i nigdy nie dotknie konta PF), więc
  ponowne podpięcie jest bezpieczne. Paweł świadomie o to poprosił: jeden
  PIN ma działać we wszystkich jego appkach. Żeby zmiana PIN-u w Gotówce
  faktycznie rozeszła się do reszty, musi iść przez utwardzoną ścieżkę
  (Zmień PIN → kod z maila → link do potwierdzenia) — zwykłe pierwsze
  ustawienie przez `setPinByLink_` (bootstrap/zaproszenie) NIE rozsyła
  dalej, celowo.

## Zasady przy zmianach

- Przed widoczną zmianą UI (nowy ekran/panel) pokaż makietę do akceptacji.
- Po każdej zmianie JS sprawdź składnię (wytnij `<script>` do pliku i
  `node --check`, albo `node scripts/check-js.js index.html` ze skilla
  `ra-ster-mini-app`, jeśli jest).
- Testuj na kopii odciętej od Arkusza: `node tools/sandbox.js index.html
  Kod.gs "" <port>` odpala PRAWDZIWY Kod.gs na atrapie Arkusza w pamięci
  (maile z linkami pod `/__mail`, appka pod `/`, `GAS_URL` podmienione na
  `/gas`) — nigdy na prawdziwych danych. Skopiowane z Wydatków domowych,
  generyczne dla każdej appki tej rodziny.
- POST do Apps Script zawsze z `Content-Type: text/plain;charset=utf-8`.
- Format danych: jeden klucz `gotowkaPfState`, JSON `{ poolStart: liczba,
  entries: [{id, date (YYYY-MM-DD), type: 'minus'|'plus', amount, note, who,
  createdAt, poolOverride}] }`. `minus` = pobranie (odejmuje od puli), `plus`
  = dopłata (zamyka bieżący okres, otwiera nowy — patrz „Funkcje" niżej).
  `who` = kto dokonał wpisu (`'PF'` albo `'ZF'`, przycisk w formularzu; brak
  pola u starych wpisów traktuj jako nieznane, nie pokazuj plakietki).
  `poolOverride` = tylko na wpisach `plus`, opcjonalne — ręczna korekta puli
  nowego okresu przez ✎ (patrz „Funkcje"); brak pola = licz normalnie
  (reszta poprzedniego okresu + kwota tej dopłaty). Zmiana formatu = migracja,
  nie rób tego mimochodem.
- `localStorage` to natychmiastowy bufor, `fetch` do Arkusza idzie w tle —
  appka ma działać offline. Status połączenia: zielona kropka = zsynchronizowano,
  czerwona = błąd (serwer odrzucił — np. sesja wygasła), pomarańczowa =
  zapisano lokalnie (offline). Serwer trzyma CAŁY stan jednym kluczem
  (ostatni zapis wygrywa), więc telefon wysyła stan TYLKO gdy ma własne,
  jeszcze niewysłane zmiany (flaga `gotowkaPfDirty` w localStorage): przy
  starcie brudny → wysyła, czysty → pobiera z serwera i nadpisuje lokalną
  kopię; zdarzenie `online` wysyła tylko brudny stan; powrót do karty
  (`visibilitychange`) dociąga świeże dane. Do 30.09.2026 `online` wysyłał
  zawsze, a pobrane dane nie trafiały do localStorage — telefon ze starą
  kopią mógł nadpisać serwer. Znane ograniczenie: dwa telefony z
  niewysłanymi zmianami naraz → wygrywa ten, który wyśle później.
- Przy wpisywaniu w polach nie przebudowuj DOM-u bez potrzeby (telefon gubi
  fokus).
- Paleta i styl: ciemny motyw (te same tokeny co Paliwo/Waga/karta godzin/
  wydatki domowe), fonty Manrope (nagłówki) + Public Sans (treść) +
  JetBrains Mono (liczby). Amber = akcja/CTA, zielony = dopłata/dobrze,
  czerwony = pobranie/błąd.
- NIE nazywaj klas CSS „reklamowo" (`ad-…`, `ads`, `banner`, `sponsor`,
  `promo`…) — blokery reklam w przeglądarce potrafią ukryć taki element bez
  żadnego błędu w konsoli (bolesne doświadczenie z karty godzin, v1.4.2).

## Funkcje (stan: 29.09.2026, v3 — dopłata zamyka okres)

- Pula gotówki działa w OKRESACH (od 29.09.2026, v3): dopłata zamyka bieżący
  okres (zapisuje do „Zamkniętych okresów": ile było / ile wykorzystano /
  ile zostało) i otwiera nowy, którego pula startowa = reszta z poprzedniego
  + kwota dopłaty. Główny ekran (zostało / % wykorzystania / pula startowa /
  wydano) zawsze pokazuje TYLKO bieżący, otwarty okres — nie sumę wszystkiego
  od początku appki. Liczone przez `computePeriods()` w locie z listy
  wpisów (żadne nowe pole w `state` poza opcjonalnym `poolOverride` — patrz
  format danych niżej) — działa też wstecznie dla dopłat sprzed tej zmiany.
  „Rytm pobrań" i wykres CELOWO liczą się z całej historii pobrań, bez
  podziału na okresy (to wzorzec zachowania, nie zależy od puli).
  ✎ przy „Pula startowa": przed pierwszą dopłatą edytuje `poolStart` wprost;
  po dopłacie zapisuje ręczną korektę jako `poolOverride` na tej dopłacie
  (dotyczy tylko bieżącego okresu, nie rusza już zamkniętych).
- Wpis: Pobranie albo Dopłata, kwota, data (domyślnie dziś), notatka
  opcjonalna (np. „szelki") — bez rozbijania na kategorie/cele, celowo
  prosto. Dotknięcie wpisu w historii otwiera edycję (z opcją Usuń, dwa
  dotknięcia dla potwierdzenia).
- „Rytm pobrań": średnia liczba dni między kolejnymi pobraniami (zawsze
  liczona per dzień, niezależnie od trybu wykresu) + wykres słupkowy z
  przełącznikiem Dzień/Tydzień/Miesiąc — Dzień pokazuje ostatnie pojedyncze
  pobrania, Tydzień/Miesiąc sumują pobrania w oknie (8 ostatnich tygodni / 6
  ostatnich miesięcy, z zerami dla pustych okresów — widać przerwy).
  Dopłaty nie wchodzą do tego wykresu/średniej (osobna, dużo rzadsza
  kategoria zdarzeń).
- Konta PF/ZF (patrz sekcja „Konta" wyżej): ekran logowania, pierwsze
  uruchomienie (zakłada konto admina), ustawienie PIN-u przez link z maila,
  „Zmień PIN" (z menu ▾ przy imieniu), Panel admina (tylko dla PF: lista
  kont, dodaj osobę, wyślij link ponownie, zmień e-mail, odblokuj, włącz/
  wyłącz konto).
- 🏠 do rozdzielacza w pasku górnym — po zalogowaniu, kieruje zależnie od
  konta: PF → https://heatcoolfulawkawro-ui.github.io/ (główny, wszystkie
  appki), pozostali (dziś: ZF) → https://heatcoolfulawkawro-ui.github.io/zuzia/
  (tylko Wydatki domowe + Gotówka).

## Otwarte tematy

- Po wdrożeniu v2 (kontowej): zakładka `Users` w Arkuszu jest PUSTA na
  starcie — pierwsze wejście na appkę pokaże „Pierwsze uruchomienie" (zakłada
  konto PF-admina, link do ustawienia PIN-u przyjdzie na maila właściciela
  Arkusza — czyli Pawła). Dopiero potem: Panel admina → „Dodaj osobę" →
  konto ZF dla Zuzi (login ZF, jej imię, jej e-mail) → ona dostaje swój
  link i sama ustawia PIN. To musi zrobić sam Paweł (wymaga jego logowania
  na produkcyjnej appce) — ja przygotowałem tylko mechanizm.
- Stare dane pod kluczem `gotowkaPfState` (pula + wpisy) zostają bez zmian —
  konta nie dotykają tego klucza, tylko dodają logowanie nad nim.
- Nie testowane na prawdziwym iPhonie/telefonie Zuzi (tylko sandbox +
  Playwright: bootstrap → ustawienie PIN-u PF → panel admina → dodanie ZF →
  jej link → jej PIN → jej logowanie → domyślny „kto" na ZF → zapis wpisu →
  przeładowanie strony (sesja i dane wracają) → zwykła zmiana PIN-u ZF →
  utwardzona zmiana PIN-u PF (kod, odrzucenie złego kodu) → panel admina
  (przycisk „‹ Wróć" po wczytaniu — złapany i naprawiony bug, brakowało
  podpięcia po drugim renderze).
- Ewentualne późniejsze pomysły (nie proszone, nie budować bez potwierdzenia):
  wykres/eksport do Excela jak w innych appkach, notatka o „na co" jako
  kategoria zamiast wolnego tekstu.

## Więcej kontekstu

- Żelazna zasada Szefa: pracujemy na poprzedniej wersji i ulepszamy tylko dany
  element — nie przebudowujemy całości i nie ruszamy tego, o co nie prosił.
- Po każdym wdrożeniu napisz wprost, co zostało wypchnięte i gdzie, co
  sprawdzone, a czego nie.
- Mapa wszystkich projektów i zasady porządku: `../CLAUDE.md`.
