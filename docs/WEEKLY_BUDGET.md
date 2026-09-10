# Wochenbudget und Überweisungsvorschlag

## Ziel

Statt fixer Daueraufträge berechnet Yuvomi Banking jede Woche den tatsächlich nötigen Transfer auf das Ausgabenkonto.

Beispiel:

```text
Wochenziel                450,00 €
Direkt Sparkasse belastet  37,80 €
----------------------------------
Vorschlag N26             412,20 €
```

## Regeln

Der Algorithmus muss konfigurierbar sein.

Insbesondere muss definiert werden:

- welches Konto ist Quelle
- welches Konto ist Ziel
- Wochentag
- Zielbetrag
- welche Kategorien/Transaktionen den Zielbetrag reduzieren
- welche Sparkassenabbuchungen ignoriert werden
- wie bereits erfolgte Transfers erkannt werden

## Transfer-Erkennung

Primär:

- Gegenkonto-ID des N26-Kontos
- Betrag
- Buchungsdatum
- Verwendungszweck

## GiroCode

Der Sidecar erzeugt später einen EPC/SEPA-QR-Code mit:

- Empfängername
- N26 IBAN
- EUR Betrag
- Verwendungszweck

Die Bank führt die Zahlung nicht automatisch aus.
Der Nutzer bestätigt sie weiterhin in der Banking-App.
