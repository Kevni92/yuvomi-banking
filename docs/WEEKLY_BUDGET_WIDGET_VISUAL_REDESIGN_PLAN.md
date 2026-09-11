# Wochenbudget-Widget: visueller Redesign-Umsetzungsplan

## Ziel

Das bereits vorhandene Wochenbudget-Widget auf der Yuvomi-Startseite soll von der aktuell sehr textnahen Darstellung in eine klar strukturierte Dashboard-Kachel umgebaut werden.

Das gewünschte Ergebnis ist:

```text
Wochenbudget

       45,42 €

  ████████████░░

      noch 6 Tage
```

Die visuelle Hierarchie ist verbindlich:

1. Titel oben
2. verfügbarer Geldbetrag sehr groß, fett und horizontal zentriert
3. direkt darunter ein horizontaler Fortschritts-/Countdown-Balken
4. darunter die zentrierte Zeitangabe `noch X Tage`

Der Betrag ist das dominante Element. Zusätzliche Kennzahlen wie Auffüllbetrag oder Direktausgaben gehören nicht in dieses Widget.

## Aktueller Stand

Stand bei Erstellung dieses Plans: `837a628c5753f90ba3f8eda903cc431f6a55899d` (`feat: surface weekly budget on dashboard`).

Das Widget existiert bereits unter:

- `modules/banking/widgets/weekly-budget.js`
- Styles in `modules/banking/style.css`
- Registrierung in `modules/banking/module.json`
- Tests in `service/test/weekly-budget-frontend.test.ts`

Bereits vorhanden und beizubehalten:

- Abruf über `GET /api/extensions/banking/weekly-budget/current`
- Anzeige von `available_to_spend_cents`
- Countdown anhand von `period.next_cutoff_at`
- `noch heute`, `noch 1 Tag`, `noch X Tage`
- Klick auf die Kachel öffnet `/m/banking`
- `defaultVisible: true`
- Fallbacks für nicht eingerichtet, deaktiviert und API-Fehler

Für diesen Redesign-Schritt ist keine neue Backend-Route erforderlich.

## Problem der aktuellen Darstellung

Die aktuelle DOM-Struktur hängt Titel, Betrag und Restzeit als einfache aufeinanderfolgende Grid-Elemente in `.banking-weekly-widget` ein. Die CSS-Regeln sind auf `align-content: start` ausgelegt und der Betrag ist mit `1.65rem` zu klein.

Dadurch wirkt die Kachel wie normaler Fließtext statt wie ein Dashboard-KPI. Besonders auf der aktuellen `1x2`-Kachel ist sehr viel freie Fläche vorhanden, während die eigentliche Hauptinformation visuell kaum Gewicht erhält.

Der Redesign soll diese Fläche bewusst nutzen und Titel und KPI-Inhalt klar voneinander trennen.

---

# 1. Ziel-DOM-Struktur

## Datei

`modules/banking/widgets/weekly-budget.js`

Die Kachel bleibt als gesamter `<a>`-Wrapper klickbar. Der Inhalt wird aber in einen Titelbereich und einen zentrierten KPI-Bereich getrennt.

Zielstruktur:

```html
<a class="banking-weekly-widget" href="/m/banking" data-route="/m/banking">
  <strong class="banking-weekly-widget__title">Wochenbudget</strong>

  <div class="banking-weekly-widget__content">
    <strong class="banking-weekly-widget__amount">45,42 €</strong>

    <div
      class="banking-weekly-widget__progress"
      role="progressbar"
      aria-label="Verbleibende Zeit dieser Budgetwoche"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="86"
    >
      <span class="banking-weekly-widget__progress-fill"></span>
    </div>

    <p class="banking-weekly-widget__remaining">noch 6 Tage</p>
  </div>
</a>
```

Wichtig:

- kein zweiter Card-/Panel-Wrapper innerhalb des Yuvomi-Widgets
- kein zusätzliches Dashboard-Chrome nachbauen
- kein neues Icon notwendig
- der vorhandene anklickbare Wrapper bleibt bestehen
- untrusted/API-Werte weiterhin ausschließlich über `textContent` setzen

## Rendering-Strategie

Nicht erst den alten Lade-Text erzeugen und anschließend einzelne Nodes per `replaceWith()` umsortieren. Stattdessen sollte das Widget eine kleine feste Struktur aufbauen:

- `title`
- `content`
- `amount`
- `progress`
- `progressFill`
- `remaining`

Im Loading-State können Amount/Progress ausgeblendet bzw. ein Statustext im Content angezeigt werden. Das reduziert Layout-Sprünge und verhindert erneut ein Aneinanderkleben von Titel und Betrag.

---

# 2. Bedeutung des Balkens

Der Balken stellt **die verbleibende Zeit der aktuellen Wochenbudget-Periode** dar.

Das ist bewusst kein Geldverbrauchsbalken. Für einen Geldverbrauchsbalken wäre die Semantik uneindeutig, weil das System sowohl den Saldo des Budget-Kontos als auch Direktausgaben über das Hauptkonto berücksichtigt.

Die Zeitsemantik ist dagegen eindeutig und passt direkt zur darunterstehenden Beschriftung `noch X Tage`.

## Verhalten

- direkt nach Beginn einer neuen Budgetwoche: Balken nahezu/voll gefüllt
- zur Wochenmitte: ungefähr halb gefüllt
- kurz vor dem nächsten Cutoff: fast leer
- ab erreichtem/überschrittenem Cutoff: 0 %

Der Balken ist damit ein visueller Countdown.

---

# 3. Fortschrittsberechnung

## Neue Konstante

Zusätzlich zum vorhandenen `DAY_MS`:

```text
WEEK_MS = 7 * DAY_MS
```

## Neue pure Hilfsfunktion

In `modules/banking/widgets/weekly-budget.js` exportieren:

```text
calculateRemainingWeeklyBudgetProgress(nextCutoffAt, now)
```

Rückgabe:

- Zahl zwischen `0` und `1`
- `null`, wenn `next_cutoff_at` oder `now` nicht valide ist

## Berechnung

```text
remainingMs = nextCutoffAt - now
progress = remainingMs / WEEK_MS
progress = clamp(progress, 0, 1)
```

Beispiele:

```text
7 Tage verbleibend -> 1.00 -> 100 %
6 Tage verbleibend -> 0.857 -> 86 %
3,5 Tage          -> 0.50 -> 50 %
1 Tag             -> 0.143 -> 14 %
Cutoff erreicht   -> 0.00 -> 0 %
```

Warum nicht `period.start_date` verwenden:

- `period.next_cutoff_at` ist bereits ein exakter Zeitpunkt
- `period.start_date` ist derzeit nur ein Kalenderdatum
- der Wochenrhythmus ist definitionsgemäß sieben Tage
- für die rein visuelle Anzeige ist daher kein neues Backend-Feld erforderlich

Die geringe DST-Abweichung in einer Zeitumstellungswoche ist für diese visuelle Anzeige akzeptabel und rechtfertigt keine Backend-Erweiterung.

## Prozentwert setzen

Nach erfolgreichem Laden:

```text
percentage = Math.round(progress * 100)
```

Dann:

- `aria-valuenow = percentage`
- Fill-Breite = `${percentage}%`

Die Breite ausschließlich aus der validierten numerischen Berechnung erzeugen, nicht aus API-Text übernehmen.

---

# 4. Countdown-Text beibehalten

Die vorhandenen Funktionen:

- `calculateRemainingWeeklyBudgetDays()`
- `formatRemainingWeeklyBudget()`

bleiben grundsätzlich bestehen.

Gewünschte deutsche Ausgabe:

```text
noch heute
noch 1 Tag
noch 2 Tage
noch 6 Tage
```

Die bisherige `Math.ceil`-Semantik bleibt bestehen: Sind z. B. noch 5 Tage und 4 Stunden übrig, zeigt das Widget `noch 6 Tage`.

Der Balken nutzt dagegen den präzisen Zeitanteil. Dadurch nimmt er im Tagesverlauf kontinuierlich ab, während der Text bewusst in ganzen Tagen bleibt.

---

# 5. CSS-Redesign

## Datei

`modules/banking/style.css`

## `.banking-weekly-widget`

Die Kachel soll die komplette verfügbare Widget-Höhe verwenden.

Ziel:

```text
display: grid
grid-template-rows: auto minmax(0, 1fr)
height: 100%
min-width: 0
```

Der bisherige Fokus-/Hover-Zustand und die Link-Semantik bleiben erhalten.

`align-content: start` soll nicht mehr die gesamte Kachel bestimmen.

## `.banking-weekly-widget__title`

Eigene Klasse ergänzen.

Anforderungen:

- oben links
- normale Widget-Titelgröße
- nicht mit dem Betrag konkurrieren
- `min-width: 0`
- kein unnötig großes Heading

## `.banking-weekly-widget__content`

Neue Klasse.

Ziel:

```text
display: grid
align-content: center
justify-items: center
gap: ...
min-height: 0
min-width: 0
```

Dieser Bereich nutzt die restliche Kachelhöhe und zentriert Betrag, Balken und Restzeit als zusammengehörigen KPI-Block.

## `.banking-weekly-widget__amount`

Der Betrag muss das eindeutig dominante Element sein.

Anforderungen:

- horizontal zentriert
- `text-align: center`
- `font-weight: 700` oder 800, abhängig von vorhandenen Yuvomi-Tokens
- `font-variant-numeric: tabular-nums`
- `white-space: nowrap`
- responsive Größe mit `clamp(...)`

Zielbereich ungefähr:

```css
font-size: clamp(2.25rem, 2rem + 1.5vw, 3.5rem);
```

Die konkrete Obergrenze darf beim Browser-Test leicht angepasst werden, damit `1.234,56 €` ebenfalls ohne Umbruch in die Standard-Kachel passt.

Nicht verwenden:

- harte Pixelpositionierung
- absolute Positionierung
- Transform-Hacks zum Zentrieren

## `.banking-weekly-widget__progress`

Neue Track-Klasse.

Anforderungen:

- Breite: möglichst groß, aber nicht bis direkt an den Card-Rand
- z. B. `width: min(100%, 18rem)`
- Höhe ca. `0.55rem` bis `0.7rem`
- pill/rund: `border-radius: 999px`
- Track über bestehende Yuvomi-Surface-/Border-Tokens
- `overflow: hidden`

Keine zweite Beschriftung oder Prozentzahl in den Balken schreiben.

## `.banking-weekly-widget__progress-fill`

Neue Fill-Klasse.

Anforderungen:

- Höhe und Border-Radius erben/100 %
- Füllfarbe über Yuvomi-Akzentvariable, bevorzugt `var(--color-accent, ...)`
- keine hart codierte violette Farbe
- keine aggressive Glow-/Neon-Optik
- Breitenänderung darf eine kurze Transition bekommen, z. B. `width 180ms ease-out`

Bei `prefers-reduced-motion: reduce` sollte die Transition entfallen, sofern dafür im Projekt bereits ein passendes Muster existiert.

## `.banking-weekly-widget__remaining`

Anforderungen:

- unterhalb des Balkens
- horizontal zentriert
- sekundäre Textfarbe
- etwas größer/lesbarer als der bisherige reine Kleinsttext, aber deutlich kleiner als der Betrag
- `margin: 0`

---

# 6. Loading- und Fehlerzustände

Die bestehende fachliche Behandlung bleibt erhalten, das Layout wird aber an die neue Struktur angepasst.

## Loading

Bevor die API antwortet:

```text
Wochenbudget

Wird geladen …
```

Optional kann später ein Skeleton ergänzt werden; in diesem Schritt nicht nötig.

## Nicht eingerichtet

```text
Wochenbudget

Noch nicht eingerichtet.
```

Kein leerer oder irreführender Progressbar.

## Deaktiviert

```text
Wochenbudget

Aktuell deaktiviert.
```

Kein Progressbar.

## API-Fehler

```text
Wochenbudget

Wochenbudget nicht verfügbar.
```

Kein Progressbar.

## Ungültiger Cutoff bei ansonsten gültigem Betrag

Der Betrag darf weiterhin angezeigt werden.

Statt eines falschen Balkens:

- Progressbar ausblenden
- vorhandenen Fallback `Zeitraum nicht verfügbar` anzeigen

Keine künstlichen 0 % anzeigen, weil das wie ein abgelaufenes Budget wirken würde.

---

# 7. Accessibility

Der Balken bekommt echte Progressbar-Semantik:

```text
role="progressbar"
aria-valuemin="0"
aria-valuemax="100"
aria-valuenow="..."
```

Zusätzlich sinnvolles `aria-label`, z. B.:

Deutsch:

```text
Verbleibende Zeit dieser Budgetwoche
```

Englisch:

```text
Remaining time in this budget week
```

Die sichtbare Textzeile `noch X Tage` bleibt bestehen, sodass die Information nicht ausschließlich visuell über den Balken transportiert wird.

Der Gesamtlink behält den bestehenden zugänglichen Namen `Banking öffnen` / `Open Banking`.

---

# 8. Keine Backend-Änderung

`GET /api/extensions/banking/weekly-budget/current` liefert bereits die nötigen Daten:

```text
available_to_spend_cents
period.next_cutoff_at
```

Daher ausdrücklich nicht:

- neue API-Route hinzufügen
- Weekly-Budget-Berechnungslogik verändern
- neue DB-Spalten anlegen
- `weekly-budget-overview.ts` nur für dieses Design anfassen

Das ist ein reiner Frontend-/Widget-Redesign.

---

# 9. `module.json`

`modules/banking/module.json` muss für dieses Redesign voraussichtlich nicht verändert werden.

Bereits korrekt:

```json
"defaultSize": "1x2",
"defaultVisible": true
```

Die Standardgröße bleibt `1x2`. Das neue Layout muss genau in dieser Standardgröße zuerst sauber funktionieren.

---

# 10. Tests

## Datei

`service/test/weekly-budget-frontend.test.ts`

Die bestehenden Tests nicht ersetzen, sondern erweitern.

## Pure Progress-Funktion testen

Neue Testfälle für `calculateRemainingWeeklyBudgetProgress()`:

```text
7 Tage -> 1
6 Tage -> ungefähr 6/7
3,5 Tage -> 0.5
1 Tag -> ungefähr 1/7
Cutoff exakt jetzt -> 0
Cutoff in Vergangenheit -> 0
mehr als 7 Tage -> 1
invalid/undefined -> null
```

Für Fließkommazahlen nicht auf Stringdarstellung testen, sondern mit sinnvoller Toleranz.

## Source-/Contract-Test erweitern

Der Widget-Source-Test soll weiterhin sicherstellen:

- `/weekly-budget/current` wird verwendet
- `available_to_spend_cents` wird verwendet
- `period?.next_cutoff_at` wird verwendet
- Link bleibt `/m/banking`

Zusätzlich prüfen, dass folgende UI-Verträge vorhanden sind:

```text
banking-weekly-widget__content
banking-weekly-widget__amount
banking-weekly-widget__progress
banking-weekly-widget__progress-fill
banking-weekly-widget__remaining
role="progressbar" bzw. entsprechendes setAttribute
aria-valuenow
```

Die bisherigen Countdown-Tests bleiben bestehen.

## CSS-Contract

Wenn im Projekt CSS nicht direkt getestet wird, reicht ein Quelltext-Contract im bestehenden Frontend-Test für die neuen Klassen. Keine neue Browser-Test-Infrastruktur nur für dieses Widget einführen.

---

# 11. Browser-/Responsive-Prüfung

Nach Implementierung manuell mindestens prüfen:

### Standard `1x2`

- Titel oben
- Betrag deutlich groß und sauber zentriert
- Balken unter Betrag
- Restzeit unter Balken
- kein Aneinanderkleben von `Wochenbudget` und Betrag
- keine unnötige Leere im oberen Bereich

### kleiner/schmaler Dashboard-Viewport

- Betrag bleibt einzeilig
- keine horizontale Scrollbar
- Balken schrumpft mit
- Restzeit bleibt lesbar

### längere Beträge

Mindestens visuell simulieren:

```text
9,99 €
450,00 €
1.234,56 €
```

Alle müssen ohne Umbruch funktionieren.

### Light/Dark Mode

- Track sichtbar
- Fill sichtbar
- Betrag mit ausreichendem Kontrast
- keine hart codierten Farben, die nur in Dark Mode funktionieren

### Hover/Keyboard

- gesamtes Widget weiterhin anklickbar
- Focus-Ring bleibt sichtbar
- Enter aktiviert den Link

---

# 12. Implementierungsreihenfolge

1. `calculateRemainingWeeklyBudgetProgress()` als pure Funktion ergänzen.
2. Tests für die Progressberechnung schreiben.
3. Widget-DOM in Titel + zentrierten Content-Block umbauen.
4. Progressbar mit ARIA-Semantik ergänzen.
5. Erfolgs-, Loading-, deaktiviert-, nicht-konfiguriert- und Fehlerzustände auf die neue Struktur umstellen.
6. CSS für Content-Zentrierung, großen Betrag, Track, Fill und Restzeit implementieren.
7. bestehenden Frontend-Contract-Test erweitern.
8. `npm test`/relevante Service-Tests ausführen.
9. Dashboard im Standard-`1x2`-Widget und auf schmalem Viewport prüfen.
10. erst danach eventuelle Font-Size-/Gap-Feinabstimmung vornehmen.

---

# 13. Acceptance Criteria

Der Redesign ist fertig, wenn alle folgenden Punkte erfüllt sind:

- [ ] `Wochenbudget` steht separat im oberen Bereich der Kachel.
- [ ] Der aktuelle verfügbare Betrag ist das größte Element der Kachel.
- [ ] Der Betrag ist horizontal deutlich zentriert.
- [ ] Der Betrag bricht in der normalen `1x2`-Kachel nicht um.
- [ ] Unter dem Betrag befindet sich ein horizontaler Fortschrittsbalken.
- [ ] Der Balken repräsentiert die verbleibende Zeit bis `period.next_cutoff_at`.
- [ ] Bei 6 verbleibenden Tagen ist der Balken ungefähr zu 86 % gefüllt.
- [ ] Unter dem Balken steht zentriert `noch X Tage`, `noch 1 Tag` oder `noch heute`.
- [ ] Bei ungültigen Periodendaten wird kein irreführender Balken angezeigt.
- [ ] Nicht eingerichtet/deaktiviert/API-Fehler bleiben verständlich dargestellt.
- [ ] Die gesamte Kachel öffnet weiterhin `/m/banking`.
- [ ] Keyboard-Fokus und Screenreader-Semantik bleiben erhalten.
- [ ] Light und Dark Mode funktionieren.
- [ ] Keine Yuvomi-Core-Datei wird verändert.
- [ ] Keine Backend-/DB-Änderung ist erforderlich.
- [ ] Bestehende Countdown-Tests bleiben grün.
- [ ] Neue Progress-Tests sind vorhanden und grün.

## Nicht Teil dieses Schritts

Bewusst nicht umsetzen:

- Geldverbrauch als zweiter Fortschrittswert
- Direktausgaben im Dashboard-Widget
- nächsten Auffüllbetrag im Dashboard-Widget
- QR-Code oder Transfer-Aktion im Widget
- animierte Countdown-Uhr
- sekundengenaues Live-Polling
- neue Widget-Größen oder Widget-Optionen

Der Fokus bleibt ausschließlich auf der gewünschten Darstellung:

**großer zentrierter Betrag → Zeitbalken → `noch X Tage`.**
