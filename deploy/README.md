# Deployment

Dieser Ordner enthält nur Beispiele.

Für lokale Entwicklung kann Caddy als Reverse Proxy verwendet werden.

Produktiv sollen später getrennte Container verwendet werden:

- Yuvomi
- yuvomi-banking
- Reverse Proxy

Der Banking-Service wird **nicht direkt ins Internet veröffentlicht**.
Nur der Reverse Proxy exponiert:

`/api/extensions/banking/*`

Secrets werden als read-only Mounts bzw. Container-Secrets eingebunden.
