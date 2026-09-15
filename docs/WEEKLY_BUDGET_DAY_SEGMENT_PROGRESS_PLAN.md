# Plan: Tageszeitbasierter Füllstand im Wochenbudget-Widget

## Ziel

Im Dashboard-Widget `Wochenbudget` soll in der unteren Wochen-Zeitachse das Segment des **aktuellen Kalendertages nur anteilig** gefüllt sein.

Der Füllstand richtet sich ausschließlich nach der **lokalen Tagesuhrzeit in der für das Wochenbudget konfigurierten Zeitzone** und ausdrücklich **nicht** danach, wann die Budgetwoche bzw. der Cutoff begonnen hat.

Beispiel für `Europe/Berlin`:

- 00:00 Uhr → 0 % des aktuellen Tagessegments
- 06:00 Uhr → 25 %
- 07:00 Uhr → `7 / 24 = 29,17 %` (visuell ungefähr ein Viertel)
- 12:00 Uhr → 50 %
- 18:00 Uhr → 75 %
- kurz vor 24:00 Uhr → nahezu 100 %

Wenn die Budgetwoche heute um 06:00 Uhr gestartet ist, darf 07:00 Uhr daher **nicht** als `1 Stunde seit Wochenbeginn = ca. 4 %` interpretiert werden. Das Segment muss bei ca. 29 % liegen, weil die tatsächliche Uhrzeit 07:00 Uhr ist.

## Ist-Analyse

Die relevante Darstellung ist bereits vollständig im Frontend des Banking-Moduls gekapselt:

- `modules/banking/widgets/weekly-budget.js`
- `modules/banking/widgets/weekly-budget.css`
- Frontend-Vertragstests in `service/test/weekly-budget-frontend.test.ts`

Der Backend-Endpunkt `/api/extensions/banking/weekly-budget/current` liefert bereits die benötigten Informationen. Das Widget verwendet insbesondere:

- `current.period.end_date`
- `current.settings.timezone`
- `Date.now()`

Damit ist **keine Backend-, Datenbank- oder API-Erweiterung erforderlich**.

### Ursache des aktuellen Verhaltens

`buildBudgetWeekSegments(...)` liefert pro Tag momentan nur:

- `date`
- `label`
- `state = past | current | future`

`renderWeekProgress(...)` setzt diesen Zustand als `data-state` auf das Segment.

In `weekly-budget.css` wird ein Segment mit `data-state="current"` anschließend genau wie ein vollständig vergangener Tag mit einer komplett gefüllten violetten Fläche dargestellt. Eine Information darüber, wie weit der aktuelle Kalendertag fortgeschritten ist, existiert derzeit nicht.

## Zielmodell

Jedes von `buildBudgetWeekSegments(...)` erzeugte Segment erhält zusätzlich einen numerischen Fortschritt:

```text
progress: 0.0 .. 1.0
```

Semantik:

- vergangener Tag: `1`
- aktueller Tag: Anteil der lokalen Tagesuhrzeit an 24 Stunden
- zukünftiger Tag: `0`

Für den aktuellen Tag gilt dabei sinngemäß:

```text
(hour * 3600 + minute * 60 + second) / 86400
```

Die Werte `cutoff_time`, `next_cutoff_at` oder der Zeitpunkt des Budgetwochenstarts dürfen in diese Berechnung **nicht** einfließen.

Die Berechnung soll bewusst eine **Wall-Clock-Berechnung** sein. Die Anzeige beantwortet die Frage „Wie weit ist der aktuelle Kalendertag laut Uhr fortgeschritten?“ und nicht „Wie viele echte Millisekunden sind seit Tages- oder Budgetbeginn vergangen?“.

## Konkret anzupassende Dateien

### 1. `modules/banking/widgets/weekly-budget.js`

#### A. Reine Hilfsfunktion für den lokalen Tagesfortschritt ergänzen

Eine kleine exportierte Pure Function ergänzen, z. B.:

```text
calculateLocalDayProgress(now, timezone)
```

Aufgaben der Funktion:

1. `now` wie die bestehenden Hilfsfunktionen als `Date`, Timestamp oder Standard `Date.now()` behandeln.
2. Mit `Intl.DateTimeFormat(..., { timeZone: timezone, hourCycle: 'h23', hour, minute, second })` die lokale Uhrzeit in der Budget-Zeitzone ermitteln.
3. Aus Stunde, Minute und Sekunde einen Wert zwischen `0` und `1` berechnen.
4. Ergebnis defensiv auf `0..1` clampen.
5. Bei einer unerwartet ungültigen Zeitzone konsistent und ohne Exception auf eine sichere UTC-basierte Berechnung zurückfallen. In der normalen Anwendung ist die Zeitzone bereits serverseitig validiert.

Wichtig: Die Funktion darf **keinen** Budget-Cutoff kennen.

#### B. `buildBudgetWeekSegments(...)` erweitern

Die Funktion berechnet den aktuellen Tagesfortschritt einmal pro Aufruf und ergänzt jedes Segment um `progress`:

- `past` → `progress: 1`
- `current` → `progress: calculateLocalDayProgress(now, timezone)`
- `future` → `progress: 0`

Die bestehende Logik für:

- Wochenstart aus `periodEndDate - 7 Tage`
- Tageslabels
- `past/current/future`
- Zeitzonenbestimmung des heutigen Datums

bleibt unverändert.

Damit bleibt die Budgetwoche weiterhin fachlich durch `period.end_date` definiert; lediglich der **visuelle Füllstand des aktuellen Kalendertags** wird feiner.

#### C. `renderWeekProgress(...)` um den Segment-Füllgrad ergänzen

Beim Erzeugen jedes `.banking-weekly-widget__week-segment` den berechneten Fortschritt als CSS Custom Property setzen, beispielsweise:

```text
--week-segment-progress: 29.17%
```

Der Wert wird aus `segment.progress * 100` abgeleitet und vor Ausgabe ebenfalls auf `0..100` begrenzt.

Es ist keine zusätzliche API-Abfrage notwendig.

#### D. Accessibility konsistent machen

Der sichtbare Text `1 von 7 Tagen` soll weiterhin die aktuelle Tagesposition innerhalb der Budgetwoche ausdrücken und deshalb nicht zu einer Dezimalanzeige werden.

Für `weekProgress[role="progressbar"]` soll `aria-valuenow` dagegen den echten visuellen Wochenfortschritt widerspiegeln:

```text
Summe aller segment.progress-Werte
```

Beispiel am ersten Budgettag um 07:00 Uhr:

- sichtbarer Text: `1 von 7 Tagen`
- `aria-valuenow`: ca. `0.2917`
- `aria-valuemax`: `7`

Dafür die bisher gemeinsam verwendete Variable `completedDays` logisch aufteilen:

- Tagesposition für den Text
- tatsächlich verstrichene Tagesanteile für ARIA

#### E. Kein eigener Live-Timer in dieser Änderung

Der Fortschritt wird bei jedem Rendern/Aktualisieren des Widgets aus `Date.now()` neu berechnet.

Es soll in dieser Änderung bewusst **kein `setInterval`/`setTimeout`** eingeführt werden, weil der vorhandene Widget-Vertrag keinen expliziten Cleanup-Hook zeigt und dadurch bei Re-Renders Timer-Leaks entstehen könnten.

Falls später eine kontinuierliche Minute-für-Minute-Aktualisierung gewünscht ist, sollte das separat und mit sauberem Widget-Lifecycle umgesetzt werden.

---

### 2. `modules/banking/widgets/weekly-budget.css`

Die aktuelle CSS-Regel für `data-state="current"` füllt das komplette Segment. Diese Darstellung wird in Track + Fill getrennt.

#### A. Segment als neutralen Track behandeln

`.banking-weekly-widget__week-segment` erhält zusätzlich:

- `position: relative`
- `overflow: hidden`
- weiterhin den neutralen Hintergrund, Border und Radius

#### B. Füllfläche über ein Pseudo-Element darstellen

Für `.banking-weekly-widget__week-segment::before`:

- absolut links im Segment positionieren
- volle Höhe
- Breite über `var(--week-segment-progress, 0%)`
- bestehende violette Verlaufsoptik verwenden
- Radius des Tracks übernehmen

Damit können alle drei Zustände denselben Renderpfad verwenden:

- Vergangenheit: 100 %
- Heute: z. B. 29,17 %
- Zukunft: 0 %

#### C. Zustandsregeln beibehalten, aber nicht mehr vollflächig färben

Die bestehenden Regeln für `data-state="past"` und `data-state="current"` dürfen weiterhin:

- Border-Farbe
- Glow/Box-Shadow

steuern.

Sie dürfen aber nicht mehr selbst den kompletten Track mit dem violetten Gradient überschreiben, weil sonst der partielle Füllstand wieder unsichtbar würde.

Die Hervorhebung des aktuellen Tageslabels bleibt unverändert.

Eine kurze `width`-Transition für das Fill ist optional, solange `prefers-reduced-motion` weiterhin respektiert wird. Für diese Änderung ist eine Animation nicht erforderlich.

---

### 3. `service/test/weekly-budget-frontend.test.ts`

Die vorhandenen Widget-Vertragstests werden gezielt erweitert.

#### A. Rückgabetyp von `buildBudgetWeekSegments(...)` erweitern

Im Test-Typ das neue Feld ergänzen:

```text
progress: number
```

#### B. Deterministische Tests für den Tagesfortschritt

Für `Europe/Berlin` feste Zeitpunkte verwenden, damit die Tests unabhängig von der lokalen Zeitzone des CI-Runners bleiben.

Mindestens prüfen:

- 00:00 lokal → `0`
- 06:00 lokal → `0.25`
- 07:00 lokal → `7 / 24`
- 12:00 lokal → `0.5`
- 18:00 lokal → `0.75`

Besonders wichtig ist der Regressionstest für das gewünschte Szenario:

```text
Budgettag: 2026-09-15
Budget-Cutoff: fachlich 06:00 Uhr
Testzeit: 2026-09-15 07:00 Europe/Berlin
Erwarteter Segmentfortschritt: 7 / 24 ≈ 0.2917
```

Der Test muss damit dokumentieren, dass nicht `1 / 24` verwendet wird.

Da `buildBudgetWeekSegments(...)` bewusst keinen Cutoff als Parameter erhält, wird zugleich verhindert, dass die Darstellungslogik versehentlich an die Budget-Cutoff-Zeit gekoppelt wird.

#### C. Zustände und Fortschritt gemeinsam testen

Für eine Woche mit aktuellem Tag in der Mitte prüfen:

- alle `past`-Segmente haben `progress === 1`
- genau das `current`-Segment hat den erwarteten Tageszeitwert
- alle `future`-Segmente haben `progress === 0`
- bestehende Tageslabels bleiben unverändert

#### D. CSS-Vertrag erweitern

Im bestehenden CSS-Source-Test zusätzlich prüfen, dass:

- `--week-segment-progress` verwendet wird
- ein Fill/Pseudo-Element für `.banking-weekly-widget__week-segment` existiert
- die aktuelle Tagesregel nicht mehr den kompletten Track unabhängig vom Fortschritt füllt

Die bestehenden Tests für `data-state="past"` und `data-state="current"` bleiben bestehen.

## Nicht anzupassende Dateien

Für diese Änderung sind ausdrücklich **keine** Änderungen notwendig an:

- `service/src/api/weekly-budget-routes.ts`
- `service/src/services/weekly-budget-overview.ts`
- `service/src/services/weekly-budget-schedule.ts`
- Datenbankmigrationen
- `modules/banking/index.js`
- Locale-Dateien

Begründung: `period.end_date`, `settings.timezone` und die Client-Uhrzeit reichen bereits vollständig für die Darstellung aus.

## Akzeptanzkriterien

1. Am aktuellen Tag ist nur ein Teil des Tagessegments violett gefüllt.
2. Um 07:00 Uhr lokaler Budget-Zeitzone beträgt der Füllstand ca. 29,17 %.
3. Ein Budgetwochenstart/Cutoff um 06:00 Uhr verändert diesen Wert nicht.
4. Vergangene Tagessegmente bleiben zu 100 % gefüllt.
5. Zukünftige Tagessegmente bleiben leer.
6. `1 von 7 Tagen` bleibt am ersten Budgettag erhalten.
7. Die Tageslabels und die bestehende `past/current/future`-Markierung ändern sich nicht.
8. Die Darstellung funktioniert identisch auf Desktop und Smartphone, da ausschließlich die bestehende responsive Segmentleiste erweitert wird.
9. Keine Backend-, API- oder Datenbankänderung.
10. Keine zusätzlichen Netzwerkrequests und kein Timer-Lifecycle.

## Verifikation nach der späteren Implementierung

Im Verzeichnis `service`:

```text
npm test
```

Zusätzlich manuell im Dashboard prüfen:

- erster Budgettag unmittelbar nach 06:00 Uhr: Segment bereits ungefähr zu einem Viertel gefüllt
- gegen 07:00 Uhr: ungefähr 29 %
- gegen Mittag: ungefähr halb gefüllt
- Smartphone-Breite: partielle Füllung bleibt innerhalb des aktuellen Segments und verschiebt weder Labels noch Segmentabstände

## Geplanter Implementierungsumfang

Die spätere Implementierung soll auf genau diese drei Dateien beschränkt bleiben:

1. `modules/banking/widgets/weekly-budget.js`
2. `modules/banking/widgets/weekly-budget.css`
3. `service/test/weekly-budget-frontend.test.ts`

Weitere Dateien nur dann anfassen, wenn die Implementierung einen durch Tests belegten, heute nicht sichtbaren Vertrag erfordert. Nach aktueller Analyse ist das nicht notwendig.
