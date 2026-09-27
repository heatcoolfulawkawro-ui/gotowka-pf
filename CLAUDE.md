# Gotówka PF — pamięć projektu

Mobilna appka webowa do śledzenia puli gotówki Pawła (RA-STER) — ile zostało,
ile wykorzystano %, i w jakim rytmie (dzień/tydzień/miesiąc) bierze kasę.
Jedna osoba, jeden PIN (jak Paliwo-PF/Waga-PF — bez wielu kont). Z użytkownikiem
rozmawiaj po polsku; to inżynier, nie programista — tłumacz krótko pojęcia przy
pierwszym użyciu i rób sam wszystko, co nie wymaga jego logowania.

## Gdzie co leży

- **Frontend**: `index.html` (jeden plik: HTML + CSS + JS, bez frameworków,
  bez build stepu) → GitHub Pages:
  https://heatcoolfulawkawro-ui.github.io/gotowka-pf/
- **Backend**: `Kod.gs` + `appsscript.json` → Google Apps Script podpięty do
  Arkusza „Gotówka PF — dane" (zakładka `Data`, kolumny `key`, `value`).
  Magazyn klucz-wartość przez `doGet`/`doPost`, PIN sprawdzany po stronie
  serwera (parametr `pin` / pole `pin` w body).
- **Web App URL** (stała `GAS_URL` w `index.html`) — NIE MOŻE się zmienić.
- `.clasp.json` / `.claspignore` — konfiguracja clasp (wypychane są tylko
  `Kod.gs` i `appsscript.json`).

## Wdrażanie — wszystko przez `git push` na `main`

- **Frontend**: push → GitHub Pages publikuje samo (~1 min). Appka sama
  wykrywa nową wersję przez `HEAD` + `last-modified` (skrypt na górze
  `index.html`) i przeładowuje się — bez ręcznego `.vertag`/`.buildtag`
  (inaczej niż karta godzin); widoczny znacznik to „wersja strony: DD.MM
  GG:MM" pod nagłówkiem, klikalny (wymusza pobranie najnowszej).
- **Backend**: push zmieniający `Kod.gs` lub `appsscript.json` uruchamia
  `.github/workflows/deploy-gas.yml`: `clasp push -f` + `clasp deploy
  --deploymentId <istniejące>` (sekret `CLASPRC_JSON`). Nigdy nie wdrażaj bez
  `--deploymentId` — powstałby nowy URL. Przepis i pułapki:
  `.claude/skills/gas-clasp-autodeploy/SKILL.md` (skopiowany z karty godzin).
- Po wdrożeniu backendu sprawdź: `gh run watch`, w logu `Deployed … @N` pod
  tym samym ID, oraz `GET <GAS_URL>?key=__ping__&pin=<PIN>` → HTTP 200.
- `appsscript.json` pochodzi z `clasp pull` — nie edytuj z głowy; pola
  `webapp.access`/`executeAs` sterują dostępem do appki.

## PIN i wspólny kod rodziny PF

- Jeden PIN dla całej appki (`APP_PIN` w Script Properties), bez wielu kont —
  jak Paliwo-PF/Waga-PF, NIE jak karta-godzin/wydatki-domowe.
- Ta appka jest częścią „rodziny" jednego kodu PF razem z Paliwo-PF, Waga-PF,
  karta-godzin (konto PF) i wydatki-domowe (konto PF): zmiana PIN-u w
  KTÓREJKOLWIEK z nich rozsyła go do reszty (`SIBLING_URLS` + `SYNC_SECRET`
  w Script Properties, mechanizm `sync_pin_push`/`pushPinToSiblings` w
  `Kod.gs`). Sekret NIGDY nie trafia do repo/czatu. Dołączenie nowej appki do
  rodziny = dopisać jej URL do `SIBLING_URLS` we wszystkich pozostałych +
  `bootstrap_sync_secret`/`reset_sync_secret` tym samym sekretem.
- Zapomniany PIN: „Zapomniałeś PIN-u? Zresetuj przez e-mail" dostępne wprost
  z ekranu blokady (nie tylko po zalogowaniu) — kod na
  heatcoolfulawkawro@gmail.com, ważny 10 minut.
- PIN długości 4–12 cyfr (`/^\d{4,12}$/`, jak Paliwo/Waga).

## Zasady przy zmianach

- Przed widoczną zmianą UI (nowy ekran/panel) pokaż makietę do akceptacji.
- Po każdej zmianie JS sprawdź składnię (`node scripts/check-js.js
  index.html` ze skilla `ra-ster-mini-app`).
- Testuj na kopii odciętej od Arkusza (`node scripts/serve-sandbox.js
  index.html`), nigdy na prawdziwych danych.
- POST do Apps Script zawsze z `Content-Type: text/plain;charset=utf-8`.
- Format danych: jeden klucz `gotowkaPfState`, JSON `{ poolStart: liczba,
  entries: [{id, date (YYYY-MM-DD), type: 'minus'|'plus', amount, note,
  createdAt}] }`. `minus` = pobranie (odejmuje od puli), `plus` = dopłata
  (dolicza do puli). Zmiana formatu = migracja, nie rób tego mimochodem.
- `localStorage` to natychmiastowy bufor, `fetch` do Arkusza idzie w tle —
  appka ma działać offline. Status połączenia: zielona kropka = zsynchronizowano,
  czerwona = błąd (serwer odrzucił/zły PIN), pomarańczowa = zapisano lokalnie
  (offline). Po powrocie ONLINE appka sama wysyła zaległy stan
  (`window.addEventListener('online', syncRemote)`).
- Przy wpisywaniu w polach nie przebudowuj DOM-u bez potrzeby (telefon gubi
  fokus).
- Paleta i styl: ciemny motyw (te same tokeny co Paliwo/Waga/karta godzin/
  wydatki domowe), fonty Manrope (nagłówki) + Public Sans (treść) +
  JetBrains Mono (liczby). Amber = akcja/CTA, zielony = dopłata/dobrze,
  czerwony = pobranie/błąd.
- NIE nazywaj klas CSS „reklamowo" (`ad-…`, `ads`, `banner`, `sponsor`,
  `promo`…) — blokery reklam w przeglądarce potrafią ukryć taki element bez
  żadnego błędu w konsoli (bolesne doświadczenie z karty godzin, v1.4.2).

## Funkcje (stan: 27.09.2026, v1.0 — pierwsze wdrożenie)

- Pula gotówki: „pula startowa" (edytowalna ✎, punkt wyjścia) + suma dopłat −
  suma pobrań = ile zostało. Pasek % wykorzystania względem pełnej puli
  (startowa + dopłaty do teraz).
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
- Ekran logowania PIN + „Zmień PIN" (z menu i z ekranu blokady) + reset przez
  e-mail — pełny wzorzec z Paliwo-PF/Waga-PF.
- 🏠 do rozdzielacza (https://heatcoolfulawkawro-ui.github.io/) w pasku
  górnym.

## Otwarte tematy

- Backend jeszcze NIE wdrożony na prawdziwym Arkuszu — `GAS_URL` w
  `index.html` to placeholder `__DEPLOYMENT_ID__`, `configured()` zwraca
  false dopóki się nie wpisze prawdziwego URL. Po wdrożeniu: dopisać URL tej
  appki do `SIBLING_URLS` w Paliwo-PF/Waga-PF/karta-godzin/wydatki-domowe i
  odwrotnie, zbootstrapować wspólny `SYNC_SECRET`.
- GitHub Pages jeszcze do włączenia (Settings → Pages → Source: `main`, `/`).
- Nie testowane na prawdziwym iPhonie Pawła (tylko sandbox + zrzuty ekranu).
- Ewentualne późniejsze pomysły (nie proszone, nie budować bez potwierdzenia):
  wykres/eksport do Excela jak w innych appkach, notatka o „na co" jako
  kategoria zamiast wolnego tekstu.

## Więcej kontekstu

- Żelazna zasada Szefa: pracujemy na poprzedniej wersji i ulepszamy tylko dany
  element — nie przebudowujemy całości i nie ruszamy tego, o co nie prosił.
- Po każdym wdrożeniu napisz wprost, co zostało wypchnięte i gdzie, co
  sprawdzone, a czego nie.
- Mapa wszystkich projektów i zasady porządku: `../CLAUDE.md`.
