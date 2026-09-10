# Security Design

## Secrets

### Enable Banking Private Key

Empfohlen:

`secrets/enablebanking-private.pem`

Nur lokal. Nicht committen.

Produktiv als read-only Secret in den Sidecar mounten.

### Weitere Secrets

- `COUNTERPARTY_HMAC_SECRET`
- `BANKING_DATA_ENCRYPTION_KEY`
- `OPENAI_API_KEY`
- `BANKING_VAPID_PRIVATE_KEY`
- `BANKING_VAPID_PUBLIC_KEY`

Nicht in:

- `module.json`
- Browser Local Storage
- JavaScript-Bundle
- Git
- Logs
- Screenshots

## IBAN

Die echte Gegenkonto-IBAN wird nur lokal gespeichert.

Speicherform:

`iban_encrypted`

Für stabile Wiedererkennung:

`counterparty_id = HMAC-SHA256(normalized_iban, COUNTERPARTY_HMAC_SECRET)`

An OpenAI geht nur `counterparty_id`.

## Wichtig zur Pseudonymisierung

Auch ohne IBAN können Empfängername und Verwendungszweck personenbezogene Daten enthalten.

Deshalb:

- nur notwendige Felder senden
- keine vollständigen Bank-Rohpayloads senden
- möglichst kurze Zwecke
- optional später lokale Redaction personenbezogener Freitexte
- OpenAI-Aufrufe in der UI transparent konfigurierbar machen

## API-Schutz

Für jeden Sidecar-Request:

- Yuvomi-Session verifizieren
- `ext:banking` Permission prüfen
- keine User-ID aus Body/Query vertrauen

Für State Changes zusätzlich:

- Origin gegen `PUBLIC_ORIGIN` prüfen
- eigener CSRF Double-Submit Token
- Ownership/Role prüfen

## Datenverschlüsselung

Browserantworten enthalten bei Konten nur die interne numerische
`bank_accounts.id` sowie fuer die Darstellung noetige Felder. Enable-Banking-UIDs
und andere Provider-IDs bleiben serverseitig; Klartext-IBANs und verschluesselte
DB-Felder werden nie an den Browser gesendet.

Mindestens folgende Felder verschlüsseln:

- IBAN
- Enable-Banking-Sessiondaten, falls sensitiv
- Banking-Web-Push-Endpoints und Subscription-Schlüssel
- ggf. Rohpayloads

Kurzlebige Capability-Tokens für eine GiroCode-Bildvorschau werden nur gehasht
gespeichert. Vollständige Token-URLs dürfen weder im Reverse-Proxy noch im
Sidecar geloggt werden. Die Bildvorschau ist wegen der auf dem Sperrbildschirm
sichtbaren Zahlungsdaten ein ausdrückliches Opt-in.

Rohpayloads nur speichern, wenn für Debugging wirklich nötig.

Bevorzugt:
normalisierte Fachfelder speichern und Raw-Daten minimieren.

## Händlerlogos

Logo-Download ausschließlich serverseitig.

Schutz gegen:

- SSRF
- private IP-Ranges
- Redirect auf private Netze
- riesige Dateien
- falschen Content-Type
- SVG mit aktiven Inhalten

Für den Anfang nur PNG/JPEG/WebP und harte Größenlimits.
