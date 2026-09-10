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

Voraussichtlich relevant:

- `GET /api/v1/auth/me`
- `GET /api/v1/version`
- `GET /api/v1/budget/meta`
- `GET /api/v1/budget/categories`
- `GET /api/v1/budget/accounts`
- `POST /api/v1/budget/accounts`
- `POST /api/v1/budget`
- `PUT /api/v1/budget/:id`

## Budget-Integration

Banking besitzt eigene Kategorien, kann sie aber auf Yuvomi-Kategorien mappen.

Beispiel:

```text
Banking category "Lebensmittel"
  -> yuvomi_category_key = "groceries"
```

Ein importierter Umsatz bleibt in `banking.db`.

Wenn der Nutzer die Synchronisation ins Yuvomi-Budget aktiviert:

1. Banking kategorisiert den Umsatz.
2. Banking legt per Yuvomi REST API einen Budget-Eintrag an.
3. Rückgabe-ID wird als `yuvomi_budget_entry_id` gespeichert.
4. erneute Imports erzeugen keinen zweiten Eintrag.

## Keine direkte DB-Integration

Auch wenn Yuvomi SQLite verwendet, ist direkter Zugriff ausdrücklich nicht Teil des Extension-Vertrags.

Gründe:

- Core-Migrationen können sich ändern
- zwei Writer gefährden Datenintegrität
- Berechtigungslogik könnte umgangen werden
- Updates würden das Banking-Modul unnötig an interne Details koppeln
