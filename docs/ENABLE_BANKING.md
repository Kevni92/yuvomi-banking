# Enable Banking Integration

## Konfiguration

Nicht geheim:

- Environment: `sandbox` / später `production`
- Application ID
- API Base URL

Geheim:

- RSA Private Key

## Geplanter Ablauf

1. Banken/ASPSPs laden
2. Auth-Request erstellen
3. Benutzer zur Bank weiterleiten
4. Callback im Sidecar empfangen
5. Session erzeugen
6. Konten speichern
7. Salden laden
8. Umsätze laden
9. Pagination über `continuation_key`
10. periodisch synchronisieren

## Redirect URL lokal

Mit lokalem Reverse Proxy:

`http://localhost:8080/api/extensions/banking/enablebanking/callback`

Diese URL muss exakt in der Enable-Banking-Application hinterlegt werden.

## Redirect URL produktiv

Beispiel:

`https://yuvomi.example.de/api/extensions/banking/enablebanking/callback`

## Import

Import muss idempotent sein.

Unique Key mindestens:

`(account_id, provider_transaction_id)`

Wenn die Bank keine stabile Transaction-ID liefert, wird später ein kontrollierter Fallback-Fingerprint benötigt.

## Re-Consent

`valid_until` je Verbindung speichern.

UI soll rechtzeitig anzeigen:

"Bankverbindung muss erneut bestätigt werden."

## Sync

Kein aggressives Polling.

Der Sidecar soll:

- letzten erfolgreichen Sync speichern
- per Scheduler kontrolliert abrufen
- bei Rate Limits Backoff verwenden
- manuelle Aktualisierung erlauben
