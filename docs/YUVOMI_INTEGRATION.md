# Yuvomi Integration

## Modulpfad

Yuvomi lädt Third-Party-Module aus seinem konfigurierten `MODULES_DIR`.

Für lokale Entwicklung soll Yuvomi direkt auf dieses Repository zeigen:

`<yuvomi-banking>/modules`

Damit bleibt das Yuvomi-Repository unverändert.

## Modul-ID

`banking`

Damit ergeben sich:

- Seite: `/m/banking`
- Permission-Key: `ext:banking`
- Sidecar-API: `/api/extensions/banking`
- Widget-ID: `banking:weekly-budget`

## Yuvomi APIs

Vor Implementierung immer gegen das lokale Yuvomi prüfen.

Für den Kernumfang relevant:

- `GET /api/v1/auth/me`
- `GET /api/v1/auth/users` für die Anzeige des Push-Empfänger-Auswahlfelds
- `GET /api/v1/version`

Das Banking-Modul verwendet keine Yuvomi-Budget-API. Kategorien, Umsätze,
Wochenbudget und Historie liegen in `banking.db`.

## Optionale spätere Budget-Exportbrücke

Banking besitzt eigene Kategorien, kann sie aber auf Yuvomi-Kategorien mappen.

Beispiel:

```text
Banking category "Lebensmittel"
  -> yuvomi_category_key = "groceries"
```

Ein importierter Umsatz bleibt in `banking.db`.

Nur falls später ausdrücklich umgesetzt und aktiviert:

1. Banking kategorisiert den Umsatz.
2. Banking legt per Yuvomi REST API einen Budget-Eintrag an.
3. Rückgabe-ID wird als `yuvomi_budget_entry_id` gespeichert.
4. erneute Imports erzeugen keinen zweiten Eintrag.

Diese Brücke ist ein optionaler Adapter. Sie darf niemals Voraussetzung für
Saldoanzeige, Stichtagsberechnung, Historie, GiroCode oder Push sein.

## Push-Integration

Yuvomis interne Push-Subscriptions können nicht über eine öffentliche API von
einer Extension gezielt verwendet werden. Das Banking-Modul verwaltet deshalb
eigene Web-Push-Subscriptions. Bei der Registrierung bindet der Sidecar sie nach
Prüfung von `GET /api/v1/auth/me` an den tatsächlichen Yuvomi-Benutzer.

Damit benötigt der Scheduler keinen Yuvomi-API-Token und keine Änderung an
Yuvomi Core. Details stehen in [`WEEKLY_BUDGET.md`](WEEKLY_BUDGET.md#11-push-benachrichtigungen).

## Keine direkte DB-Integration

Auch wenn Yuvomi SQLite verwendet, ist direkter Zugriff ausdrücklich nicht Teil des Extension-Vertrags.

Gründe:

- Core-Migrationen können sich ändern
- zwei Writer gefährden Datenintegrität
- Berechtigungslogik könnte umgangen werden
- Updates würden das Banking-Modul unnötig an interne Details koppeln
