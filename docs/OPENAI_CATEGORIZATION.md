# OpenAI Kategorisierung

## Ziel

Nicht jeder Umsatz soll einen AI-Request erzeugen.

Priorität:

1. manuelle exakte Gegenkonto-Regel
2. gelernte Gegenkonto-Regel
3. Händlerregel
4. Textregel
5. erst dann OpenAI

## OpenAI Batch

Ungeklärte Umsätze werden zusammengefasst.

Beispiel eines logischen Items:

```text
transaction_id: 481
counterparty_id: 2d84...
counterparty_name: REWE Markt GmbH
merchant_name: REWE
purpose: Kartenzahlung REWE Neustadt
amount: -62.41
currency: EUR
direction: outgoing
mcc: 5411
```

Nicht senden:

- IBAN
- Konto-ID von Enable Banking
- vollständigen Bank-Rohpayload
- Zugangsdaten
- Session-Tokens

## Kategorien-Allowlist

OpenAI erhält die aktuell erlaubten Kategorien mit stabilen IDs.

Antwort darf nur enthalten:

- vorhandene `category_id`
- Confidence
- kurze Begründung
- optional einen neuen Kategorie-Vorschlag

Ein neuer Vorschlag wird in `category_suggestions` gespeichert.

Er wird **nicht automatisch** als Kategorie angelegt.

## Lernen

Wenn der Nutzer eine Kategorie manuell korrigiert:

- gibt es `counterparty_id`: exakte Regel erzeugen/aktualisieren
- sonst bei eindeutigem Händler: Händlerregel
- sonst optional Textregel

Manuelle Regeln haben höchste Priorität.

## Confidence

Vorschlag:

- >= 0.93: automatisch anwenden
- 0.75 - 0.92: anwenden, aber als AI markiert
- < 0.75: "Prüfen" anzeigen

Die Grenzwerte sollen später konfigurierbar sein.
