# Implementierungsplan

## Phase 1 - Technische Basis

Ziel:

- Yuvomi-Modul erscheint unter `/m/banking`
- Sidecar läuft auf Port 3100
- Reverse Proxy funktioniert
- `/health`
- `/me` mit echter Yuvomi Session
- Permissions `ext:banking`
- Tests

Noch keine Bankdaten.

## Phase 2 - SQLite + Security-Basis

- konkrete SQLite-Library festlegen
- Migration Runner
- `001_init.sql` prüfen/anpassen
- Verschlüsselungsservice
- HMAC Service
- Tests
- keine sensiblen Daten in Logs

## Phase 3 - Enable Banking Sandbox

- JWT Signierung
- ASPSP-Liste
- Auth Flow
- Callback
- Session
- Konten
- Salden
- Umsätze
- Pagination
- Import-Deduplizierung

Erst Mock/Sandbox.

## Phase 4 - Banking UI

- Kontenübersicht
- Salden
- Umsatzliste
- Detailansicht
- manuelle Kategorie
- Filter
- Sync-Status
- Consent-Status

## Phase 5 - OpenAI Kategorisierung

- Kategorien-Allowlist
- Batch
- Structured Output
- Regeln
- Confidence
- Kategorie-Vorschläge
- Review-UI

## Phase 6 - Händler & Logos

- Händlernormalisierung
- Logo-Registry
- sicherer serverseitiger Logo-Fetcher
- lokaler Cache
- Fallback Initialen

## Phase 7 - Yuvomi Budget Bridge

- Yuvomi Kategorien lesen
- Mapping
- Konten-Mapping
- optional Umsatz -> Budget-Eintrag
- Sync-Mapping verhindern Doppelimporte

## Phase 8 - Wochenbudget

- konfigurierbares Wochenziel
- relevante Sparkassen-Ausgaben erkennen
- Zielbetrag minus direkte Ausgaben
- Transfer-Vorschlag
- Erkennung bereits ausgeführter Transfers

## Phase 9 - GiroCode

- EPC/SEPA QR Payload
- PNG/SVG serverseitig erzeugen
- UI für "Überweisung vorbereiten"
- Zielkonto N26
- Betrag aus Wochenbudget

## Phase 10 - Scheduler + Notifications

- kontrollierter Bank-Sync
- Consent-Warnung
- Sonntags Wochenbudget berechnen
- Yuvomi Notification/Reminder Integration
- API Token nur mit minimalen Scopes

## Phase 11 - Production Hardening

- HTTPS
- Production Enable Banking App
- Secrets als echte Container Secrets
- Backups
- Recovery
- Rate Limit
- Audit Log
- Datenexport
- Datenlöschung
