# Architektur

## 1. Warum ein Sidecar?

Das Yuvomi-Third-Party-Modul ist Browser-Code und besitzt keinen eigenen sicheren Serverkontext.

Banking benötigt jedoch:

- persistente Daten
- einen Scheduler
- Enable-Banking-Private-Key
- OpenAI API Key
- Verschlüsselungsschlüssel
- serverseitige Bank-API-Aufrufe
- serverseitige Session-Verifikation

Daher wird die Integration in zwei Teile getrennt.

## 2. Frontend-Modul

Pfad:

`modules/banking`

Aufgaben:

- Seite `/m/banking`
- Kontenübersicht
- Umsatzliste
- Kategorien bearbeiten
- Kategorie-Vorschläge bestätigen/ablehnen
- Wochenbudget anzeigen
- GiroCode anzeigen
- Händlerlogos darstellen
- Dashboard-Widget

Nicht erlaubt:

- Bank-Credentials
- Private Keys
- OpenAI-Aufrufe direkt aus dem Browser
- direkter DB-Zugriff
- externe Logo-CDNs direkt im Browser

## 3. Sidecar

Pfad:

`service`

Öffentliche API:

`/api/extensions/banking/*`

Aufgaben:

- Yuvomi-Session verifizieren
- Berechtigungen prüfen
- Enable Banking API
- SQLite
- Kategorisierungsregeln
- OpenAI-Batch-Kategorisierung
- Händlerlogo-Cache
- Scheduler
- Wochenbudget
- GiroCode
- Banking-eigene Web-Push-Benachrichtigungen

## 4. Datenhaltung

Es gibt zwei getrennte Datenwelten:

### `banking.db`

Quelle der Wahrheit für Bankdaten.

Enthält:

- Bankverbindungen
- Bankkonten
- Umsätze
- Gegenkonto-IDs
- Kategorisierungsregeln
- AI-Ergebnisse
- Händlerlogos
- Wochenbudget-Einstellungen und Saldo-Snapshots
- historisierte Wochenperioden und Überweisungsvorschläge
- Banking-Push-Abonnements und Zustellhistorie

### `yuvomi.db`

Bleibt ausschließlich Eigentum von Yuvomi Core.

Banking greift niemals direkt darauf zu. Das Banking-Modul besitzt eigene
Kategorien und eine eigene Wochenbudget-Logik. Es verwendet das Yuvomi-Budget
weder zur Berechnung noch zur Historisierung.

Eine spätere, optionale Exportfunktion in das Yuvomi-Budget wäre ein separater
Adapter über die öffentliche `/api/v1`-REST-API. Sie ist nicht Teil des
Wochenbudget-Kernumfangs und darf dessen Betrieb nicht beeinflussen.

## 5. Authentifizierung

Browser:

`Yuvomi Session Cookie`

Sidecar:

1. Browserrequest empfangen
2. Cookie an internes Yuvomi `GET /api/v1/auth/me` weiterreichen
3. Benutzer + Rollen + Rechte aus dieser Antwort übernehmen
4. `ext:banking` prüfen
5. erst danach Banking-Daten zurückgeben

Der Browser darf niemals selbst `user_id` oder Berechtigungen vorgeben.

## 6. Reverse Proxy

Der Browser soll nur eine Origin kennen.

```text
http://localhost:8080/
  /api/extensions/banking/* -> banking sidecar :3100
  alles andere              -> yuvomi :3000
```

Produktiv entsprechend über HTTPS.

## 7. Scheduler

Geplante Jobs laufen ohne Browser-Session und arbeiten ausschließlich mit Daten
aus `banking.db` und Enable Banking. Dafür ist kein Yuvomi-API-Token nötig.

Der Sidecar führt zwei reguläre Bank-Synchronisierungen pro Tag aus. Zusätzlich
erzwingt der konfigurierbare Wochenbudget-Stichtag aus Wochentag, Uhrzeit und
IANA-Zeitzone einen frischen Abruf beider beteiligter Konten. Berechnung,
Historisierung, GiroCode und Push-Outbox folgen erst nach erfolgreichem Abruf.

Push-Abonnements werden vom Banking-Modul selbst verwaltet und bei der Anlage
über die aktuelle Yuvomi-Session einer serverseitig ermittelten Benutzer-ID
zugeordnet. Der Sidecar greift nicht auf Yuvomis interne Push-Tabellen zu.

Details: [`WEEKLY_BUDGET.md`](WEEKLY_BUDGET.md).
