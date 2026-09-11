# Kategorien anlegen und verwalten – technisches Umsetzungskonzept

Stand der Analyse: `24baf9edd11dd0679743ea68e073b8ea2e973379` (`main`).

Dieses Dokument ist die verbindliche Spezifikation für die nächste Banking-Iteration. Ziel ist, dass Kategorien nicht mehr nur indirekt über akzeptierte KI-Vorschläge entstehen können, sondern im Banking-Modul vollständig manuell angelegt und verwaltet werden können. Gleichzeitig soll der bestehende KI-Flow auch ohne bereits vorhandene Kategorien funktionieren, damit eine neue Installation nicht in einem Bootstrap-Deadlock hängt.

Die Umsetzung bleibt vollständig im Repository `yuvomi-banking`. Yuvomi Core wird nicht verändert.

---

## 1. Ergebnis, das nach der Umsetzung erreicht sein muss

Ein Benutzer mit `ext:banking=write` kann:

1. in den Banking-Einstellungen eine Kategorie manuell anlegen,
2. zwischen `Ausgabe`, `Einnahme` und `Transfer` wählen,
3. für eine Ausgaben-Kategorie festlegen, ob sie standardmäßig zum Wochenbudget gehört,
4. eine Kategorie umbenennen,
5. eine Kategorie deaktivieren und später wieder aktivieren,
6. weiterhin KI-Kategorie-Vorschläge akzeptieren,
7. bereits deaktivierte Kategorien bei historischen Umsätzen weiterhin erkennen,
8. bei einer frischen Installation ohne Kategorien die KI-Analyse starten und dadurch Kategorie-Vorschläge erzeugen lassen.

Es gibt **kein hartes Löschen von Kategorien**. Historische Umsätze, Regeln und KI-Reviews dürfen durch Kategorieverwaltung nicht beschädigt werden.

---

# 2. Analyse des aktuellen Codes

## 2.1 Das Datenmodell kann Kategorien bereits speichern

Die Tabelle `categories` existiert seit `001_init.sql` und besitzt bereits die für die erste vollständige Kategorieverwaltung benötigten Felder:

```text
id
name
type
active
created_at
updated_at
weekly_budget_default   # seit Migration 007
```

Die erlaubten Typen sind bereits durch das Schema definiert:

```text
expense
income
transfer
```

Für die reine Kategorieverwaltung ist daher **keine neue Datenbankmigration notwendig**.

Die aktuelle letzte Migration ist `017_transaction_data_enrichment.sql`. Für dieses Feature soll **keine `018` erzeugt werden**, solange keine zusätzlichen Kategorie-Felder eingeführt werden.

---

## 2.2 Es gibt bereits einen Lese-Endpunkt, aber keinen Erzeugungs-Endpunkt

In `service/src/api/weekly-budget-routes.ts` existiert bereits:

```text
GET /categories
```

Der Endpoint liefert:

```text
id
name
type
active
weekly_budget_default
```

Außerdem existiert bereits:

```text
PATCH /categories/:categoryId/weekly-budget
```

Damit kann der Wochenbudget-Standard einer bestehenden Kategorie verändert werden.

Es fehlt aber vollständig:

```text
POST /categories
PATCH /categories/:categoryId
```

Daher kann die UI keine neue Kategorie erzeugen und bestehende Kategorien nicht allgemein verwalten.

---

## 2.3 KI-Vorschläge können bereits Kategorien erzeugen

`service/src/services/category-suggestions.ts` besitzt mit

```text
acceptCategorySuggestion(...)
```

bereits einen indirekten Kategorie-Erzeugungsweg.

Die Funktion:

- normalisiert den Namen,
- akzeptiert maximal 80 Zeichen,
- akzeptiert nur `expense|income|transfer`,
- sucht eine bestehende Kategorie case-insensitive nach Name + Typ,
- reaktiviert eine vorhandene inaktive Kategorie,
- oder legt eine neue Kategorie an.

Diese Logik ist ein guter Ausgangspunkt, darf aber nicht parallel ein zweites Mal leicht unterschiedlich implementiert werden. Die neue manuelle Kategorieverwaltung soll dieselben zentralen Validierungs- und Normalisierungsregeln verwenden.

---

## 2.4 Aktuell existiert ein Bootstrap-Deadlock

`service/src/services/transaction-categorization.ts` enthält derzeit sinngemäß:

```ts
const categories = activeCategories(database);
if (categories.length === 0) {
  throw new Error('Create at least one active Banking category before categorizing transactions.');
}
```

Gleichzeitig deaktiviert `loadMainView()` im Frontend den Button zur Umsatzanalyse, wenn keine aktive Kategorie vorhanden ist.

Das ist unnötig restriktiv, denn `OpenAiCategorizer` unterstützt bereits:

```text
category_id: null
suggested_category: { name, type }
```

Damit kann OpenAI auch ohne vorhandene Allowlist neue Kategorien vorschlagen.

Nach dieser Iteration muss daher gelten:

```text
0 Kategorien
   -> KI analysiert ungelöste Umsätze
   -> category_id = null
   -> suggested_category wird gespeichert
   -> Benutzer akzeptiert Vorschlag
   -> erste Kategorie entsteht
```

Manuelle Erstellung bleibt trotzdem der primäre und deterministische Weg.

---

## 2.5 Kategorien sind aktuell bewusst ein Instanz-Katalog

`categories` besitzt aktuell **keine `yuvomi_user_id`**. Der bestehende Code behandelt die Kategorien als gemeinsamen Banking-Katalog innerhalb der Yuvomi-Instanz:

- `GET /categories` ist nicht auf einen User gefiltert,
- `activeCategories()` verwendet alle aktiven Kategorien,
- Kategorie-Regeln selbst sind hingegen user-scoped,
- KI-Vorschläge sind ebenfalls user-scoped.

Dieses Feature soll die Scope-Semantik **nicht nebenbei verändern**.

Verbindliche Entscheidung für diese Iteration:

> Kategorien bleiben zunächst ein instanzweiter Banking-Katalog. Es wird keine teilweise oder inkonsistente User-Ownership in `categories` eingeführt.

Falls später getrennte Kategorie-Kataloge je Yuvomi-Nutzer gewünscht sind, muss das als eigene Migration inklusive Backfill aller bestehenden `transactions`, `category_rules`, `ai_categorization_reviews` und Vorschläge geplant werden.

---

# 3. Zielarchitektur

Die Kategorieverwaltung wird aus dem inzwischen sehr großen `weekly-budget-routes.ts` herausgelöst.

Neue Struktur:

```text
service/src/services/categories.ts
service/src/api/category-routes.ts
```

`app.ts` registriert den Router unter dem bestehenden Prefix:

```text
/api/extensions/banking
```

Die öffentlichen Pfade bleiben:

```text
GET   /categories
POST  /categories
PATCH /categories/:categoryId
PATCH /categories/:categoryId/weekly-budget
```

Dadurch ändern sich bestehende Frontend-URLs nicht.

---

# 4. Neue zentrale Kategorie-Service-Schicht

Datei neu anlegen:

```text
service/src/services/categories.ts
```

Diese Datei soll sämtliche grundlegende Kategorie-CRUD-Logik kapseln.

## 4.1 Typen

```ts
export type CategoryType = 'expense' | 'income' | 'transfer';

export interface BankingCategory {
  id: number;
  name: string;
  type: CategoryType;
  active: boolean;
  weeklyBudgetDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Zusätzlich Fehlerklassen:

```text
CategoryNotFoundError
CategoryValidationError
CategoryConflictError
```

---

## 4.2 Gemeinsame Namensnormalisierung

Eine einzige exportierte Funktion verwenden:

```text
normalizeCategoryName(value)
```

Verbindliche Normalisierung:

```text
NFKC
-> Control Characters entfernen/zu Leerzeichen machen
-> trim()
-> Whitespace auf ein Leerzeichen reduzieren
```

Beispiel:

```text
"  Lebens   mittel  " -> "Lebens mittel"
```

Regeln:

```text
min: 1 Zeichen
max: 80 Zeichen
```

Keine HTML- oder SQL-Sonderbehandlung in der Fachlogik. SQL bleibt parametrisiert; Frontend escaped weiter über `esc()`.

`category-suggestions.ts` soll anschließend diese gemeinsame Funktion importieren und seine private Kopie von `normalizeCategoryName()` entfernen.

---

## 4.3 Typ validieren

Gemeinsamer Helper:

```text
isCategoryType(value)
```

Zulässig ausschließlich:

```text
expense
income
transfer
```

Auch diese Logik soll aus `category-suggestions.ts` in die zentrale Kategorie-Service-Datei verschoben oder von dort wiederverwendet werden.

---

## 4.4 `listCategories()`

Neue Service-Funktion:

```ts
listCategories(database, { includeInactive: true })
```

Sortierung verbindlich:

```text
active DESC
CASE type
  expense  -> 1
  income   -> 2
  transfer -> 3
END
name COLLATE NOCASE
id
```

Die API soll weiterhin standardmäßig aktive und inaktive Kategorien liefern, weil historische Umsätze auf inaktive Kategorien zeigen können.

---

## 4.5 `createCategory()`

Signatur sinngemäß:

```ts
createCategory(database, {
  name,
  type,
  weeklyBudgetDefault,
  now
})
```

Ablauf:

1. Namen normalisieren.
2. Typ validieren.
3. `weekly_budget_default` auf Boolean prüfen.
4. `BEGIN IMMEDIATE` starten.
5. Case-insensitive nach bereits existierender Kategorie mit gleichem Namen und gleichem Typ suchen.
6. Wenn aktiv vorhanden: `CategoryConflictError`.
7. Wenn inaktiv vorhanden: **nicht stillschweigend reaktivieren**; ebenfalls `CategoryConflictError`, aber mit Information, dass die Kategorie reaktiviert werden kann.
8. Neue Zeile mit `active=1` anlegen.
9. `created_at` und `updated_at` setzen.
10. Commit.
11. vollständiges öffentliches Category-Objekt zurückgeben.

Warum kein automatisches Reaktivieren bei POST:

- `Kategorie anlegen` soll nicht überraschend historische Konfiguration wieder aktivieren.
- die UI kann bei Konflikt eindeutig `Kategorie reaktivieren` anbieten.

### Wochenbudget-Default

Für `income` und `transfer` soll `weekly_budget_default` beim manuellen Erstellen serverseitig auf `false` normalisiert werden.

Nur `expense` kann standardmäßig als direkte Wochenbudget-Ausgabe markiert werden.

Das passt zur bestehenden Wochenbudget-Auswertung, die ohnehin nur `outgoing`-Buchungen berücksichtigt.

---

## 4.6 `updateCategory()`

Signatur:

```ts
updateCategory(database, categoryId, {
  name?,
  active?,
  weeklyBudgetDefault?,
  now
})
```

Mindestens ein veränderbares Feld muss vorhanden sein.

### Veränderbar

```text
name
active
weekly_budget_default
```

### Nicht veränderbar

```text
type
```

Der Kategorie-Typ ist nach Erstellung absichtlich unveränderlich.

Grund:

Eine Änderung von `expense` zu `income` würde die Semantik bereits kategorisierter historischer Umsätze, AI-Ergebnisse und Regeln rückwirkend verändern. Wenn der Typ falsch angelegt wurde, soll eine neue Kategorie erzeugt und die alte deaktiviert werden.

Bei Namensänderung dieselbe Normalisierung und Duplicate-Prüfung wie bei `createCategory()` verwenden.

Wenn die Kategorie `income` oder `transfer` ist, darf `weekly_budget_default=true` nicht gespeichert werden.

---

# 5. Neuer `category-routes.ts`

Datei neu:

```text
service/src/api/category-routes.ts
```

Der Router bekommt:

```text
database
resolveSession
clock
```

Alle Mutationen verwenden weiterhin:

```text
resolveAuthorizedUser(..., 'write')
mutationIsAllowed(...)
```

Alle Antworten:

```text
Cache-Control: no-store
```

---

## 5.1 GET `/categories`

Bestehenden Endpoint aus `weekly-budget-routes.ts` hierher verschieben.

Response kompatibel halten:

```json
{
  "data": [
    {
      "id": 1,
      "name": "Lebensmittel",
      "type": "expense",
      "active": true,
      "weekly_budget_default": true
    }
  ]
}
```

Keine bestehende Frontend-Nutzung brechen.

---

## 5.2 POST `/categories`

Berechtigung:

```text
ext:banking = write
CSRF erforderlich
```

Request:

```json
{
  "name": "Lebensmittel",
  "type": "expense",
  "weekly_budget_default": true
}
```

Response bei Erfolg:

```text
HTTP 201
```

```json
{
  "data": {
    "id": 12,
    "name": "Lebensmittel",
    "type": "expense",
    "active": true,
    "weekly_budget_default": true
  }
}
```

Statuscodes:

```text
400 ungültiger Name / Typ / Body
403 keine write-Berechtigung oder CSRF
409 Kategorie mit Name + Typ existiert bereits
500 unerwarteter Fehler
```

Keine internen SQLite-Fehler an den Browser senden.

---

## 5.3 PATCH `/categories/:categoryId`

Beispiel Umbenennung:

```json
{
  "name": "Lebensmittel & Drogerie"
}
```

Deaktivieren:

```json
{
  "active": false
}
```

Reaktivieren:

```json
{
  "active": true
}
```

Wochenbudget-Default:

```json
{
  "weekly_budget_default": true
}
```

Mehrere Felder dürfen atomar in einem Request geändert werden.

Response:

```text
200 + vollständige aktualisierte Kategorie
```

Fehler:

```text
400 Validation
404 ID existiert nicht
409 Namenskonflikt
```

---

## 5.4 Bestehendes PATCH `/categories/:id/weekly-budget`

Der Endpoint bleibt aus Rückwärtskompatibilität bestehen.

Er wird aber nicht mehr mit eigener SQL-Logik implementiert, sondern delegiert intern an:

```text
updateCategory(..., { weeklyBudgetDefault })
```

Danach existiert nur noch eine Stelle für Validierung und Persistenz.

---

# 6. Kategorie-Endpunkte aus `weekly-budget-routes.ts` entfernen

Datei:

```text
service/src/api/weekly-budget-routes.ts
```

Entfernen:

```text
GET /categories
PATCH /categories/:categoryId/weekly-budget
```

Nicht verändern:

```text
PATCH /transactions/:transactionId/category
PATCH /transactions/:transactionId/weekly-budget
```

Diese Endpunkte gehören weiterhin zum Transaktions-/Wochenbudget-Flow und funktionieren mit den neuen Kategorien unverändert.

---

# 7. Router in `app.ts` registrieren

Datei:

```text
service/src/app.ts
```

Import:

```text
createCategoryRouter
```

Registrierung im vorhandenen database-Block:

```text
app.use(API_PREFIX, createCategoryRouter({
  database,
  resolveSession,
  clock
}));
```

Es dürfen keine Pfadänderungen für den Browser entstehen.

---

# 8. Manuelle Kategorieverwaltung in der Settings-UI

Datei:

```text
modules/banking/index.js
```

Die bisherige Settings-Sektion

```text
Wochenbudget-Kategorien
```

wird zu einem vollständigen Bereich:

```text
Kategorien
```

Der Bereich bleibt in `/m/banking?view=settings`.

## 8.1 Zielbild

```text
┌──────────────────────────────────────────────────────┐
│ Kategorien                         [+ Kategorie]     │
│ Verwalte Kategorien für Umsätze und Wochenbudget.   │
│                                                      │
│ Lebensmittel       Ausgabe    Wochenbudget ✓   ⋯    │
│ Mobilität          Ausgabe    Wochenbudget ✓   ⋯    │
│ Abonnements        Ausgabe    Wochenbudget ✕   ⋯    │
│ Gehalt             Einnahme                    ⋯    │
│ Interner Transfer  Transfer                     ⋯    │
│                                                      │
│ Inaktive Kategorien (2) ▾                           │
└──────────────────────────────────────────────────────┘
```

Keine große Tabellenoptik notwendig. Eine kompakte Listen-/Row-Darstellung passt besser zu den Settings.

---

## 8.2 Header

Neue Übersetzungsschlüssel:

```text
categoriesTitle
categoriesDescription
categoryAdd
```

Deutsch:

```text
Kategorien
Verwalte Kategorien für Umsätze, Regeln und das Wochenbudget.
Kategorie hinzufügen
```

Englisch entsprechend.

Der Button `Kategorie hinzufügen` ist bei `read` deaktiviert oder nicht vorhanden.

---

## 8.3 Kategoriezeile

Jede aktive Kategorie zeigt:

```text
Name
Typ-Badge
Wochenbudget-Standard (nur sinnvoll für Ausgabe)
Bearbeiten
Deaktivieren
```

Typ-Bezeichnungen:

```text
expense  -> Ausgabe
income   -> Einnahme
transfer -> Transfer
```

CSS-Klassen beispielsweise:

```text
.banking-category-list
.banking-category-row
.banking-category-row__identity
.banking-category-type
.banking-category-row__actions
```

Die Row soll kompakt bleiben.

---

## 8.4 Inaktive Kategorien

Inaktive Kategorien separat unter einem `<details>` darstellen:

```text
Inaktive Kategorien (N)
```

Dort:

```text
Name
Typ
Reaktivieren
```

Kein Hard Delete anbieten.

---

# 9. Kategorie-Erstellen-Dialog

Der Transaction-Detail-Flow verwendet inzwischen bereits native `<dialog>`-Elemente. Die Kategorieverwaltung soll dasselbe Browser-Primitiv verwenden und keine neue Modal-Library einführen.

Markup in `renderSettingsMarkup()` einmalig anlegen:

```text
<dialog data-banking-category-dialog>
```

Inhalt bei Create:

```text
Kategorie hinzufügen

Name
[____________________________]

Typ
[ Ausgabe ▾ ]

[ ] Standardmäßig im Wochenbudget berücksichtigen

[Abbrechen] [Kategorie anlegen]
```

Fields:

```text
data-category-name
data-category-type
data-category-weekly-budget
data-action="save-category"
```

Wenn `type != expense`:

```text
weekly budget checkbox = unchecked + disabled
```

Beim Wechsel zurück auf `expense` wieder aktivieren.

---

# 10. Kategorie-Bearbeiten-Dialog

Derselbe Dialog kann Create und Edit verwenden.

Bei Edit:

```text
Name              editierbar
Typ               nur Anzeige / disabled
Wochenbudget      editierbar bei expense
Status            nicht im Formular nötig
```

`type` nicht über PATCH senden.

Deaktivierung/Reaktivierung erfolgt als eigene explizite Row-Aktion.

---

# 11. Neue Frontend-Funktionen

In `modules/banking/index.js` bevorzugt kleine Funktionen ergänzen statt weitere monolithische Blöcke.

Verbindliche Verantwortlichkeiten:

```text
renderCategoryManagement(host, categories, canWrite)
openCreateCategoryDialog(container)
openEditCategoryDialog(container, category)
configureCategoryDialog(container, signal)
saveCategory(container, dialog, signal)
setCategoryActive(container, categoryId, active, signal)
refreshCategories(container, signal)
categoryTypeLabel(type)
```

`renderWeeklyBudgetCategories()` kann danach entfernt oder auf `renderCategoryManagement()` umgestellt werden, wenn keine andere Stelle die alte Darstellung benötigt.

Wichtig: keine zweite konkurrierende Kategorie-Liste in den Settings behalten.

---

# 12. Settings-Ladevorgang anpassen

`loadSettingsView()` lädt bereits:

```text
GET categories
```

Das bleibt bestehen.

Statt:

```text
renderWeeklyBudgetCategories(...)
```

in der Settings-Ansicht:

```text
renderCategoryManagement(...)
```

Die Hauptansicht kann weiterhin dieselben geladenen Category-Objekte für Filter, Dropdowns und KI verwenden.

---

# 13. Nach Kategorieänderungen alle abhängigen UI-Bereiche aktualisieren

Kategorieänderungen betreffen mehrere bereits geladene Bereiche:

- Transaktions-Kategorie-Dropdowns,
- Kategorie-Filter,
- Wochenbudget-Defaults,
- KI-Kategorisierung,
- Kategorie-Vorschläge.

Daher einen zentralen Helper einführen:

```text
refreshCategoryDependentViews(container, signal)
```

Aufgabe:

1. `GET /categories`
2. `container.bankingTransactionCategories = categories`
3. Kategorie-Management neu rendern, falls Settings-View
4. Transaction-Filter neu rendern, falls Main-View
5. Transaction-Tabelle neu laden, falls Main-View
6. Zustand des KI-Analysebuttons aktualisieren

Keine komplette Browser-Seite reloaden.

---

# 14. Inaktive Kategorien in der Umsatz-Tabelle korrekt behandeln

Das ist für Deaktivierung zwingend erforderlich.

Aktuell filtert `renderTransactionTable()` die Kategorie-Optionen auf:

```text
category.active !== false
```

Wenn ein historischer Umsatz einer später deaktivierten Kategorie zugeordnet ist, würde diese Kategorie dadurch aus seinem `<select>` verschwinden.

Neue Regel:

### Für neue Zuweisungen

Nur aktive Kategorien auswählbar.

### Für bereits zugewiesene inaktive Kategorie

Die aktuell zugewiesene Kategorie zusätzlich als selected + disabled Option anzeigen:

```text
Lebensmittel (inaktiv)
```

Damit bleibt die historische Zuordnung sichtbar, bis der Benutzer bewusst eine andere aktive Kategorie auswählt.

Dafür Helper bauen:

```text
transactionCategoryOptions(categories, currentCategoryId)
```

Diesen Helper sowohl in der neuen Tabellenansicht als auch in noch vorhandenen Legacy-Renderpfaden verwenden.

---

# 15. Kategorie-Filter muss historische Kategorien unterstützen

Im Filter ist das Verhalten anders als beim Assignment.

Der Benutzer muss historische Umsätze nach einer deaktivierten Kategorie filtern können.

Daher `renderTransactionFilters()` nicht mehr nur mit aktiven Kategorien befüllen.

Darstellung bevorzugt:

```text
Aktiv
  Lebensmittel
  Mobilität
  Abos

Inaktiv
  Alte Kategorie
```

mittels `<optgroup>`.

Der Backend-Query benötigt dafür keine Änderung; `category_id` filtert bereits nach ID.

---

# 16. KI-Bootstrap ohne Kategorien erlauben

Datei:

```text
service/src/services/transaction-categorization.ts
```

Entfernen:

```text
if (categories.length === 0) throw ...
```

Die restliche Logik kann grundsätzlich bereits mit `categories=[]` umgehen:

- `allowedCategoryIds` ist leer,
- `category_id` wird `null`,
- `suggested_category` kann gespeichert werden,
- `category_suggestions` ist bereits user-scoped.

---

# 17. OpenAI-Instruktion für Bootstrap präzisieren

Datei:

```text
service/src/openai/categorizer.ts
```

Die Instructions sollen zusätzlich eindeutig sagen:

```text
- If no supplied category fits, return category_id null and provide a concise suggested_category.
- If the category allowlist is empty, return category_id null and propose the best reusable category for each transaction.
- Prefer reusable household-finance categories over merchant-specific categories.
```

Beispiel:

```text
REWE -> Lebensmittel
nicht -> REWE

Spotify -> Abonnements
nicht -> Spotify
```

Keine automatische Anlage durch OpenAI. Der Benutzer akzeptiert Vorschläge weiterhin explizit.

---

# 18. Frontend-Deadlock entfernen

Aktuell deaktiviert `loadMainView()` den Analysebutton bei `!hasActiveCategories`.

Diese Logik entfernen.

Stattdessen bei 0 aktiven Kategorien einen hilfreichen Hinweis anzeigen:

```text
Noch keine Kategorien vorhanden. Du kannst Kategorien in den Einstellungen anlegen oder die Analyse verwenden, um Vorschläge erzeugen zu lassen.
```

Optionaler Link:

```text
/m/banking?view=settings#banking-categories
```

Text:

```text
Kategorien verwalten
```

Der Analysebutton bleibt bei `write` aktiv.

Bei `read` bleibt er wie bisher deaktiviert.

---

# 19. AI-Vorschläge an die neue Kategorieverwaltung anbinden

`acceptCategorySuggestion()` soll weiterhin Kategorien anlegen können.

Aber die Funktion soll für:

```text
normalizeCategoryName
isCategoryType
```

die neue zentrale Service-Logik verwenden.

Die bestehende Semantik bleibt:

- passende aktive Kategorie -> verwenden,
- passende inaktive Kategorie -> reaktivieren,
- sonst neue Kategorie -> anlegen.

Nach `accept-category-suggestion` im Frontend:

```text
refreshCategoryDependentViews(...)
```

aufrufen.

Dadurch erscheint eine akzeptierte Kategorie sofort:

- im Transaction-Dropdown,
- im Filter,
- in der Settings-Kategorieverwaltung,
- in der nächsten OpenAI-Allowlist.

---

# 20. Deaktivierungs-Semantik

`active=false` bedeutet ausschließlich:

- nicht mehr für neue manuelle Zuweisungen auswählbar,
- nicht mehr in OpenAI-Allowlist,
- Kategorie-Regeln werden nicht mehr angewendet, weil `category-rules.ts` bereits `categories.active = 1` verlangt,
- Wochenbudget-Default wird für neu ausgewertete ungeklärte Zuweisungen nicht neu angewandt.

Nicht passieren darf:

- vorhandene `transactions.category_id` löschen,
- bestehende Kategorie-Regeln löschen,
- AI-Reviews löschen,
- Historie umschreiben.

Reaktivieren stellt dieselbe Kategorie-ID wieder zur Verfügung.

---

# 21. Warum kein DELETE-Endpoint

Kein:

```text
DELETE /categories/:id
```

implementieren.

Die Category-ID ist bereits referenziert von:

```text
transactions
category_rules
ai_categorization_reviews
```

Ein Hard Delete würde Historie verlieren oder Beziehungen über `ON DELETE SET NULL/CASCADE` verändern.

Für Yuvomi Banking ist `active` die korrekte Lifecycle-Semantik.

---

# 22. Bestehenden manuellen Assignment-Service härten

Datei:

```text
service/src/services/category-rules.ts
```

`assignManualTransactionCategory()` prüft bereits:

```text
SELECT id FROM categories WHERE id = ? AND active = 1
```

Das ist korrekt und bleibt erhalten.

Die neue Kategorieverwaltung darf diesen Guard nicht umgehen.

---

# 23. Wochenbudget-Kategorie-Endpoint härten

Der bestehende Endpoint

```text
PATCH /categories/:id/weekly-budget
```

muss über `updateCategory()` gehen.

Verbindliche Regel:

```text
weekly_budget_default=true
```

nur für:

```text
type = expense
```

Für `income` und `transfer`:

```text
400
```

Das Frontend verhindert den Zustand bereits visuell; Backend bleibt trotzdem autoritativ.

---

# 24. UI-Texte / Locales

Dateien:

```text
modules/banking/locales/de.json
modules/banking/locales/en.json
```

Mindestens folgende Keys ergänzen:

```text
categoriesTitle
categoriesDescription
categoryAdd
categoryEdit
categoryName
categoryType
categoryTypeExpense
categoryTypeIncome
categoryTypeTransfer
categoryWeeklyBudgetDefault
categoryActive
categoryInactive
categoryDeactivate
categoryReactivate
categoryCreate
categorySave
categoryCancel
categoryCreated
categoryUpdated
categoryDeactivated
categoryReactivated
categoryDuplicate
categoryInvalid
inactiveCategories
categoriesEmpty
categoriesEmptyHint
categoriesManage
categorizationNoCategoriesHint
```

Alle Fallback-Texte in `index.js` ebenfalls pflegen.

---

# 25. CSS

Datei:

```text
modules/banking/style.css
```

Neue Styles gezielt ergänzen:

```text
.banking-category-management
.banking-category-management__header
.banking-category-list
.banking-category-row
.banking-category-row__identity
.banking-category-row__meta
.banking-category-row__actions
.banking-category-type
.banking-category-dialog
.banking-category-dialog__form
```

Ziel:

- kompakt,
- bestehende Yuvomi Farben/Variablen nutzen,
- keine neue Farbe hart codieren, wenn ein Yuvomi CSS-Token existiert,
- auf Mobilgeräten Actions umbrechen,
- Dialog maximal etwa `32rem–36rem` breit,
- keine neue UI-Library.

---

# 26. Accessibility

Native `<dialog>` verwenden.

Pflicht:

- Dialogtitel über `aria-labelledby`,
- erstes Formularfeld beim Öffnen fokussieren,
- Escape schließt Dialog,
- Buttons sind echte `<button>`-Elemente,
- Type-Badge nicht als einzige Information über den Typ verwenden,
- disabled Wochenbudget-Checkbox für Income/Transfer mit erklärendem Text/Title,
- Confirm für `Deaktivieren` nur wenn nötig; Reaktivieren ohne Confirm.

---

# 27. API- und Security-Regeln

Für alle neuen Mutationen:

```text
resolveAuthorizedUser(..., 'write')
mutationIsAllowed(...)
```

Read-only Nutzer:

```text
GET /categories              erlaubt
POST /categories             verboten
PATCH /categories/:id        verboten
```

Keine Kategorie-API darf:

- Bankdaten lesen,
- Providercredentials liefern,
- Yuvomi-Core-DB öffnen.

Alle DB-Zugriffe ausschließlich auf `banking.db`.

---

# 28. Tests

Neue fokussierte Testdateien bevorzugen:

```text
service/test/categories.test.ts
service/test/category-routes.test.ts
```

Bestehende:

```text
service/test/category-suggestions.test.ts
service/test/category-rules.test.ts
```

gezielt erweitern.

## 28.1 Service-Tests

Mindestens:

1. Kategorie `Lebensmittel / expense` wird erstellt.
2. Name wird NFKC/Whitespace-normalisiert.
3. leerer Name wird abgelehnt.
4. >80 Zeichen wird abgelehnt.
5. unbekannter Typ wird abgelehnt.
6. Duplicate gleicher Name + Typ case-insensitive -> Conflict.
7. gleichnamige inaktive Kategorie -> Conflict statt stiller Reaktivierung.
8. Kategorie kann umbenannt werden.
9. Typ kann über Update nicht verändert werden.
10. Kategorie kann deaktiviert werden.
11. Kategorie kann reaktiviert werden.
12. Income/Transfer können nicht `weekly_budget_default=true` bekommen.
13. vorhandene Transaction-Referenz bleibt nach Deaktivierung unverändert.

## 28.2 Route-Tests

Mindestens:

1. read darf GET.
2. read darf POST nicht.
3. write ohne CSRF darf POST nicht.
4. write + CSRF kann POST.
5. ungültiger Request -> 400.
6. Duplicate -> 409.
7. fehlende ID -> 404.
8. PATCH active false/true funktioniert.
9. alter `/categories/:id/weekly-budget`-Endpoint funktioniert weiter.

## 28.3 KI-Bootstrap-Test

Wichtiger Regressionstest:

```text
DB enthält 0 Kategorien
+ mindestens einen ungelösten Umsatz
+ Fake Categorizer liefert:
  category_id = null
  suggested_category = Lebensmittel/expense

=> categorizeUnresolvedTransactions() wirft NICHT
=> category_suggestions enthält den Vorschlag
=> acceptCategorySuggestion() erzeugt die Kategorie
=> nächste Kategorisierung erhält sie in der Allowlist
```

Dieser Test beweist, dass eine frische Installation ohne manuelle SQL-Eingriffe startfähig ist.

---

# 29. Frontend-Verhalten nach CRUD

## Nach Create

```text
Dialog schließen
-> Kategorien neu laden
-> neue Kategorie in Management anzeigen
-> Transaction-Selects aktualisieren
-> Filter aktualisieren
-> Success-Feedback
```

## Nach Rename

Dasselbe; bestehende Umsätze zeigen automatisch den neuen Namen, weil sie dieselbe Category-ID referenzieren.

## Nach Deactivate

```text
Kategorie wandert nach "Inaktive Kategorien"
-> neue Zuweisung nicht mehr möglich
-> historische Zuordnung bleibt sichtbar
```

## Nach Reactivate

Kategorie erscheint wieder in aktiven Assignment-Selects und in der OpenAI-Allowlist.

---

# 30. Keine automatische Massen-Neukategorisierung

Beim Erstellen einer Kategorie **nicht automatisch alle Umsätze erneut durch OpenAI schicken**.

Die Kategorie wird lediglich verfügbar.

Danach kann der Benutzer explizit:

```text
Ungeklärte Umsätze analysieren
```

verwenden.

Lokale Counterparty-/Merchant-Regeln bleiben weiterhin vor AI priorisiert.

---

# 31. Keine automatisch erzeugten Starter-Kategorien in dieser Iteration

Es sollen nicht ungefragt Kategorien wie

```text
Lebensmittel
Mobilität
Freizeit
```

in die Datenbank geschrieben werden.

Gründe:

- Kategorien sind persönliche Finanz-Taxonomie,
- der Benutzer soll Kontrolle behalten,
- KI-Vorschläge können bei Bedarf einen sinnvollen Startpunkt erzeugen.

Ein späterer Onboarding-Button `Starter-Kategorien anlegen` kann separat geplant werden.

---

# 32. Dateien – konkrete Änderungsliste

## Neu

```text
service/src/services/categories.ts
service/src/api/category-routes.ts
service/test/categories.test.ts
service/test/category-routes.test.ts
```

## Ändern

```text
service/src/app.ts
service/src/api/weekly-budget-routes.ts
service/src/services/category-suggestions.ts
service/src/services/transaction-categorization.ts
service/src/openai/categorizer.ts
modules/banking/index.js
modules/banking/style.css
modules/banking/locales/de.json
modules/banking/locales/en.json
```

## Voraussichtlich nicht ändern

```text
service/migrations/*
```

Keine Migration für dieses Feature nötig.

---

# 33. Empfohlene Implementierungsreihenfolge für Copilot/Codex

## Schritt 1 – Service extrahieren

1. `categories.ts` erstellen.
2. Normalisierung/Validation zentralisieren.
3. `listCategories`, `createCategory`, `updateCategory` implementieren.
4. Unit-Tests schreiben.

Erst weitergehen, wenn diese Tests grün sind.

## Schritt 2 – REST API

1. `category-routes.ts` erstellen.
2. GET aus Weekly-Budget-Router verschieben.
3. POST + PATCH implementieren.
4. Legacy Weekly-Budget-PATCH delegieren.
5. Router in `app.ts` registrieren.
6. Route-Tests schreiben.

## Schritt 3 – AI Bootstrap

1. No-category-Guard entfernen.
2. OpenAI Instructions präzisieren.
3. AI-Bootstrap-Test ergänzen.
4. `category-suggestions.ts` auf gemeinsame Validatoren umstellen.

## Schritt 4 – Settings UI

1. alte reine Wochenbudget-Kategorieliste ersetzen.
2. Kategorie-Management rendern.
3. Create/Edit Dialog implementieren.
4. Activate/Deactivate implementieren.
5. Locales + CSS.

## Schritt 5 – Transaction UI härten

1. aktive/inaktive Assignment-Options korrekt darstellen.
2. Filter um inaktive historische Kategorien erweitern.
3. Kategorieänderungen ohne Page Reload propagieren.

## Schritt 6 – Regression

```text
npm test
npm run build
```

Danach Browser-Test mit leerer und befüllter DB.

---

# 34. Manuelle Acceptance Tests

## Szenario A – Frische DB

1. Keine Kategorie vorhanden.
2. Banking Settings öffnen.
3. `Kategorie hinzufügen` klicken.
4. `Lebensmittel`, Typ `Ausgabe`, Wochenbudget aktiv anlegen.
5. Hauptansicht öffnen.
6. Kategorie ist im Umsatz-Dropdown vorhanden.
7. Kategorie ist im Filter vorhanden.

## Szenario B – AI Bootstrap

1. Keine aktive Kategorie vorhanden.
2. Es gibt ungelöste Umsätze.
3. `Ungeklärte Umsätze analysieren` bleibt klickbar.
4. OpenAI liefert neue Vorschläge.
5. Vorschlag `Abonnements` akzeptieren.
6. Kategorie erscheint sofort in der UI.

## Szenario C – Deaktivieren

1. Umsatz hat Kategorie `Lebensmittel`.
2. Kategorie deaktivieren.
3. Umsatz behält sichtbar `Lebensmittel (inaktiv)`.
4. Kategorie kann keinem neuen Umsatz zugeordnet werden.
5. Filter kann weiterhin nach `Lebensmittel` filtern.
6. Kategorie reaktivieren.
7. Sie ist wieder normal auswählbar.

## Szenario D – Berechtigungen

1. `read`-Nutzer sieht Kategorien.
2. kein Add/Edit/Deactivate möglich.
3. `write`-Nutzer kann alle Management-Aktionen ausführen.

---

# 35. Definition of Done

Die Iteration ist erst fertig, wenn alle folgenden Punkte erfüllt sind:

- [ ] Kategorien können ohne SQL/AI manuell angelegt werden.
- [ ] Kategorie-Typ ist bei Erstellung auswählbar.
- [ ] Kategorie-Namen sind normalisiert und validiert.
- [ ] Duplikate werden deterministisch verhindert.
- [ ] Kategorien können umbenannt werden.
- [ ] Kategorien können deaktiviert und reaktiviert werden.
- [ ] Es existiert kein Hard Delete.
- [ ] Inaktive Kategorien bleiben an historischen Umsätzen sichtbar.
- [ ] Inaktive Kategorien sind nicht für neue Zuordnungen auswählbar.
- [ ] Historische Filter können inaktive Kategorien verwenden.
- [ ] Weekly-Budget-Default ist zentral über denselben Category-Service validiert.
- [ ] `expense|income|transfer` wird in UI lokalisiert dargestellt.
- [ ] KI-Kategorisierung funktioniert auch mit leerer Kategorie-Allowlist.
- [ ] KI-Vorschläge können weiterhin explizit Kategorien erzeugen.
- [ ] Kategorieänderungen erscheinen ohne vollständigen Page Reload in abhängigen Controls.
- [ ] `read` kann nur lesen, `write` mutieren.
- [ ] CSRF-Schutz gilt für alle neuen Mutationen.
- [ ] `npm test` ist grün.
- [ ] `npm run build` ist grün.
- [ ] keine Änderung an Yuvomi Core.
- [ ] keine neue DB-Migration ohne tatsächlichen Schema-Bedarf.

---

## Architektur-Kernaussage

Die Kategorieverwaltung soll nicht als Sonderlogik des Wochenbudgets weiterwachsen. Kategorien werden ab dieser Iteration als eigene Banking-Domäne behandelt:

```text
Category Service
      │
      ├── manuelle Verwaltung
      ├── Transaction Assignment
      ├── Weekly Budget Defaults
      └── AI Suggestions
```

Damit gibt es genau eine zentrale Definition dafür, wie ein Kategoriename validiert wird, welche Typen zulässig sind und wie der Lifecycle `aktiv -> inaktiv -> aktiv` funktioniert. Das ist die notwendige Grundlage, bevor echte Bankdaten dauerhaft mit Kategorien und Regeln verknüpft werden.
