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

Optionales Mapping auf ein Yuvomi-Budgetkonto.

### Counterparty

Repräsentiert ein Gegenkonto oder einen erkannten Händler.

Wichtig:

- `counterparty_id`: HMAC der IBAN
- `iban_encrypted`: nur lokal
- `display_name`
- Händlernormalisierung
- Logo

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

Pending/Booked-Datensätze werden nur bei einem eindeutigen Match über Account,
Betrag, Währung, Richtung, Gegenpartei, normalisierten Verwendungszweck,
optionalen MCC und ein plausibles Buchungsfenster zusammengeführt.

### Category

Banking-interne Kategorie.

Kann auf Yuvomi Budget-Kategorie/Subkategorie gemappt werden.

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

Wochenbudget-/Überweisungsvorschlag.

Später Grundlage für GiroCode.
