# Datenmodell

Die Datei `service/migrations/001_init.sql` ist ein Startvorschlag.

## Wichtigste Entitäten

### Bank Connection

Eine Enable-Banking-Session/Consent-Verbindung.

Bezug zu:

- Yuvomi Benutzer
- Bank/ASPSP
- Ablaufdatum

### Bank Account

Ein konkretes Konto innerhalb der Connection.

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

Wochenbudget-/Überweisungsvorschlag.

Später Grundlage für GiroCode.
