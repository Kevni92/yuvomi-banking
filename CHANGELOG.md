# Changelog

## 2026-09-14

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
