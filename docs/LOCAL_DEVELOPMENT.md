# Lokale Entwicklung

## Verzeichnislayout

Empfohlen:

```text
projects/
├── yuvomi/
└── yuvomi-banking/
```

## 1. Yuvomi

Im Yuvomi-Repository die lokale `.env` so konfigurieren, dass `MODULES_DIR` auf den Banking-Modulordner zeigt.

Beispiel Windows:

```text
MODULES_DIR=C:\dev\yuvomi-banking\modules
```

Beispiel Linux:

```text
MODULES_DIR=/home/user/dev/yuvomi-banking/modules
```

Dann Yuvomi normal starten.

Erwartet:

`http://localhost:3000`

## 2. Banking Sidecar

Im Ordner `service`:

```text
npm install
```

`.env.example` nach `.env` kopieren und konfigurieren. Der Sidecar lädt diese Datei beim Start automatisch.

Dann:

```text
npm run dev
```

Erwartet:

`http://127.0.0.1:3100`

Health-Test:

`GET http://127.0.0.1:3100/api/extensions/banking/health`

Automatisierte Tests:

```text
npm test
```

Die Session-Prüfung für `GET /api/extensions/banking/me` fragt Yuvomi intern unter
`GET /api/v1/auth/me` ab und akzeptiert den Zugriff nur bei `permissions.modules['ext:banking']` gleich `read` oder `write`.

## 3. Reverse Proxy

Der Browser soll später Yuvomi und Sidecar unter derselben Origin sehen.

Beispiel mit Caddy:

```text
http://localhost:8080
```

Caddyfile liegt unter:

`deploy/caddy/Caddyfile.example`

## 4. Enable Banking Sandbox

Der Redirect muss auf die Proxy-Origin zeigen:

`http://localhost:8080/api/extensions/banking/enablebanking/callback`

## 5. PEM

Private Key ablegen unter:

`secrets/enablebanking-private.pem`

Die Datei ist durch `.gitignore` ausgeschlossen.

## 6. VS Code

Öffne:

`yuvomi-banking.code-workspace`

Damit sieht Codex gleichzeitig:

- dieses Projekt
- das lokale Yuvomi-Repository

Codex darf das Yuvomi-Repo analysieren, aber nicht verändern.
