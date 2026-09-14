# Changelog

## 2026-09-14

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
