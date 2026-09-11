# Wochenbudget: aktuelle Budgetwoche bei Aktivierung korrekt berücksichtigen

Stand der Analyse: `c59fb145b9f5ff5af36599b0702d73f1d68af599` (`main`).

Dieses Dokument beschreibt die konkrete Korrektur für den Fall, dass das Wochenbudget mitten in einer bereits laufenden Budgetwoche aktiviert wird und Ausgaben vom Beginn dieser Woche deshalb aktuell nicht in die Direktausgaben einfließen.

Das beobachtete Beispiel ist:

```text
Aktuelles Datum:               11.09.2026
Nächster Stichtag:             17.09.2026 08:00
Nominaler Wochenbeginn:        10.09.2026
Bargeld-Umsatz Hauptkonto:     10.09.2026, -40,00 EUR
Kategorie:                     Bargeld
Kategorie gehört zum Budget:   ja
Budget-Konto Saldo:            45,42 EUR
Wochenziel:                    450,00 EUR
```

Erwartete Rechnung:

```text
450,00 EUR Wochenziel
- 40,00 EUR Direktausgaben Hauptkonto
- 45,42 EUR bereits auf Budget-Konto
= 364,58 EUR Auffüllbetrag
```

Aktuell erscheint dagegen sinngemäß:

```text
Direktausgaben Hauptkonto: 0,00 EUR
Auffüllbetrag:            404,58 EUR
```

Die Ursache liegt in der Aktivierungslogik des Wochenbudgets, nicht in der mathematischen Berechnung selbst.

---

## 1. Root Cause

### 1.1 Aktuelle Speicherung von `effective_from_date`

In `service/src/api/weekly-budget-routes.ts` wird beim erstmaligen Aktivieren bzw. Reaktivieren aktuell sinngemäß gesetzt:

```ts
const activationChanged = !existing || (!existing.enabled && input.enabled);
const effectiveFromDate = activationChanged
  ? localDateForInstant(now, input.timezone)
  : existing.effective_from_date;
```

Damit wird bei einer Aktivierung am 11.09.2026 gespeichert:

```text
effective_from_date = 2026-09-11
```

### 1.2 `weeklyBudgetWindow()` schneidet die erste Periode dadurch ab

`service/src/services/weekly-budget-schedule.ts` bestimmt zunächst den nominellen Beginn der laufenden Budgetwoche:

```text
nextCutoffDate   = 2026-09-17
nominalStartDate = 2026-09-10
```

Anschließend gilt aber:

```ts
const periodStartDate = effectiveFromDate && effectiveFromDate > nominalStartDate
  ? effectiveFromDate
  : nominalStartDate;
```

Mit dem gespeicherten `effective_from_date = 2026-09-11` wird daraus:

```text
periodStartDate = 2026-09-11
```

Der 40-EUR-Umsatz vom 10.09. liegt damit außerhalb der berechneten ersten Periode.

### 1.3 Der Umsatz wird bereits im SQL ausgeschlossen

`collectWeeklyBudgetDirectExpenses()` in
`service/src/services/weekly-budget-overview.ts` lädt nur Transaktionen mit:

```sql
transaction_date >= periodStartDate
AND transaction_date < periodEndDate
```

Der Umsatz vom 10.09. erreicht dadurch `evaluateDirectExpense()` überhaupt nicht mehr.

Die Kategorie `Bargeld` kann also korrekt `weekly_budget_default = 1` besitzen und der Umsatz kann korrekt `BOOK`, `outgoing` und EUR sein; er wird trotzdem nicht gezählt, weil das Zeitfenster vorher bereits auf den 11.09. gekürzt wurde.

---

# 2. Gewünschte fachliche Semantik

Bei Aktivierung eines Wochenbudgets soll die **gesamte aktuell laufende Budgetperiode** berücksichtigt werden.

Das bedeutet:

> `effective_from_date` ist bei einer Aktivierung nicht das Aktivierungsdatum, sondern der nominelle Beginn der Budgetperiode, in der die Aktivierung stattfindet.

Beispiel:

```text
Aktivierung:        Freitag, 11.09.2026
Stichtag:           Donnerstag, 17.09.2026 08:00
Budgetwoche:        10.09.2026 bis exklusiv 17.09.2026

effective_from_date = 2026-09-10
```

Dadurch werden alle seit Beginn dieser Woche bereits gebuchten relevanten Hauptkonto-Ausgaben korrekt in die erste Auffüllberechnung einbezogen.

Diese Semantik soll sowohl gelten für:

1. eine komplett neue Wochenbudget-Konfiguration,
2. eine Reaktivierung einer zuvor deaktivierten Konfiguration.

Bei normalen Änderungen an einer bereits aktiven Konfiguration darf `effective_from_date` **nicht** neu gesetzt werden.

---

# 3. Backend-Änderung in `weekly-budget-routes.ts`

Datei:

```text
service/src/api/weekly-budget-routes.ts
```

Die bestehende Aktivierungslogik muss von `localDateForInstant(now, timezone)` auf den Beginn des aktuellen nominalen Wochenfensters umgestellt werden.

## 3.1 Bestehende Logik ersetzen

Aktuell sinngemäß:

```ts
const activationChanged = !existing || (!existing.enabled && input.enabled);
const effectiveFromDate = activationChanged
  ? localDateForInstant(now, input.timezone)
  : existing.effective_from_date;
```

Neu:

```ts
const activationChanged = !existing || (!existing.enabled && input.enabled);

const activationWindow = activationChanged
  ? weeklyBudgetWindow({
      now,
      cutoffWeekday: input.cutoffWeekday,
      cutoffTime: input.cutoffTime,
      timezone: input.timezone
    })
  : null;

const effectiveFromDate = activationChanged
  ? activationWindow!.periodStartDate
  : existing.effective_from_date;
```

`weeklyBudgetWindow` ist in dieser Datei bereits importiert und kann wiederverwendet werden.

## 3.2 `effective_from_at`

`effective_from_at` soll weiterhin den tatsächlichen Aktivierungszeitpunkt speichern:

```text
effective_from_date = Beginn der Budgetwoche
effective_from_at   = tatsächlicher Aktivierungszeitpunkt
```

Beispiel:

```text
effective_from_date = 2026-09-10
effective_from_at   = 2026-09-11T21:00:00.000Z
```

Das ist absichtlich unterschiedlich.

`effective_from_date` bestimmt den fachlichen Zeitraum für Wochenbudget-Umsätze.
`effective_from_at` bleibt Audit-/Lifecycle-Metadatum.

Nicht versuchen, beide Werte identisch zu halten.

---

# 4. Keine Änderung an der eigentlichen Budgetformel

`calculateWeeklyBudgetTransfer()` in
`service/src/services/weekly-budget.ts` soll unverändert bleiben.

Die Formel ist korrekt:

```text
transfer = Wochenziel - Direktausgaben - Budgetkonto-Saldo
```

Der Fehler entsteht ausschließlich dadurch, dass relevante Direktausgaben vor der Berechnung nicht gesammelt werden.

Auch `evaluateDirectExpense()` soll in dieser Iteration fachlich nicht verändert werden.

---

# 5. Bestehende Sicherheits- und Ausschlussregeln beibehalten

Ein Hauptkonto-Umsatz darf weiterhin nur berücksichtigt werden, wenn alle bestehenden Bedingungen erfüllt sind:

```text
account == source_account_id
direction == outgoing
status == BOOK
currency == EUR
kein interner Transfer
kein bereits erkannter Auffülltransfer
Wochenbudget-Entscheidung == included
Datum innerhalb der Budgetperiode
```

Die Entscheidung `included` bleibt weiterhin:

1. expliziter Transaction-Override `include`, oder
2. Kategorie hat `weekly_budget_default = true`.

Das Fix darf diese Regeln nicht lockern.

Insbesondere darf **nicht** einfach jede Belastung des Hauptkontos vom Wochenbudget abgezogen werden.

---

# 6. UI transparenter machen

Der aktuelle Wochenbudget-Block zeigt zwar den Betrag der Direktausgaben und die Anzahl berücksichtigter Umsätze, aber nicht klar genug, **welcher Zeitraum gerade ausgewertet wird**.

Datei:

```text
modules/banking/index.js
```

In `renderWeeklyBudget()` beim Summary-Card für die Direktausgaben soll der Zeitraum zusätzlich sichtbar werden.

Aktuell sinngemäß:

```text
KEVIN KRONE JACQUELINE KRONE · 0 berücksichtigte Umsätze
```

Ziel:

```text
KEVIN KRONE JACQUELINE KRONE
1 berücksichtigter Umsatz · 10.09.–16.09.
```

oder bei mehreren:

```text
3 berücksichtigte Umsätze · 10.09.–16.09.
```

Die API liefert bereits:

```text
current.period.start_date
current.period.end_date
```

Dabei ist `end_date` technisch exklusiv. Für die UI muss daher der sichtbare letzte Tag einen Kalendertag davor liegen.

Beispiel:

```text
start_date = 2026-09-10
end_date   = 2026-09-17

Anzeige:
10.09.–16.09.
```

## 6.1 Helper für sichtbaren Zeitraum

In `modules/banking/index.js` einen kleinen Helper ergänzen, z. B.:

```text
formatInclusiveDateRange(startDate, exclusiveEndDate)
```

Anforderungen:

- ISO-Datumswerte validieren,
- `exclusiveEndDate - 1 Kalendertag`,
- mit bestehender lokalisierter Datumsformatierung anzeigen,
- bei ungültigen Daten nur den bisherigen Text zeigen statt einen Fehler zu werfen.

Keine Zeitzonenberechnung über UTC-Mitternacht verwenden, die das Datum in bestimmten Locales verschieben könnte. Am besten ISO-Kalenderdatum explizit als Kalenderdatum behandeln.

---

# 7. Optional, aber empfohlen: nachvollziehbare Direktausgaben direkt erreichbar machen

`buildCurrentWeeklyBudgetOverview()` liefert bereits:

```json
{
  "direct_expenses": [
    {
      "transaction_id": 123,
      "booking_date": "2026-09-10",
      "amount_cents": 4000,
      "category_name": "Bargeld",
      "decision_source": "category_default"
    }
  ]
}
```

Diese Information soll nicht in einer neuen Datenbankstruktur dupliziert werden.

Empfehlung für den bestehenden Wochenbudget-Bereich:

```text
Direktausgaben über das Hauptkonto
40,00 EUR
1 berücksichtigter Umsatz · 10.09.–16.09.
[Anzeigen]
```

Beim Klick auf `Anzeigen` kann eine kleine einklappbare Liste erscheinen:

```text
10.09.  Bargeld                   40,00 EUR
         Kategorie: Bargeld
         Grund: Kategorie gehört zum Wochenbudget
```

Dabei sollte `decision_source` für Benutzer übersetzt werden:

```text
category_default      -> Kategorie gehört zum Wochenbudget
transaction_override  -> Umsatz explizit einbezogen
```

Das ist keine Voraussetzung für den Bugfix, erhöht aber die Transparenz erheblich und verhindert künftig die Frage „warum ist dieser Umsatz drin bzw. nicht drin?".

Nicht versuchen, ausgeschlossene Umsätze in dieser ersten UI ebenfalls vollständig aufzulisten. Dafür wäre später eine eigene Diagnoseansicht sinnvoll.

---

# 8. Bestehende Konfigurationen

Der Code-Fix verändert bereits gespeicherte `effective_from_date`-Werte bewusst **nicht automatisch**.

Grund:

- eine globale Migration könnte historische Budgetperioden rückwirkend verändern,
- wir können bei bestehenden Installationen nicht sicher wissen, ob ein gekürzter erster Zeitraum bewusst so gewollt war,
- historische Transfer-Suggestions dürfen nicht stillschweigend neu interpretiert werden.

## 8.1 Aktuelle lokale Entwicklungsinstallation reparieren

Nach Implementierung des Fixes:

1. Wochenbudget in den Einstellungen deaktivieren.
2. Speichern.
3. Wochenbudget wieder aktivieren.
4. Speichern.

Durch den Übergang

```text
disabled -> enabled
```

ist `activationChanged = true` und die neue Logik schreibt den Beginn der aktuell laufenden Budgetwoche.

Für das konkrete Beispiel muss danach gelten:

```text
effective_from_date = 2026-09-10
```

Nicht die SQLite-Datenbank manuell bearbeiten, solange der normale Konfigurationsflow die Korrektur durchführen kann.

---

# 9. Tests

Die Änderung darf nicht ohne Regressionstests umgesetzt werden.

## 9.1 Route-Test: neue Konfiguration mitten in der Woche

In den Tests für `weekly-budget-routes.ts` bzw. dem vorhandenen passenden API-Testfixture:

```text
now             = 2026-09-11
cutoff_weekday  = Donnerstag
cutoff_time     = 08:00
Europe/Berlin
```

Erwartung nach erstmaligem Aktivieren:

```text
effective_from_date = 2026-09-10
```

Nicht:

```text
2026-09-11
```

## 9.2 Route-Test: Reaktivierung

Ausgang:

```text
existing.enabled = false
```

Reaktivierung am 11.09. mit Stichtag 17.09.

Erwartung:

```text
effective_from_date = 2026-09-10
```

## 9.3 Route-Test: normale Bearbeitung einer aktiven Konfiguration

Ausgang:

```text
existing.enabled = true
existing.effective_from_date = 2026-09-03
```

Nur z. B. Zielbetrag ändern.

Erwartung:

```text
effective_from_date bleibt 2026-09-03
```

Keine ungewollte Perioden-Neuinitialisierung.

## 9.4 Integrationstest für den konkreten Umsatzfall

Fixture:

```text
Hauptkonto = Account A
Budget-Konto = Account B
Wochenziel = 45000 Cent
Budget-Konto-Saldo = 4542 Cent
Periode = 2026-09-10 bis exklusiv 2026-09-17
```

Transaktion:

```text
Account A
booking_date = 2026-09-10
amount_cents = -4000 oder gemäß bestehender Import-Signkonvention
currency = EUR
direction = outgoing
status = BOOK
Kategorie = Bargeld
weekly_budget_default = 1
weekly_budget_override = inherit
```

Erwartung:

```text
direct_expense_cents = 4000
available_to_spend_cents = 4542
provisional_calculation.transfer_amount_cents = 36458
```

und:

```text
direct_expenses.length = 1
```

## 9.5 Negativtest Kategorie nicht im Wochenbudget

Gleicher Umsatz, aber:

```text
weekly_budget_default = 0
weekly_budget_override = inherit
```

Erwartung:

```text
direct_expense_cents = 0
```

Damit wird verhindert, dass der Fix versehentlich alle Hauptkonto-Ausgaben berücksichtigt.

## 9.6 Override-Test

Kategorie nicht im Wochenbudget:

```text
weekly_budget_default = 0
```

aber:

```text
weekly_budget_override = include
```

Erwartung:

```text
40,00 EUR werden berücksichtigt
```

Analog muss `exclude` einen eigentlich per Kategorie enthaltenen Umsatz ausschließen.

---

# 10. UI-Tests / Acceptance Criteria

Nach Umsetzung muss lokal folgendes geprüft werden:

## Fall A – konkrete aktuelle Situation

1. Wochenbudget auf Hauptkonto und Budget-Konto konfigurieren.
2. Stichtag so setzen, dass die laufende Periode am 10.09. beginnt.
3. Wochenbudget aktivieren.
4. Hauptkonto enthält gebuchten Umsatz vom 10.09. über 40 EUR.
5. Kategorie `Bargeld` hat `weekly_budget_default=true`.
6. Budget-Konto hat 45,42 EUR verfügbaren Saldo.
7. `Neu laden`.

Erwartete UI:

```text
Im Budget-Konto verfügbar          45,42 EUR
Direktausgaben über Hauptkonto     40,00 EUR
Aktuelle Auffüllberechnung        364,58 EUR
```

Zusätzlich soll unter Direktausgaben sinngemäß stehen:

```text
1 berücksichtigter Umsatz · 10.09.–16.09.
```

## Fall B – nicht relevante Kategorie

Wird derselbe Umsatz einer Kategorie zugeordnet, die nicht zum Wochenbudget gehört, muss nach Reload wieder gelten:

```text
Direktausgaben = 0,00 EUR
Auffüllbetrag = 404,58 EUR
```

## Fall C – explizites Include

Transaction-Override auf `include` setzen.

Auch wenn die Kategorie nicht standardmäßig zum Wochenbudget gehört, muss der Umsatz wieder eingerechnet werden.

---

# 11. Betroffene Dateien

Verbindlich prüfen/ändern:

```text
service/src/api/weekly-budget-routes.ts
modules/banking/index.js
modules/banking/locales/de.json
modules/banking/locales/en.json
```

Tests je nach bestehender Struktur insbesondere unter:

```text
service/test/
```

Bereits bestehende Fachlogik prüfen, aber möglichst nicht ändern:

```text
service/src/services/weekly-budget-schedule.ts
service/src/services/weekly-budget-overview.ts
service/src/services/weekly-budget.ts
```

Nur wenn ein Test eine echte Inkonsistenz in diesen Services nachweist, dort Änderungen vornehmen.

---

# 12. Keine Migration erforderlich

Für diesen Fix ist keine neue SQLite-Migration notwendig.

Es werden keine neuen Felder benötigt.

Die vorhandenen Felder:

```text
effective_from_date
effective_from_at
```

reichen aus.

Historische Konfigurationen werden nicht automatisch umgeschrieben.

---

# 13. Implementierungsreihenfolge für Codex

Codex soll die Änderung in dieser Reihenfolge umsetzen:

1. aktuellen Stand und bestehende Weekly-Budget-Tests lesen,
2. Regressionstest für Aktivierung mitten in einer Budgetwoche schreiben,
3. Aktivierungslogik in `weekly-budget-routes.ts` auf `weeklyBudgetWindow(...).periodStartDate` umstellen,
4. Reaktivierungs- und „aktive Konfiguration bearbeiten"-Tests ergänzen,
5. konkreten 40-EUR-Integrationstest für `buildCurrentWeeklyBudgetOverview()` ergänzen,
6. UI um sichtbaren Periodenzeitraum erweitern,
7. falls ohne großen Umbau möglich: Direktausgaben einklappbar im Weekly-Budget-Bereich anzeigen,
8. deutsche und englische Locale-Einträge ergänzen,
9. `npm test` ausführen,
10. `npm run build` ausführen,
11. keine bestehenden Migrationen ändern,
12. keine bestehenden historischen Weekly-Budget-Perioden oder Transfer-Suggestions automatisch neu berechnen.

---

# 14. Definition of Done

Die Änderung ist fertig, wenn:

- Aktivierung mitten in der Woche die gesamte laufende Budgetwoche berücksichtigt,
- der Bargeld-Umsatz vom ersten Tag der Woche in der Beispielkonstellation in die 40 EUR Direktausgaben einfließt,
- daraus 364,58 EUR statt 404,58 EUR Auffüllbetrag berechnet werden,
- normale Änderungen einer bereits aktiven Konfiguration den Periodenbeginn nicht verschieben,
- Deaktivieren/Reaktivieren die aktuelle Periode sauber neu startet,
- Kategorie-Default und Transaction-Override weiterhin korrekt wirken,
- die UI den ausgewerteten Zeitraum sichtbar macht,
- alle Tests und der TypeScript-Build erfolgreich sind.
