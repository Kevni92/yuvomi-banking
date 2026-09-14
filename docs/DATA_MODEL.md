# Datenmodell

Die Datei `service/migrations/001_init.sql` ist ein Startvorschlag.

## Wichtigste Entitäten

### Bank Connection

Eine Enable-Banking-Session/Consent-Verbindung.

Bezug zu:

- Yuvomi Benutzer
- Bank/ASPSP
- Ablaufdatum
- beim Bankauswahl-Flow gelieferte `aspsp_maximum_consent_validity` in Sekunden

### Bank Account

Ein konkretes Konto innerhalb der Connection.

`identification_hash` ist die stabile Enable-Banking-Kontoidentitaet ueber
mehrere Sessions hinweg. `provider_account_id`/UID ist dagegen nur fuer die
aktuelle Provider-Session gueltig. Das Matching erfolgt immer zusaetzlich im
Scope desselben Yuvomi-Benutzers.

Ein Konto kann in der eigenständigen Wochenbudget-Konfiguration als Quell- oder
Zielkonto ausgewählt werden. Ein Mapping auf ein Yuvomi-Budgetkonto ist für das
Wochenbudget nicht erforderlich.

### Counterparty

Repräsentiert ein Gegenkonto oder einen erkannten Händler.

Wichtig:

- `counterparty_id`: HMAC der IBAN
- `iban_encrypted`: nur lokal
- `display_name`
- Händlernormalisierung
- Logo

### Payee und Payee-Identifier

Ein `payee` ist eine owner-gescopte, über mehrere ausgehende Umsätze stabile Gegenpartei.
`payees.status` unterscheidet `candidate`, `confirmed` und `ignored`; Zähler und erste/
letzte Buchung werden nicht redundant gespeichert, sondern aus den verknüpften Umsätzen
aggregiert.

`payee_identifiers` enthält ausschließlich domänenseparierte HMAC-SHA256-Werte für
allowlist-geprüfte Merkmale wie SEPA-Gläubiger-ID, Gegenkonto-IBAN, zusätzliche
Kontoidentifikation, Merchant-Key oder konservativ normalisierte Namen. Die legacy-
`counterparty_id`-HMAC wird für bestehende IBAN-Regeln kompatibel wiederverwendet. Die
Tabelle `transaction_payee_evidence` bewahrt die technische Quelle und Stärke der
Entscheidung pro Umsatz, niemals Klartext-Identifier.

### Transaction

Normalisierter Bankumsatz.

Die normalisierten Felder sind die Arbeitsgrundlage der UI und Kategorisierung.

`amount_cents` ist die kanonische Geldrepraesentation als SQLite-`INTEGER`.
`provider_transaction_id` enthaelt den lokalen Deduplizierungsschluessel
(`entry_reference` oder stabiler Fingerprint); der veraenderliche Providerwert
`transaction_id` wird separat fuer Detailabrufe gespeichert.
Der Feldname ist historisch und bedeutet nicht "Enable Banking transaction_id":
`transaction_id` darf niemals als lokale Primary Identity verwendet werden.
`entry_reference` wird bei Bekanntwerden zum bevorzugten lokalen Schlüssel.
`transaction_date` unterstützt die zeitliche Pending/Booked-Reconciliation.
`status` enthält mindestens `PDNG` und `BOOK`; unbekannte Providerwerte werden
robust als `UNKNOWN` gespeichert.

`weekly_budget_override` enthält `inherit`, `include` oder `exclude`. Die
individuelle Entscheidung am Umsatz hat Vorrang vor dem Kategorie-Standard.

Pending/Booked-Datensätze werden nur bei einem eindeutigen Match über Account,
Betrag, Währung, Richtung, Gegenpartei, normalisierten Verwendungszweck,
optionalen MCC und ein plausibles Buchungsfenster zusammengeführt.

Die Migration `024_recurring_payees.sql` ergänzt `transactions` um `payee_id`,
`payee_match_state`, Methode/Confidence und `category_origin_payee_id`. Wiederkehrend
zählen ausschließlich gebuchte ausgehende Umsätze; eingehende, eigene Transfers,
Bargeld- und technische Parteien werden ausgeschlossen. Das Origin-Feld erlaubt beim
Entfernen einer Payee-Kategorie ein präzises Zurücknehmen automatischer Zuordnungen,
ohne manuelle Einzelentscheidungen zu überschreiben.

### Category

Banking-interne Kategorie. `weekly_budget_default` legt fest, ob Umsätze dieser
Kategorie standardmäßig als Wochenbudget-Ausgaben gelten. Das Banking-Modul
benötigt kein Mapping auf Yuvomis Budget-Kategorien.

### Category Rule

Regeltypen:

- `counterparty`
- `merchant`
- `text`

### Category Suggestion

Von AI vorgeschlagene neue Kategorie.

Muss manuell akzeptiert oder verworfen werden.

### Transfer Suggestion

`target_amount_cents`, `computed_amount_cents` und `deducted_amount_cents`
werden ebenfalls als SQLite-`INTEGER` in Cent gespeichert.

Revisionierter Wochenbudget-/Überweisungsvorschlag. Er speichert die
Berechnungsfaktoren, den historischen Periodenbezug, den Überweisungstext, den
Hash des reproduzierbaren EPC-Payloads und erkannte Transferbuchungen.

### Weekly Budget Config

Konfiguration von Quellkonto, Zielkonto, Wochenziel, Wochentag, Uhrzeit,
Zeitzone, regulären Sync-Zeiten und Push-Empfänger.

### Balance Snapshot

Historischer, normalisierter Banksaldo mit Saldoart und Beobachtungszeit. Ein
Stichtagsvorschlag verweist auf genau den verwendeten Snapshot.

### Weekly Budget Period

Unveränderlicher Abschluss einer Woche. Enthält Konfigurationssnapshot,
Periodengrenzen, verwendeten Saldo des Budget-Kontos, Direktausgaben, Ergebnis,
Algorithmusversion und Jobstatus.

### Weekly Budget Period Transaction

Snapshot eines als Direktausgabe einbezogenen Umsatzes einschließlich Betrag,
damaliger Kategorie und Entscheidungsquelle.

### Banking Push Subscription / Notification Delivery

Eigene, einem Yuvomi-Benutzer zugeordnete Web-Push-Subscription sowie die
idempotente Zustellhistorie eines Vorschlags. Subscription-Geheimnisse werden
verschlüsselt gespeichert.

Das genaue Zielschema und seine Constraints stehen in
[`WEEKLY_BUDGET.md`](WEEKLY_BUDGET.md#13-datenmodell).
