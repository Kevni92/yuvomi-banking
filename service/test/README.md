# Tests

Phase 1 ist mit folgenden Tests abgedeckt:

- `GET /api/extensions/banking/health`
- Yuvomi Session-Forwarding für `/me`
- Permission `none/read/write`

Ab Phase 2 zusätzlich:

- HMAC-ID deterministisch
- IBAN-Masking
- DB-Migrationen idempotent
- Enable-Banking-Pagination
- Import-Deduplizierung
- Rule-Prioritäten
- OpenAI Structured Output
- keine IBAN im OpenAI-Payload
- Wochenbudget-Zuordnung (`Umsatz > Kategorie > Standard`)
- Cent-genaue Transferberechnung und Periodengrenzen
- historisierte Perioden und Vorschlagsrevisionen
- EPC/GiroCode-Payload und Längenlimits
- idempotenter Stichtags-Scheduler
- Banking-Push-Zuordnung und Notification-Outbox
