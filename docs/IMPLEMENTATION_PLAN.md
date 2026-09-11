# Implementierungsplan

## Statusübersicht

| Phase | Status | Aktueller Stand |
|---|---|---|
| 1 | Erledigt | Yuvomi-Modul, Sidecar, Reverse Proxy, Session- und Permission-Prüfung |
| 2 | Erledigt | Eigene SQLite-Datenbank, Migrationen, Verschlüsselung, HMAC und Tests |
| 3 | Teilweise erledigt | JWT, ASPSP-, Consent-, Callback-, Konto-, Saldo- und lifecycle-sicherer Import-Adapter inklusive Mock- und Migrations-Tests; echte Sandbox-Anmeldedaten und End-to-End-Test offen |
| 4 | In Arbeit | Bankauswahl, Consent-Start, Verbindungsübersicht, Konten-, Saldo- und Umsatzdarstellung begonnen; vollständige UI offen |
| 5 | Erledigt | Benutzerbezogene Gegenkonto-Regeln, expliziter pseudonymisierter OpenAI-Batch mit Kategorien-Allowlist, Confidence-Schwelle und Review-Liste; neue Kategorien entstehen erst nach explizitem Annehmen, Vorschläge können verworfen werden |
| 6 | Erledigt | Lokale Registry-Normalisierung, serverseitig allowlist-geschützter HTTPS-Fetch ohne Redirects, signatur- und größenbegrenzter lokaler Logo-Cache sowie Initialen-Fallback umgesetzt |
| 7 | Nicht im Kernumfang | Optionale Yuvomi-Budget-Exportbrücke; keine Abhängigkeit des Wochenbudgets |
| 8 | In Arbeit | Datenmodell, Berechnungslogik, Saldo-Snapshots, Stichtagsdienst, Settings-/Current-/Historien-API und UI umgesetzt; eindeutige Transfer-Erkennung sowie `late_candidate`-Erkennung laufen nach regulären, manuellen und Stichtags-Syncs. Schreibberechtigte Benutzer können ungematchte Vorschläge verwerfen oder aus Kandidaten eine unveränderlich dokumentierte Revision erzeugen. |
| 9 | Erledigt | EPC069-12-v3.1-Payload, Empfängersnapshot, SHA-256-Fingerprint, geschützte Metadaten-/PNG-API sowie Anzeige und Download in der Wochenbudget-UI |
| 10 | In Arbeit | Cutoff-Scheduler und zwei tägliche Kontosyncs mit Lease, Idempotenz, Retry, Catch-up und Doppelabruf-Schutz umgesetzt; Banking-eigene Push-Benachrichtigungen offen |
| 11 | Offen | Produktionshärtung |

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
- Import-Deduplizierung inklusive `PDNG`/`BOOK`-Reconciliation und stabilem Fingerprint-Upgrade
- ASPSP-abhängige Consent-Obergrenze (`maximum_consent_validity`)

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

## Phase 7 - Optionale Yuvomi-Budget-Exportbrücke

Diese Phase ist nicht Teil des aktuellen Kernumfangs. Das Wochenbudget besitzt
eigene Kategorien, Daten und Historie und darf weder beim Lesen noch beim
Schreiben von Yuvomis Budget abhängen.

Falls später gewünscht, kann ein separater Adapter kategorisierte Umsätze über
die öffentliche Yuvomi-REST-API exportieren. Fehler oder API-Änderungen dieses
Adapters dürfen das Wochenbudget nicht beeinträchtigen.

## Phase 8 - Wochenbudget

- konfigurierbares Wochenziel
- Quell- und Zielkonto
- Stichtag aus Wochentag, Uhrzeit und Zeitzone
- Kategorie-Standard und Umsatz-Override mit Vorrang des Umsatzes
- persistente, normalisierte Saldo-Snapshots
- relevante Sparkassen-Ausgaben erkennen
- `Zielbetrag - N26-Saldo - Direktausgaben`
- idempotente Perioden, Vorschlagsrevisionen und Historie
- aktuelle Wochenbudget-API und Dashboard-Widget
- Erkennung bereits ausgeführter Transfers auf beiden Konten

## Phase 9 - GiroCode

- EPC069-12-v3.1-Payload mit validierter N26-IBAN
- Drei-Faktoren-Formel und Periodenschlüssel im Verwendungszweck
- PNG serverseitig erzeugen
- Klartext-Zahlungsdaten neben dem QR-Code anzeigen
- Download/Teilen und UI für "Überweisung vorbereiten"
- kein GiroCode bei Betrag `0`

## Phase 10 - Scheduler + Notifications

Status: In Arbeit. Scheduler und frische Stichtagsverarbeitung sind umgesetzt;
die verschlüsselte Subscription-Verwaltung, die idempotente Zustell-Outbox und
die atomare Einreihung neuer Vorschläge sind vorhanden. VAPID-Versand,
Outbox-Leasing, Retry, der isolierte Browser-Worker und die explizite
Subscription-Verwaltung sind umgesetzt. Als Nächstes folgen die Empfängerwahl
über die öffentliche Yuvomi-Benutzerliste und die optionale QR-Vorschau.

- zwei kontrollierte Bank-Syncs täglich
- erzwungener frischer Sync beider Konten am Stichtag
- Consent-Warnung
- konfigurierbarer Wochentag, Uhrzeit und IANA-Zeitzone
- Lease, Idempotenz, Retry und Catch-up nach Sidecar-Ausfall
- eigener Banking-Push-Service-Worker und eigene Web-Push-Subscriptions
- auswählbarer Yuvomi-Benutzer als Empfänger
- Notification-Outbox mit Textformel und Link zum GiroCode
- optionale, kurzlebige QR-Bildvorschau auf unterstützten Plattformen

Die vollständige Spezifikation und Abnahmekriterien stehen in
[`WEEKLY_BUDGET.md`](WEEKLY_BUDGET.md).

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
