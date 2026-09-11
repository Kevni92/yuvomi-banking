# Plan: Wochenbudget auf dem Yuvomi-Dashboard

## Ziel

Das bereits vorhandene Banking-Dashboard-Widget soll auf der Yuvomi-Startseite das aktuell verfügbare Wochenbudget sehr klar und kompakt darstellen.

Gewünschte Hauptdarstellung:

```text
Wochenbudget

45,42 €
noch 5 Tage
```

Der Betrag ist die wichtigste Information und steht groß im Mittelpunkt. Direkt darunter steht ausschließlich die verbleibende Zeit bis zum nächsten Wochenbudget-Stichtag.

Das Widget soll bewusst deutlich reduzierter sein als die Banking-Seite. Detailinformationen wie Direktausgaben, Auffüllbetrag oder Kontonamen gehören nicht in die primäre Dashboard-Darstellung.

---

## Bestehende Architektur

Das Banking-Modul registriert bereits ein Yuvomi-Dashboard-Widget:

- Widget-ID: `weekly-budget`
- globale Dashboard-ID: `banking:weekly-budget`
- Entry: `modules/banking/widgets/weekly-budget.js`
- API: `GET /api/extensions/banking/weekly-budget/current`

Der Endpoint liefert bereits alle benötigten Werte:

- `available_to_spend_cents`
- `period.start_date`
- `period.end_date`
- `period.next_cutoff_at`

Es ist daher **keine Änderung an Yuvomi Core und keine neue Backend-Route notwendig**.

---

## 1. Widget standardmäßig auf dem Dashboard anbieten

Datei:

`modules/banking/module.json`

Aktuell ist das Widget mit

```json
"defaultVisible": false
```

registriert.

Das soll auf

```json
"defaultVisible": true
```

geändert werden.

Damit wird das Widget bei neuen bzw. noch nicht individuell konfigurierten Dashboard-Layouts automatisch eingeblendet.

### Bestehende persönliche Dashboard-Konfigurationen

Yuvomi speichert die Sichtbarkeit der Widgets pro Benutzer. Eine bereits bewusst gespeicherte Einstellung `visible: false` darf durch diese Änderung nicht überschrieben werden.

Für bestehende Benutzer gilt daher:

- ist `banking:weekly-budget` bereits Teil der persönlichen Konfiguration, bleibt die persönliche Sichtbarkeit erhalten;
- das Widget kann weiterhin über die Dashboard-Anpassung ein- oder ausgeblendet werden.

Kein Core-Patch ist nötig.

---

## 2. Primäre Widget-Darstellung vereinfachen

Datei:

`modules/banking/widgets/weekly-budget.js`

Die aktuelle Darstellung zeigt zusätzlich eine Auffüllberechnung. Diese Information soll aus der primären Widget-Ansicht entfernt werden.

Zielstruktur:

```text
Wochenbudget

45,42 €
noch 5 Tage
```

DOM-seitig beispielsweise:

```text
.banking-weekly-widget
  title
  .banking-weekly-widget__amount
  .banking-weekly-widget__remaining
```

### Betrag

Quelle:

```text
current.available_to_spend_cents
```

Formatierung weiterhin über `Intl.NumberFormat` als EUR.

Beispiel:

```text
45,42 €
```

Der Betrag soll visuell das dominante Element des Widgets sein.

---

## 3. Verbleibende Tage berechnen

Die verbleibende Zeit wird aus

```text
current.period.next_cutoff_at
```

berechnet.

`next_cutoff_at` ist gegenüber `period.end_date` zu bevorzugen, weil dort der exakte Stichtag inklusive Uhrzeit und Zeitzone enthalten ist.

### Berechnung

Clientseitig:

```text
remainingMs = nextCutoffAt - Date.now()
remainingDays = ceil(remainingMs / 24h)
```

Der Wert darf nie negativ dargestellt werden:

```text
remainingDays = max(0, remainingDays)
```

Die Berechnung ist nur für die kompakte Dashboard-Anzeige gedacht. Der Server bleibt weiterhin die Quelle für die eigentliche Budgetperiode.

### Texte

Deutsch:

```text
0 Tage  -> noch heute
1 Tag   -> noch 1 Tag
>= 2    -> noch X Tage
```

Englisch:

```text
0 days  -> ends today
1 day   -> 1 day left
>= 2    -> X days left
```

Damit wird insbesondere kurz vor dem Stichtag kein unnatürliches `noch 0 Tage` angezeigt.

### Ungültiger oder fehlender Stichtag

Wenn `next_cutoff_at` fehlt oder kein valides Datum ist:

```text
Zeitraum nicht verfügbar
```

Das Widget darf dadurch nicht komplett fehlschlagen.

---

## 4. Widget-Zustände

### Nicht eingerichtet

```text
Wochenbudget
Noch nicht eingerichtet.
```

### Deaktiviert

```text
Wochenbudget
Aktuell deaktiviert.
```

### API nicht erreichbar

```text
Wochenbudget
Wochenbudget nicht verfügbar.
```

### Aktiv

Nur bei einem aktiven und gültigen Wochenbudget:

```text
Wochenbudget
45,42 €
noch 5 Tage
```

Der Auffüllbetrag wird im Dashboard nicht mehr als Standardinformation angezeigt.

---

## 5. Navigation

Das komplette Widget soll als Einstieg ins Banking dienen.

Empfohlen:

- Klick/Tap auf das Widget bzw. eine dezente Aktion führt zu `/m/banking`;
- Tastaturbedienung muss erhalten bleiben;
- kein eigener Detaildialog im Dashboard.

Alternativ kann der vorhandene Widget-Container unverändert bleiben und nur ein kleiner Link `Banking öffnen` ergänzt werden, falls Yuvomis Widget-Chrome bereits eine bevorzugte Interaktionskonvention vorgibt.

Die Core-Konventionen des Dashboards haben Vorrang vor einer eigenen Navigationstechnik.

---

## 6. Styling

Datei:

`modules/banking/style.css`

Das Widget soll kompakt bleiben und sich in das Yuvomi-Dashboard einfügen.

Geplante Klassen:

```text
.banking-weekly-widget
.banking-weekly-widget__amount
.banking-weekly-widget__remaining
```

### Betrag

- deutlich größere Schrift als der restliche Widget-Inhalt;
- `font-weight: 700` oder Yuvomi-äquivalente Gewichtung;
- `font-variant-numeric: tabular-nums`;
- kein zusätzlicher Card-in-Card-Look.

### Restzeit

- direkt unter dem Betrag;
- kleinere Schrift;
- sekundäre Textfarbe;
- kein Badge notwendig.

Beispiel:

```text
45,42 €
noch 5 Tage
```

Nicht:

```text
Verfügbares Budget: 45,42 €
Zeitraum endet in: 5 Tagen
```

Die Information soll auf einen Blick erkennbar sein.

---

## 7. Keine neue Backendlogik

`GET /api/extensions/banking/weekly-budget/current` liefert bereits:

```json
{
  "available_to_spend_cents": 4542,
  "period": {
    "start_date": "2026-09-10",
    "end_date": "2026-09-17",
    "next_cutoff_at": "..."
  }
}
```

Deshalb:

- keine DB-Migration;
- keine neue Route;
- keine Änderung der Wochenbudget-Berechnung;
- kein Zugriff auf `banking.db` aus dem Browser;
- keine Änderung an Yuvomi Core.

---

## 8. Tests

Mindestens folgende Fälle absichern.

### Widget-Contract

Prüfen, dass:

- `module.json` weiterhin das Widget `weekly-budget` registriert;
- `defaultVisible` auf `true` steht;
- das Widget weiterhin `/api/extensions/banking/weekly-budget/current` verwendet.

### Countdown

Die verbleibende-Zeit-Hilfsfunktion sollte separat testbar sein.

Fälle:

```text
Cutoff in 5,2 Tagen -> "noch 6 Tage"
Cutoff in 1 Tag     -> "noch 1 Tag"
Cutoff in < 24 h    -> "noch 1 Tag"
Cutoff erreicht     -> "noch heute"
fehlendes Datum     -> Fallback
ungültiges Datum    -> Fallback
```

Wenn die Produktentscheidung später eine kalenderbasierte statt 24h-basierte Anzeige verlangt, soll nur diese Hilfsfunktion angepasst werden müssen.

### API-Zustände

- `configured: false`
- `enabled: false`
- aktives Budget mit Betrag und `next_cutoff_at`
- aktives Budget ohne gültigen `next_cutoff_at`
- HTTP-Fehler

---

## 9. Implementierungsreihenfolge

1. `modules/banking/module.json`
   - `defaultVisible: true`.
2. `modules/banking/widgets/weekly-budget.js`
   - Auffüllbetrag aus der Primärdarstellung entfernen.
   - Resttage aus `period.next_cutoff_at` berechnen.
   - Singular/Plural/Fallback behandeln.
3. `modules/banking/style.css`
   - Betrag prominent.
   - `noch X Tage` direkt darunter.
4. Tests ergänzen.
5. Browser-Test auf Desktop und Mobilansicht.

---

## Acceptance Criteria

- [ ] Auf der Yuvomi-Startseite kann das bestehende Banking-Wochenbudget-Widget angezeigt werden.
- [ ] Das Widget ist für neue/default Dashboard-Konfigurationen standardmäßig sichtbar.
- [ ] Der Hauptwert ist `available_to_spend_cents`.
- [ ] Der Betrag wird groß und prominent dargestellt.
- [ ] Direkt darunter steht `noch X Tage` bzw. `noch 1 Tag` / `noch heute`.
- [ ] Grundlage des Countdowns ist `period.next_cutoff_at`.
- [ ] Der bisherige Auffüllbetrag wird nicht mehr als primäre Widget-Information dargestellt.
- [ ] Nicht eingerichtet, deaktiviert und API-Fehler besitzen verständliche Fallbacks.
- [ ] Bestehende persönliche Widget-Einstellungen werden nicht überschrieben.
- [ ] Es wird kein Yuvomi-Core-Code geändert.
- [ ] Es wird keine neue Backend-Route und keine Migration benötigt.
