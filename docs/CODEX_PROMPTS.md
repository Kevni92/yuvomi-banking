# Codex Prompts

## Prompt 1 - Basis vollständig machen

Analysiere zuerst dieses Repository und danach das lokale Schwesterrepository `../yuvomi`.

Lies insbesondere:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `../yuvomi/MODULES.md`
- `../yuvomi/DESIGN.md`
- `../yuvomi/docs/PAGE-COMPOSITION.md`

Wir bauen ein Yuvomi Third-Party-Modul `banking`.

Verbindliche Regeln:

- Yuvomi Core nicht verändern.
- Niemals `yuvomi.db` öffnen.
- Banking besitzt eine eigene SQLite-Datenbank.
- Sidecar-API ausschließlich `/api/extensions/banking`.
- Session über `GET /api/v1/auth/me` validieren.
- Secrets nur serverseitig.
- keine externen Frontend-CDNs.

Aufgabe für Phase 1:

1. Prüfe die vorhandene Projektstruktur.
2. Korrigiere technische Fehler in der Basis.
3. Stelle sicher, dass das `module.json` zur aktuell lokal installierten Yuvomi-Version passt.
4. Stelle sicher, dass `/m/banking` innerhalb Yuvomis gerendert wird.
5. Vervollständige den Sidecar so, dass `/health` und `/me` funktionieren.
6. Implementiere die von Yuvomi verlangte Permission-Prüfung korrekt.
7. Ergänze automatisierte Tests.
8. Erzeuge eine klare lokale Startanleitung.
9. Führe Tests selbst aus und behebe Fehler.

Noch keine Enable-Banking-Integration implementieren.

Bevor du Dateien änderst, gib einen kurzen Plan aus.

---

## Prompt 2 - SQLite + Verschlüsselung

Implementiere Phase 2 aus `docs/IMPLEMENTATION_PLAN.md`.

Anforderungen:

- eigene `banking.db`
- keine Verbindung zu `yuvomi.db`
- append-only Migrationen
- Verschlüsselungsservice für sensible Werte
- HMAC-SHA256 `counterparty_id`
- IBAN-Normalisierung + Maskierung
- Tests für deterministische HMAC-ID
- Tests, dass keine Klartext-IBAN aus der API geleakt wird
- sensible Werte nicht loggen

Prüfe `service/migrations/001_init.sql` kritisch und passe das Schema an, wenn nötig.

---

## Prompt 3 - Enable Banking Sandbox

Implementiere Phase 3.

Nutze die aktuelle Enable-Banking-Dokumentation und gleiche alle Endpunkte gegen die aktuelle API ab.

Anforderungen:

- Sandbox
- RS256 JWT
- Application ID als konfigurierbarer Wert
- Private Key aus Datei
- Redirect Flow
- Callback
- Session
- Accounts
- Balances
- Transactions
- `continuation_key`
- idempotenter Import
- Consent-Ablauf speichern
- keine echten Secrets im Repo

Erstelle Integrationstests mit gemockten HTTP-Antworten.

---

## Prompt 4 - Kategorisierung

Implementiere Phase 5 anhand `docs/OPENAI_CATEGORIZATION.md`.

Wichtig:

- lokale Regeln zuerst
- nur ungelöste Umsätze an OpenAI
- mehrere Umsätze pro Request
- keine Klartext-IBAN
- stabile `counterparty_id`
- vorhandene Kategorien als Allowlist
- neue Kategorien nur vorschlagen
- Structured Output
- manuelle Korrektur lernt dauerhafte Regel
- Tests für Prioritäten und Datenschutz
