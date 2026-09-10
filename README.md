# Yuvomi Banking

Basisprojekt für ein eigenständiges Banking-Modul für Yuvomi.

## Ziel

Das Projekt integriert Bankkonten über Enable Banking in Yuvomi, ohne Yuvomi Core zu verändern.

Geplante Kernfunktionen:

- Bankkonten und Umsätze über Enable Banking synchronisieren
- Sparkasse und N26 über dieselbe Provider-Schicht anbinden
- Umsätze lokal in einer eigenen SQLite-Datenbank speichern
- Gegenkonten stabil über eine HMAC-basierte `counterparty_id` erkennen
- Kategorien über lokale Regeln und OpenAI-Batch-Klassifizierung zuordnen
- neue Kategorien nur vorschlagen, nicht automatisch anlegen
- bekannte Händler mit lokal gecachten Logos darstellen
- Yuvomi-Budget-Kategorien und -Einträge über die öffentliche Yuvomi REST API nutzen
- Wochenbudget berechnen
- GiroCode/SEPA-QR für Überweisungsvorschläge erzeugen
- spätere Push-/Reminder-Integration

## Architektur

Yuvomi Third-Party-Module sind Browser-Code. Persistenz, Scheduler und Credentials gehören in einen separaten Sidecar-Service.

```text
Browser
  |
  +-- /m/banking
  |      Yuvomi Frontend-Modul
  |
  +-- /api/extensions/banking/*
              |
              v
      Banking Sidecar
      Node.js + TypeScript
              |
       +------+--------+---------+
       |               |         |
       v               v         v
  banking.db     Enable Banking  OpenAI
       |
       +------> Yuvomi REST API /api/v1/*
```

## Wichtige Regel

**Das Banking-Modul öffnet oder verändert niemals `yuvomi.db` direkt.**

Banking-spezifische Daten liegen in `banking.db`. Wenn Daten in Yuvomi erscheinen sollen, geschieht dies ausschließlich über `/api/v1`.

## Projektstruktur

```text
yuvomi-banking/
├── AGENTS.md
├── README.md
├── yuvomi-banking.code-workspace
├── modules/
│   └── banking/
├── service/
│   ├── src/
│   ├── migrations/
│   └── test/
├── docs/
├── deploy/
├── data/
└── secrets/
```

## Schnellstart für Codex

1. Dieses Projekt entpacken.
2. Das Yuvomi-Repository als Schwesterordner klonen:
   `../yuvomi`
3. `yuvomi-banking.code-workspace` in VS Code öffnen.
4. `docs/LOCAL_DEVELOPMENT.md` lesen.
5. Danach den ersten Prompt aus `docs/CODEX_PROMPTS.md` an Codex geben.

Das Sidecar enthält die technische Basis, die Sicherheitsdienste und den Enable-Banking-Adapter. Die echte Sandbox-Verbindung und weitere Banking-Funktionen werden phasenweise ergänzt.

## Phase 1 lokal starten

Voraussetzung: Node.js 22 oder neuer.

1. Yuvomi als Schwesterordner neben `yuvomi-banking` bereitstellen. Das Banking-Repo verändert Yuvomi nicht.
2. In Yuvomi `MODULES_DIR` auf den absoluten Pfad zu `yuvomi-banking/modules` setzen und Yuvomi starten.
3. Das Sidecar starten:

   ```powershell
   Set-Location service
   Copy-Item .env.example .env
   npm install
   npm run dev
   ```

   Das Sidecar lauscht danach auf `http://127.0.0.1:3100`.

4. Den Reverse Proxy aus `deploy/caddy/Caddyfile.example` auf Port 8080 starten und Yuvomi über `http://localhost:8080` öffnen. So bleibt die Sidecar-API same-origin unter `/api/extensions/banking`.

Schnelltests:

```powershell
Invoke-RestMethod http://127.0.0.1:3100/api/extensions/banking/health
Set-Location service
npm test
```

`/api/extensions/banking/me` funktioniert nur mit einem gültigen Yuvomi-Session-Cookie und der Yuvomi-Berechtigung `ext:banking` (`read` oder `write`).
