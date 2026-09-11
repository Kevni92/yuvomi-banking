# Provider-neutrale Kontorollen – technisches Umsetzungskonzept

Stand der Analyse: `a7fe67ee7440d9d544ac3fc284ea8d83d71163d8` (`main`, CI grün am 11.09.2026).

Dieses Dokument beschreibt die nächste Polishing-Iteration vor dem Einsatz mit echten Bankdaten. Ziel ist, das Wochenbudget vollständig von konkreten Banken wie N26 oder Sparkasse zu entkoppeln und im gesamten produktiven Nutzerfluss mit stabilen fachlichen Kontorollen zu arbeiten.

## 1. Zielbild und verbindliche Terminologie

Die fachlichen Rollen heißen ab jetzt:

| Technische Rolle | Deutsche UI-Bezeichnung | Englische UI-Bezeichnung |
|---|---|---|
| `source_account_id` | **Hauptkonto** | **Main account** |
| `target_account_id` | **Budget-Konto** | **Budget account** |

Bedeutung:

- **Hauptkonto**: Konto, von dem die wöchentliche Auffüllung abgeht und auf dem für das Wochenbudget relevante Direktausgaben anfallen können.
- **Budget-Konto**: Konto, dessen aktueller Saldo das noch verfügbare Wochenbudget repräsentiert und auf das die Auffüllung überwiesen wird.

Diese Rollen sind absichtlich unabhängig von Bank, Kontomodell und Provider. Heute kann das Hauptkonto eine Sparkasse und das Budget-Konto N26 sein; später können beide durch andere angebundene EUR-Konten ersetzt werden, ohne Code oder Texte anzupassen.

### Wichtige Architekturentscheidung

**Die bestehenden technischen DB-/API-Feldnamen `source_account_id` und `target_account_id` bleiben unverändert.**

Sie sind bereits provider-neutral und beschreiben die Überweisungsrichtung korrekt. Eine Umbenennung in `main_account_id` / `budget_account_id` würde Migrationen, API-Verträge, Tests und Historientabellen unnötig verändern, ohne fachlichen Mehrwert zu erzeugen.

Die Zuordnung lautet dauerhaft:

```text
source_account_id = Hauptkonto
target_account_id = Budget-Konto
```

Es ist **keine Datenbankmigration** notwendig.

---

## 2. Analyse des aktuellen Stands

Der aktuelle Stand ist technisch bereits gut für eine Provider-neutralisierung vorbereitet:

- `weekly_budget_configs` speichert `source_account_id` und `target_account_id` und keine Banknamen.
- `weekly-budget-overview.ts` lädt beide Konten generisch als `source_account` und `target_account`.
- `serializeWeeklyBudgetSettings()` liefert bereits die tatsächlichen `display_name`-Werte der gewählten Konten.
- Die Berechnung arbeitet ausschließlich mit Account-IDs, Salden und Umsätzen.
- Die neue kompakte Konten-UI aus `48a9ca0` ist umgesetzt.
- Die OpenAI-Konfiguration aus `a7fe67e` ändert an dieser Domänenlogik nichts.

Die Abhängigkeit von N26/Sparkasse ist daher **keine strukturelle Datenmodell-Abhängigkeit**, sondern aktuell hauptsächlich eine Copy-/Darstellungs- und Snapshot-Text-Abhängigkeit.

### 2.1 Aktuell provider-spezifische Runtime-Texte

In `modules/banking/index.js` existieren noch Fallback-Texte wie:

```text
Sparkasse expenses and the current N26 balance determine the next refill.
Available on N26
Sparkasse direct expenses
```

Die deutschen und englischen Locale-Dateien enthalten dieselben Annahmen:

```text
weeklyBudgetDescription
weeklyBudgetAvailable
weeklyBudgetDirect
```

Zusätzlich heißen die beiden Konfigurationsfelder aktuell nur generisch `Quellkonto` / `Zielkonto`. Für die technische API ist das gut; für die Benutzeroberfläche soll jetzt aber die konkrete Fachrolle sichtbar sein: `Hauptkonto` / `Budget-Konto`.

### 2.2 Providername steckt auch in erzeugten historischen Texten

`service/src/services/weekly-budget.ts::buildWeeklyBudgetTransferPurpose()` verwendet aktuell als Default:

```ts
targetAccountLabel ?? 'N26'
```

`service/src/services/weekly-budget-runner.ts` setzt zusätzlich explizit:

```ts
targetAccountLabel: 'N26'
```

Dadurch landet `N26` nicht nur in der UI, sondern im gespeicherten `purpose` eines Überweisungsvorschlags und damit auch im GiroCode-Verwendungszweck.

Beispiel heute:

```text
WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR
```

Das ist für einen echten produktiven Wechsel des Budget-Kontos falsch.

### 2.3 Push-Nachrichten sind ebenfalls provider-spezifisch

`service/src/services/push-outbox.ts::weeklyBudgetPayload()` erzeugt derzeit unter anderem:

```text
450,00 EUR - 30,00 EUR Direkt - 100,00 EUR N26 = 320,00 EUR
```

Auch dieser Text muss rollenbasiert werden.

### 2.4 Die fachliche Spezifikation ist noch auf Sparkasse/N26 zugeschnitten

`docs/WEEKLY_BUDGET.md` beschreibt Quell- und Zielkonto noch explizit als Sparkassen-/N26-Konto und verwendet diese Marken in Ablauf, Berechnung und Beispielen. Dieses Dokument ist die kanonische Fachspezifikation und muss deshalb zusammen mit dem Code provider-neutralisiert werden.

---

## 3. Konkrete UI-Änderungen

### 3.1 Locale-Texte ändern

Dateien:

```text
modules/banking/locales/de.json
modules/banking/locales/en.json
```

Die bestehenden Keys können beibehalten werden; ihre Namen sind technisch neutral genug. Folgende Werte werden verbindlich geändert.

### Deutsch

```text
weeklyBudgetDescription
  = "Direktausgaben über das Hauptkonto und der aktuelle Saldo des Budget-Kontos bestimmen den nächsten Auffüllbetrag."

weeklyBudgetSource
  = "Hauptkonto"

weeklyBudgetTarget
  = "Budget-Konto"

weeklyBudgetBeneficiary
  = "Kontoinhaber des Budget-Kontos"

weeklyBudgetAvailable
  = "Im Budget-Konto verfügbar"

weeklyBudgetDirect
  = "Direktausgaben über das Hauptkonto"

weeklyBudgetChooseSource
  = "Hauptkonto auswählen"

weeklyBudgetChooseTarget
  = "Budget-Konto auswählen"

weeklyBudgetChooseAccounts
  = "Wähle ein Hauptkonto und ein Budget-Konto aus."

weeklyBudgetClosingBalance
  = "Saldo des Budget-Kontos am Stichtag"

weeklyBudgetStatusSourceBooked
  = "Vom Hauptkonto gebucht"

weeklyBudgetStatusTargetBooked
  = "Im Budget-Konto angekommen"
```

### Englisch

```text
weeklyBudgetDescription
  = "Direct expenses paid from the main account and the current budget-account balance determine the next top-up."

weeklyBudgetSource
  = "Main account"

weeklyBudgetTarget
  = "Budget account"

weeklyBudgetBeneficiary
  = "Budget-account holder"

weeklyBudgetAvailable
  = "Available in budget account"

weeklyBudgetDirect
  = "Direct expenses from main account"

weeklyBudgetChooseSource
  = "Choose main account"

weeklyBudgetChooseTarget
  = "Choose budget account"

weeklyBudgetChooseAccounts
  = "Choose a main account and a budget account."

weeklyBudgetClosingBalance
  = "Budget-account balance at cutoff"

weeklyBudgetStatusSourceBooked
  = "Booked from main account"

weeklyBudgetStatusTargetBooked
  = "Arrived in budget account"
```

Andere bereits neutrale Begriffe wie `Wochenziel`, `Stichtag`, `Überweisung`, `GiroCode` und `Direktausgabe` bleiben bestehen.

### 3.2 Fallback-Texte in `index.js` ebenfalls ändern

Datei:

```text
modules/banking/index.js
```

Nicht nur die Locale-Dateien ändern. `localized(key, fallback)` kann den Fallback anzeigen, wenn ein Locale-Key fehlt. Deshalb darf auch **kein Fallback** mehr N26 oder Sparkasse enthalten.

Insbesondere in:

```text
renderMainMarkup()
renderSettingsMarkup()
renderWeeklyBudget()
weeklyBudgetSettingsMarkup()
```

alle provider-spezifischen Fallbacks durch die oben definierten Rollenbegriffe ersetzen.

Nach Umsetzung muss gelten:

```bash
rg -n -i 'N26|Sparkasse|Sparkassen' modules/banking
```

liefert **keinen hartkodierten fachlichen UI-Text**. Reale Banknamen, die zur Laufzeit als `display_name` vom Konto kommen, sind selbstverständlich erlaubt.

---

## 4. Tatsächlich ausgewähltes Konto in der UI sichtbar machen

Nur `Hauptkonto` / `Budget-Konto` zu schreiben ist korrekt, aber bei mehreren Konten soll der Nutzer trotzdem sofort erkennen, welches konkrete Konto diese Rolle aktuell erfüllt.

Die API liefert dies bereits über:

```text
current.settings.source_account.id
current.settings.source_account.display_name
current.settings.target_account.id
current.settings.target_account.display_name
```

Es ist kein Backend-Umbau nötig.

### 4.1 Wochenbudget-Summary

In `renderWeeklyBudget()` sollen die generischen Rollenbezeichnungen stehen, darunter aber der aktuelle Kontoname als Meta-Information.

Zielbild sinngemäß:

```text
Im Budget-Konto verfügbar
100,00 €
N26 Gemeinschaftskonto · 11.09.2026 12:30

Direktausgaben über das Hauptkonto
37,80 €
Girokonto Haushalt · 3 berücksichtigte Umsätze
```

Wichtig: `N26 Gemeinschaftskonto` wäre hier **kein hartkodierter Providername**, sondern der echte `display_name` des vom Benutzer ausgewählten Kontos. Wechselt der Nutzer das Budget-Konto, ändert sich der Text automatisch.

### Konkrete Umsetzung

`weeklySummaryCard()` soll weiterhin für das Layout zuständig sein. Vor dem Aufruf in `renderWeeklyBudget()` einen kleinen Helper verwenden, z. B.:

```text
summaryMeta(accountName, detail)
```

Der Helper verbindet nur nichtleere Werte mit ` · `.

Für Karte 1:

```text
accountName = settings?.target_account?.display_name
detail = Saldo-Zeitpunkt / "Saldo ist veraltet"
```

Für Karte 2:

```text
accountName = settings?.source_account?.display_name
detail = "{count} berücksichtigte Umsätze"
```

Keine Banknamen aus `aspsp_name` oder Provider-spezifische Sonderlogik einbauen.

### 4.2 Kontenliste mit Rollen-Badge

Die kompakte Kontenliste soll die Rollen ebenfalls sichtbar machen.

`loadMainView()` hat Accounts und `weeklyBudgetResult` bereits gleichzeitig verfügbar. Ändere den Aufruf von:

```text
renderAccounts(accountsHost, accounts, canWrite)
```

zu sinngemäß:

```text
renderAccounts(accountsHost, accounts, canWrite, weeklyBudgetSettings)
```

`weeklyBudgetSettings` ist:

```text
weeklyBudgetResult.value?.data?.settings
```

wenn das Wochenbudget konfiguriert ist, sonst `null`.

In `renderAccounts()`:

```text
account.id === settings.source_account.id -> Hauptkonto
account.id === settings.target_account.id -> Budget-Konto
sonst -> kein Rollen-Badge
```

Neue Locale-Keys:

```text
accountRoleMain
accountRoleBudget
```

Deutsch:

```text
Hauptkonto
Budget-Konto
```

Englisch:

```text
Main account
Budget account
```

Das Badge soll klein und sekundär sein und die bestehende kompakte Account-Row **nicht wieder vergrößern**. In `style.css` z. B. als kleine Pill/Meta-Auszeichnung neben dem Kontonamen, nicht als zusätzliche volle Zeile.

Keine Rolle anzeigen, solange kein Wochenbudget konfiguriert ist.

---

## 5. GiroCode-/Verwendungszweck provider-neutral machen

### 5.1 `weekly-budget.ts`

Datei:

```text
service/src/services/weekly-budget.ts
```

In `buildWeeklyBudgetTransferPurpose()` den Default ändern:

```text
alt: targetAccountLabel ?? 'N26'
neu: targetAccountLabel ?? 'Budget'
```

`Budget` ist hier bewusst kürzer als `Budget-Konto`, weil der EPC-Verwendungszweck maximal 140 Zeichen erlaubt und die Funktion bereits eine kompakte Fallback-Darstellung besitzt.

Die Ausgabe wird dann z. B.:

```text
WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 Budget = 320,00 EUR
```

Die Berechnung selbst bleibt unverändert.

### 5.2 `weekly-budget-runner.ts`

Datei:

```text
service/src/services/weekly-budget-runner.ts
```

Den expliziten Providerbezug entfernen:

```ts
targetAccountLabel: 'N26'
```

entfernen und den provider-neutralen Default aus `buildWeeklyBudgetTransferPurpose()` verwenden.

Nicht den echten `display_name` des Budget-Kontos in den SEPA-Verwendungszweck übernehmen. Ein frei von der Bank gelieferter Kontoname kann lang sein, sich ändern und unnötig Provider-/Produktnamen in historische Berechnungssnapshots schreiben. Der Verwendungszweck soll die **fachliche Rolle**, nicht die konkrete Bank enthalten.

### Historische Datensätze

Bereits existierende `transfer_suggestions.purpose` oder historische Perioden **nicht migrieren oder überschreiben**.

Diese Daten sind Snapshots eines damals erzeugten Zahlungsvorschlags. Eine nachträgliche Änderung würde die Historie verfälschen und gegebenenfalls nicht mehr zum gespeicherten `payload_sha256` passen.

Nur neu erzeugte Vorschläge verwenden den neuen provider-neutralen Text.

---

## 6. Push-Benachrichtigungen provider-neutral machen

Datei:

```text
service/src/services/push-outbox.ts
```

In `weeklyBudgetPayload()` ersetzen:

```text
... EUR N26 = ...
```

mit:

```text
... EUR Budget-Konto = ...
```

Der Null-Transfer-Text soll ebenfalls rollenbasiert formuliert werden.

Empfohlen:

```text
alt:
"Ziel und vorhandenes Guthaben decken die neue Woche ab."

neu:
"Wochenziel und Guthaben im Budget-Konto decken die neue Woche ab."
```

Keine konkrete Bank und keinen dynamischen `display_name` in Push-Texte schreiben. Push-Nachrichten können auf dem Sperrbildschirm erscheinen; die Rolle reicht als Kontext und ist datensparsamer.

---

## 7. Tests konkret anpassen und erweitern

### 7.1 `weekly-budget.test.ts`

Tests für `buildWeeklyBudgetTransferPurpose()` auf den neuen Default `Budget` anpassen.

Zusätzlich explizit testen:

```text
kein targetAccountLabel übergeben -> Purpose enthält "Budget", nicht "N26"
optionales explizites neutrales Label funktioniert weiterhin
140-Zeichen-Limit bleibt eingehalten
```

### 7.2 `weekly-budget-runner.test.ts`

Die Fixtures selbst provider-neutral machen. Nicht mehr:

```text
sparkasse-provider
Sparkasse Girokonto
n26-provider
N26
```

sondern z. B.:

```text
main-provider
Main Current Account
budget-provider
Weekly Budget Account
```

Alle Mock-Verzweigungen entsprechend anpassen.

Erwarteter Purpose z. B.:

```text
WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 Budget = 320,00 EUR
```

Erwartete Push-Body-Zeile z. B.:

```text
450,00 EUR - 30,00 EUR Direkt - 100,00 EUR Budget-Konto = 320,00 EUR
```

Der Test soll dadurch künftig selbst dokumentieren, dass die Berechnung nicht an einen Provider gebunden ist.

### 7.3 `weekly-budget-frontend.test.ts`

Bestehende Locale-Key-Prüfung erweitern um:

```text
accountRoleMain
accountRoleBudget
```

Zusätzlich einen Regressionstest ergänzen:

```text
weekly-budget user-facing copy is provider-neutral
```

Der Test liest mindestens:

```text
modules/banking/index.js
modules/banking/locales/de.json
modules/banking/locales/en.json
modules/banking/widgets/weekly-budget.js
```

und prüft case-insensitive:

```text
kein "N26"
kein "Sparkasse"
kein "Sparkassen"
```

Damit kann später nicht versehentlich wieder ein konkreter Provider in die UI eingebaut werden.

### 7.4 Push-/Runner-Regression

Wo bereits Tests den verschlüsselten Push-Payload entschlüsseln, den erwarteten Text auf `Budget-Konto` ändern.

Zusätzlich mindestens eine Assertion:

```text
payload.body enthält weder N26 noch Sparkasse
```

---

## 8. Kanonische Dokumentation bereinigen

Datei:

```text
docs/WEEKLY_BUDGET.md
```

Dieses Dokument muss auf die neue Terminologie umgestellt werden, weil es aktuell noch die frühere persönliche Sparkasse/N26-Konfiguration als allgemeine Systemarchitektur beschreibt.

Verbindliche Ersetzungen auf Bedeutungsebene, nicht blindes Search/Replace:

```text
Sparkassen-Girokonto -> Hauptkonto
N26-Konto -> Budget-Konto
Sparkassen-Ausgabe -> Direktausgabe über das Hauptkonto
N26-Saldo -> Saldo des Budget-Kontos
Sparkassen-App -> Banking-App des Hauptkontos bzw. allgemeine Banking-App
```

Beispiele im Dokument ebenfalls neutral formulieren.

Der Abschnitt "Begriffe" soll danach explizit definieren:

```text
Hauptkonto = technisch source_account_id
Budget-Konto = technisch target_account_id
```

Provider-/Produktspezifische Beispiele dürfen nur dort stehen, wo sie ausdrücklich als Beispiel markiert sind. Die normative Spezifikation selbst darf keine Bank voraussetzen.

`README.md`, `docs/IMPLEMENTATION_PLAN.md` und weitere aktive Dokumentation mit folgendem Audit prüfen:

```bash
rg -n -i 'N26|Sparkasse|Sparkassen' README.md docs modules service/src service/test
```

Jeden Treffer klassifizieren:

1. produktive UI/Runtime-Copy -> **muss entfernt werden**
2. kanonische Fach-/Architekturdokumentation -> **muss neutralisiert werden**
3. Tests/Fixtures -> **soll neutralisiert werden**, damit Provider-Unabhängigkeit sichtbar bleibt
4. echte historische Notiz oder ausdrücklich gekennzeichnetes Beispiel -> darf ausnahmsweise bleiben

Nicht blind reale Laufzeitdaten, ASPSP-Namen oder von Enable Banking gelieferte Kontonamen filtern.

---

## 9. Was ausdrücklich NICHT geändert werden soll

Für diese Iteration keine unnötige Architekturänderung durchführen:

- keine neue DB-Migration
- `source_account_id` nicht umbenennen
- `target_account_id` nicht umbenennen
- `source_account` / `target_account` im REST-Vertrag nicht umbenennen
- keine Änderung der Wochenbudget-Formel
- keine Änderung des Transfer-Matchings
- keine Änderung der Periodenlogik
- keine Änderung von GiroCode-Empfänger/IBAN-Ermittlung
- keine Änderung von Enable-Banking-Account-IDs
- keine automatische Umschreibung historischer `purpose`-Werte

Der Umbau ist eine **Domänenterminologie-/Polishing-Änderung**, keine Datenmodellmigration.

---

## 10. Empfohlene Implementierungsreihenfolge für Codex/Copilot

1. Mit `rg -n -i 'N26|Sparkasse|Sparkassen' .` vollständige Ausgangsliste erzeugen.
2. `de.json` und `en.json` auf Hauptkonto/Budget-Konto umstellen.
3. Alle entsprechenden `localized(..., fallback)`-Fallbacks in `modules/banking/index.js` neutralisieren.
4. `renderWeeklyBudget()` um tatsächliche Account-Display-Namen als Meta-Information ergänzen.
5. `loadMainView()` / `renderAccounts()` um die Rollen-Badges Hauptkonto/Budget-Konto ergänzen.
6. `buildWeeklyBudgetTransferPurpose()` auf Default `Budget` ändern.
7. Explizites `targetAccountLabel: 'N26'` im Runner entfernen.
8. Push-Texte in `push-outbox.ts` neutralisieren.
9. `weekly-budget.test.ts`, `weekly-budget-runner.test.ts` und Push-Assertions anpassen.
10. Provider-Neutralitäts-Test in `weekly-budget-frontend.test.ts` ergänzen.
11. `docs/WEEKLY_BUDGET.md` fachlich auf Hauptkonto/Budget-Konto umstellen.
12. Restliche aktive Dokumentation per `rg` prüfen und sinnvolle Treffer neutralisieren.
13. `npm test` im `service`-Verzeichnis ausführen.
14. `npm run build` ausführen.
15. Abschließend erneut `rg -n -i 'N26|Sparkasse|Sparkassen' modules/banking service/src` ausführen und sicherstellen, dass keine hartkodierte Runtime-Annahme mehr vorhanden ist.

---

## 11. Acceptance Criteria

Die Arbeit ist erst abgeschlossen, wenn alle folgenden Punkte erfüllt sind:

- Die UI bezeichnet die Rollen konsequent als **Hauptkonto** und **Budget-Konto**.
- Die englische UI verwendet **Main account** und **Budget account**.
- Kein sichtbarer Wochenbudget-Text setzt N26 oder Sparkasse voraus.
- Die Wochenbudget-Karten zeigen optional den tatsächlichen ausgewählten Account-Display-Namen, ohne ihn als Fachrolle zu verwenden.
- Die Kontenliste zeigt bei konfiguriertem Wochenbudget kompakte Rollen-Badges für Hauptkonto und Budget-Konto.
- Ein Wechsel des Haupt-/Budget-Kontos erfordert keine Codeänderung und aktualisiert die Rollenanzeige automatisch aus den gespeicherten Account-IDs.
- Neue GiroCode-/Transfer-Purposes enthalten kein `N26` und keine `Sparkasse`.
- Neue Push-Nachrichten enthalten keine hartkodierten Banknamen.
- Historische Vorschläge werden nicht umgeschrieben.
- DB- und REST-Verträge bleiben kompatibel.
- Die Wochenbudget-Berechnung bleibt byte-for-byte fachlich gleich; nur Texte/Rollenbezeichnungen ändern sich.
- Alle Tests und der TypeScript-Build sind grün.
- Die Provider-Neutralität ist durch einen Regressionstest abgesichert.

Damit kann dieselbe Installation später beispielsweise von Sparkasse/N26 auf DKB/Revolut, ING/C24 oder beliebige andere von Enable Banking unterstützte EUR-Konten wechseln, ohne die Wochenbudget-Implementierung erneut anzupassen.