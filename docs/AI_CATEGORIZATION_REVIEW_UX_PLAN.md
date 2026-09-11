# KI-Kategorisierung als Review-Workflow – technisches Umsetzungskonzept

Stand der Analyse: `6300dd0f4e2d1abfaab627d0f768f2385691d1c4` (`main`).

Dieses Dokument beschreibt die nächste UX-/Workflow-Iteration der KI-Kategorisierung. Ziel ist, aus der heutigen textlastigen Ergebnisliste eine nachvollziehbare Review-Queue zu machen: Der Benutzer muss jederzeit erkennen können, was bereits automatisch passiert ist, welche Umsätze noch geprüft werden müssen, welche neue Kategorie die KI nur vorschlägt und welche konkrete Aktion eine Schaltfläche ausführt.

Die Umsetzung bleibt vollständig in `yuvomi-banking`. Yuvomi Core wird nicht verändert.

---

## 1. Analyse des aktuellen Zustands

### 1.1 Die fachliche KI-Pipeline ist grundsätzlich bereits sinnvoll

`service/src/services/transaction-categorization.ts` macht bereits die richtige grobe Reihenfolge:

1. lokale Regeln anwenden,
2. nur noch ungelöste Umsätze auswählen,
3. höchstens 25 Umsätze pro Batch an den Categorizer geben,
4. existierende Kategorien als Allowlist mitsenden,
5. bei ausreichender Confidence direkt kategorisieren,
6. unsichere Ergebnisse in `ai_categorization_reviews` speichern,
7. neue Kategorien separat in `category_suggestions` sammeln.

Die AI ist also nicht das Hauptproblem. Das Hauptproblem ist die Darstellung und der fehlende Review-Workflow im Frontend.

### 1.2 `renderCategorizationReviews()` ist derzeit nur eine Log-Ausgabe

Datei:

```text
modules/banking/index.js
```

Die Funktion rendert aktuell pro Review praktisch nur:

```text
Händler / Empfänger
Kategorie-Vorschlag · Confidence · reason
```

Es gibt keine direkte Aktion am Review.

Dadurch ist für den Benutzer nicht klar:

- Muss ich etwas tun?
- Wurde die Kategorie schon gespeichert?
- Hat die KI den Umsatz bereits kategorisiert?
- Ist `Shopping` eine existierende Kategorie oder nur ein neuer Vorschlag?
- Was bedeutet `60 %` praktisch?
- Wie korrigiere ich das Ergebnis?
- Was passiert mit dem Review, wenn ich unten eine Kategorie annehme?

Diese Unklarheit ist auf dem aktuellen Screenshot deutlich sichtbar.

### 1.3 Kategorie-Vorschläge und Umsatz-Reviews sind zwei getrennte Dinge

Backend:

```text
GET  /categorization/reviews
GET  /category-suggestions
POST /category-suggestions/:id/accept
POST /category-suggestions/:id/dismiss
```

`acceptCategorySuggestion()` erzeugt bzw. reaktiviert eine Kategorie. Es kategorisiert aber nicht automatisch alle zugehörigen Review-Umsätze.

Das ist fachlich sinnvoll, wird in der UI aber nicht erklärt. Der heutige Button `Kategorie annehmen` klingt so, als würde damit die sichtbare Analyse erledigt. Tatsächlich wird nur der Kategorie-Katalog verändert.

### 1.4 Der manuelle Kategorisierungsweg existiert bereits

Es gibt bereits:

```text
PATCH /transactions/:transactionId/category
```

mit:

```json
{
  "category_id": 12,
  "remember_counterparty": true
}
```

`assignManualTransactionCategory()`:

- kategorisiert den Umsatz,
- setzt `category_source = manual`,
- markiert einen noch offenen AI-Review für diesen Umsatz als `applied`,
- kann optional eine Gegenkonto-Regel speichern,
- kann weitere passende Umsätze desselben Gegenkontos nachziehen.

Dieser existierende Pfad soll der zentrale Weg für die neue Review-UI bleiben. Es wird kein zweiter paralleler Kategorisierungsmechanismus gebaut.

### 1.5 Confidence ist fachlich vorhanden, aber UX-seitig nicht interpretiert

Aktuell gilt im Backend:

```text
AUTO_APPLY_CONFIDENCE = 0.75
```

Das heißt: Eine existierende Kategorie wird ab 75 % automatisch angewendet.

Die UI zeigt bei offenen Reviews dennoch rohe Werte wie:

```text
55 %
60 %
65 %
```

ohne sie einzuordnen.

Für eine Finanzanwendung ist außerdem zu prüfen, ob 75 % als automatische Schwelle langfristig ausreichend konservativ ist. Diese Iteration soll die Schwelle nicht stillschweigend ändern, aber die Entscheidung explizit machen und testbar vorbereiten.

### 1.6 AI-Begründungen sind derzeit teilweise Englisch

Der OpenAI-Prompt fordert aktuell nur eine kurze und sachliche Begründung. Eine Sprache ist nicht vorgeschrieben.

Daher entstehen in einer deutschen UI Texte wie:

```text
Incoming payment.
Internal transfer to Jaqueline & Kevin.
Insurance payment not in allowlist.
```

Die Begründungen sollen künftig in der aktuell konfigurierten Modulsprache, zunächst mindestens Deutsch, erzeugt werden.

---

# 2. Verbindliches UX-Zielbild

Die KI-Sektion wird nicht mehr als Ergebnisprotokoll verstanden, sondern als **Review-Queue**.

Zielstruktur:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ KI-Kategorisierung                            [Neu analysieren]      │
│                                                                      │
│  ✓ 7 automatisch      ! 13 zu prüfen      + 4 neue Kategorien      │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ ZU PRÜFEN (13)                                            [▾]       │
│                                                                      │
│ PayPal Europe S.à r.l.                                  -14,99 €    │
│ Google Payment Ireland                                              │
│                                                                      │
│ KI-Vorschlag   Shopping        ● Unsicher 65 %                      │
│ Begründung     Google-Play-Kauf erkannt.                            │
│                                                                      │
│ [Shopping übernehmen] [Andere Kategorie ▾] [Umsatzdetails]          │
│ ☐ Entscheidung für dieses Gegenkonto merken                         │
│                                                                      │
│ ──────────────────────────────────────────────────────────────────── │
│ Versicherungskammer Bayern                              -31,10 €    │
│ KI-Vorschlag   Versicherungen     ● Unsicher 55 %                   │
│ Neue Kategorie erforderlich                                         │
│ [Kategorie erstellen] [Andere Kategorie ▾] [Umsatzdetails]          │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ NEUE KATEGORIEN (4)                                       [▾]       │
│                                                                      │
│ Versicherungen · Ausgabe · 2 passende Umsätze                        │
│ "Wiederkehrende Versicherungsbeiträge erkannt."                     │
│ [Erstellen] [Name bearbeiten] [Verwerfen]                            │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ AUTOMATISCH ZUGEORDNET                                   [Anzeigen] │
└──────────────────────────────────────────────────────────────────────┘
```

Die drei Zustände müssen visuell und semantisch klar getrennt sein:

1. **Automatisch zugeordnet** – bereits erledigt, kein Handlungszwang.
2. **Zu prüfen** – Umsatz braucht eine Entscheidung.
3. **Neue Kategorie vorgeschlagen** – Kategorie existiert noch nicht; Annahme erzeugt zunächst nur die Kategorie.

---

# 3. Dateien, die geändert werden

## Frontend

```text
modules/banking/index.js
modules/banking/style.css
modules/banking/locales/de.json
modules/banking/locales/en.json
```

## Backend

```text
service/src/api/categorization-routes.ts
service/src/services/transaction-categorization.ts
service/src/openai/categorizer.ts
service/src/services/category-suggestions.ts
```

Optional, wenn die Review-Query sauber ausgelagert wird:

```text
service/src/services/categorization-reviews.ts
```

## Tests

Bevorzugt neue fokussierte Dateien:

```text
service/test/categorization-review-workflow.test.ts
service/test/categorization-summary.test.ts
```

Bestehende Tests nur dort erweitern, wo der vorhandene Fixture-Aufbau passt.

---

# 4. Datenmodell: keine Migration für den ersten UX-Umbau nötig

Die bestehenden Tabellen reichen zunächst aus:

```text
transactions
ai_categorization_reviews
category_suggestions
categories
category_rules
```

Insbesondere enthält `ai_categorization_reviews` bereits:

```text
transaction_id
category_id
confidence
reason
suggested_category_name
suggested_category_type
status
created_at
updated_at
resolved_at
```

Für die erste Review-UI soll daher **keine neue Migration** eingeführt werden.

Wenn später eine echte persistente Run-Historie benötigt wird, kann separat eine `ai_categorization_runs`-Tabelle geplant werden. Diese Iteration soll das nicht vorwegnehmen.

---

# 5. Review-API erweitern

## 5.1 `GET /categorization/reviews` fachlich anreichern

Der bestehende Endpoint bleibt bestehen, soll aber nicht mehr nur rohe DB-Spalten liefern.

Zusätzlich pro Review liefern:

```json
{
  "id": 41,
  "transaction_id": 912,
  "transaction": {
    "merchant_name": "PayPal Europe S.à r.l.",
    "counterparty_name": "PayPal Europe S.à r.l.",
    "purpose": "Google Payment Ireland",
    "amount_cents": -1499,
    "currency": "EUR",
    "direction": "outgoing",
    "booking_date": "2026-09-11"
  },
  "proposal": {
    "category_id": 4,
    "category_name": "Shopping",
    "suggested_category_name": null,
    "suggested_category_type": null,
    "confidence": 0.65,
    "confidence_level": "low",
    "reason": "Google-Play-Kauf erkannt."
  },
  "can_accept_existing": true,
  "requires_new_category": false
}
```

Wenn `category_id = null` und `suggested_category_name` gesetzt ist:

```text
can_accept_existing = false
requires_new_category = true
```

### Ownership

Die heutige Ownership-Prüfung über:

```text
transactions
-> bank_accounts
-> enable_banking_connections.yuvomi_user_id
```

bleibt zwingend erhalten.

### Betrag und Datum

Review-Karten brauchen mindestens Betrag und Datum. Diese Felder sollen direkt in der Review-Query gejoint werden, damit das Frontend nicht je Review einen zweiten Request ausführen muss.

---

# 6. Confidence semantisch abbilden

Neue gemeinsame Backend- oder Frontend-Hilfslogik:

```text
>= 0.90   high
>= 0.75   medium
<  0.75   low
```

Darstellung Deutsch:

```text
high   -> Hohe Sicherheit
medium -> Wahrscheinlich
low    -> Unsicher
```

Englisch:

```text
high   -> High confidence
medium -> Likely
low    -> Low confidence
```

Der Prozentwert bleibt zusätzlich sichtbar.

Beispiel:

```text
● Unsicher · 65 %
```

CSS verwendet keine hartkodierten Inlinefarben. Zustände über `data-confidence="high|medium|low"` stylen.

### Automatische Schwelle

`AUTO_APPLY_CONFIDENCE = 0.75` bleibt in dieser Iteration funktional zunächst bestehen, damit kein versteckter Verhaltenswechsel erfolgt.

Aber:

- Konstante mit Kommentar versehen,
- Tests explizit für 0.74 / 0.75 / 0.90 ergänzen,
- im Plan festhalten, dass vor Production eine bewusste Entscheidung zwischen 0.75 und konservativerem 0.90 getroffen werden soll.

Eine spätere UI-Einstellung der Schwelle ist nicht Bestandteil dieser Iteration.

---

# 7. `renderCategorizationReviews()` komplett ersetzen

Datei:

```text
modules/banking/index.js
```

Die heutige `<ul>`-Logliste wird durch Review-Cards ersetzt.

Neue Struktur pro Review:

```text
article.banking-ai-review
  header
    merchant/payee
    amount
  secondary transaction text
  proposal row
    category proposal
    confidence pill
  reason
  actions
    accept proposal
    category select
    transaction details
  remember-counterparty checkbox
```

### 7.1 Titel

Priorität:

```text
merchant_name
counterparty_name
purpose
"Unbekannter Umsatz"
```

### 7.2 Betrag

Wie in der Umsatz-Tabelle:

```text
incoming -> grün und mit +
outgoing -> rot
```

### 7.3 Purpose

Maximal zwei Zeilen anzeigen; voller Text bleibt über den bereits existierenden Umsatzdetaildialog erreichbar.

### 7.4 Existierende Kategorie vorgeschlagen

Wenn `proposal.category_id` vorhanden:

Primärer Button:

```text
[Shopping übernehmen]
```

Dieser Button ruft **keinen neuen Review-Sonderendpoint** auf, sondern den bestehenden:

```text
PATCH /transactions/:transactionId/category
```

Request:

```json
{
  "category_id": 4,
  "remember_counterparty": true
}
```

Der bestehende Service markiert den offenen AI-Review bereits als `applied`.

### 7.5 `remember_counterparty`

Die Checkbox wird verständlich beschriftet:

```text
☑ Für dieses Gegenkonto künftig merken
```

Default:

```text
true, wenn counterparty_id vorhanden
false/deaktiviert, wenn keine stabile Gegenkonto-ID existiert
```

Wenn möglich soll der Review-Endpoint dafür zusätzlich liefern:

```text
can_remember_counterparty: boolean
```

### 7.6 Andere Kategorie wählen

Jede Review-Card enthält ein kompaktes Select mit allen aktiven Kategorien.

Nach Auswahl:

```text
[Ausgewählte Kategorie übernehmen]
```

oder der primäre Button übernimmt dynamisch den gewählten Wert.

Keine automatische Mutation allein durch `change` am Select; der Review ist eine bewusste Entscheidung und braucht einen expliziten Bestätigungsklick.

### 7.7 Umsatzdetails

Button:

```text
[Umsatzdetails]
```

verwendet den bereits vorhandenen Transaction-Detaildialog und denselben Codepfad wie die Umsatz-Tabelle:

```text
openTransactionDetail(...)
```

Es wird kein zweiter Detaildialog gebaut.

---

# 8. Neue Kategorie innerhalb eines Reviews behandeln

Wenn ein Review enthält:

```text
category_id = null
suggested_category_name = "Versicherungen"
suggested_category_type = "expense"
```

zeigt die Card:

```text
Neue Kategorie vorgeschlagen
Versicherungen · Ausgabe
```

Aktionen:

```text
[Kategorie erstellen]
[Andere Kategorie auswählen]
[Umsatzdetails]
```

### Wichtig

`Kategorie erstellen` darf nicht so wirken, als würde der Umsatz automatisch kategorisiert.

Nach erfolgreicher Erstellung:

```text
Kategorie „Versicherungen“ wurde erstellt.
Jetzt diesem Umsatz zuordnen?

[Versicherungen übernehmen]
```

Alternativ darf das Frontend nach dem Erstellen die Card neu rendern und den normalen vorhandenen Kategorie-Übernehmen-Button anzeigen.

---

# 9. Aggregierte Kategorie-Vorschläge deutlich verbessern

`renderCategorySuggestions()` wird optisch und funktional erweitert.

Heute:

```text
Versicherungen expense · 2 Beispiele · reason
[Kategorie annehmen] [Verwerfen]
```

Neu:

```text
Versicherungen
Typ: Ausgabe
2 passende Umsätze

Begründung:
Wiederkehrende Versicherungszahlungen ohne passende vorhandene Kategorie.

[Erstellen] [Name bearbeiten] [Verwerfen]
```

## 9.1 Beispiele anzeigen

Der Endpoint `GET /category-suggestions` soll pro Vorschlag bis zu 3 passende offene Reviews als Preview mitliefern.

Matching:

```text
ai_categorization_reviews.status = pending
lower(suggested_category_name) = lower(category_suggestions.suggested_name)
suggested_category_type = category_suggestions.suggested_type
```

Preview-Felder:

```text
transaction_id
merchant_name / counterparty_name
amount_cents
currency
booking_date
```

Nicht mehr als 3 Previews je Vorschlag zurückgeben.

Response zusätzlich:

```json
{
  "matching_review_count": 2,
  "examples": [ ... ]
}
```

`sample_count` kann historisch weiterhin existieren; für die aktuelle UI ist `matching_review_count` die wichtigere Zahl.

## 9.2 Vorschlag vor Annahme umbenennen

Der Nutzer muss einen AI-Vorschlag vor dem Erstellen editieren können.

Beispiel:

```text
AI: "Investitionen"
Benutzer: "ETF / Investments"
```

Hierfür nicht `acceptCategorySuggestion()` heimlich mit einem fremden Namen überschreiben.

Sauberer API-Vertrag:

```text
POST /category-suggestions/:suggestionId/accept
```

Body optional:

```json
{
  "name": "ETF / Investments"
}
```

Backend:

- wenn `name` fehlt: bisherigen `suggested_name` verwenden,
- wenn gesetzt: dieselbe zentrale Category-Normalisierung und Validierung wie bei manueller Kategorie-Erstellung verwenden,
- Typ bleibt der vorgeschlagene Typ,
- bestehende Konfliktlogik respektieren.

Damit bleibt der bestehende Endpoint erhalten und wird nur kompatibel erweitert.

---

# 10. Was passiert nach Annahme einer Kategorie?

Nach `accept` soll die API explizit zurückgeben:

```json
{
  "data": {
    "id": 12,
    "status": "accepted",
    "category": {
      "id": 8,
      "name": "Versicherungen",
      "type": "expense",
      "created": true
    },
    "matching_pending_reviews": 2
  }
}
```

Das Frontend zeigt danach:

```text
„Versicherungen“ wurde erstellt.
2 offene Umsätze wurden von der KI dafür vorgeschlagen.

[2 Umsätze prüfen]
```

Wichtig:

> Das Akzeptieren einer Kategorie weist **nicht automatisch** alle Umsätze zu.

Das verhindert gefährliche Bulk-Zuordnungen aufgrund eines bloßen Kategorienamens.

---

# 11. Optionaler expliziter Bulk-Apply

Für den nächsten Schritt kann innerhalb dieser Iteration ein sicherer Bulk-Flow umgesetzt werden, sofern der Aufwand überschaubar bleibt.

Neuer Endpoint:

```text
POST /categorization/reviews/apply-category
```

Request:

```json
{
  "transaction_ids": [912, 913],
  "category_id": 8,
  "remember_counterparty": false
}
```

Regeln:

- `write` Permission,
- CSRF,
- maximal 100 IDs,
- jede Transaction muss dem aktuellen Yuvomi-User gehören,
- Kategorie muss aktiv sein,
- atomare Transaktion,
- `category_source = manual`,
- zugehörige Reviews auf `applied`,
- keine automatische Counterparty-Regel bei Multi-Apply, außer das später separat und explizit designed wird.

Die UI darf Bulk-Apply nur nach einer klaren Zusammenfassung anbieten:

```text
2 Umsätze der Kategorie „Versicherungen“ zuordnen?
[Abbrechen] [2 Umsätze zuordnen]
```

Kein Bulk-Apply beim bloßen Erstellen der Kategorie.

Wenn diese Iteration bewusst kleiner gehalten werden soll, kann dieser Abschnitt auf später verschoben werden. Einzelreview muss jedoch vollständig funktionieren.

---

# 12. Review ablehnen / überspringen

Heute gibt es für `ai_categorization_reviews` keine echte Reject-Aktion.

Das führt dazu, dass ein Review ohne Kategorieentscheidung dauerhaft `pending` bleibt.

Neue Route:

```text
POST /categorization/reviews/:reviewId/dismiss
```

Berechtigung:

```text
write + CSRF
```

Semantik:

```text
status = dismissed
resolved_at = now
updated_at = now
```

Ownership zwingend über Transaction -> Account -> Connection -> User prüfen.

UI:

```text
[Für später überspringen]
```

Nicht `Verwerfen`, weil der Umsatz selbst natürlich nicht verworfen wird. Der Text bedeutet nur:

> Diesen KI-Vorschlag schließen, ohne eine Kategorie zu setzen.

Wenn später erneut analysiert werden soll, muss bewusst entschieden werden, ob dismissed Reviews erneut erzeugt werden dürfen. Für diese Iteration: **nein**, damit der Benutzer nicht denselben abgelehnten Vorschlag bei jedem Run wiederbekommt.

Dafür `unresolvedTransactions()` erweitern:

```text
NOT EXISTS ai_categorization_reviews
WHERE transaction_id = transactions.id
  AND status IN ('pending', 'dismissed')
```

Eine manuelle Kategoriezuordnung aus der normalen Umsatz-Tabelle darf den Umsatz natürlich weiterhin kategorisieren.

---

# 13. Zusammenfassung oben statt Text-Feedback

Die Categorization-Section bekommt eine kompakte Statuszeile.

Benötigte Werte:

```text
pending_review_count
pending_category_suggestion_count
uncategorized_transaction_count
```

Optional:

```text
ai_applied_count
```

## Neuer Endpoint

```text
GET /categorization/summary
```

Response:

```json
{
  "data": {
    "uncategorized": 18,
    "pending_reviews": 13,
    "pending_category_suggestions": 4,
    "ai_applied_total": 7
  }
}
```

`ai_applied_total` ist explizit ein Gesamtwert, solange keine Run-Historie existiert. In der UI nicht als "bei letzter Analyse" beschriften.

Nach einem `POST /categorization/run` kann zusätzlich transient das vorhandene Run-Ergebnis angezeigt werden:

```text
Letzte Analyse: 24 geprüft · 7 automatisch · 13 Review · 4 Kategorie-Vorschläge
```

Diese Meldung muss nach Page Reload nicht persistieren.

---

# 14. Bereiche einklappbar machen

Unterhalb der Summary drei `<details>`-Bereiche:

```text
Zu prüfen (13)                default offen wenn > 0
Neue Kategorien (4)           default offen wenn > 0
Automatisch zugeordnet         default geschlossen
```

SessionStorage:

```text
yuvomi:banking:ai-reviews-open
yuvomi:banking:ai-suggestions-open
yuvomi:banking:ai-applied-open
```

Keine zusätzliche Accordion-Library.

---

# 15. Automatisch kategorisierte Umsätze

Für Transparenz kann eine kleine Liste eingeblendet werden.

Kein neuer komplexer Audit-Store nötig.

Endpoint optional erweitern bzw. neu:

```text
GET /categorization/applied?limit=20
```

Query:

```text
transactions.category_source = 'ai'
owned by current user
ORDER BY updated_at DESC
LIMIT 20
```

Darstellung:

```text
REWE               -> Lebensmittel     94 %
Netflix             -> Abonnements      98 %
```

Aktion:

```text
[Ändern]
```

öffnet entweder die bestehende Umsatzdetailansicht oder verwendet das Kategorie-Select aus der Umsatz-Tabelle.

Dieser Bereich ist sekundär und standardmäßig geschlossen.

---

# 16. OpenAI-Prompt auf UI-Sprache festlegen

Datei:

```text
service/src/openai/categorizer.ts
```

Die Instructions ergänzen:

```text
Return reason in German.
Keep reason concise, factual, and understandable to an end user.
Do not use English category descriptions when the supplied category names are German.
```

Besser als dauerhafte harte Kopplung wäre mittelfristig ein `locale` im Categorizer-Input. Für die aktuelle Anwendung reicht zunächst `de`, sofern das Modul primär Deutsch betrieben wird.

Empfohlene saubere Signatur:

```ts
categorize({
  categories,
  transactions,
  locale: 'de'
})
```

Prompt daraus dynamisch:

```text
Write reason in German (de).
```

Damit bleibt die spätere englische UI möglich.

### Wichtige Trennung

Nur `reason` wird lokalisiert.

Strukturwerte bleiben stabil:

```text
expense
income
transfer
category_id
confidence
```

---

# 17. Kategorienamen nicht blind von der AI übernehmen

Die AI darf weiter Vorschläge machen, aber das Backend validiert weiterhin strikt:

```text
1–80 Zeichen
expense|income|transfer
normalisierte Whitespace-Regeln
```

Zusätzlich im Prompt:

```text
Suggest short reusable category names, not transaction-specific descriptions.
Prefer broad household-finance categories such as Lebensmittel, Versicherungen, Abonnements, Mobilität, Freizeit, Einkommen, Transfers.
Do not include merchant names in category names unless the merchant itself represents a meaningful category.
```

Dadurch soll aus:

```text
"Google Play purchase"
```

nicht etwa eine Kategorie `Google Play Kauf` entstehen, wenn `Digitale Käufe` oder `Abonnements` sinnvoller wäre.

---

# 18. Frontend Event-Flows

## 18.1 Review übernehmen

```text
click data-action="accept-review-category"
-> Review transaction ID lesen
-> gewählte category_id lesen
-> remember checkbox lesen
-> CSRF laden
-> PATCH /transactions/:id/category
-> Review-Card entfernen
-> Summary refresh
-> Transaction table refresh
-> ggf. Kategorien/Rules nicht vollständig neu laden, sofern unverändert
```

## 18.2 Review andere Kategorie

```text
select change
-> nur lokalen Card-State ändern
-> keine API Mutation
-> Button-Label aktualisieren
```

## 18.3 Review überspringen

```text
click data-action="dismiss-categorization-review"
-> POST /categorization/reviews/:id/dismiss
-> Card entfernen
-> Summary refresh
```

## 18.4 Umsatzdetails

```text
click data-action="review-transaction-details"
-> openTransactionDetail(...) wiederverwenden
```

## 18.5 Kategorie-Vorschlag erstellen

```text
click data-action="accept-category-suggestion"
-> optional Dialog zum Editieren des Namens
-> POST /category-suggestions/:id/accept { name? }
-> Category list refresh
-> Suggestions refresh
-> Reviews refresh
-> Summary refresh
```

---

# 19. CSS-Konzept

Neue bzw. neu strukturierte Klassen:

```text
.banking-ai-categorization
.banking-ai-summary
.banking-ai-summary__stat
.banking-ai-section
.banking-ai-section__header
.banking-ai-review-list
.banking-ai-review
.banking-ai-review__header
.banking-ai-review__merchant
.banking-ai-review__amount
.banking-ai-review__proposal
.banking-ai-review__reason
.banking-ai-review__actions
.banking-ai-confidence
.banking-ai-category-suggestions
.banking-ai-category-suggestion
```

### Review-Card

Desktop:

```text
Merchant/Amount in einer Zeile
Proposal + Confidence zweite Zeile
Reason darunter
Actions kompakt darunter
```

Keine riesigen Kartenhöhen.

### Confidence

```css
[data-confidence="high"]
[data-confidence="medium"]
[data-confidence="low"]
```

Farben aus vorhandenen Yuvomi-/Modulvariablen verwenden. Keine neue Designpalette erfinden.

### Mobile

Unter ca. 720 px:

- Header stacked,
- Amount weiterhin rechts oder eigene Zeile,
- Select volle Breite,
- Actions umbrechen,
- Detailbutton und Übernehmen klar getrennt.

---

# 20. Texte / Locales

Mindestens ergänzen:

```text
categorizationSummary
categorizationPendingReviews
categorizationNewCategories
categorizationAutomaticallyApplied
categorizationReviewTitle
categorizationAiProposal
categorizationReason
categorizationConfidenceHigh
categorizationConfidenceMedium
categorizationConfidenceLow
categorizationAcceptProposed
categorizationChooseOther
categorizationRememberCounterparty
categorizationTransactionDetails
categorizationDismissReview
categorizationNewCategoryRequired
categorizationCreateCategory
categorizationCategoryCreated
categorizationMatchingReviews
categorizationReviewTransactions
categorizationEditSuggestionName
categorizationLastRun
```

Deutsche UX-Texte sollen eindeutig sein. Nicht verwenden:

```text
Kategorie angenommen
```

wenn nur die Kategorie erzeugt wurde.

Stattdessen:

```text
Kategorie „Versicherungen“ wurde erstellt. 2 offene Umsätze können jetzt geprüft werden.
```

---

# 21. Tests

## Backend

Mindestens folgende Tests ergänzen:

### Review API

- liefert Betrag, Währung, Datum und Transaction-Daten,
- liefert `confidence_level`,
- anderer Yuvomi-User sieht Review nicht,
- `can_remember_counterparty=false`, wenn keine Counterparty-ID existiert.

### Review übernehmen

Bestehenden Assignment-Service regressiontesten:

- setzt `category_source=manual`,
- Review wird `applied`,
- optional Counterparty-Regel entsteht,
- anderer User kann Transaction nicht übernehmen.

### Review dismiss

- `pending -> dismissed`,
- `resolved_at` gesetzt,
- Ownership geprüft,
- dismissed Umsatz wird bei nächstem AI-Run nicht sofort erneut analysiert.

### Kategorie-Vorschlag

- optionaler angepasster Name wird normalisiert,
- Typ bleibt unverändert,
- Duplicate/Conflict korrekt behandelt,
- Response enthält Anzahl passender offener Reviews.

### AI locale

Mock-Request an OpenAI prüfen:

- Instructions verlangen deutsche Reason,
- Payload enthält weiterhin keine IBAN / Provider IDs / Raw Payloads.

### Summary

- Pending Reviews korrekt,
- Pending Suggestions korrekt,
- uncategorized korrekt user-scoped,
- AI-applied count user-scoped.

## Frontend-nahe Contract Tests

Falls bereits ein geeigneter statischer UI-Contract-Test existiert, ergänzen:

- alte reine `banking-transaction-list`-Reviewdarstellung nicht mehr verwendet,
- Review action data-attributes vorhanden,
- Detaildialog wird wiederverwendet,
- Kategorie-Vorschlag unterscheidet "Kategorie erstellen" von "Umsatz zuordnen".

---

# 22. Implementierungsreihenfolge für Codex

Die Umsetzung soll in dieser Reihenfolge erfolgen:

## Schritt 1 – Backend Review-Contract

1. `GET /categorization/reviews` erweitern.
2. Confidence-Level ableiten.
3. Transaction-Betrag/Datum mitliefern.
4. `can_remember_counterparty` liefern.
5. Tests.

## Schritt 2 – Review-Aktionen

1. Dismiss-Endpoint ergänzen.
2. Existing Transaction Category PATCH als Accept-Pfad beibehalten.
3. `unresolvedTransactions()` für dismissed Reviews absichern.
4. Tests.

## Schritt 3 – Kategorie-Vorschläge

1. Beispiele + matching count liefern.
2. optionalen editierten Namen beim Accept erlauben.
3. Response klar erweitern.
4. Tests.

## Schritt 4 – Summary API

1. `GET /categorization/summary`.
2. User-Scoped Counts.
3. Tests.

## Schritt 5 – Frontend Review-Queue

1. alten Log-Renderer ersetzen,
2. Summary-Header,
3. Review Cards,
4. Confidence Pills,
5. Kategorieauswahl,
6. Übernehmen,
7. Merken-Checkbox,
8. Umsatzdetails,
9. Überspringen.

## Schritt 6 – Vorschlagsbereich

1. neue Kategorie-Cards,
2. Beispiele anzeigen,
3. Name vor Annahme editierbar,
4. nach Erstellung klare Rückmeldung,
5. kein implizites Bulk-Apply.

## Schritt 7 – Prompt-Lokalisierung

1. `locale` sauber an Categorizer geben,
2. deutsche Reasons verlangen,
3. Test der OpenAI-Request-Struktur.

## Schritt 8 – Polish

1. CSS responsive,
2. einklappbare Bereiche,
3. SessionStorage-Zustände,
4. Locales vollständig,
5. Main View nach Aktionen nur gezielt refreshen statt unnötig komplett neu aufzubauen.

---

# 23. Acceptance Criteria

Die Iteration ist erst fertig, wenn folgende Punkte erfüllt sind:

- [ ] Nach einer Analyse sieht der Benutzer sofort, wie viele Umsätze automatisch kategorisiert wurden, wie viele geprüft werden müssen und wie viele neue Kategorien vorgeschlagen wurden.
- [ ] Ein offener Review ist keine reine Textzeile mehr, sondern eine klare Entscheidungseinheit.
- [ ] Bei jedem Review kann eine vorhandene Kategorie gewählt und bewusst übernommen werden.
- [ ] Der Benutzer kann entscheiden, ob die Zuordnung für das Gegenkonto gemerkt wird.
- [ ] Ein Review kann ohne Kategorisierung geschlossen/übersprungen werden.
- [ ] Ein Klick auf `Umsatzdetails` öffnet den bestehenden vollständigen Transaction-Detaildialog.
- [ ] Neue Kategorie-Vorschläge zeigen Beispiel-Umsätze.
- [ ] Kategorie-Vorschläge können vor Erstellung umbenannt werden.
- [ ] Das Erstellen einer Kategorie kategorisiert nicht stillschweigend mehrere Umsätze.
- [ ] Nach Erstellung einer Kategorie ist klar ersichtlich, wie viele Reviews dazu passen.
- [ ] AI-Begründungen werden in der deutschen UI auf Deutsch erzeugt.
- [ ] Confidence wird semantisch als hohe Sicherheit / wahrscheinlich / unsicher dargestellt.
- [ ] Read-only Benutzer können Reviews sehen, aber keine Entscheidungen mutieren.
- [ ] Alle Mutationen verlangen `write` + CSRF.
- [ ] Kein fremder Benutzer kann Reviews oder Transactions eines anderen Benutzers verändern.
- [ ] Bestehende manuelle Kategorie-Regeln bleiben höchste Priorität.
- [ ] OpenAI erhält weiterhin keine IBAN, Provider-IDs oder Raw-Bankdaten.
- [ ] `npm test` und `npm run build` sind grün.

---

# 24. Bewusste Nicht-Ziele

Nicht Teil dieser Iteration:

- neue AI-Provider,
- selbstlernende Embedding-/Vector-Datenbank,
- automatische Änderung historischer manueller Kategorien,
- automatisches Bulk-Kategorisieren beim Erstellen eines Kategorie-Vorschlags,
- Änderung des Yuvomi-Core,
- persistente AI-Run-Historie,
- frei konfigurierbare Confidence-Schwelle in der UI.

---

# 25. Wichtigste Designentscheidung

Die KI-Kategorisierung wird ab jetzt fachlich so betrachtet:

```text
AI analysiert
      ↓
hohe Sicherheit + existierende Kategorie
      ↓
automatisch anwenden

unsicher / keine existierende Kategorie
      ↓
Review-Queue
      ↓
Benutzer entscheidet
      ↓
manuelle Kategorie + optional lernende lokale Regel
```

Die UI darf niemals so aussehen, als wäre eine unsichere AI-Ausgabe bereits eine abgeschlossene Aktion.

Der bestehende Code besitzt dafür bereits fast alle fachlichen Bausteine. Die nächste Iteration soll deshalb keine neue KI-Architektur bauen, sondern die vorhandenen Reviews, Kategorien, Regeln und den Transaction-Detaildialog zu einem verständlichen und sicheren Workflow verbinden.
