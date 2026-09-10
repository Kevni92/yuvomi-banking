# Enable Banking Integration

## Konfiguration

Nicht geheim:

- Environment: `sandbox` / später `production`
- Application ID
- API Base URL

Geheim:

- RSA Private Key

## Aktueller Implementierungsstand

Der Sidecar enthält bereits JWT-Signierung, ASPSP-Abfrage, Consent-Start,
Callback, Session-Verarbeitung, Konten-, Salden- und Umsatzabruf sowie
idempotenten Import. Diese Pfade sind mit Mock-Provider-Tests abgesichert.

Für den echten Sandbox-Flow fehlen noch die Enable-Banking-Application-ID,
der serverseitige Private Key und ein End-to-End-Test mit einer Sandbox-Bank.
Ohne diese Werte bleiben Health, Yuvomi-Session und die lokale UI erreichbar;
Provider-Aufrufe werden kontrolliert als nicht verfügbar gemeldet.

Die Response-Formen und Filter folgen der [offiziellen Enable-Banking-API-Referenz](https://enablebanking.com/docs/api/reference/).
Insbesondere werden `POST /sessions` (`AccountResource[]`) und
`GET /sessions/{session_id}` (Account-IDs plus `accounts_data`) getrennt
modelliert.

### Consent-Dauer

`GET /aspsps` liefert pro ASPSP `maximum_consent_validity` in Sekunden. Die
Bankauswahl behält die vollständigen ASPSP-Objekte im Browser, aber der
Consent-Start lädt die Liste serverseitig erneut und akzeptiert ausschließlich
die exakte Kombination aus ASPSP-Name und Land. Werte aus dem Browser können
die Dauer daher nicht beeinflussen.

Die gewünschte Standarddauer beträgt 90 Tage. Ist ein gültiges Maximum
vorhanden, wird serverseitig `min(90 Tage, maximum_consent_validity)`
angefordert. Fehlt das Maximum oder ist es ungültig, wird vorsorglich nur eine
30-tägige Dauer verwendet. Die verwendete Provider-Grenze wird zusätzlich an
der Verbindung gespeichert. Enable Banking kann zu kurze Werte wegen einer
ASPSP-Mindestdauer anpassen; das ist Providerverhalten und keine Erlaubnis,
die gespeicherte Obergrenze zu überschreiten. Beim Callback wird deshalb der
serverseitig berechnete Wert beibehalten und nicht durch einen Providerwert
verlängert.

## Geplanter Ablauf

1. Banken/ASPSPs laden (`country`, `psu_type=personal`, `service=AIS`; eine Namenssuche erfolgt lokal)
2. Auth-Request erstellen
3. Benutzer zur Bank weiterleiten
4. Callback im Sidecar empfangen
5. Session erzeugen
6. Konten speichern; `POST /sessions` liefert AccountResource-Objekte direkt
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

Der lokale Schluessel `provider_transaction_id` ist dabei nur der
Deduplizierungsschluessel:

`<entry_reference>` oder, wenn `entry_reference` fehlt, ein kanonischer
Fingerprint aus stabilen Umsatzmerkmalen. `transaction_id` wird separat fuer
spaetere Detailabrufe gespeichert und darf nicht Teil des Fallback-Fingerprints
sein, weil Enable Banking diesen Wert bei spaeteren Abrufen aendern kann.

`entry_reference` und `transaction_id` sind Providerwerte. Sobald eine echte
`entry_reference` bekannt ist, ersetzt sie den lokalen Fingerprint als
`provider_transaction_id`. Alte `fallback-*`-Schlüssel werden beim Sync nur
bei einer eindeutigen, streng geprüften Zuordnung auf den neuen Schlüssel
umgestellt; bei Mehrdeutigkeit bleibt der alte Datensatz unangetastet.

Der Providerstatus wird in `transactions.status` als `PDNG`, `BOOK` oder
`UNKNOWN` gespeichert. Beim erneuten Abruf wird ein eindeutiger Übergang von
`PDNG` zu `BOOK` reconciled: gleicher Account, Betrag, Währung und Richtung
sowie ein exakt normalisierter Empfänger und Verwendungszweck sind zwingend;
MCC und ein plausibles Sieben-Tage-Fenster werden zusätzlich geprüft.
Mehrere passende Datensätze gelten als Mehrdeutigkeit und werden nicht
automatisch zusammengeführt.

Geldbetraege werden in `amount_cents` bzw. den `*_amount_cents`-Feldern als
SQLite-`INTEGER` gespeichert. Die HTTP-Antwort formatiert sie nur fuer die UI.

## Re-Consent

`valid_until` je Verbindung speichern.

Enable Banking vergibt bei jeder neuen Session neue Account-UIDs. Das Banking
matcht deshalb innerhalb desselben Yuvomi-Benutzers ueber
`identification_hash` und aktualisiert die Provider-UID am bestehenden
`bank_accounts.id`. So bleiben Umsaetze und Budget-Mappings erhalten.

Der OAuth-State wird mit `state_expires_at` etwa 15 Minuten gueltig gemacht und
im Callback atomar genau einmal von `pending` nach `exchanging` ueberfuehrt.
Danach ist der Hash ungueltig. Nach erfolgreicher lokaler Speicherung folgt
`authorized`, bei Fehlern `failed`.

Die vollstaendigen Providerdaten werden vor der lokalen SQLite-Schreibtransaktion
normalisiert. Ein zusaetzlicher `/details`-Abruf ist im Callback daher nicht
noetig. Wenn die lokale Speicherung nach einem erfolgreichen `POST /sessions`
fehlschlaegt, wird `DELETE /sessions/{session_id}` best effort ausgefuehrt.

UI soll rechtzeitig anzeigen:

"Bankverbindung muss erneut bestätigt werden."

## Sync

Kein aggressives Polling.

`GET /accounts/:id/transactions` liest die bereits lokal gespeicherten
Umsaetze und ist fuer `read` und `write` verfuegbar. Ausschliesslich
`POST /accounts/:id/sync` ruft den Provider ab und benoetigt `write`.

Der Sidecar soll:

- letzten erfolgreichen Sync speichern
- per Scheduler kontrolliert abrufen
- bei Rate Limits Backoff verwenden
- manuelle Aktualisierung erlauben
