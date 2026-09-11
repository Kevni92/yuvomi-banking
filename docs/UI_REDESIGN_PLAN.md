# Banking UI Redesign – technisches Umsetzungskonzept

Stand der Analyse:

- `yuvomi-banking`: `33f74ea91f5b11c7f89a5f534f548bdf19daef93`
- Yuvomi Core: `1f96c4dc80f0a9668fd0d2885ca6242f9fc5b0ca`

Dieses Dokument ist die verbindliche Umsetzungsplanung für den nächsten UI-Umbau. Es ist absichtlich konkreter als ein gewöhnliches UX-Konzept, damit ein nachgelagerter Coding-Agent die Arbeit ohne erneute Architekturentscheidung abarbeiten kann.

## 1. Zielbild

Die Banking-Seite soll von einer technisch orientierten Integrations-/Debugseite zu einer alltagstauglichen Finanzansicht werden.

Die Hauptseite `/m/banking` zeigt in dieser Reihenfolge:

1. **Wochenbudget** – aktuelle Kennzahlen und ggf. GiroCode/Überweisungsvorschlag.
2. **Konten** – kompakte Kontenübersicht und Synchronisationsaktionen.
3. **Umsätze** – eine volle, einklappbare, filterbare und sortierbare Tabelle über alle eigenen Banking-Konten.
4. **Umsatzkategorisierung** – offene Prüfungen und Kategorie-Vorschläge.
5. **Wochenbudget-Historie** – vergangene Perioden und Revisionen.

Nicht mehr auf der Hauptseite:

- Banking-Sidecar-Debugkarte
- eingeloggter Yuvomi-Benutzer als Debugkarte
- Banking-Berechtigung als Debugkarte
- Bank anbinden
- Liste der Bankverbindungen
- Wochenbudget-Konfigurationsformular
- Push-/Benachrichtigungseinstellungen
- Wochenbudget-Kategorie-Defaults
- generischer `banking-empty-state`-Platzhalter

Die Hauptseite ist damit eine **Nutzungsansicht**, keine Konfigurationsseite.

---

## 2. Analyse des aktuellen Codes

### 2.1 Hauptproblem: Seitenaufbau

`modules/banking/index.js::renderOverviewMarkup()` rendert derzeit alles in einen einzigen großen View:

- `.banking-integration-grid` mit drei Debugkarten
- Bankverbindungsformular
- Bankverbindungsliste
- Wochenbudget inkl. Einstellungen, Push, Kategorien, Kategorisierung und Historie
- Konten

Dadurch steht das Wochenbudget nicht als primärer Anwendungsfall oben und administrative Konfiguration dominiert die Seite.

### 2.2 Hauptproblem: Umsätze sind an Kontokarten gekoppelt

`renderAccounts()` erzeugt je Konto eine `.banking-account-card`.

Darin erzeugt `.banking-account-card__details` aktuell zwei Spalten:

```text
Salden | Umsätze
```

Die CSS-Regel

```css
.banking-account-card__details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
```

ist der direkte Grund dafür, dass die Umsatzliste auf Desktop nur die rechte Hälfte des Inhalts nutzt.

`renderTransactions()` rendert außerdem eine `<ul>` mit Kartenzeilen statt einer Datentabelle. Filterung, Sortierung und Pagination existieren nicht.

### 2.3 Positive Beträge

`renderTransactions()` setzt `data-direction="incoming|outgoing"` auf den Betrag. In `style.css` existiert aber nur eine Farbregel für `outgoing`:

```css
.banking-transaction-row__amount[data-direction="outgoing"] {
  color: var(--color-danger, #b42318);
}
```

Für `incoming` fehlt die Erfolgsfarbe. Dadurch erscheinen Einnahmen in der Standard-Textfarbe.

### 2.4 Backend ist noch nicht für eine globale Tabelle ausgelegt

`service/src/api/enable-banking-routes.ts` bietet aktuell:

```text
GET /accounts/:accountId/transactions
```

`listPublicTransactions()` ist an genau ein Konto gebunden, sortiert fest nach Datum und liefert maximal 100 Zeilen.

Das reicht nicht für eine globale, filterbare Tabelle über alle Konten. Die neue Tabelle soll **nicht** alle Account-Endpunkte im Browser einzeln laden und anschließend clientseitig zusammenführen. Filter, Sortierung und Pagination gehören serverseitig in eine lokale DB-Abfrage.

### 2.5 Yuvomi-Seitenbreite

`modules/banking/module.json` verwendet aktuell:

```json
"page": {
  "composition": "data",
  "width": "content"
}
```

Yuvomi erlaubt für `data` die semantische Breite `wide`. Die neue Umsatz-Tabelle braucht mehr Platz, ohne eigenes Seitenlayout oder hartkodierte `max-width`-Werte einzuführen.

Ziel:

```json
"page": {
  "composition": "data",
  "width": "wide"
}
```

Keine eigenen Seitenbreiten in `style.css` einführen.

---

## 3. Wichtige Yuvomi-Einschränkung: Einstellungen von Third-Party-Modulen

Der gewünschte Endzustand ist, Banking-Konfiguration in Yuvomis normaler Einstellungsoberfläche zu haben.

**Das ist mit der aktuellen Third-Party-Modul-API von Yuvomi noch nicht direkt möglich.**

Geprüft wurden im aktuellen Yuvomi-Core insbesondere:

- `MODULES.md`
- `public/settings/registry.js`
- `public/pages/settings.js`
- das Extension-Manifest-/Capabilities-Modell

Aktuell registriert ein Third-Party-Modul über `module.json` nur:

- Permissions
- Dashboard-Widgets
- API-Prefix

Die Settings-Leaves sind in `public/settings/registry.js` statisch im Core registriert. Es gibt derzeit kein `capabilities.settings`, kein Extension-Settings-Entry und keinen zulässigen Weg, aus `yuvomi-banking` eine neue `/settings/modules/banking`-Seite einzuhängen.

### Konsequenz

**Yuvomi Core in diesem Projekt nicht patchen.**

Insbesondere nicht:

- `../yuvomi/public/settings/registry.js` verändern
- eine unbekannte `/settings/modules/banking`-Route erzwingen
- Core-Dateien aus dem Banking-Repo überschreiben

### Übergangslösung

Die Banking-Konfiguration wird aus der Hauptansicht entfernt und als **eigener Banking-Einstellungsview** umgesetzt:

```text
/m/banking?view=settings
```

Die Hauptseite erhält im Page-Header eine Aktion `Einstellungen`.

Der Settings-View verwendet dieselben Yuvomi-Komponenten/Token und sieht damit wie eine Yuvomi-Einstellungskarte aus, bleibt technisch aber innerhalb des Third-Party-Moduls.

Die Settings-UI soll von Anfang an so gekapselt werden, dass sie später ohne Business-Logic-Umbau in einen zukünftigen offiziellen Yuvomi-Settings-Hook verschoben werden kann.

Wenn Yuvomi später eine Extension-Capability für Settings bereitstellt, wird nur das Mounting geändert; API und Formlogik bleiben bestehen.

---

## 4. Zielstruktur der Hauptseite

### 4.1 Header

`Banking` als normaler Page-Titel.

Rechts im Header:

```text
[Einstellungen]
```

Die Aktion navigiert same-origin zu:

```text
/m/banking?view=settings
```

Die drei Debugkarten entfallen vollständig.

`GET /health` bleibt als Server-/Monitoring-Endpunkt bestehen, wird aber nicht mehr für eine sichtbare Debugkarte auf der normalen Seite benötigt.

`GET /me` bleibt erforderlich, weil `render()` daraus `banking_permission` ableitet.

### 4.2 Wochenbudget

Erste sichtbare Karte der Hauptseite.

Auf der Hauptseite bleiben nur:

- `banking-weekly-summary`
- aktueller GiroCode/Überweisungsvorschlag
- Button `Neu laden`

Nicht mehr in dieser Karte:

- `data-weekly-budget-settings`
- Push-Konfiguration
- Wochenbudget-Kategorie-Defaults
- Kategorisierung
- Historie

Diese Bestandteile werden aufgeteilt wie unten beschrieben.

### 4.3 Konten

Zweite Karte.

Je Konto:

- Kontoname
- maskierte IBAN / Typ / Währung
- letzter Sync optional
- `Details anzeigen`
- bei `write`: `Konto synchronisieren`

Beim Öffnen der Details werden nur noch Salden/Kontodetails angezeigt.

Die Umsatzliste wird aus `.banking-account-card__details` entfernt.

`Händlerlogos laden` nicht als gleichwertigen Hauptbutton neben Sync darstellen. Die Funktion bleibt erhalten, wird aber als sekundäre Wartungsaktion in den aufgeklappten Kontodetails oder im Banking-Settings-View platziert.

### 4.4 Umsätze

Dritte Karte und zentrale Datenansicht.

Sie ist mit einem nativen `<details>` einklappbar:

```html
<details class="banking-panel banking-transactions-panel" open>
  <summary>Umsätze …</summary>
  … Filter …
  … Tabelle …
  … Pagination …
</details>
```

Die Tabelle nutzt die komplette verfügbare Seitenbreite innerhalb der `wide` Page-Composition.

### 4.5 Kategorisierung

Eigene Karte nach den Umsätzen.

Hier bleiben:

- `Ungeklärte Umsätze analysieren`
- Review-Liste
- Kategorie-Vorschläge

Die eigentlichen Kategorie-Dropdowns pro Umsatz bleiben zusätzlich direkt in der Tabelle verfügbar.

### 4.6 Wochenbudget-Historie

Eigene einklappbare Karte nach der Kategorisierung.

Die bestehende `renderWeeklyBudgetHistory()`-Logik soll weiterverwendet werden.

---

## 5. Umsatz-Tabelle: verbindliches UI-Konzept

### 5.1 Spalten

Desktop-Tabelle:

| Spalte | Inhalt | sortierbar |
|---|---|---|
| Datum | Buchungs-/Wert-/Transaktionsdatum | ja |
| Empfänger / Händler | Logo, Merchant/Counterparty, darunter Verwendungszweck | ja |
| Konto | `account_display_name` | ja |
| Kategorie | vorhandenes Kategorie-Select | ja |
| Wochenbudget | `inherit/include/exclude`-Select | nein |
| Status | Gebucht / Vorgemerkt / Unbekannt | ja |
| Betrag | formatierter Betrag | ja |

Betrag immer rechtsbündig innerhalb **seiner Tabellenzelle**, nicht als separate rechte Kartenhälfte.

Farben:

```text
outgoing -> var(--color-danger)
incoming -> var(--color-success)
```

Damit sind positive Einnahmen explizit grün.

### 5.2 Filter

Oberhalb der Tabelle ein kompaktes Filterformular mit:

- freie Suche `q`
- Konto
- Kategorie
- Richtung: Alle / Einnahmen / Ausgaben
- Status: Alle / Gebucht / Vorgemerkt / Unbekannt
- Datum von
- Datum bis
- Button `Filter zurücksetzen`

Optional in derselben Implementierung, wenn ohne Zusatzkomplexität möglich:

- `Nur ohne Kategorie`

Nicht in Phase 1 des UI-Redesigns aufnehmen:

- komplexe Betragsbereiche
- gespeicherte Filtersets
- freie SQL-artige Filter

### 5.3 Sortierung

Sortierung erfolgt serverseitig.

Klick auf einen sortierbaren Tabellenkopf:

1. neues Sortierfeld -> Standardrichtung setzen
2. gleiches Sortierfeld -> `asc`/`desc` toggeln
3. `aria-sort` aktualisieren
4. Offset auf `0` setzen
5. Tabelle neu laden

Default:

```text
sort=date
order=desc
```

### 5.4 Pagination

Default:

```text
limit=50
offset=0
```

Maximal 100 Zeilen pro Request.

Footer:

```text
1–50 von 347    [Zurück] [Weiter]
```

Keine unendliche DOM-Liste mit allen historischen Umsätzen erzeugen.

### 5.5 Einklappen

Die Umsatzsektion ist standardmäßig offen.

Der Benutzer kann sie über `<details>` schließen.

Optional darf der Open/Closed-Zustand in `sessionStorage` gespeichert werden, z. B.:

```text
yuvomi:banking:transactions-open
```

Keine serverseitige Preference und keine neue DB-Spalte nur für diesen UI-Zustand.

### 5.6 Responsive Verhalten

Keine neue moduleigene Page-Geometrie und keine hartkodierte Seitenbreite.

Die Tabelle liegt in einem Komponenten-Scrollcontainer:

```css
.banking-transactions-table-wrap {
  overflow-x: auto;
}
```

Auf kleinen Seitenbreiten darf die Tabelle horizontal scrollen. Nicht versuchen, die gesamte Seite mit negativen Margins oder eigener Viewport-Geometrie breiter zu machen.

---

## 6. Neues Backend-API für die globale Umsatzliste

### 6.1 Neuer Endpoint

Implementieren:

```text
GET /api/extensions/banking/transactions
```

Berechtigung:

```text
ext:banking = read oder write
```

Der Endpoint liest ausschließlich aus `banking.db` und ruft Enable Banking **nicht** auf.

### 6.2 Query-Parameter

Unterstützen:

```text
q=<string max 200>
account_id=<positive integer>
category_id=<positive integer>
uncategorized=1
direction=incoming|outgoing
status=BOOK|PDNG|UNKNOWN
date_from=YYYY-MM-DD
date_to=YYYY-MM-DD
sort=date|amount|merchant|account|category|status
order=asc|desc
limit=1..100
offset>=0
```

Regeln:

- `category_id` und `uncategorized=1` nicht gleichzeitig; sonst `400`.
- unbekannte `sort`-/`order`-Werte -> `400`, nicht still in SQL übernehmen.
- `date_from > date_to` -> `400`.
- Filterwerte immer parameterisieren.
- SQL-Spaltennamen nur über eine feste serverseitige Sort-Whitelist auswählen.

### 6.3 Ownership

Die Query muss immer über folgende Kette scopen:

```text
transactions
 -> bank_accounts
 -> enable_banking_connections
 -> yuvomi_user_id = eingeloggter Benutzer
```

Ein `account_id` eines anderen Yuvomi-Benutzers darf niemals Daten liefern.

### 6.4 Search

`q` sucht case-insensitive in:

- `merchant_name`
- `counterparty_name`
- `purpose`

Keine Suche in verschlüsselter IBAN.

### 6.5 Sort-Mapping

Feste Zuordnung, sinngemäß:

```text
date     -> COALESCE(booking_date, value_date, transaction_date)
amount   -> amount_cents
merchant -> COALESCE(merchant_name, counterparty_name, purpose, '') COLLATE NOCASE
account  -> COALESCE(bank_accounts.display_name, '') COLLATE NOCASE
category -> COALESCE(categories.name, '') COLLATE NOCASE
status   -> transactions.status
```

Immer einen stabilen Tie-Breaker ergänzen:

```text
transactions.id
```

### 6.6 Response

Zielvertrag:

```json
{
  "data": {
    "transactions": [],
    "pagination": {
      "total": 347,
      "limit": 50,
      "offset": 0
    }
  }
}
```

Jede Transaction enthält mindestens:

```text
id
account_id
account_display_name
booking_date
value_date
transaction_date
amount
currency
direction
counterparty_name
purpose
merchant_name
merchant_key
merchant_logo_available
status
category_id
category_name
category_source
category_confidence
weekly_budget_override
category_weekly_budget_default
```

Nicht an den Browser senden:

- Provider Account UID
- Klartext-IBAN
- `iban_encrypted`
- Raw Provider Payload
- Provider Session IDs

### 6.7 Bestehenden Code wiederverwenden

`listPublicTransactions()` lebt aktuell in `enable-banking-routes.ts`.

Diese Projektion nicht ein zweites Mal unabhängig implementieren.

Empfohlene Refaktorierung:

```text
service/src/services/transactions-query.ts
```

Dort kapseln:

- öffentliche SELECT-Projektion
- Filterbau
- Sort-Whitelist
- Pagination
- `amount_cents -> amount`-Formatierung

Danach verwenden:

- neuer globaler `/transactions`-Endpoint
- bestehender `/accounts/:accountId/transactions`-Endpoint
- Sync-Response nach `POST /accounts/:accountId/sync`

Der alte Account-Endpoint bleibt aus Kompatibilitätsgründen bestehen.

### 6.8 Router

Neue Datei bevorzugt:

```text
service/src/api/transaction-routes.ts
```

In `service/src/app.ts` unter demselben `API_PREFIX` mounten.

Der Router verwendet die vorhandenen Security-Helfer aus:

```text
service/src/api/route-security.ts
```

insbesondere `resolveAuthorizedUser(..., 'read')` und `noStore()`.

Für den reinen GET-Endpoint ist kein CSRF-Token notwendig.

---

## 7. Frontend-Änderungen – genaue Codeorte

### 7.1 `modules/banking/module.json`

Ändern:

```text
page.width: content -> wide
```

`composition: data` beibehalten.

### 7.2 `modules/banking/index.js` – Render-Einstieg

`render()` nicht mehr blind `renderOverviewMarkup()` aufrufen lassen.

View aus der URL bestimmen:

```text
new URLSearchParams(window.location.search).get('view')
```

Zulässige Views:

```text
main (Default)
settings
```

Unbekannte Werte -> Main.

Danach getrennt:

```text
renderMainMarkup()
renderSettingsMarkup()
```

`GET /me` weiterhin vor Datenzugriff verwenden.

Die Debug-Darstellung von Health/User/Permission vollständig entfernen.

### 7.3 `renderOverviewMarkup()` ersetzen

Nicht weiter als monolithische Funktion ausbauen.

Aufteilen in mindestens:

```text
renderMainMarkup()
renderSettingsMarkup()
renderTransactionsPanelMarkup()
```

Optional weitere kleine Markup-Helfer.

### 7.4 `loadOverview()` aufteilen

Aktuell lädt `loadOverview()` gleichzeitig Connections, Accounts, Weekly Budget, Kategorien, Perioden und Kategorisierung.

Aufteilen in:

```text
loadMainView(container, signal, canWrite)
loadSettingsView(container, signal, canWrite)
```

`loadMainView` lädt:

- Accounts
- weekly-budget/current
- categories
- weekly-budget/periods
- categorization/reviews
- category-suggestions
- erste Seite `/transactions`

`loadSettingsView` lädt:

- connections
- accounts
- weekly-budget/current bzw. die nötigen Settingsdaten
- categories
- Push-/Recipient-Daten

Dadurch werden auf der Hauptseite keine ASPSP-/Push-/Settingsdaten geladen, die dort nicht sichtbar sind.

### 7.5 `renderAccounts()`

Beibehalten, aber Detailbereich vereinfachen.

Entfernen:

```text
<h4>Umsätze</h4>
[data-account-transactions]
```

Der Detailbereich zeigt nur noch Salden und sekundäre Kontoaktionen.

### 7.6 `loadAccountDetails()`

Nicht mehr laden:

```text
GET /accounts/:id/transactions
GET /categories
```

Nur noch Salden/Kontodetails laden.

### 7.7 `syncAccount()`

Provider-Sync-Verhalten beibehalten.

Nach erfolgreichem Sync:

1. Feedback der Kontokarte aktualisieren.
2. Saldo aktualisieren.
3. globale Umsatz-Tabelle neu laden, falls sie im Main-View existiert.
4. Weekly Budget aktualisieren, weil ein Sync dessen Berechnung verändern kann.

Nicht wieder eine lokale Umsatzliste in die Account-Karte rendern.

### 7.8 `renderTransactions()` ersetzen

Die jetzige Kartenlisten-Funktion nicht für die neue Tabelle weiterverwenden.

Neue Funktionen mit klarer Verantwortung:

```text
renderTransactionTable(host, payload, state, canWrite, categories)
renderTransactionFilters(host, accounts, categories, state)
loadTransactionTable(...)
updateTransactionSort(...)
resetTransactionFilters(...)
```

Die bestehenden Mutation-Funktionen für Kategorie und Wochenbudget-Override weiterverwenden, aber ihr DOM-Umfeld an die Tabellenzeile statt an `[data-banking-account-card]` anpassen.

### 7.9 Event Delegation

Transaction-Events nicht mehr auf `[data-banking-accounts]` binden.

Neuer Host:

```text
[data-banking-transactions]
```

Dort delegieren:

- `change` für Kategorie
- `change` für Wochenbudget-Override
- `click` für Sort-Header
- `submit/change/input` für Filter
- Pagination

Suche `q` mit ca. 250 ms Debounce, damit nicht jeder Tastendruck einen Request erzeugt.

Race-Condition vermeiden: bei einem neuen Tabellenrequest entweder vorherigen Child-`AbortController` abbrechen oder eine monotone Request-ID verwenden und veraltete Antworten ignorieren.

### 7.10 Category-/Weekly-Budget-Mutation

`updateTransactionCategory()` und `updateTransactionWeeklyBudget()` dürfen nicht mehr voraussetzen, dass die Transaction in einer Account-Card lebt.

Nach erfolgreicher Mutation:

- aktuelle Tabellen-Seite neu laden
- Categorization Reviews aktualisieren
- Weekly Budget aktualisieren, wenn Kategorie/Override die Berechnung beeinflusst

---

## 8. Banking Settings View

### 8.1 Navigation

Main Header:

```text
Banking                                  [Einstellungen]
```

Settings Header:

```text
Banking-Einstellungen                    [Zurück zu Banking]
```

Keine neue Yuvomi-Core-Route.

### 8.2 Inhalte

Settings-View in dieser Reihenfolge:

1. **Bankverbindungen** – einklappbar
2. **Wochenbudget konfigurieren**
3. **Benachrichtigungen**
4. **Wochenbudget-Kategorien**
5. optional **Wartung** (z. B. Händlerlogos)

### 8.3 Bankverbindungen einklappbar

Bank anbinden + vorhandene Verbindungen zusammen in ein `<details>`.

Default:

- geschlossen, wenn mindestens eine autorisierte Verbindung existiert
- offen, wenn noch keine Verbindung existiert
- offen, wenn `?banking=error` oder `?banking=connected` vorhanden ist, damit das Ergebnis des OAuth-Flows sichtbar ist

### 8.4 OAuth-Callback

`service/src/api/enable-banking-routes.ts::redirectToModule()` aktuell auf `/m/banking`.

Ändern auf:

```text
/m/banking?view=settings&banking=connected
/m/banking?view=settings&banking=error
```

So landet der Nutzer nach einer Bankautorisierung wieder dort, wo die Bankverwaltung jetzt lebt.

### 8.5 Spätere echte Yuvomi-Settings-Integration

Die Settings-Renderlogik möglichst in einer eigenen Datei kapseln, z. B.:

```text
modules/banking/settings.js
```

mit einer exportierten Render-/Wire-Funktion.

Das ist keine Pflicht für den ersten Commit, aber die bevorzugte Struktur, weil `index.js` bereits sehr groß ist.

Wenn Yuvomi später Third-Party-Settings unterstützt, kann diese Komponente in den offiziellen Settings-Mount verschoben werden.

---

## 9. CSS-Änderungen

Datei:

```text
modules/banking/style.css
```

### Entfernen/aufräumen

Nach Entfernen der Debugkarten können folgende Klassen entfallen, sofern sonst unbenutzt:

```text
.banking-integration-grid
.banking-integration-card
.banking-integration-card__label
.banking-integration-card__value
```

### Kontodetails

`.banking-account-card__details` nicht mehr als Salden/Umsatz-2-Spaltenlayout verwenden.

Nach Entfernen der eingebetteten Umsätze genügt ein einspaltiger interner Bereich.

### Transaktionstabelle

Neue Komponentenklassen, z. B.:

```text
.banking-transactions-panel
.banking-transactions-panel__summary
.banking-transaction-filters
.banking-transactions-table-wrap
.banking-transactions-table
.banking-transactions-table__merchant
.banking-transactions-table__amount
.banking-transactions-pagination
```

Tabelle:

```css
.banking-transactions-table {
  width: 100%;
  border-collapse: collapse;
}
```

Scrollwrapper:

```css
.banking-transactions-table-wrap {
  width: 100%;
  overflow-x: auto;
}
```

Keine eigene Page-`max-width`.

### Betragfarben

Verbindlich:

```css
.banking-transactions-table__amount[data-direction="outgoing"] {
  color: var(--color-danger, #b42318);
}

.banking-transactions-table__amount[data-direction="incoming"] {
  color: var(--color-success, #15803d);
}
```

### Filterlayout

Komponenteninternes Grid mit `auto-fit/minmax`, damit keine zusätzliche viewportbasierte Page-Geometrie nötig ist.

Neue globale `@media`-Regeln nur vermeiden; Yuvomis Page-Composition soll die äußere Breite kontrollieren.

---

## 10. Übersetzungen

Mindestens aktualisieren:

```text
modules/banking/locales/de.json
modules/banking/locales/en.json
```

Neue Keys unter anderem für:

- Banking-Einstellungen
- Zurück zu Banking
- Umsätze
- Tabelle einklappen/aufklappen, falls zusätzliche Textbuttons verwendet werden
- Suche
- Alle Konten
- Alle Kategorien
- Ohne Kategorie
- Einnahmen
- Ausgaben
- Gebucht
- Vorgemerkt
- Datum von/bis
- Filter zurücksetzen
- Tabellenköpfe
- Vorherige/Nächste Seite
- `{from}–{to} von {total}`
- keine Treffer

Keine UI-Texte neu hartkodieren, wenn bereits das vorhandene `localized()`-Muster verwendet wird.

---

## 11. Tests

### 11.1 Backend

Neue Testdatei bevorzugt:

```text
service/test/transaction-routes.test.ts
```

Mindestens testen:

1. `read` darf globale Transactions abrufen.
2. `none` wird abgewiesen.
3. Daten anderer Yuvomi-Benutzer werden niemals geliefert.
4. `account_id` filtert korrekt und respektiert Ownership.
5. `q` findet Merchant/Counterparty/Purpose.
6. Kategorie-Filter.
7. `uncategorized=1`.
8. Direction-Filter.
9. Status-Filter.
10. Date Range.
11. Sortierung Datum asc/desc.
12. Sortierung Betrag asc/desc.
13. Pagination und `total`.
14. ungültiges Sortierfeld -> `400`.
15. SQL-Injection-artige Sortwerte werden nicht übernommen.
16. Response enthält keine Klartext-IBAN, Provider-UID oder Raw Payloads.

Bestehende Tests für `/accounts/:id/transactions` dürfen nicht regressieren.

### 11.2 Frontend

Es existiert aktuell keine vollständige Browser-Test-Suite im Banking-Repo. Daher zusätzlich manuelle Acceptance-Prüfung durchführen.

Optional CI um einen reinen Syntaxcheck der Browsermodule ergänzen, sofern dies ohne Yuvomi-Core-Abhängigkeit stabil möglich ist.

---

## 12. Manuelle Acceptance Criteria

Der Umbau ist erst fertig, wenn alle folgenden Punkte erfüllt sind.

### Hauptseite

- Wochenbudget ist die erste Karte unter dem Header.
- Debugkarten sind entfernt.
- Bankverbindungsformular ist nicht auf der Hauptseite.
- Wochenbudget-Konfigurationsformular ist nicht auf der Hauptseite.
- Konten stehen über der Umsatzliste.
- Kategorisierung und Historie sind eigenständige Bereiche.

### Umsätze

- Umsätze stehen nicht mehr in der rechten Hälfte einer Kontokarte.
- Es gibt genau eine globale Umsatzsektion über alle eigenen Konten.
- Tabelle nutzt die volle `wide`-Seitenbreite.
- Positive/incoming Beträge sind grün.
- Negative/outgoing Beträge sind rot.
- Filter funktionieren gemeinsam.
- Sortierung funktioniert.
- Pagination funktioniert.
- Filter/Sortierung führen nicht zu Daten eines anderen Nutzers.
- Tabelle ist einklappbar.
- Kategorie und Wochenbudget-Override können weiterhin direkt geändert werden.

### Settings

- `Einstellungen` im Banking-Header öffnet `/m/banking?view=settings`.
- Bankverwaltung ist dort einklappbar.
- Wochenbudget-Konfiguration ist dort vorhanden.
- Push-Konfiguration ist dort vorhanden.
- Kategorie-Defaults sind dort vorhanden.
- OAuth-Callback landet im Settings-View.
- Keine Änderung am Yuvomi-Core erforderlich.

### Read-only

Bei `ext:banking=read`:

- Hauptseite und Umsatzfilter funktionieren.
- Settings können gelesen werden, soweit sinnvoll.
- Sync-/Mutation-/Speicheraktionen bleiben deaktiviert oder unsichtbar.

---

## 13. Empfohlene Implementierungsreihenfolge

Die Reihenfolge ist absichtlich so gewählt, dass jeder Schritt separat testbar bleibt.

### Schritt 1 – globale Transaction Query im Sidecar

- `transactions-query.ts`
- `transaction-routes.ts`
- `app.ts` mounten
- Tests grün

Noch keine UI ändern.

### Schritt 2 – globale Tabelle auf bestehender Seite ergänzen

- `module.json` auf `width: wide`
- neue Transaction-Sektion
- Filter, Sortierung, Pagination
- positive Beträge grün
- Mutationen aus Tabelle funktional

Bestehende eingebettete Account-Transaktionen vorübergehend noch nicht entfernen, bis die neue Tabelle funktioniert.

### Schritt 3 – Account-Transaktionen entfernen

- Umsatzspalte aus `renderAccounts()` entfernen
- `loadAccountDetails()` vereinfachen
- `syncAccount()` auf globale Tabelle umstellen
- alte Transaction-List-CSS entfernen, soweit nicht von Categorization verwendet

### Schritt 4 – Hauptseite neu ordnen

- Debugkarten entfernen
- Wochenbudget ganz nach oben
- Accounts danach
- Transactions danach
- Categorization danach
- History danach

### Schritt 5 – Settings-View extrahieren

- `?view=settings`
- Bankverbindungen
- Weekly-Budget-Form
- Push
- Kategorie-Defaults
- Header-Navigation
- OAuth-Redirect anpassen

### Schritt 6 – Cleanup

- tote CSS-Regeln entfernen
- tote Locale-Keys nur entfernen, wenn sicher unbenutzt
- keine Debug-Requests/DOM-Reste
- `npm test`
- `npm run build`
- manueller Test in Yuvomi Desktop + schmaler Ansicht

---

## 14. Nicht-Ziele dieses Umbaus

Nicht gleichzeitig neu bauen:

- Enable-Banking-Importlogik
- Wochenbudget-Berechnungsalgorithmus
- OpenAI-Kategorisierungslogik
- GiroCode-Generierung
- Push-Delivery-Backend
- DB-Schema der Transactions ohne konkreten Query-Performance-Grund
- Yuvomi-Core
- offizielles Yuvomi-Settings-Extension-System

Der Umbau ist primär **Informationsarchitektur + Transaction-Query + UI-Darstellung**.

---

## 15. Regeln für den implementierenden Agenten

1. Vor Änderungen dieses Dokument vollständig lesen.
2. `../yuvomi/MODULES.md`, `DESIGN.md` und `docs/PAGE-COMPOSITION.md` gegen den lokal installierten Stand prüfen.
3. Yuvomi-Core nicht verändern.
4. Keine eigene Seitenbreite oder Shell-Geometrie in Banking-CSS einführen.
5. Datenfilterung/Sortierung nicht durch Laden aller historischen Transactions in den Browser lösen.
6. SQL-Sortfelder niemals direkt aus Query-Strings interpolieren; nur Whitelist-Mapping.
7. Bestehende Berechtigungs- und CSRF-Regeln beibehalten.
8. Keine Provider-IDs/IBANs zusätzlich an den Browser exponieren.
9. Bestehende Mutation-Funktionen für Kategorie und Wochenbudget nicht duplizieren, sondern an den neuen Tabellenkontext anpassen.
10. Nach jedem Implementierungsschritt Tests ausführen und Regressionen beheben.

Wenn während der Umsetzung eine Annahme dieses Dokuments vom aktuellen lokalen Yuvomi-Stand abweicht, darf die technische Detailumsetzung angepasst werden. Die UX-Ziele und die Architekturregel `kein Yuvomi-Core-Patch` bleiben jedoch verbindlich.
