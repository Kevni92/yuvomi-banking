# Produktionsdeployment

Ein Produktions-Compose-Deployment bedeutet hier: Der Banking-Sidecar läuft als
eigener, aktualisierbarer Container neben dem bestehenden Yuvomi-Container. Die
Banking-Datenbank liegt in einem eigenen persistenten Volume, sensible Werte
werden als read-only Docker-Secrets eingebunden und der Sidecar-Port wird nur
auf `127.0.0.1` des Hosts veröffentlicht. Der Browser erreicht ihn ausschließlich
über den Reverse Proxy unter derselben Origin wie Yuvomi.

Das Banking-Compose verändert Yuvomi Core nicht und startet absichtlich keinen
zweiten Yuvomi-Container. Es wird als Erweiterung zum bereits laufenden Yuvomi-
Compose-Projekt verwendet.

## Frontend-Modul in Yuvomi installieren

Das Compose-Deployment startet nur den Sidecar. Das Browser-Modul muss zusätzlich
in das vom Yuvomi-Compose gemountete Module-Verzeichnis kopiert werden. Wenn der
Yuvomi-Stack sein Standardverzeichnis `./modules` verwendet, führe auf dem Server
im Verzeichnis des Banking-Repositories aus:

```sh
cp -a modules/banking /pfad/zu/yuvomi/modules/
```

Bei einem Update denselben Kopiervorgang wiederholen und anschließend den
Yuvomi-Container neu starten. Setze `MODULES_DIR` nicht einfach auf das gesamte
Banking-Repository, wenn dort bereits andere Yuvomi-Module installiert sind;
sonst würde der bestehende Module-Bestand durch den Mount verdeckt.

## Einmalige Vorbereitung

Voraussetzungen:

- Docker Engine und Docker Compose v2
- ein laufender Yuvomi-Compose-Stack
- ein gemeinsames Docker-Netzwerk mit dem Yuvomi-Container, normalerweise
  `yuvomi_default`
- ein Reverse Proxy, der HTTPS für die Yuvomi-Domain terminiert

Im Ordner `deploy`:

```sh
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
openssl rand -hex 32 > secrets/counterparty_hmac_secret
openssl rand -hex 32 > secrets/data_encryption_key
chmod 600 secrets/counterparty_hmac_secret secrets/data_encryption_key
```

Lege den Enable-Banking-Private-Key als
`secrets/enablebanking-private.pem` ab und setze ebenfalls restriktive Rechte:

```sh
chmod 600 secrets/enablebanking-private.pem
```

Passe danach mindestens `PUBLIC_ORIGIN` in `.env` an. Der Wert muss exakt der
öffentlichen Yuvomi-Origin entsprechen, zum Beispiel
`https://yuvomi.example.com`. Wenn das Compose-Projekt anders heißt, ermittle
den Netzwerknamen mit `docker network ls` und setze `YUVOMI_NETWORK` entsprechend.

## Start und Update

```sh
docker compose -f docker-compose.production.yml config
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

Der lokale Healthcheck ist danach erreichbar unter:

```sh
curl http://127.0.0.1:3100/api/extensions/banking/health
```

Der Sidecar startet auch ohne Enable-Banking-Credentials. In diesem Zustand
bleiben Bankauswahl und Consent absichtlich deaktiviert beziehungsweise liefern
eine kontrollierte Provider-Fehlermeldung. Für echte Bankdaten müssen
`ENABLE_BANKING_ENV`, `ENABLE_BANKING_APPLICATION_ID` und der passende Private
Key gesetzt sein. Die Callback-URL lautet dann:

`https://<deine-domain>/api/extensions/banking/enablebanking/callback`

Für Updates:

```sh
docker compose -f docker-compose.production.yml up -d --build
```

Das Volume `yuvomi-banking-data` enthält die verschlüsselte `banking.db` und
den lokalen Händlerlogo-Cache. Sichere dieses Volume regelmäßig zusätzlich zu
den Yuvomi-Backups. Der Verschlüsselungsschlüssel darf dabei niemals verloren
gehen oder geändert werden, sonst kann die Datenbank nicht mehr entschlüsselt
werden.

## Reverse Proxy

Der Proxy muss `/api/extensions/banking/*` an `127.0.0.1:3100` weiterleiten und
alle anderen Pfade wie bisher an Yuvomi auf `127.0.0.1:3000`.

- Caddy-Vorlage: `caddy/Caddyfile.production.example`
- Nginx-Vorlage: `nginx-banking-location.example.conf`

Die Enable-Banking-Callback-URL muss exakt dieselbe HTTPS-Origin verwenden wie
`PUBLIC_ORIGIN`. Den Banking-Port nicht direkt ins Internet veröffentlichen.

## OpenAI und Push

Der OpenAI-Key kann nach der Installation in den Banking-Einstellungen hinterlegt
und dort ein Modell ausgewählt werden. Er muss nicht in `deploy/.env` stehen.

Web Push bleibt optional. Ohne vollständige VAPID-Konfiguration läuft der
Sidecar trotzdem; Push-Zustellung wird erst aktiviert, wenn Subject, Public Key
und Private Key vollständig gesetzt sind.
