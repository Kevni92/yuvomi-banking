# Umsatz-UI-Polish und vollständiger Detaildialog – technisches Umsetzungskonzept

Stand der Analyse: `34760b8fbbf391793c6c7a82ac43f6287dd3f250` (`main`).

Dieses Dokument ist die verbindliche technische Spezifikation für die nächste UI-Polish-Iteration der Umsatzansicht. Ziel ist, die aktuell funktionale, aber visuell unruhige Umsatzliste in eine klar lesbare Banking-Tabelle umzubauen und jeden Umsatz über einen Detaildialog vollständig inspizierbar zu machen.

Die Umsetzung bleibt vollständig innerhalb von `yuvomi-banking`. Yuvomi Core wird nicht verändert.

---

## 1. Aktueller Stand und konkrete Probleme

Die technische Grundlage ist bereits gut:

- `GET /api/extensions/banking/transactions` bietet serverseitige Filter, Sortierung und Offset/Limit-Pagination.
- `createTransactionState()` hält Suche, Konto, Kategorie, Richtung, Status, Datum, Sortierung und Pagination.
- `renderTransactionTable()` rendert bereits eine echte Tabelle.
- positive/negative Beträge werden bereits über `data-direction` unterschiedlich eingefärbt.
- Kategorie und Wochenbudget können direkt am Umsatz geändert werden.
- Händlerlogos bzw. Initialen sind bereits vorhanden.
- `banking.db` besitzt bereits `transactions.raw_payload_encrypted`.
- der AES-256-GCM-Verschlüsselungsdienst ist vorhanden.

Die aktuelle UX hat aber folgende Probleme:

1. Die Filter werden als großes Grid aus beschrifteten Formularfeldern dargestellt. Dadurch entsteht viel vertikaler Leerraum und die Filter dominieren die eigentliche Tabelle.
2. `Filter anwenden` und `Filter zurücksetzen` stehen als große Buttons untereinander, obwohl die meisten Filter ohnehin bereits automatisch neu laden.
3. Die Tabelle ist funktional, aber die visuelle Hierarchie der Zeile ist zu schwach. Datum, Händler, Konto, Kategorie, Wochenbudget, Status und Betrag konkurrieren gleich stark miteinander.
4. Kategorie- und Wochenbudget-Selects wirken wie normale große Formulareingaben und nicht wie kompakte Tabellenaktionen.
5. Der Status ist nur Text statt eines schnell erfassbaren Status-Pills.
6. Das Konto nimmt zu viel Aufmerksamkeit ein, obwohl Händler, Betrag und Kategorie wichtiger sind.
7. Die Pagination besteht nur aus `Zurück` / `Weiter` und skaliert bei vielen Umsätzen schlecht.
8. Es gibt aktuell keinen vollständigen Umsatz-Detaildialog.
9. Das Schema hat zwar `raw_payload_encrypted`, der aktuelle Importer befüllt die Spalte jedoch nicht. Damit können derzeit nicht alle Providerdaten eines Umsatzes angezeigt werden.

---

## 2. Verbindliches UX-Zielbild

Die Umsatzsektion soll sich optisch an folgendem Aufbau orientieren:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Umsätze  [124]                                                   [Spalten] [Filter  3] │
│                                                                                         │
│ ┌ Suche … ─────────┐ ┌ Alle Konten ─┐ ┌ Alle Kategorien ─┐ ┌ 01.09 – 30.09 ┐ ┌ Alle ┐ │
│ │ Händler, Empfänger│ │               │ │                  │ │                │ │ Richt.│ │
│ └───────────────────┘ └───────────────┘ └──────────────────┘ └────────────────┘ └──────┘ │
│                                                                                         │
│ [ Ohne Kategorie ○ ]   [ Weitere Filter ▾ ]                       Filter zurücksetzen   │
│                                                                                         │
│ Datum      Empfänger / Händler        Konto      Kategorie    Wochenbudget Status Betrag│
│ ─────────────────────────────────────────────────────────────────────────────────────── │
│ 11.09.26  ● Amazon.de                 K. Krone   Einkäufe ▾   Kategorie ▾   ● Geb. -17€ │
│            Bestellung 304-...          ••••1234                                      ⋮ │
│ ─────────────────────────────────────────────────────────────────────────────────────── │
│ 11.09.26  ● PayPal Europe S.à r.l.    K. Krone   Software ▾   Digital ▾     ● Geb.  -3€ │
│            Zahlung an Google Ireland   ••••1234                                      ⋮ │
│ ─────────────────────────────────────────────────────────────────────────────────────── │
│ 10.09.26  ● Gehalt AG                  Gehalt     Gehalt ▾     –             ● Geb. +2450│
│            Gehalt September            ••••5678                                        │
│                                                                                         │
│ 1–25 von 124 Umsätzen                ‹  1  2  3  4  5 … 16  ›              [25 / Seite] │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Wichtig: Die Skizze beschreibt die Informationsarchitektur. Es darf **keine zweite App-Sidebar oder ein eigener Yuvomi-App-Header** gebaut werden. Das Modul bleibt innerhalb der vorhandenen Yuvomi-Seite.

---

## 3. Dateien, die geändert werden

### Frontend

```text
modules/banking/index.js
modules/banking/style.css
modules/banking/locales/de.json
modules/banking/locales/en.json
```

### Sidecar

```text
service/src/api/transaction-routes.ts
service/src/services/transactions-query.ts
service/src/enable-banking/importer.ts
service/src/app.ts                       # nur falls EncryptionService injiziert wird
```

### Tests

Bevorzugt neue, fokussierte Tests statt weitere große Sammeltests:

```text
service/test/transaction-detail.test.ts
service/test/transaction-ui-contract.test.ts
```

Zusätzlich bestehende Importer-/Phase-3-Tests nur dort erweitern, wo der vorhandene Setup-Code sinnvoll wiederverwendet werden kann.

### Keine Migration nötig

`transactions.raw_payload_encrypted` existiert bereits seit `001_init.sql`. Es wird nur erstmals tatsächlich befüllt.

---

# Teil A – Umsatzliste neu gestalten

## 4. `renderTransactionsPanelMarkup()` umbauen

Datei:

```text
modules/banking/index.js
```

Die bestehende einklappbare `<details>`-Sektion bleibt erhalten. Der Zustand über

```text
yuvomi:banking:transactions-open
```

bleibt ebenfalls erhalten.

Innerhalb der Sektion wird der Body aber neu strukturiert:

```text
summary
body
  ├─ transaction-toolbar
  │    ├─ count badge
  │    ├─ columns control
  │    └─ filter toggle + active count
  ├─ filter panel
  │    ├─ primary filters
  │    └─ secondary filters
  ├─ table wrap
  │    └─ table
  ├─ feedback
  ├─ pagination
  └─ transaction detail dialog
```

Neue Data-Attribute, die verbindlich verwendet werden sollen:

```text
data-transactions-count
data-action="toggle-transaction-filters"
data-transaction-filter-count
data-transaction-filter-panel
data-transaction-columns-menu
data-banking-transaction-dialog
\data-banking-transaction-dialog-content
```

`data-banking-transactions-table`, `data-transaction-filters` und `data-banking-transactions-pagination` bleiben bestehen, damit möglichst wenig bestehende Logik gebrochen wird.

---

## 5. Filterleiste komplett neu rendern

Aktuelle Funktion:

```text
renderTransactionFilters(host, accounts, categories, state)
```

Die fachliche State-Struktur wird **nicht** neu erfunden. Folgende vorhandenen Felder bleiben:

```text
q
accountId
categoryId
uncategorized
direction
status
dateFrom
dateTo
```

### 5.1 Primäre Filter

Immer sichtbar, solange das Filterpanel geöffnet ist:

1. Suche
2. Konto
3. Kategorie
4. Datumsbereich
5. Richtung

Diese Controls bekommen **keine sichtbare Überschrift oberhalb**. Stattdessen:

- semantisches `<label>` mit einer `visually-hidden` / Modul-eigenen Screenreader-Klasse,
- verständlicher Placeholder bzw. erste Option,
- kompakte Höhe,
- optional kleines Symbol links nur dann, wenn dafür bereits Yuvomi-kompatible Icons verfügbar sind; keine neue Icon-Library einführen.

### 5.2 Datumsbereich

`dateFrom` und `dateTo` bleiben technisch zwei native `type="date"`-Inputs, werden aber in **einem gemeinsamen visuellen Container** gerendert:

```text
[ 01.09.2026 ] – [ 30.09.2026 ]
```

Keine eigene Datepicker-Abhängigkeit einführen.

### 5.3 Sekundäre Filter

Zweite, deutlich kleinere Zeile:

```text
[ Ohne Kategorie  ○ ]   [ Weitere Filter ▾ ]                Filter zurücksetzen
```

`Weitere Filter` blendet derzeit mindestens `Status` ein. Die Struktur soll so gebaut werden, dass später weitere selten benötigte Filter dort ergänzt werden können.

### 5.4 Keine großen Apply-/Reset-Buttons mehr

`Filter anwenden` entfällt komplett.

Verhalten:

- Suche: bestehendes 250-ms-Debounce behalten.
- Selects: sofort nach `change` neu laden.
- Datum: nach `change` neu laden.
- Toggle `Ohne Kategorie`: sofort neu laden.
- Status: sofort neu laden.

`Filter zurücksetzen` wird ein kleiner textartiger Secondary-Button rechts in der Filterleiste.

### 5.5 Aktive Filter zählen

Neue Helper-Funktion:

```text
countActiveTransactionFilters(state)
```

Zählregeln:

- `q`: 1
- `accountId`: 1
- `categoryId` oder `uncategorized`: zusammen maximal 1
- `direction`: 1
- `status`: 1
- `dateFrom` oder `dateTo`: zusammen maximal 1 Datumsfilter

Der Wert wird am Filter-Button als Badge angezeigt. Bei 0 wird das Badge ausgeblendet.

### 5.6 Filterpanel-Zustand merken

Neuer SessionStorage-Key:

```text
yuvomi:banking:transaction-filters-open
```

Default auf Desktop: `true`.

Wenn der Nutzer das Panel zuklappt, bleibt die Tabelle vollständig sichtbar.

---

## 6. Spaltenauswahl ergänzen

Der Button `Spalten` aus dem Zielbild wird als kompakte `<details>`-basierte Dropdown-Steuerung umgesetzt. Keine neue Popover-Library.

Pflichtspalten, nicht abschaltbar:

```text
Datum
Empfänger / Händler
Betrag
```

Optionale Spalten:

```text
Konto
Kategorie
Wochenbudget
Status
```

Frontend-State:

```js
columns: {
  account: true,
  category: true,
  weeklyBudget: true,
  status: true
}
```

Persistenz in SessionStorage:

```text
yuvomi:banking:transaction-columns
```

In `<th>` und `<td>` jeweils `data-transaction-column="account|category|weeklyBudget|status"` setzen. Nicht sichtbare Spalten bekommen `hidden` oder eine dedizierte CSS-Klasse. Die Daten werden weiterhin normal vom Server geladen; es entsteht kein Backend-Sonderfall.

---

# Teil B – Tabellenzeilen lesbar machen

## 7. Spaltengewichtung ändern

Aktuell ist die Tabelle mit `min-width: 58rem` zu eng für die Anzahl der Controls.

Neues Ziel:

```text
Datum             ~ 6.5rem
Händler            flexibel, größte Spalte
Konto             ~ 9–10rem
Kategorie         ~ 9.5rem
Wochenbudget      ~ 9.5rem
Status            ~ 7rem
Betrag            ~ 8.5rem
Aktion            ~ 2.5rem
```

Neue Tabellen-Minimalbreite:

```text
ca. 72rem
```

Auf schmalen Viewports darf `.banking-transactions-table-wrap` horizontal scrollen. Keine aggressiven Spaltenquetschungen.

---

## 8. Händlerzelle als primäre Information

Aktuell existiert bereits:

```text
merchant/name
purpose
logo/fallback initials
```

Das bleibt, wird aber visuell klarer:

```text
●  PayPal Europe S.à r.l.      <- stark, eine Zeile
   Zahlung an Google Ireland   <- sekundär, maximal zwei Zeilen
```

CSS:

- Merchant-Mark von derzeit `1.5rem` auf ca. `2rem`.
- Titel `font-weight: 700`.
- Titel möglichst eine Zeile mit Ellipsis.
- Purpose maximal zwei Zeilen; lange Rohtexte nicht die komplette Tabellenhöhe aufblasen lassen.
- Zeilenhöhe soll im Normalfall etwa 3.75–4.5rem betragen.

Der vollständige Purpose ist jederzeit im Detaildialog verfügbar.

---

## 9. Konto kompakt darstellen

`loadMainView()` besitzt bereits die Accounts und speichert sie in:

```text
container.bankingTransactionAccounts
```

Keine neue Backend-Abfrage nötig.

In `renderTransactionTable()` einen Account-Lookup nach `account_id` verwenden.

Darstellung:

```text
K. Krone
•••• 1234
```

oder bei einem klar benannten Konto:

```text
Gehaltskonto
•••• 5678
```

Dafür `display_name` plus `iban_masked` aus der bereits geladenen Account-Liste verwenden.

Wichtig:

- keinen Provider-/Banknamen hartcodieren;
- lange Display-Namen mit Ellipsis;
- vollständiger Kontoname bleibt per `title` verfügbar;
- die Tabelle darf niemals die echte unmaskierte IBAN aus dem Listenendpoint erhalten.

---

## 10. Kategorie und Wochenbudget zu kompakten Row-Controls machen

Die vorhandenen Selects bleiben semantisch bestehen, weil die direkte Änderung sinnvoll ist.

Sie bekommen aber eine separate Klasse:

```text
banking-table-select
```

Nicht mehr wie allgemeine `.form-input`-Formulare wirken lassen.

Ziel:

```text
[ Lebensmittel ▾ ]
[ Kategorie   ▾ ]
```

Eigenschaften:

- Höhe ca. 2.25rem,
- geringe horizontale Padding,
- abgerundete Pill-/Compact-Control-Optik,
- Text mit Ellipsis,
- keine unnötige Mindestbreite über die Spaltenbreite hinaus.

Funktional bleiben die bestehenden Endpunkte für Kategorie und Wochenbudget unverändert.

---

## 11. Status als Pill rendern

Statt reinem Text:

```text
● Gebucht
● Vorgemerkt
● Unbekannt
```

Klassen:

```text
banking-transaction-status
banking-transaction-status--booked
banking-transaction-status--pending
banking-transaction-status--unknown
```

Farben nur über bestehende Yuvomi-/Banking-Variablen bzw. Fallbacks:

- BOOK: success/grün
- PDNG: warning/gelb-orange
- UNKNOWN: neutral/grau

Status bleibt sortierbar.

---

## 12. Betrag stärker hervorheben

Aktuelle Richtungseinfärbung bleibt bestehen.

Zusätzlich:

- `font-weight: 700`
- tabellarische Ziffern
- strikt rechtsbündig
- positive Beträge mit sichtbarem `+`

Neue Helper-Funktion nur für die Umsatzliste:

```text
formatTransactionAmount(transaction)
```

Beispiel:

```text
-17,39 €
+2.450,00 €
```

`formatMoney()` selbst nicht global verändern, weil es an vielen anderen Stellen verwendet wird.

---

## 13. Subtiles Zebra-/Hover-Verhalten

In `style.css`:

- alternierende sehr subtile Row-Surface,
- Hover-Surface für klickbare Zeilen,
- klare, aber dezente Separatoren,
- `cursor: pointer` auf der nicht-interaktiven Row-Fläche,
- Focus-Outline für Tastaturnavigation.

Keine extremen Kontraste oder neue Farbschemata einführen.

---

# Teil C – bessere Pagination

## 14. Seitenzahlen statt nur Zurück/Weiter

`GET /transactions` liefert bereits:

```text
total
limit
offset
```

Backend muss dafür nicht geändert werden.

`renderTransactionPagination()` berechnet:

```text
currentPage = floor(offset / limit) + 1
pageCount = ceil(total / limit)
```

Renderregel:

- erste Seite
- letzte Seite
- aktuelle Seite
- bis zu zwei Seiten links/rechts der aktuellen Seite
- Lücken als `…`

Beispiel:

```text
‹  1  2  3  4  5  …  16  ›
```

Links:

```text
1–25 von 382 Umsätzen
```

Rechts:

```text
[25 pro Seite ▾]
```

Seitengrößen:

```text
10
25
50
100
```

Frontend-Default wird von 50 auf **25** gesetzt.

Beim Ändern von `limit`:

```text
offset = 0
```

Neues Data-Attribut:

```text
data-transaction-page-size
```

Bestehendes `data-transaction-page` kann für konkrete Seitennummern weiterverwendet werden; statt relativer `-1/+1` Werte bevorzugt absolute Seitennummern bzw. explizite `previous`/`next` Actions verwenden.

---

# Teil D – Umsatz anklicken und ALLE Informationen anzeigen

## 15. Fachliches Ziel

Jede Umsatzzeile wird anklickbar.

Ein Klick öffnet einen modalen Dialog, der alle lokal bekannten Informationen zu genau diesem Umsatz zeigt – einschließlich der vollständigen, beim Provider empfangenen Rohdaten, sofern sie gespeichert wurden.

**Wichtig:** "Alle Daten" bedeutet alle transaction-bezogenen Daten. Es werden niemals API-Keys, Private Keys, Provider-Session-Credentials, Yuvomi-Session-Cookies oder andere Verbindungs-Secrets angezeigt.

---

## 16. Provider-Rohdaten ab jetzt verschlüsselt persistieren

Das Schema besitzt bereits:

```text
transactions.raw_payload_encrypted TEXT
```

Der aktuelle `importer.ts` schreibt die Spalte noch nicht.

### Änderung in `service/src/enable-banking/importer.ts`

Beim Normalisieren jedes Provider-Umsatzes:

```text
rawPayloadEncrypted = encryption.encrypt(JSON.stringify(transaction))
```

Das verschlüsselte Payload wird in `NormalizedTransaction` aufgenommen.

Danach:

### INSERT

`raw_payload_encrypted` in `insertTransaction` und die Parameterliste aufnehmen.

### UPDATE

`raw_payload_encrypted = ?` in `updateTransaction` aufnehmen.

Bei jedem erfolgreichen erneuten Sync wird der aktuelle Provider-Payload gespeichert. Dadurch werden auch bestehende Transaktionen automatisch mit Rohdaten nachbefüllt, **wenn der Provider sie beim nächsten Sync erneut liefert**.

Keine Klartext-Rohdaten in Logs schreiben.

Keine neue Migration erstellen.

---

## 17. Neuer Detail-Endpunkt

Neue Route:

```http
GET /api/extensions/banking/transactions/:transactionId
```

Datei:

```text
service/src/api/transaction-routes.ts
```

Permission:

```text
read
```

### Ownership ist zwingend

Der Query muss über

```text
transactions
 -> bank_accounts
 -> enable_banking_connections
```

sicherstellen:

```text
enable_banking_connections.yuvomi_user_id = currentUser.id
```

Existiert die Transaction nicht oder gehört sie einem anderen Benutzer:

```http
404 Not Found
```

Nicht `403`, damit fremde IDs nicht enumerierbar sind.

---

## 18. Detail-Service in `transactions-query.ts`

Neue Funktion, z. B.:

```ts
getTransactionDetail(database, userId, transactionId, encryption)
```

Sie lädt alle transaction-bezogenen Informationen in einem kontrollierten Query.

### 18.1 Lokale Umsatzdaten

Mindestens:

```text
id
account_id
provider_transaction_id
entry_reference
transaction_id
booking_date
value_date
transaction_date
amount_cents / formatiertes amount
currency
direction
counterparty_name
purpose
merchant_name
merchant_key
mcc
status
category_id
category_name
category_source
category_confidence
weekly_budget_override
category_weekly_budget_default
yuvomi_budget_entry_id
created_at
updated_at
```

### 18.2 Konto

Join auf `bank_accounts` und Connection:

```text
account.id
account.display_name
account.currency
account.account_type
account.iban               # serverseitig entschlüsselt, nur Detailendpoint
bank.aspsp_name
bank.aspsp_country
```

Die Provider-Account-UID darf unter einer technischen Sektion angezeigt werden, wenn sie als diagnostische transaction-bezogene Kontoinformation hilfreich ist. Provider-Session-Credentials werden nicht ausgegeben.

### 18.3 Gegenpartei

Join auf `counterparties`:

```text
counterparty.counterparty_id
counterparty.display_name
counterparty.iban          # serverseitig entschlüsselt
counterparty.normalized_merchant_name
counterparty.logo_key
```

Da der Benutzer ausdrücklich eine vollständige Detailansicht verlangt, wird die IBAN hier **nicht maskiert**. Sie bleibt aber ausschließlich im geschützten Detailendpoint und erscheint nie im Tabellen-/Listenendpoint.

### 18.4 Rohdaten

Wenn `raw_payload_encrypted` vorhanden ist:

1. mit dem vorhandenen `EncryptionService` entschlüsseln;
2. JSON parsen;
3. als `provider_raw` zurückgeben.

Wenn nicht vorhanden:

```json
"provider_raw": null
```

Zusätzlich z. B.:

```json
"provider_raw_available": false
```

Keinen Provider-Request beim Öffnen des Dialogs auslösen. Der Dialog soll den lokalen, zum Importzeitpunkt gespeicherten Datenstand zeigen und sofort/zuverlässig funktionieren.

---

## 19. EncryptionService sauber injizieren

`transaction-routes.ts` benötigt zum Detail-Lesen den bestehenden `EncryptionService`.

Bevorzugte Lösung:

```text
AppDependencies.encryption?: EncryptionService
```

In `createApp()`:

```text
const resolvedEncryption = encryption ?? createEncryptionService()
```

und:

```text
createTransactionRouter({ database, resolveSession, encryption: resolvedEncryption })
```

Dadurch kann der Detailendpoint im Test einen deterministischen Test-Key / Test-Service verwenden.

Keine eigene Crypto-Implementierung in `transaction-routes.ts` schreiben.

---

# Teil E – Detaildialog im Frontend

## 20. Native `<dialog>` verwenden

Yuvomi selbst verwendet bereits native HTML-Dialoge mit `showModal()`. Das Banking-Modul soll deshalb keine Modal-Library hinzufügen.

Markup wird einmal in `renderTransactionsPanelMarkup()` angelegt:

```html
<dialog class="banking-transaction-dialog" data-banking-transaction-dialog>
  ...
</dialog>
```

Dialog muss besitzen:

```text
aria-labelledby
Close-Button
Esc-Schließen über natives dialog-Verhalten
scrollbaren Body
max-height passend zu Viewport
```

---

## 21. Row-Click und Tastaturbedienung

Jede Tabellenzeile bekommt:

```text
data-transaction-row
data-transaction-id="123"
tabindex="0"
```

Zusätzlich rechts eine sehr kleine Aktion:

```text
⋮
```

mit `aria-label="Umsatzdetails anzeigen"`.

### Klick-Regel

Ein Klick auf die Row öffnet den Dialog, **außer** das Event kommt aus einem interaktiven Element:

```text
select
input
button
a
label
```

Damit öffnen Kategorie- und Wochenbudget-Selects nicht versehentlich den Dialog.

### Tastatur

Wenn die Row selbst fokussiert ist:

```text
Enter -> Dialog öffnen
Space -> Dialog öffnen
```

Selects behalten normales Tastaturverhalten.

---

## 22. Detaildaten lazy laden

Neue Funktion:

```text
openTransactionDetail({ container, transactionId, signal })
```

Ablauf:

1. Dialog öffnen bzw. Loading-State anzeigen.
2. `GET transactions/:id` laden.
3. `renderTransactionDetail(dialogContent, payload.data)` aufrufen.
4. Fehler im Dialog darstellen, Dialog nicht einfach schließen.

Nicht alle Detaildaten im Listenendpoint mitsenden. Die Tabelle bleibt schlank.

---

## 23. Dialog-Informationsarchitektur

Der Dialog soll nicht nur einen JSON-Dump zeigen. Die wichtigsten Daten werden strukturiert dargestellt; darunter befinden sich die vollständigen Provider-Rohdaten.

### Header

```text
Händler / Empfänger                         -17,39 €
11.09.2026 · Gebucht
```

Betrag verwendet dieselbe Rot-/Grün-Semantik wie die Tabelle.

### Sektion 1 – Buchung

```text
Betrag
Währung
Richtung
Status
Buchungsdatum
Valutadatum
Transaktionsdatum
Verwendungszweck (vollständig, kein Truncation)
```

### Sektion 2 – Empfänger / Gegenpartei

```text
Gegenpartei-Name
IBAN vollständig
Merchant-Name
Merchant-Key
MCC
lokale counterparty_id
```

Fehlende Werte werden als `–` dargestellt, nicht ausgelassen. Dadurch ist klar erkennbar, welche Daten der Provider tatsächlich geliefert hat.

### Sektion 3 – Eigenes Konto / Bank

```text
Kontoname
IBAN vollständig
Kontotyp
Kontowährung
Bank / ASPSP
Land
```

### Sektion 4 – Kategorisierung / Wochenbudget

```text
Kategorie
Kategorie-ID
Quelle der Kategorie
Confidence
Wochenbudget-Override
Kategorie-Default für Wochenbudget
Yuvomi-Budget-Entry-ID
```

### Sektion 5 – Bank-/Provider-Referenzen

```text
Provider transaction key
entry_reference
transaction_id
weitere vorhandene Referenzen aus provider_raw
```

### Sektion 6 – Technische lokale Daten

```text
Lokale Transaction-ID
created_at
updated_at
```

### Sektion 7 – Provider-Rohdaten

Einklappbar, standardmäßig geschlossen:

```text
▶ Alle Provider-Rohdaten
```

Inhalt als formatiertes JSON:

```html
<pre></pre>
```

**Sicherheitsregel:** JSON niemals per `innerHTML` einfügen. Ausschließlich:

```js
pre.textContent = JSON.stringify(providerRaw, null, 2)
```

Zusätzlich Button:

```text
JSON kopieren
```

mit `navigator.clipboard.writeText()` und kontrolliertem Fallback/Fehlerstatus.

Wenn Rohdaten fehlen:

```text
Provider-Rohdaten sind für diesen älteren Import nicht gespeichert.
Sie werden bei einem zukünftigen Sync ergänzt, falls die Bank den Umsatz erneut liefert.
```

---

# Teil F – CSS-Struktur

## 24. Neue/angepasste CSS-Komponenten

Datei:

```text
modules/banking/style.css
```

Mindestens folgende Klassen einführen bzw. gezielt überarbeiten:

```text
.banking-transactions-toolbar
.banking-transactions-toolbar__actions
.banking-transactions-count
.banking-transaction-filter-panel
.banking-transaction-filter-row
.banking-transaction-filter-row--secondary
.banking-transaction-date-range
.banking-transaction-filter-toggle
.banking-transaction-columns
.banking-table-select
.banking-transaction-status
.banking-transaction-status--booked
.banking-transaction-status--pending
.banking-transaction-status--unknown
.banking-transactions-table__row
.banking-transactions-table__action
.banking-transactions-pagination__pages
.banking-transactions-pagination__page-size
.banking-transaction-dialog
.banking-transaction-dialog__header
.banking-transaction-dialog__body
.banking-transaction-detail-grid
.banking-transaction-detail-section
.banking-transaction-detail-raw
```

### Responsive Regeln

Desktop:

- Tabelle normal breit.
- Filter in einer kompakten horizontalen Zeile.

Mittlere Breite:

- Filter dürfen auf zwei Zeilen wrappen.
- Tabelle scrollt horizontal statt Spalten aggressiv zusammenzudrücken.

Mobil:

- Filter untereinander.
- Dialog nahezu viewport-breit.
- Tabelle bleibt horizontal scrollbar; in diesem Schritt **keine zweite Mobile-Card-Implementierung** bauen.

---

# Teil G – Locales

## 25. Neue Locale-Keys

Deutsch und Englisch ergänzen, mindestens:

```text
transactionFilters
transactionFilterCount
transactionMoreFilters
transactionColumns
transactionColumnsAccount
transactionColumnsCategory
transactionColumnsWeeklyBudget
transactionColumnsStatus
transactionDetails
transactionDetailsOpen
transactionDetailsClose
transactionDetailsBooking
transactionDetailsCounterparty
transactionDetailsAccount
transactionDetailsCategorization
transactionDetailsProviderRefs
transactionDetailsTechnical
transactionDetailsRaw
transactionDetailsRawUnavailable
transactionDetailsCopyJson
transactionDetailsJsonCopied
transactionDetailLoadFailed
transactionsPerPage
```

Keine UI-Texte ausschließlich als englische Fallbacks stehen lassen.

---

# Teil H – Tests

## 26. Importer-Tests

Verifizieren:

1. Provider-Rohpayload wird gespeichert.
2. `raw_payload_encrypted` enthält **nicht** den Klartext-JSON-String.
3. Mit `EncryptionService.decrypt()` ergibt sich exakt der gespeicherte Provider-Payload.
4. Beim Update derselben Transaktion wird das Raw-Payload aktualisiert.
5. Kein Raw-Payload wird geloggt.

---

## 27. Detailendpoint-Tests

Neue Datei bevorzugt:

```text
service/test/transaction-detail.test.ts
```

Mindestens:

1. nicht authentifiziert -> 401
2. Permission `none` -> 403
3. `read` -> darf eigene Details lesen
4. `write` -> darf eigene Details lesen
5. fremde Transaction-ID -> 404
6. unbekannte ID -> 404
7. vollständige eigene Konto-IBAN nur im Detailendpoint
8. vollständige Gegenkonto-IBAN nur im Detailendpoint
9. `provider_raw` wird korrekt entschlüsselt und geparst
10. fehlendes Raw-Payload -> `provider_raw: null`
11. Listenendpoint enthält weiterhin **keine** unmaskierte IBAN und **kein** `raw_payload_encrypted`
12. API-Response enthält niemals Provider-Session-Secret, API-Key oder Private Key

---

## 28. Frontend-Vertragstests

Neue Datei oder Erweiterung von `weekly-budget-frontend.test.ts`.

Besser neue Datei:

```text
service/test/transaction-ui-contract.test.ts
```

Marker prüfen:

```text
data-action="toggle-transaction-filters"
data-transaction-filter-count
data-transaction-columns-menu
data-transaction-row
data-banking-transaction-dialog
data-action="transaction-details"
data-transaction-page-size
banking-transaction-status--booked
banking-table-select
```

Zusätzlich sicherstellen:

- alte `Filter anwenden`-Struktur ist nicht mehr notwendig;
- Dialog-Rohdaten werden nicht mit ungefiltertem `.innerHTML` aus Providerdaten gesetzt;
- Kategorie-/Wochenbudget-Controls bleiben vorhanden;
- positive und negative Betragklassen bleiben erhalten.

---

# Teil I – Implementierungsreihenfolge für Codex/Copilot

## Schritt 1 – Raw-Payload vollständig machen

1. `importer.ts` erweitern.
2. Raw-Payload verschlüsselt bei Insert und Update speichern.
3. Importer-Tests grün machen.

Erst danach Detailendpoint bauen, damit neue Daten tatsächlich vollständig sind.

## Schritt 2 – Detailendpoint

1. EncryptionService injizierbar machen.
2. `getTransactionDetail()` implementieren.
3. `GET /transactions/:id` implementieren.
4. Ownership und Secret-Grenzen testen.

## Schritt 3 – Tabellenmarkup

1. `renderTransactionsPanelMarkup()` umbauen.
2. Toolbar, Count, Filter-Button, Spalten-Button ergänzen.
3. Filtermarkup kompakt neu schreiben.
4. bestehende Data-Attribute soweit möglich weiterverwenden.

## Schritt 4 – Zeilenvisualisierung

1. neue Spaltenbreiten.
2. Merchant-Zelle.
3. Account kompakt + maskierte IBAN aus bereits geladenen Accounts.
4. Kategorie-/Wochenbudget-Selects kompakt.
5. Status-Pill.
6. Betrag `+/-` und stärker.
7. Zebra/Hover/Focus.

## Schritt 5 – Pagination

1. Default `limit=25`.
2. Seitenzahlen berechnen.
3. `10/25/50/100` selector.
4. absolute Seitennavigation.

## Schritt 6 – Dialog

1. `<dialog>` in Panel-Markup.
2. Row-Click + Tastatur.
3. lazy Fetch.
4. strukturierte Sektionen.
5. Raw JSON `<pre>` mit `textContent`.
6. Copy-Button.

## Schritt 7 – Polish + Tests

1. de/en Locales vollständig.
2. Responsive CSS.
3. `npm test`.
4. `npm run build`.
5. Browsertest mit echten/realistischen langen Buchungstexten.

---

# Teil J – Abnahmekriterien

Die Arbeit ist erst fertig, wenn alle folgenden Punkte erfüllt sind:

- [ ] Umsatzfilter wirken wie eine kompakte Toolbar, nicht wie ein großes Einstellungsformular.
- [ ] Kein großer `Filter anwenden`-Button mehr nötig.
- [ ] Filter werden automatisch angewendet.
- [ ] Filterbereich ist ein-/ausklappbar und merkt seinen Zustand.
- [ ] Aktive Filter werden am Filterbutton gezählt.
- [ ] Nutzer kann optionale Tabellenspalten ein-/ausblenden.
- [ ] Händler/Empfänger ist die visuell wichtigste Textspalte.
- [ ] lange Buchungstexte blähen die Zeile nicht mehr unkontrolliert auf.
- [ ] Konto ist kompakt und zeigt nach Möglichkeit maskierte IBAN.
- [ ] Kategorie- und Wochenbudget-Controls sind kompakt.
- [ ] Status wird als visuelles Pill dargestellt.
- [ ] Ausgaben sind rot.
- [ ] Einnahmen sind grün und besitzen ein sichtbares `+`.
- [ ] Tabelle hat subtile Zebra-/Hover-Hervorhebung.
- [ ] Pagination bietet Seitenzahlen und wählbare Seitengröße.
- [ ] Jede Umsatzzeile ist per Maus und Tastatur öffnbar.
- [ ] Klick auf Selects/Buttons öffnet den Dialog nicht.
- [ ] Dialog zeigt alle normalisierten Umsatzdaten.
- [ ] Dialog zeigt vollständige eigene und Gegenkonto-IBAN.
- [ ] Dialog zeigt vollständigen Verwendungszweck.
- [ ] Dialog zeigt technische IDs und Kategorisierungsmetadaten.
- [ ] Dialog zeigt verschlüsselt gespeicherte Provider-Rohdaten nach serverseitiger Entschlüsselung.
- [ ] Raw Providerdaten werden niemals im Listenendpoint ausgeliefert.
- [ ] Secrets werden niemals im Detailendpoint ausgeliefert.
- [ ] Fremde Transaktionen sind über IDs nicht lesbar.
- [ ] Yuvomi Core wurde nicht geändert.
- [ ] keine neue Frontend-/Modal-/Datepicker-Abhängigkeit hinzugefügt.
- [ ] `npm test` und `npm run build` sind grün.

---

## 29. Bewusste Nicht-Ziele dieser Iteration

Nicht Teil dieses Umbaus:

- neue Kategorienlogik,
- neues Wochenbudget-Datenmodell,
- neue Bankprovider,
- neue Händlerlogo-Quelle,
- echte Full-Text-Suchengine,
- eigener Datepicker,
- Mobile-Card-Alternative zur Tabelle,
- Yuvomi-Core-Änderungen,
- Live-Abfrage des Providers beim Öffnen eines Umsatzes.

Diese Iteration ist ausschließlich ein gezielter **Usability-/Informationsarchitektur-Polish der Umsatzansicht plus vollständige lokale Detailinspektion**.
