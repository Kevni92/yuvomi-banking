# Changelog

## 2026-09-15

- Wochenbudget-Day-Segment-Fortschritt produktiv ausgerollt: Die beiden Frontend-Assets
  unter `/opt/yuvomi/modules/banking/widgets` berechnen den aktuellen Tagesanteil in der
  konfigurierten Zeitzone und stellen ihn als partielle Segmentfüllung dar.
- Backup-Gate erfolgreich: `yuvomi-2026-09-15_071803.tar.zst.age` wurde erstellt, geprüft,
  verschlüsselt und nach `yuvomi-gdrive:Yuvomi-Backups/daily/2026-09-15_071803/` geladen.
- Verifiziert: lokale und serverseitige SHA-256-Hashes identisch, Yuvomi und Banking healthy,
  alle HTTPS-Healthchecks erfolgreich, keine neuen Banking-Fehlerlogs, weiterhin nur TCP
  22/80/443 öffentlich. Kein Containerneustart erforderlich (Module-Bind-Mount).

Rollback: die beiden vorherigen Dateien aus dem unmittelbar vorherigen Backup gemäß
`/opt/backups/RESTORE.md` wiederherstellen und die Hashes sowie die HTTPS-Healthchecks erneut
prüfen; ein Neustart ist für die statischen Moduldateien nicht erforderlich.

## 2026-09-14

- Produktionskorrektur nach dem Rollout: `/opt/yuvomi/modules/banking` und seine
  Unterverzeichnisse auf `755` gesetzt, damit der Yuvomi-Prozess (`node`, UID 1000)
  `module.json` lesen kann. Backup `yuvomi-2026-09-14_205148.tar.zst.age` war vorher
  erfolgreich erstellt und hochgeladen; Yuvomi danach neu gestartet und verifiziert.

- `017c6fd` – automatische Abbucher-Erkennung umgesetzt: append-only Migration 024,
  owner-gescopte Payee-Identifier/Evidenz, Resolver mit Kandidaten-/Ambiguitätslogik,
  Payee-APIs, Backfill-CLI, lokale Payee-Kategoriepriorität sowie Tabelle und Dialog.
- Produktionsrollout von `017c6fd` erfolgreich. Backup-Gate: `yuvomi-2026-09-14_204127.tar.zst.age`
  unter `yuvomi-gdrive:Yuvomi-Backups/daily/2026-09-14_204127/`; Hash-/Entschlüsselungstest
  und Upload im Backup-Journal bestätigt.
- Backfill Dry-run/Apply: 400 Umsätze, 66 neue Payees, 49 bestätigt, 17 Kandidaten,
  0 Ambiguitäten, 37 Ausschlüsse, 13 eindeutig übernommene Legacy-Regeln.
- Verifiziert: Sidecar und Yuvomi healthy, alle HTTPS-Prüfungen erfolgreich, keine neuen
  Yuvomi-Fehlerlogs, weiterhin nur TCP 22/80/443 öffentlich. Lokale Tests: 198 bestanden.

Rollback: das vorherige bekannte Banking-Image/Artefakt erneut deployen; Migration 024
und die zusätzlichen Spalten bleiben additiv bestehen. Bei notwendiger Datenrestauration
ausschließlich `/opt/backups/RESTORE.md` und eine konsistente Sicherung verwenden.

- `757513d` – Banking-Popovers schließen jetzt bei `focusout`, sobald der Fokus
  das Popup verlässt; Fokuswechsel innerhalb des Popups bleiben möglich.
- Regressionstest im bestehenden Popover-Frontend-Contract ergänzt.
- Produktionsbackup vor dem Rollout erfolgreich: `yuvomi-2026-09-14_195705.tar.zst.age`
  unter `yuvomi-gdrive:Yuvomi-Backups/daily/2026-09-14_195705/`.
- Modul nach `/opt/yuvomi/modules/banking` kopiert und nur der Yuvomi-Container
  neu gestartet. Tests: 184 bestanden; Yuvomi und Banking healthy; HTTPS-Checks
  für Paperless, n8n, Yuvomi und Banking erfolgreich.

Rollback: `git revert 757513d`, danach `modules/banking` erneut ausrollen und
`docker compose -f /opt/yuvomi/compose.yaml restart yuvomi` ausführen.
