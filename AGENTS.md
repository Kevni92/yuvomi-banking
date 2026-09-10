# Codex Arbeitsanweisung

## Projektziel

Baue ein eigenständiges Yuvomi-Third-Party-Modul `banking` mit einem separaten Node.js/TypeScript-Sidecar.

## Verbindliche Architekturregeln

1. Yuvomi Core nicht verändern.
2. `yuvomi.db` niemals direkt öffnen oder beschreiben.
3. Alle Banking-spezifischen Daten in der eigenen `banking.db` speichern.
4. Yuvomi ausschließlich über die öffentliche `/api/v1`-REST-API integrieren.
5. Frontend-Modul unter `modules/banking`.
6. Backend-API ausschließlich unter `/api/extensions/banking`.
7. Secrets nie ins Frontend, nie in `module.json`, nie in Git.
8. Enable-Banking-Private-Key nur serverseitig aus einer gemounteten Datei lesen.
9. Echte Gegenkonto-IBAN lokal verschlüsselt speichern.
10. Für externe Klassifizierung nur eine stabile HMAC-ID (`counterparty_id`) statt der IBAN verwenden.
11. Keine externen Frontend-CDNs.
12. Untrusted Strings vor HTML-Ausgabe escapen.
13. Yuvomi-Session serverseitig über `GET /api/v1/auth/me` verifizieren.
14. Schreibende Sidecar-Endpunkte benötigen zusätzlich Origin-Prüfung und eigenen CSRF-Schutz.
15. Änderungen klein und phasenweise halten. Nach jeder Phase Tests ausführen.

## Vor jeder Implementierungsphase

Lies mindestens:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION_PLAN.md`
- die zur Phase passende Fachdokumentation in `docs/`
- im lokalen Schwesterrepo `../yuvomi`:
  - `MODULES.md`
  - `DESIGN.md`
  - `docs/PAGE-COMPOSITION.md`

Wenn eine Annahme über eine Yuvomi-API gemacht wird, prüfe sie gegen das lokale Yuvomi-Repo bzw. dessen OpenAPI.

## Coding-Konvention

- TypeScript im Sidecar
- kleine Services mit klarer Verantwortung
- Node.js >= 22
- keine Secrets in Logs
- keine IBAN oder Bank-Rohdaten an OpenAI
- Datenbankmigrationen append-only
- externe HTTP-Ziele strikt validieren
- keine automatische Erstellung vorgeschlagener AI-Kategorien
