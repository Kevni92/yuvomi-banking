# Händlernormalisierung und Logos

## Lokale Normalisierung

Das Banking-Sidecar normalisiert nur Händler aus einer fest hinterlegten
Registry. Unbekannte Gegenparteien, Namen und Verwendungszwecke werden nicht
als Händler übernommen. Damit werden private Empfänger nicht versehentlich zu
einer wiedererkennbaren Händleridentität zusammengefasst.

Die Registry enthält einen stabilen `merchant_key`, einen Anzeigenamen und
bekannte Schreibweisen. Der Import aktualisiert `transactions.merchant_key` und
`transactions.merchant_name` ausschließlich bei einem Registry-Treffer.

Beispiele:

```text
REWE Markt GmbH         -> merchant_key "rewe"
Netflix.com             -> merchant_key "netflix"
LIDL Filiale 123        -> merchant_key "lidl"
Unbekannte Privatperson -> kein merchant_key
```

## Logo-Registry und Cache

Der Browser lädt niemals ein externes Logo. Fehlt ein lokales Logo, zeigt die
Umsatzliste Initialen. Ein schreibberechtigter Benutzer kann fehlende Logos
pro Konto ausdrücklich laden.

Der Browser ruft dabei ausschließlich die geschützte lokale Route
`/api/extensions/banking/merchant-logos/<merchant-key>` auf. Der Ablauf lautet:

1. Händlername lokal normalisieren
2. Registry-Eintrag suchen
3. fehlendes Logo serverseitig laden
4. Datei lokal cachen
5. lokales Logo oder Initialen anzeigen

Der Sidecar akzeptiert dabei nur die fest verdrahtete HTTPS-Quelle eines
Registry-Eintrags. Er akzeptiert keine URL aus Browser, Datenbank oder
Provider-Payload, folgt keinen Redirects, erlaubt nur PNG/JPEG/WebP/ICO,
begrenzt die Größe auf 512 KiB und prüft die Dateisignatur. Die Bytes werden
unter `MERCHANT_LOGO_CACHE_DIR` (standardmäßig `data/merchant-logos`) abgelegt
und anschließend ausschließlich über die geschützte Sidecar-Route ausgeliefert.

Nicht erreichbare oder ungültige Quellen bleiben beim Initialen-Fallback; ein
Fehler verhindert weder den Import noch die Umsatzanzeige.
