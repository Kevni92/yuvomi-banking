# Händlerlogos

## Ziel

Bei bekannten Unternehmen soll in der Umsatzliste ein Logo erscheinen.

## Architektur

Der Browser darf kein beliebiges externes Logo-CDN direkt ansprechen.

Stattdessen:

1. Händlername normalisieren
2. lokalen Merchant Registry Eintrag suchen
3. falls Logo fehlt: serverseitig beschaffen
4. Datei lokal cachen
5. Browser lädt nur:
   `/api/extensions/banking/logos/<logo-key>`

## Merchant Registry

Beispiele:

```text
REWE Markt GmbH -> merchant_key "rewe"
Netflix.com     -> merchant_key "netflix"
Shell Deutschland -> merchant_key "shell"
```

## Sicherheit

Der spätere Fetcher braucht:

- Domain-Allowlist oder streng validierte öffentliche HTTP(S)-Ziele
- DNS/IP-Prüfung gegen private Netze
- Redirect-Prüfung
- Größenlimit
- Timeout
- Content-Type-Allowlist
- SVG zunächst vermeiden

## Fallback

Wenn kein Logo existiert:

- neutraler Kreis
- erste 1-2 Buchstaben des normalisierten Händlernamens

Die Umsatzliste darf nicht davon abhängen, dass ein Logo erfolgreich geladen wird.
