# Changelog

## 2026-09-17

- Banking-Modul auf den Zielstand `9184c7a` aktualisiert: direkte Wochenbudget-Ausgaben
  werden im Dashboard berücksichtigt und das Effective-Remaining-Widget ist registriert.
  Der Yuvomi-Container wurde neu geladen.
- Backup-Gate erfolgreich: `yuvomi-2026-09-17_222045.tar.zst.age` wurde erstellt, geprüft,
  verschlüsselt und nach `yuvomi-gdrive:Yuvomi-Backups/daily/2026-09-17_222045/` geladen.
- Verifiziert: `module.json` und `weekly-budget-effective-remaining.js` per SHA-256 identisch,
  alle 204 Tests sowie alle HTTPS-Healthchecks erfolgreich, keine neuen Fehlerzeilen und
  weiterhin nur TCP 22/80/443 öffentlich.

Rollback: die beiden vorherigen Moduldateien aus dem Backup gemäß `/opt/backups/RESTORE.md`
wiederherstellen, den Yuvomi-Container neu laden und Hashes sowie Healthchecks erneut prüfen.

## 2026-09-17

- Banking-Modul auf Commit `2d25eb4` aktualisiert: Kalenderwochen-Widget, vier tägliche
  Abrufzeiten und der intraday Tagesfortschritt sind unter `/opt/yuvomi/modules/banking`
  installiert. Der Yuvomi-Container wurde neu geladen.
- Backup-Gate erfolgreich: `yuvomi-2026-09-17_203217.tar.zst.age` wurde erstellt, geprüft,
  verschlüsselt und nach `yuvomi-gdrive:Yuvomi-Backups/daily/2026-09-17_203217/` geladen.
- Verifiziert: alle sieben Moduldateien per SHA-256 identisch, Yuvomi und Banking healthy,
  alle vier HTTPS-Healthchecks erfolgreich, keine neuen Fehlerzeilen und weiterhin nur TCP
  22/80/443 öffentlich.

Rollback: die sieben vorherigen Moduldateien aus dem Backup gemäß `/opt/backups/RESTORE.md`
wiederherstellen, den Yuvomi-Container neu laden und dieselben Hashes sowie Healthchecks prüfen.

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
