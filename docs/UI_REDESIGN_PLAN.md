# Banking UI Redesign – technisches Umsetzungskonzept

Stand der Analyse:

- `yuvomi-banking`: `c25fa2471ad9debade687d521cbf5e3d63e459fc`
- Yuvomi Core: `1f96c4dc80f0a9668fd0d2885ca6242f9fc5b0ca`
- UI-Review anhand des aktuellen Browserstands vom 11.09.2026

Dieses Dokument ist die verbindliche technische Planung für die nächste UI-Iteration. Es beschreibt nicht mehr den ursprünglichen Umbau von Grund auf, sondern den **bereits erreichten Stand nach `c25fa247`** und die jetzt noch konkret umzusetzenden Korrekturen. Es ist absichtlich so detailliert, dass ein nachgelagerter Coding-Agent die Änderungen ohne erneute Architekturentscheidung abarbeiten kann.

---

## 1. Zielbild

Die Banking-Hauptseite `/m/banking` ist eine Nutzungsansicht und bleibt in dieser Reihenfolge aufgebaut:

1. **Wochenbudget**
2. **Konten**
3. **Umsätze**
4. **Umsatzkategorisierung**
5. **Wochenbudget-Historie**

Die Konfiguration bleibt unter:

```text
/m/banking?view=settings
```

Der aktuelle Umbau hat die wesentlichen Ziele bereits erreicht:

- Debug-Karten sind von der Hauptseite entfernt.
- Wochenbudget steht oben.
- Banking-Einstellungen sind aus der Hauptseite herausgelöst.
- Bankverbindungen sind im Settings-View einklappbar.
- Umsätze sind nicht mehr an einzelne Kontokarten gekoppelt.
- Es gibt eine globale, serverseitig filterbare/sortierbare Umsatz-Tabelle.
- Die Seite verwendet `data + wide` statt `data + content`.
- Einnahmen sind grün, Ausgaben rot.
- Umsatzfilter, Sortierung und Pagination sind vorhanden.
- Die Umsatzsektion ist einklappbar.

Die nächste Iteration konzentriert sich deshalb auf die **Konten-Sektion** und einige beim Review des Commits gefundene UI-/Frontend-Regressionspunkte.

---

## 2. Review des Commits `c25fa247`

### 2.1 Was gut umgesetzt wurde

Der Commit folgt der ursprünglichen Architekturplanung in den entscheidenden Punkten.

#### Hauptansicht und Settings sind getrennt

`modules/banking/index.js::render()` unterscheidet jetzt zwischen:

```text
view=main
view=settings
```

und rendert über:

```text
renderMainMarkup()
renderSettingsMarkup()
```

Das ist die richtige Richtung. Die Hauptseite enthält keine Debug-Karten mehr und der Settings-View kapselt Bankverbindungen, Wochenbudget-Konfiguration, Push und Wochenbudget-Kategorien.

#### Seitenbreite wurde korrekt über Yuvomi gelöst

`modules/banking/module.json` verwendet jetzt:

```json
"page": {
  "composition": "data",
  "width": "wide"
}
```

Das entspricht Yuvomis Page-Composition-Regeln. Es wurde keine eigene globale Seitenbreite in CSS erfunden.

#### Globale Umsatz-API ist sauber getrennt

Neu vorhanden:

```text
GET /api/extensions/banking/transactions
```

mit:

- Ownership über `enable_banking_connections.yuvomi_user_id`
- serverseitigen Filtern
- serverseitiger Sortierung
- Sort-Whitelist
- Pagination
- read-Berechtigung
- keiner Enable-Banking-Netzwerkabfrage

Die Logik liegt sinnvoll getrennt in:

```text
service/src/api/transaction-routes.ts
service/src/services/transactions-query.ts
```

Das ist besser als ein clientseitiges Zusammenführen mehrerer Account-Endpunkte.

#### Tests und CI

Der Commit enthält neue API-Tests für die globale Umsatzliste. Die GitHub-CI für `c25fa247` ist grün.

---

## 2.2 Noch offene bzw. neu sichtbare Probleme

### A. Die Konten-Sektion ist nicht einklappbar

In `renderMainMarkup()` ist der Bereich weiterhin ein normales:

```html
<section class="banking-panel">
```

Im Gegensatz zu Umsätzen und Historie kann der Nutzer die gesamte Konten-Sektion daher nicht schließen.

**Ziel:** Konten werden wie Umsätze zu einem nativen `<details>`-Panel.

---

### B. Einzelne Konten sind im geschlossenen Zustand deutlich zu groß

`renderAccounts()` rendert derzeit pro Konto:

```text
.banking-account-card
  .banking-account-card__header
  .banking-feedback
  .banking-account-card__details
```

Auch ohne geöffnete Details entsteht zu viel vertikale Fläche. Auf dem aktuellen Screenshot nimmt jedes Konto einen großen Block ein.

Dazu tragen insbesondere bei:

- relativ großes `padding` und `gap`
- Aktionsbuttons, die teilweise untereinander umbrechen
- ein immer vorhandenes Feedback-Element
- der Detailbereich ist visuell nicht zuverlässig verborgen

**Ziel:** Ein geschlossenes Konto ist nur noch eine kompakte Zeile bzw. maximal eine zweizeilige Row.

---

### C. Der Detailbereich ist im Screenshot sichtbar, obwohl das HTML `hidden` setzt

`renderAccounts()` erzeugt korrekt:

```html
<div class="banking-account-card__details" data-account-details hidden>
```

Gleichzeitig setzt `style.css` aber:

```css
.banking-account-card__details {
  display: grid;
}
```

Der aktuelle Browserstand zeigt dadurch bereits im geschlossenen Konto:

```text
Salden
Noch nicht geladen.
```

Unabhängig davon, welche UA-Regel der Browser für `hidden` anwendet, soll sich das Modul hier **nicht auf implizites Browserverhalten verlassen**.

Verbindlicher Fix:

```css
.banking-account-card__details[hidden] {
  display: none;
}
```

Nur der explizit geöffnete Zustand darf ein Layout bekommen.

---

### D. `Details anzeigen` ist aktuell kein Toggle

`configureMainInteractions()` ruft bei `show-account` immer:

```text
loadAccountDetails(...)
```

`loadAccountDetails()` öffnet anschließend immer:

```js
details.hidden = false;
```

Es gibt keinen Pfad zurück zu `hidden = true`.

**Ziel:** Derselbe Button toggelt zwischen:

```text
Details anzeigen
Details ausblenden
```

und setzt korrekt:

```text
aria-expanded=true|false
```

---

### E. Konkreter Frontend-Bug in `loadAccountDetails()`

Der aktuelle Code macht:

```js
const balancesResult = await Promise.allSettled([
  loadJson(...)
]);
```

prüft danach aber fälschlich:

```js
balancesResult.status
balancesResult.value
balancesResult.reason
```

`Promise.allSettled()` liefert hier ein Array. Korrekt wäre `balancesResult[0]`; noch besser ist in diesem Fall, `Promise.allSettled()` komplett zu entfernen, weil nur **ein einziger Request** ausgeführt wird.

**Verbindliche Lösung:** `loadAccountDetails()` nicht nur kosmetisch anfassen, sondern beim Account-Refactoring vollständig vereinfachen.

---

### F. `syncAccount()` öffnet Details ungefragt

Aktuell setzt auch `syncAccount()`:

```js
details.hidden = false;
```

Damit öffnet ein manueller Sync automatisch das Konto.

Das widerspricht dem gewünschten Verhalten:

> Ein Konto soll sich erst öffnen, wenn der Benutzer explizit `Details anzeigen` auswählt.

**Ziel:** Synchronisieren verändert den Open/Closed-Zustand nicht.

- Konto geschlossen -> nach Sync geschlossen lassen.
- Konto offen -> geöffnete Salden nach Sync aktualisieren.

---

### G. Leeres Feedback erzeugt unnötige Höhe

Jede Kontokarte enthält immer:

```html
<p class="banking-feedback" data-account-feedback></p>
```

Die allgemeine `.banking-feedback`-Regel besitzt Margin. Ein leeres Statusfeld darf im kompakten Zustand keine zusätzliche Zeile erzeugen.

Verbindliche CSS-Regel:

```css
.banking-feedback:empty {
  display: none;
}
```

Wenn ein Sync-/Fehlertext vorhanden ist, darf es wieder sichtbar werden.

---

### H. Lange Kontonamen drücken die Umsatz-Spalten zusammen

Der neue Umsatz-View ist grundsätzlich richtig. Der aktuelle Screenshot zeigt aber einen Folgezustand:

```text
AccountOwnerNameLongerThan35DigitsWi
```

nimmt so viel Tabellenbreite ein, dass die Kategorie- und Wochenbudget-Selects extrem schmal werden.

Das ist kein Backendproblem. Die Tabelle benötigt definierte Komponenten-Spalten und Ellipsis für lange Accountnamen.

Diese kleine Nachbesserung wird in derselben UI-Iteration mit erledigt.

---

## 3. Verbindliches Ziel für die Konten-Sektion

### 3.1 Gesamte Konten-Sektion einklappbar

`renderMainMarkup()` wird geändert von:

```html
<section class="banking-panel">
  ...
</section>
```

zu sinngemäß:

```html
<details
  class="banking-panel banking-accounts-panel"
  data-banking-accounts-panel
  open
>
  <summary>
    <span>Konten</span>
  </summary>
  <div class="banking-accounts-panel__body">
    <p class="banking-panel__description">...</p>
    <div data-banking-accounts></div>
  </div>
</details>
```

Die Sektion ist beim ersten Besuch standardmäßig offen.

Der Zustand wird analog zur Umsatzsektion nur clientseitig in `sessionStorage` gespeichert:

```text
yuvomi:banking:accounts-open
```

Werte:

```text
1 = offen
0 = geschlossen
```

Keine DB-Spalte und keine Server-Preference dafür anlegen.

---

## 3.2 Geschlossenes Konto = kompakte Row

Das Konto ist im Ausgangszustand **kein großer Content-Block** mehr.

Desktop-Ziel:

```text
Ann-Kathrin Staab        DE45••••5100 · EUR          [Details] [Synchronisieren]
```

oder bei etwas weniger Platz:

```text
Ann-Kathrin Staab                                  [Details] [Synchronisieren]
DE45••••5100 · EUR
```

Das Konto soll im geschlossenen Zustand ausschließlich enthalten:

- Kontoname
- maskierte IBAN bzw. Kontotyp
- Währung
- optional `last_synced_at` als kleine Sekundärinformation
- Detail-Aktion
- bei `write` Sync-Aktion

Nicht sichtbar im geschlossenen Zustand:

- `Salden`
- `Noch nicht geladen`
- Händlerlogo-Wartungsaktion
- technische Detailtexte

---

## 3.3 Empfohlene DOM-Struktur je Konto

`renderAccounts()` soll sinngemäß erzeugen:

```html
<article
  class="banking-account-card"
  data-banking-account-card
  data-account-id="42"
  data-can-write="true"
>
  <div class="banking-account-card__header">
    <div class="banking-account-card__identity">
      <strong class="banking-account-card__name">Ann-Kathrin Staab</strong>
      <span class="banking-account-card__meta">DE45••••5100 · EUR</span>
    </div>

    <div class="banking-account-card__actions">
      <button
        class="btn btn--secondary"
        type="button"
        data-action="show-account"
        aria-expanded="false"
        aria-controls="banking-account-details-42"
      >
        Details anzeigen
      </button>

      <button ... data-action="sync-account">
        Konto synchronisieren
      </button>
    </div>
  </div>

  <p class="banking-feedback" data-account-feedback role="status"></p>

  <div
    id="banking-account-details-42"
    class="banking-account-card__details"
    data-account-details
    data-loaded="false"
    hidden
  >
    ...
  </div>
</article>
```

Wichtig:

- `aria-controls` muss auf die echte Detail-ID zeigen.
- `aria-expanded` muss mit `hidden` synchron bleiben.
- Keine verschachtelten interaktiven Buttons innerhalb eines `<summary>` pro Konto bauen.
- Das **Panel** darf `<details>` sein; das einzelne Konto bleibt bewusst eine Row mit explizitem Toggle-Button.

---

## 4. Detail-Toggle: exaktes Verhalten

### 4.1 Neue Funktion statt aktuellem `loadAccountDetails()`

Die bisherige Funktion soll durch eine klare Toggle-Logik ersetzt werden, z. B.:

```text
toggleAccountDetails({ card, button, signal })
```

Ablauf:

### Fall 1: Konto ist offen

```text
1. details.hidden = true
2. button.ariaExpanded = false
3. Buttontext = "Details anzeigen"
4. kein Netzwerkrequest
```

Geladene Daten dürfen im DOM bleiben. Beim erneuten Öffnen müssen sie nicht erneut geladen werden.

### Fall 2: Konto ist geschlossen und bereits geladen

Wenn:

```text
details.dataset.loaded === 'true'
```

nur öffnen:

```text
1. details.hidden = false
2. aria-expanded = true
3. Buttontext = "Details ausblenden"
4. kein erneuter Netzwerkrequest
```

### Fall 3: Konto ist geschlossen und noch nicht geladen

```text
1. Detailbereich öffnen
2. Loading-Zustand anzeigen
3. GET /accounts/:id/balances
4. renderBalances(...)
5. data-loaded = true
6. Loading-Zustand entfernen
```

Dafür ist `Promise.allSettled()` nicht erforderlich.

Sinngemäß:

```js
const payload = await loadJson(`accounts/${id}/balances`, { signal });
renderBalances(balancesHost, payload?.data);
details.dataset.loaded = 'true';
```

Fehler:

- Detailbereich bleibt offen.
- Fehler wird im Detailbereich oder Feedback angezeigt.
- `data-loaded` bleibt `false`, damit ein weiterer Versuch möglich ist.

---

## 5. Sync-Verhalten

`syncAccount()` bleibt eine eigene Aktion.

### Verbindliche Regel

**Ein Sync darf ein geschlossenes Konto nicht öffnen.**

Zu Beginn:

```js
const wasOpen = !details.hidden;
```

Dann:

1. `POST /accounts/:id/sync` immer ausführen.
2. Wenn `wasOpen === true`, zusätzlich den aktuellen Saldo laden und darstellen.
3. Wenn `wasOpen === false`, keinen Saldo-Detailbereich öffnen.
4. Globalen Umsatz-View und Wochenbudget wie bisher aktualisieren.
5. Open/Closed-Zustand unverändert lassen.

Wenn Salden beim Sync ohnehin aus fachlichen Gründen benötigt werden, dürfen sie intern geladen werden; trotzdem bleibt der Detailbereich geschlossen.

Nach erfolgreichem Sync kann ein kompakter Status kurz im `data-account-feedback` erscheinen.

---

## 6. Kompaktere Account-CSS

Datei:

```text
modules/banking/style.css
```

### 6.1 Panel

Neue/angepasste Selektoren:

```text
.banking-accounts-panel
.banking-accounts-panel > summary
.banking-accounts-panel__body
```

Die Summary soll visuell dieselbe Sprache wie `.banking-transactions-panel > summary` verwenden.

Bestehende gemeinsame Summary-Regel darf erweitert werden:

```css
.banking-transactions-panel > summary,
.banking-weekly-history-panel > summary,
.banking-settings-connections > summary,
.banking-accounts-panel > summary {
  ...
}
```

### 6.2 Konto-Row

Zielwerte als Yuvomi-Tokens, keine willkürliche Card-Mindesthöhe:

```css
.banking-account-card {
  gap: 0;
  padding: var(--space-2, 0.5rem) 0;
}
```

Header:

```css
.banking-account-card__header {
  align-items: center;
}
```

Identity:

```css
.banking-account-card__identity {
  display: grid;
  gap: var(--space-1, 0.25rem);
  min-width: 0;
}
```

Name:

```css
.banking-account-card__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Meta kleiner und sekundär.

Actions auf Desktop möglichst in einer Zeile halten:

```css
.banking-account-card__actions {
  align-items: center;
  flex-wrap: nowrap;
}
```

Bei wirklich engem Komponentenplatz darf bestehendes responsives Verhalten umbrechen. Keine neue globale Seitengeometrie einführen.

### 6.3 Details wirklich verstecken

Verbindlich:

```css
.banking-account-card__details[hidden] {
  display: none;
}
```

Für offen:

```css
.banking-account-card__details:not([hidden]) {
  display: grid;
  gap: var(--space-3, 0.75rem);
  padding-top: var(--space-3, 0.75rem);
}
```

### 6.4 Leeres Feedback

Verbindlich:

```css
.banking-feedback:empty {
  display: none;
}
```

Damit erzeugt ein Konto im Normalzustand keine unsichtbare Statuszeile.

---

## 7. Händlerlogos-Aktion

`Händlerlogos laden` bleibt vorhanden, ist aber keine primäre Kontoaktion.

Sie bleibt ausschließlich im geöffneten Detailbereich:

```text
Details
  Salden
  Wartung
    Händlerlogos laden
```

Im geschlossenen Konto darf dieser Button nicht sichtbar sein.

---

## 8. Umsatz-Tabelle: kleine Nachbesserung aus dem Commit-Review

Der globale Umsatz-View ist grundsätzlich korrekt und bleibt erhalten.

Der Screenshot zeigt jedoch, dass sehr lange Kontonamen die Spalten `Kategorie` und `Wochenbudget` zusammendrücken.

### 8.1 Ziel

Lange Namen dürfen nicht die Bedienbarkeit der Selects zerstören.

Empfohlen:

- Tabellenlayout kontrollieren, z. B. über `<colgroup>` oder klar definierte Komponentenbreiten.
- Account-Spalte begrenzen.
- sichtbaren Accountnamen mit Ellipsis darstellen.
- vollständigen Namen über `title` verfügbar machen.
- Kategorie- und Wochenbudget-Select dürfen nicht auf eine praktisch unbedienbare Breite schrumpfen.

Beispiel für die Account-Zelle:

```html
<td class="banking-transactions-table__account" title="Vollständiger Kontoname">
  AccountOwnerNameLonger…
</td>
```

CSS sinngemäß:

```css
.banking-transactions-table__account {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.banking-transactions-table select {
  width: 100%;
  min-width: 8rem;
}
```

Die konkrete Spaltenaufteilung ist Komponentenlayout und darf lokal definiert werden. Keine Änderung an Yuvomis Page-Width-System.

---

## 9. Dateien, die in dieser Iteration geändert werden sollen

### `modules/banking/index.js`

Änderungen:

1. Konten-Panel in `renderMainMarkup()` als `<details>` ausgeben.
2. Panel-Open-State über `sessionStorage` verwalten.
3. `renderAccounts()` auf kompakte Row-Struktur umstellen.
4. `aria-expanded` / `aria-controls` hinzufügen.
5. `loadAccountDetails()` durch Toggle-Logik ersetzen.
6. den `Promise.allSettled()`-Fehler entfernen.
7. Details nur beim expliziten Details-Klick öffnen.
8. `syncAccount()` darf geschlossene Details nicht öffnen.
9. Sync aktualisiert Salden nur sichtbar, wenn Details bereits offen sind bzw. hält den Open-State unverändert.
10. Händlerlogo-Aktion nur im Detailbereich belassen.
11. Umsatz-Accountzelle mit eigener CSS-Klasse und `title` rendern.
12. ggf. `<colgroup>` bzw. kontrollierte Tabellenbreiten ergänzen.

### `modules/banking/style.css`

Änderungen:

1. Accounts-Panel-Summary unterstützen.
2. Account-Rows deutlich kompakter machen.
3. `[hidden]` explizit auf `display:none` setzen.
4. leeres `.banking-feedback` verstecken.
5. Account-Actions kompakt halten.
6. Accountname mit Ellipsis unterstützen.
7. Umsatz-Accountspalte begrenzen.
8. Selects in der Tabelle nicht unbenutzbar klein werden lassen.

### `modules/banking/locales/de.json`

Neu mindestens:

```json
"hideAccountDetails": "Details ausblenden"
```

Optional, falls für Summary/Status benötigt:

```json
"accountsCollapsed": "Konten"
```

Keine neuen Keys einführen, wenn ein vorhandener semantisch exakt passt.

### `modules/banking/locales/en.json`

Entsprechender Key:

```json
"hideAccountDetails": "Hide details"
```

### `service/test/weekly-budget-frontend.test.ts`

Frontend-Vertrag ergänzen.

Siehe Testabschnitt unten.

### Backend

Für diesen Account-UI-Umbau ist **keine neue Migration und kein neuer Banking-Endpoint** erforderlich.

Die bestehende Account-API reicht aus.

---

## 10. Interaktionsdetails

### 10.1 Accounts-Panel-State

Beim Initialisieren:

```text
sessionStorage key nicht vorhanden -> open
"1" -> open
"0" -> closed
```

Beim `toggle`-Event des `<details>`:

```text
yuvomi:banking:accounts-open = panel.open ? "1" : "0"
```

Fehler in `sessionStorage` dürfen die UI nicht blockieren.

### 10.2 Konto-State

Der Open-State einzelner Konten muss **nicht** serverseitig persistiert werden.

Für diese Iteration reicht:

- bei Seitenaufruf alle Konten geschlossen
- während derselben gerenderten Seite bleibt ein manuell geöffnetes Konto offen

Optional darf später auch je Account ein `sessionStorage`-State ergänzt werden. Das ist für diese Iteration nicht notwendig.

### 10.3 Sync bei geöffnetem Konto

Wenn das Konto geöffnet ist und Sync erfolgreich war:

- Saldo aktualisieren
- globalen Umsatz-View neu laden
- Wochenbudget neu laden
- Detailbereich offen lassen

### 10.4 Sync bei geschlossenem Konto

Wenn das Konto geschlossen ist:

- synchronisieren
- globalen Umsatz-View neu laden
- Wochenbudget neu laden
- Konto geschlossen lassen
- kein `details.hidden = false`

---

## 11. Accessibility

Verbindlich:

- Konten-Panel über natives `<details>/<summary>`.
- Detailbutton je Konto mit `aria-expanded`.
- `aria-controls` auf eindeutige Detail-ID.
- Buttontext reflektiert den Zustand.
- Ausblenden darf keinen Netzwerkrequest auslösen.
- Tastaturbedienung der Buttons bleibt erhalten.
- `hidden` ist die einzige Quelle für die Sichtbarkeit des Account-Detailbereichs; CSS respektiert diesen Zustand explizit.

---

## 12. Tests

Die bisherige CI prüft Backend und einige statische Frontend-Verträge, aber kein echtes Browser-DOM-Verhalten. Genau deshalb konnte der `Promise.allSettled()`-Fehler in `loadAccountDetails()` trotz grüner CI bestehen bleiben.

### 12.1 Bestehenden Frontend-Vertrag erweitern

In `service/test/weekly-budget-frontend.test.ts` mindestens Marker prüfen für:

```text
data-banking-accounts-panel
yuvomi:banking:accounts-open
aria-expanded
aria-controls
hideAccountDetails
banking-account-card__details[hidden]
```

Weiterhin sicherstellen:

```text
keine data-account-transactions innerhalb der Account-Karten
```

### 12.2 Regression gegen den konkreten Promise-Bug

Mindestens statisch verhindern, dass erneut folgender fehlerhafte Zustand entsteht:

```text
const balancesResult = await Promise.allSettled([singleRequest]);
balancesResult.status
```

Bevorzugt ist allerdings eine kleine testbare Helper-Struktur statt eines Regex-only-Tests.

Wenn ohne große Infrastruktur möglich, Account-Toggle-Logik in kleine pure/helper-nahe Funktionen zerlegen, sodass folgende Zustände getestet werden können:

1. geschlossen -> öffnen
2. offen -> schließen
3. bereits geladen -> erneut öffnen ohne Request
4. Sync geschlossen -> bleibt geschlossen
5. Sync offen -> bleibt offen

Keine neue große DOM-Testbibliothek nur für diesen Umbau einführen.

### 12.3 Backend-Regression

Die bestehenden Tests für:

```text
GET /transactions
Filter
Sortierung
Pagination
Ownership
```

müssen unverändert grün bleiben.

---

## 13. Acceptance Criteria

Die Änderung ist erst fertig, wenn alle folgenden Punkte erfüllt sind.

### Konten-Sektion

- [ ] Die gesamte Konten-Sektion kann ein- und ausgeklappt werden.
- [ ] Zustand der Sektion bleibt während der Browser-Session erhalten.
- [ ] Standard beim ersten Besuch ist offen.

### Einzelnes Konto

- [ ] Jedes Konto ist initial kompakt und geschlossen.
- [ ] Im geschlossenen Zustand sind weder `Salden` noch `Noch nicht geladen` sichtbar.
- [ ] Ein Konto benötigt im Normalzustand nur ungefähr die Höhe seiner Identitäts-/Aktionszeile, nicht den bisherigen großen Block.
- [ ] `Details anzeigen` öffnet das Konto.
- [ ] Button wechselt zu `Details ausblenden`.
- [ ] `Details ausblenden` schließt ohne Netzwerkrequest.
- [ ] Erneutes Öffnen bereits geladener Details benötigt keinen erneuten Balance-Request.
- [ ] `aria-expanded` ist korrekt.
- [ ] `aria-controls` zeigt auf den richtigen Detailbereich.
- [ ] Read-only-Nutzer können Details öffnen.
- [ ] Read-only-Nutzer erhalten keinen Sync-Button.

### Sync

- [ ] Sync eines geschlossenen Kontos lässt es geschlossen.
- [ ] Sync eines offenen Kontos lässt es offen.
- [ ] Nach Sync werden globale Umsätze und Wochenbudget weiterhin aktualisiert.
- [ ] Kein `details.hidden = false` allein als Seiteneffekt des Syncs.

### CSS

- [ ] `.banking-account-card__details[hidden] { display:none; }` oder äquivalente explizite Regel vorhanden.
- [ ] Leeres Feedback erzeugt keine Höhe.
- [ ] Account-Actions stehen auf Desktop möglichst in einer Zeile.
- [ ] Lange Accountnamen sprengen die Row nicht.

### Umsatz-Tabelle

- [ ] Sehr lange Accountnamen drücken Kategorie-/Wochenbudget-Selects nicht mehr auf unbenutzbare Breite.
- [ ] Vollständiger Accountname bleibt über Tooltip/`title` erreichbar.
- [ ] Einnahmen bleiben grün.
- [ ] Ausgaben bleiben rot.
- [ ] Filter, Sortierung und Pagination regressieren nicht.

### Qualität

- [ ] `npm test` grün.
- [ ] `npm run build` grün.
- [ ] GitHub-CI grün.
- [ ] Keine Änderung am Yuvomi-Core.
- [ ] Keine Änderung an `yuvomi.db`.
- [ ] Keine neue DB-Migration für reinen UI-State.

---

## 14. Empfohlene Implementierungsreihenfolge für Codex

Diese Reihenfolge soll eingehalten werden, damit der Umbau klein und überprüfbar bleibt.

### Schritt 1 – konkreten Bug beseitigen

- `loadAccountDetails()` prüfen.
- `Promise.allSettled()` für den Einzelrequest entfernen.
- bestehenden Balance-Load wieder funktional machen.

### Schritt 2 – Account-Toggle implementieren

- `show-account` zu echtem Toggle machen.
- `aria-expanded` / `aria-controls`.
- Lazy Loading + `data-loaded`.
- Schließen ohne Request.

### Schritt 3 – Sync vom Open-State entkoppeln

- `syncAccount()` darf nicht automatisch öffnen.
- geöffneten Zustand bewahren.
- globales Reload-Verhalten erhalten.

### Schritt 4 – Konten kompakt stylen

- Detailbereich mit `[hidden]` wirklich verstecken.
- Feedback `:empty` verstecken.
- Padding/Gaps reduzieren.
- Aktionen horizontal halten.
- Name/Meta kompakt darstellen.

### Schritt 5 – gesamtes Konten-Panel einklappbar machen

- `<details>` in `renderMainMarkup()`.
- Session-State wie bei Umsatzpanel.

### Schritt 6 – Tabellenbreiten nachziehen

- lange Accountnamen begrenzen.
- Select-Spalten schützen.
- keine globale Page-Geometrie ändern.

### Schritt 7 – Locale + Tests

- DE/EN-Key für `Details ausblenden`.
- Frontend-Vertragstests erweitern.
- vollständige Tests/Build.

---

## 15. Nicht Teil dieser Iteration

Nicht gleichzeitig ändern:

- Enable-Banking-Providerlogik
- Consent-Flow
- Datenbankmodell
- Kategorisierungslogik
- OpenAI-Prompting
- Wochenbudget-Berechnungsformel
- GiroCode-Generierung
- Push-Delivery-Architektur
- Yuvomi-Core-Settings-Registry

Diese Iteration ist ein fokussierter **Account-UX- und kleiner Tabellenlayout-Fix** auf der bereits implementierten Redesign-Basis.

---

## 16. Definition of Done

Die gewünschte visuelle Wirkung ist erreicht, wenn die Banking-Seite beim Öffnen ungefähr so gelesen wird:

```text
Banking                                      [Einstellungen]

[ Wochenbudget ............................................... ]

[ ▼ Konten ................................................... ]
  Account 1 · IBAN · EUR                     [Details] [Sync]
  Account 2 · IBAN · EUR                     [Details] [Sync]
  Account 3 · IBAN · EUR                     [Details] [Sync]

[ ▼ Umsätze .................................................. ]
  Filter
  Tabelle

[ Kategorisierung ............................................ ]

[ ▼ Historie ................................................. ]
```

Erst nach Klick auf `Details` wird aus genau **einer** Account-Row:

```text
Account 2 · IBAN · EUR               [Details ausblenden] [Sync]
  Salden
    ITAV  123,45 €
    CLBD  123,45 €
  Händlerlogos laden
```

Alle anderen Konten bleiben kompakt.

Damit ist die Kontenübersicht auch bei mehreren verbundenen Konten schnell scanbar und nimmt nicht mehr den Großteil der Seite ein.
