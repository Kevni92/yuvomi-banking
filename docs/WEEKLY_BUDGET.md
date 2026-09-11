# Eigenständiges Wochenbudget, Überweisungsvorschlag und GiroCode

## 1. Status und Ziel dieses Dokuments

Dieses Dokument ist die verbindliche Fach- und Umsetzungsspezifikation für das
Wochenbudget im Banking-Modul.

Das Wochenbudget wird vollständig im Banking-Sidecar und in `banking.db`
umgesetzt. Es verwendet weder Tabellen noch Berechnungen noch Kategorien des
Yuvomi-Budget-Moduls. Dadurch bleibt die Funktion unabhängig von Änderungen am
Yuvomi-Budget-Modul.

Yuvomi wird nur für folgende Plattformfunktionen verwendet:

- Anmeldung und Ermittlung des aktuellen Benutzers
- Anzeige der Yuvomi-Benutzer im Empfänger-Auswahlfeld
- Berechtigungen des Third-Party-Moduls (`ext:banking`)
- Einbindung der Banking-Seite und des Dashboard-Widgets
- Zuordnung eigener Banking-Push-Abonnements zu einem Yuvomi-Benutzer

Das Ziel ist ein wöchentlicher, nachvollziehbarer Ablauf:

1. Daten des Hauptkontos und des Budget-Kontos werden regulär zweimal täglich synchronisiert.
2. Zum eingestellten Stichtag aus Wochentag und Uhrzeit werden beide Konten
   unmittelbar erneut aktualisiert.
3. Die gerade abgelaufene Budgetperiode wird historisiert.
4. Der notwendige Auffüllbetrag für das Budget-Konto wird berechnet.
5. Für einen positiven Betrag wird ein GiroCode erzeugt.
6. Ein ausgewählter Yuvomi-Benutzer erhält eine Push-Nachricht mit Betrag,
   Kurzformel und Link zum Überweisungsvorschlag. Soweit die Plattform dies
   unterstützt, wird der GiroCode zusätzlich als Bildvorschau angezeigt.
7. Nach Ausführung wird die Überweisung in den Bankumsätzen erkannt und dem
   Vorschlag zugeordnet.

Das Banking-Modul stößt in Version 1 keine Zahlung selbstständig an. Es stellt
eine vorausgefüllte SEPA-Überweisung als GiroCode bereit; die Freigabe bleibt in
der Banking-App des Hauptkontos beziehungsweise einer allgemeinen Banking-App.

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| Hauptkonto | Technisches `source_account_id`; Konto, von dem die Auffüllung und gegebenenfalls direkte Wochenausgaben abgehen |
| Budget-Konto | Technisches `target_account_id`; Konto, dessen Bankguthaben das verfügbare Wochenbudget darstellt |
| Wochenziel | Gewünschter Zielbetrag, zum Beispiel `450,00 EUR` |
| Direktausgabe | Für das Wochenbudget relevante Ausgabe, die vom Hauptkonto statt vom Budget-Konto bezahlt wurde |
| Stichtag | Konfigurierter Wochentag plus lokale Uhrzeit, zu der die Periode abgeschlossen und der Vorschlag erzeugt wird |
| Budgetperiode | Zeitraum zwischen zwei aufeinanderfolgenden Stichtagen |
| Vorschlag | Unveränderlicher Berechnungsstand mit Betrag, Kurzformel und gegebenenfalls GiroCode |
| GiroCode | EPC-QR-Code, der die Daten einer SEPA-Überweisung enthält |

## 3. Fachliche Grundregeln

### 3.1 Quelle der Wahrheit

- Kontostände und Umsätze stammen ausschließlich aus Enable Banking.
- Normalisierte Bankdaten, Einstellungen und Historie liegen ausschließlich in
  `banking.db`.
- Das Yuvomi-Budget ist weder Berechnungsquelle noch Fallback.
- Geldbeträge werden intern immer als `INTEGER` in Cent gespeichert.
- Die konfigurierte Währung ist in Version 1 ausschließlich `EUR`.

### 3.2 Verfügbares aktuelles Wochenbudget

Der große Wert in der aktuellen Wochenbudget-Übersicht ist der zuletzt
erfolgreich synchronisierte verwendbare Saldo des Budget-Kontos.

```text
Aktuell noch verfügbar = verwendbarer Saldo des Budget-Kontos
```

Direkte Ausgaben über das Hauptkonto verändern diesen Hauptwert während der laufenden
Woche nicht. Sie werden separat als "wird am nächsten Stichtag verrechnet"
angezeigt und reduzieren den nächsten Auffüllbetrag.

Die Anzeige muss immer enthalten:

- Betrag und Währung
- Zeitpunkt der Saldo-Ermittlung
- Zustand `aktuell`, `veraltet` oder `nicht verfügbar`
- optional Anzahl und Summe ausstehender (`PDNG`) Budget-Konto-Umsätze
- Summe der bisher erkannten relevanten Direktausgaben über das Hauptkonto der laufenden
  Periode
- Datum und Uhrzeit des nächsten Stichtags

Ein Saldo gilt standardmäßig nach 14 Stunden als veraltet. Diese Kennzeichnung
ändert den gespeicherten Betrag nicht.

### 3.3 Auswahl des verwendbaren Banksaldos

Enable Banking kann mehrere Saldoarten liefern. Der Provider-Adapter muss sie
normalisieren und genau einen Saldo als `usable_balance_cents` auswählen.

Priorität:

1. verfügbarer/interim available Saldo
2. gebuchter/interim booked Saldo
3. closing booked Saldo
4. kein verwendbarer Saldo

Die konkreten Provider-Codes werden zentral im Enable-Banking-Adapter gemappt
und nicht in der Wochenbudget-Logik verteilt. Saldoart, Rohwert und
Beobachtungszeit werden in einem Snapshot gespeichert.

Pending-Umsätze werden nicht zusätzlich vom verwendbaren Saldo abgezogen, wenn
die gewählte Saldoart sie bereits berücksichtigt. Die Auswahlfunktion muss dies
durch Tests pro unterstützter Saldoart absichern.

## 4. Einstellungen

Version 1 unterstützt je Yuvomi-Benutzer höchstens eine aktive
Wochenbudget-Konfiguration. Das Schema soll eine spätere Erweiterung auf mehrere
Konfigurationen nicht verhindern.

Pflichtfelder:

| Einstellung | Regel |
|---|---|
| Aktiv | Wochenbudget und Stichtagslauf ein-/ausschalten |
| Quellkonto | aktives, angebundenes EUR-Konto |
| Zielkonto | anderes aktives, angebundenes EUR-Konto |
| Wochenziel | positiver Cent-Betrag, zum Beispiel `45000` |
| Wochentag | ISO-Wochentag `1` bis `7` (`1 = Montag`) |
| Uhrzeit | lokale Uhrzeit `HH:mm` |
| Zeitzone | IANA-Zeitzone, standardmäßig `Europe/Berlin` |
| Benachrichtigung | aktiviert/deaktiviert |
| Empfänger | Yuvomi-Benutzer-ID mit mindestens einem aktiven Banking-Push-Abonnement |
| QR-Vorschau in Push | ausdrückliches Opt-in wegen sensibler Zahlungsdaten auf dem Sperrbildschirm |

Erweiterte Einstellungen mit Defaults:

| Einstellung | Default |
|---|---|
| reguläre Synchronisierung 1 | `06:00` lokal |
| reguläre Synchronisierung 2 | `18:00` lokal |
| Saldo gilt als veraltet nach | `14 Stunden` |
| Wiederholungen nach fehlgeschlagenem Stichtags-Sync | 3 Versuche nach 5, 15 und 30 Minuten |
| Betreffpräfix | `WB` |

Validierung beim Speichern:

- Quelle und Ziel dürfen nicht identisch sein.
- Beide Konten müssen demselben konfigurierenden Banking-Benutzer gehören.
- Beide Konten müssen `EUR` führen.
- Das Zielkonto muss eine entschlüsselbare IBAN und einen Empfängernamen besitzen.
- Das Wochenziel muss mindestens `0,01 EUR` betragen.
- Der Push-Empfänger muss ein aktives Banking-Push-Abonnement besitzen.
- Änderungen gelten erst für noch nicht finalisierte Perioden.

Beim erstmaligen Aktivieren beginnt die erste Periode am lokalen
Aktivierungsdatum. Der erste Stichtagslauf berücksichtigt keine Umsätze aus der
Zeit vor der Aktivierung. Wird Wochentag oder Uhrzeit geändert, bleibt eine
bereits finalisierte Periode unverändert; die neue Grenze gilt ab dem nächsten
noch nicht ausgeführten Stichtag.

## 5. Zuordnung von Kategorien und Umsätzen

### 5.1 Kategorie-Standard

Jede Banking-Kategorie besitzt das Merkmal:

```text
weekly_budget_default = true | false
```

Die Oberfläche bezeichnet es als "Dem Wochenbudget zuordnen".

### 5.2 Übersteuerung am Umsatz

Jeder Umsatz besitzt eine dreistufige Einstellung:

```text
weekly_budget_override = inherit | include | exclude
```

- `inherit`: Einstellung der Kategorie übernehmen
- `include`: diesen Umsatz dem Wochenbudget zuordnen
- `exclude`: diesen Umsatz nicht dem Wochenbudget zuordnen

Die wirksame Zuordnung wird so bestimmt:

1. `include` oder `exclude` direkt am Umsatz
2. bei `inherit` der Wert `weekly_budget_default` der Kategorie
3. ohne Kategorie oder ohne Kategorie-Merkmal: `false`

Damit hat das Merkmal am Umsatz wie gefordert Vorrang vor der Kategorie.

### 5.3 Technische Eignungsprüfung

Die Priorität aus Abschnitt 5.2 wird nur auf fachlich geeignete Ausgaben
angewendet. Folgende technischen Ausschlüsse verhindern Doppelzählungen:

- nur Umsätze des konfigurierten Quellkontos reduzieren die Auffüllung
- nur `outgoing` wird als Direktausgabe berücksichtigt
- nur gebuchte Umsätze (`BOOK`) werden endgültig verrechnet
- interne Überweisungen zwischen Quell- und Zielkonto werden immer ausgeschlossen
- der zum Vorschlag gehörende Auffülltransfer wird immer ausgeschlossen
- stornierte, gelöschte oder eindeutig durch einen gebuchten Umsatz ersetzte
  Pending-Datensätze werden ausgeschlossen
- Währungen ungleich `EUR` werden in Version 1 nicht berücksichtigt

Ein technischer Ausschluss ist keine konkurrierende Kategorisierungspriorität.
Die UI darf bei internen Transfers daher keine wirksame Wochenbudget-Zuordnung
vortäuschen.

### 5.4 Zeitraum einer Direktausgabe

Da Bankumsätze häufig nur ein Buchungsdatum und keine verlässliche Uhrzeit
besitzen, erfolgt die Periodenzuordnung anhand lokaler Kalendertage:

```text
period_start_date <= booking_date < period_end_date
```

`period_end_date` ist das lokale Datum des aktuellen Stichtags. Umsätze mit dem
Buchungsdatum des Stichtags gehören bereits zur neu beginnenden Periode. Die
Uhrzeit steuert den Joblauf, nicht die tagesgenaue Zuordnung der Bankbuchung.

Fehlt `booking_date`, wird für gebuchte Umsätze ersatzweise `value_date`, danach
`transaction_date` verwendet. Fehlt jedes verwendbare Datum, wird der Umsatz
nicht automatisch verrechnet und in der Review-Liste markiert.

Der technische Periodenschlüssel wird nicht allein aus einer ISO-Kalenderwoche
gebildet. Er enthält Konfigurations-ID und geplanten Stichtag in UTC, damit auch
Änderungen des Stichtags und Jahreswechsel eindeutig bleiben. Für den kurzen
Überweisungstext wird das lokale Stichtagsdatum als lesbare Kennung verwendet.

## 6. Berechnung am Stichtag

### 6.1 Eingaben

- `target_cents`: konfiguriertes Wochenziel
- `target_balance_cents`: beim Stichtags-Sync ermittelter Saldo des Budget-Kontos
- `direct_expenses_cents`: Summe aller wirksam einbezogenen Ausgaben über das Hauptkonto
  der abgelaufenen Periode, jeweils als positiver Cent-Betrag

### 6.2 Formel

```text
raw_transfer_cents =
  target_cents
  - target_balance_cents
  - direct_expenses_cents

transfer_cents = max(0, raw_transfer_cents)
overfunded_cents = max(0, -raw_transfer_cents)
```

Beispiel:

```text
Wochenziel                         450,00 EUR
aktueller Saldo des Budget-Kontos -100,00 EUR
relevante Hauptkonto-Ausgaben     -30,00 EUR
------------------------------------------------
Überweisung                       320,00 EUR
```

Ein negativer Saldo des Budget-Kontos erhöht den notwendigen Auffüllbetrag automatisch. Ein
Saldo über dem Ziel oder sehr hohe Direktausgaben können den Rohbetrag negativ
machen; dann wird keine negative Überweisung erzeugt. `overfunded_cents` wird in
der Historie angezeigt, aber in Version 1 nicht automatisch in eine spätere
Woche übertragen und es wird keine Rücküberweisung vorgeschlagen.

### 6.3 Rundung und Darstellung

- Es gibt keine Fließkommarechnung.
- Alle Rechenschritte erfolgen in Cent.
- Die UI formatiert erst bei der Ausgabe gemäß Benutzer-Locale.
- Der GiroCode verwendet ein Dezimalformat mit Punkt entsprechend EPC, zum
  Beispiel `EUR320.00`.

## 7. Stichtagsablauf

Der Stichtagsjob ist eine idempotente Zustandsmaschine.

### 7.1 Ablauf

1. Fällige Konfiguration anhand Zeitzone, Wochentag und Uhrzeit bestimmen.
2. Verteilten/SQLite-basierten Lease für den Periodenschlüssel erwerben.
3. Joblauf mit eindeutigem `run_key` anlegen.
4. Quellkonto bei Enable Banking aktualisieren: Umsätze und Salden.
5. Zielkonto bei Enable Banking aktualisieren: Umsätze und Salden.
6. Prüfen, ob beide Aktualisierungen frisch und erfolgreich sind.
7. Abgelaufene Periodengrenzen bestimmen.
8. Geeignete Quellkonto-Umsätze bewerten und als Periodenpositionen snapshotten.
9. Verwendbaren Saldo des Budget-Kontos snapshotten.
10. Betrag ausschließlich aus den gespeicherten Snapshots berechnen.
11. Historische Periode und Revision des Überweisungsvorschlags atomar speichern.
12. Bei `transfer_cents > 0` GiroCode-Daten validieren und QR-Payload vorbereiten.
13. Push-Outbox-Eintrag erzeugen.
14. Datenbanktransaktion abschließen.
15. Push außerhalb der Transaktion zustellen.
16. Spätere Syncs versuchen, Quell- und Zielbuchung dem Vorschlag zuzuordnen.

### 7.2 Frischegarantie

Der Stichtagsjob führt immer einen eigenen Provider-Abruf aus, auch wenn kurz
zuvor ein regulärer Sync lief. Gleichzeitige manuelle oder reguläre Syncs werden
pro Konto serialisiert.

Scheitert der Abruf eines der beiden Konten, wird kein neuer finanzieller Betrag
und kein GiroCode aus alten Daten erzeugt. Der Lauf erhält `sync_failed` und wird
nach 5, 15 und 30 Minuten erneut versucht. Nach dem letzten Fehlversuch wird eine
Fehler-Push-Nachricht ohne Überweisungsdaten erzeugt.

### 7.3 Ausfall und Nachholen

Beim Start des Sidecars prüft der Scheduler, ob der jüngste Stichtag noch keinen
erfolgreichen Lauf besitzt. Genau der jüngste verpasste Lauf wird nachgeholt;
ältere Wochen werden nicht automatisch mit heutigen Salden berechnet.

In der Historie wird ein nachgeholter Lauf als solcher gekennzeichnet. Seine
Berechnung verwendet die beim Nachholen verfügbaren Daten und darf deshalb nicht
als exakter damaliger Kontostand ausgegeben werden.

### 7.4 Sommer-/Winterzeit

- Die Konfiguration speichert eine IANA-Zeitzone, keine feste UTC-Abweichung.
- Eine bei der Zeitumstellung nicht vorhandene lokale Uhrzeit läuft zum nächsten
  gültigen Zeitpunkt desselben Tages.
- Eine doppelt vorkommende lokale Uhrzeit läuft wegen des eindeutigen
  Periodenschlüssels nur einmal.

### 7.5 Reguläre Kontosynchronisierung

Die beiden konfigurierten lokalen Abrufzeiten synchronisieren Hauptkonto und Budget-Konto
jeweils gemeinsam. Umsätze werden mit einem rollierenden 14-Tage-Fenster
abgerufen, damit vorgemerkte Buchungen zuverlässig abgeglichen werden; Salden
werden bei jedem Lauf frisch geladen. Providerdaten beider Konten werden erst
atomar übernommen, wenn beide Abrufe erfolgreich waren und für das Budget-Konto ein
verwendbarer EUR-Saldo vorliegt.

Jeder Slot besitzt einen eindeutigen Schlüssel, eine zehnminütige Lease und die
Wiederholungsfolge 5, 15 und 30 Minuten. Nach einem Sidecar-Ausfall wird nur der
jüngste fällige Slot nachgeholt. Hat ein erfolgreicher Stichtagslauf bereits nach
diesem Slot beide Konten frisch geladen, wird der reguläre Lauf als abgedeckt
markiert und löst keinen zweiten Providerabruf aus.

## 8. Historisierung und Revisionen

### 8.1 Unveränderliche Periodensnapshots

Eine finalisierte Periode speichert mindestens:

- lokale und UTC-Periodengrenzen
- Stichtag und tatsächlichen Ausführungszeitpunkt
- Wochenziel zum Berechnungszeitpunkt
- Saldo des Budget-Kontos, Saldoart und Beobachtungszeit
- Summe der Direktausgaben
- jede einbezogene Direktausgabe mit Betrag, Kategorie und Entscheidungsquelle
- Rohbetrag, Überweisungsbetrag und Überfinanzierung
- Formel-/Algorithmusversion
- Sync-Ergebnisse beider Konten
- Status des Vorschlags und der Push-Zustellung
- erkannte tatsächliche Transferbuchungen

Berechnungsfaktoren und einbezogene Positionen sind nach der Finalisierung
unveränderlich. Nachträgliche Änderungen an Kategorien oder Umsatzmerkmalen
verändern sie nicht. Zustellstatus und später erkannte Transferbuchungen werden
als Lifecycle-Daten ergänzt, ohne die ursprüngliche Berechnung umzuschreiben.

### 8.2 Verspätet importierte Buchungen

Wird nach dem Stichtag ein gebuchter Umsatz mit einem Buchungsdatum in einer
bereits finalisierten Periode importiert, wird er als `late_candidate` markiert.
Der bestehende Vorschlag und GiroCode bleiben unverändert.

Solange noch keine passende Überweisung erkannt wurde, kann ein Benutzer mit
Schreibrecht "Neu berechnen" wählen. Dadurch entsteht eine neue Revision:

- alte Revision: `superseded`
- neue Revision: neue Snapshots, neue Formel, neuer GiroCode
- neue Push-Nachricht mit demselben periodenbezogenen Tag

Nach erkannter Überweisung ist keine stille Neuberechnung erlaubt. Eine
Korrektur wird als eigener manueller Historieneintrag dokumentiert.

### 8.3 Historienansicht

Die Historie zeigt je Periode:

- Zeitraum
- Wochenziel
- Schlusssaldo des Budget-Kontos
- Direktausgaben über das Hauptkonto
- vorgeschlagene Überweisung
- tatsächlich erkannte Überweisung
- Status (`keine Zahlung`, `vorgeschlagen`, `gesendet`, `angekommen`,
  `fehlgeschlagen`, `ersetzt`)
- Kennzeichnung für nachgeholt, verspätete Buchungen oder manuelle Revision

Ein Detail öffnet die vollständige Formel, die berücksichtigten Umsätze, Sync-
Zeitpunkte, Revisionen und den GiroCode der aktiven Revision.

## 9. Überweisungstext

Der Verwendungszweck enthält eine kurze, deterministische Angabe der drei
Berechnungsfaktoren und des Ergebnisses.

Kanonisches Format:

```text
WB 2026-09-14: 450,00 - 30,00 Direkt - 100,00 Budget = 320,00 EUR
```

Dabei sind:

- `450,00`: Wochenziel
- `30,00 Direkt`: relevante Direktausgaben über das Hauptkonto
- `100,00 Budget`: verwendbarer Saldo des Budget-Kontos
- `320,00 EUR`: Überweisungsvorschlag
- `2026-09-14`: lokales Stichtagsdatum als kurze Periodenkennung

Für negative Salden wird die Formel mathematisch eindeutig geklammert:

```text
WB 2026-09-14: 450,00 - 30,00 Direkt - (-20,00 Budget) = 440,00 EUR
```

Der Text wird serverseitig erzeugt und auf höchstens 140 Zeichen sowie auf das
Byte-Limit des GiroCode-Payloads geprüft. Fällt eine Kürzung an, bleiben
Periodenschlüssel, drei Faktoren und Ergebnis erhalten; nur Beschriftungen
werden verkürzt.

## 10. GiroCode

### 10.1 Standard

Der GiroCode wird nach `EPC069-12`, Version 3.1, erzeugt. Maßgeblich sind die
[offiziellen EPC-Richtlinien](https://www.europeanpaymentscouncil.eu/document-library/guidance-documents/quick-response-code-guidelines-enable-data-capture-initiation).

Vorgaben:

- Service Tag `BCD`
- Datenversion `002`
- Zeichensatz UTF-8 (`1`)
- Identifikation `SCT`
- QR-Fehlerkorrekturlevel `M`
- höchstens QR-Version 13
- höchstens 331 Byte Gesamtpayload
- ausschließlich IBAN als Kontoidentifikation
- Betrag mindestens `0,01 EUR`
- unstrukturierte Remittance Information, höchstens 140 Zeichen
- kein Zeilenumbruch nach dem letzten befüllten Element

Payload-Felder:

```text
BCD
002
1
SCT
<BIC oder leer>
<Empfängername des Budget-Kontos>
<Budget-Konto-IBAN>
EUR320.00


<Überweisungstext>
```

Die BIC wird aufgenommen, wenn sie zuverlässig vorhanden ist; für ein deutsches
Budget-Konto darf sie in Version 2 leer bleiben. IBAN, Name, Betrag und
Verwendungszweck werden vor Erzeugung separat validiert.

Der Server speichert den vollständigen EPC-Payload nicht unverschlüsselt, weil
er die Ziel-IBAN enthält. Er wird aus dem verschlüsselten Kontodatensatz und den
unveränderlichen Vorschlagsfeldern reproduzierbar erzeugt. Für Audit und Tests
kann ein SHA-256-Hash des Payloads gespeichert werden.

### 10.2 Ausgabe

Der Sidecar erzeugt PNG serverseitig ohne externes CDN. Die Detailseite zeigt:

- QR-Code
- Empfängername
- maskierte IBAN
- Betrag
- Verwendungszweck im Klartext
- Schaltflächen `GiroCode öffnen`, `PNG herunterladen` und, falls verfügbar,
  `Teilen`

Der EPC-Standard verlangt, dass die Zahlungsdaten zusätzlich im Klartext
sichtbar und vor der Freigabe prüfbar sind. Ein GiroCode kann von einer
kompatiblen Banking-App als QR-Code gescannt und anschließend zur Freigabe
vorgelegt werden. Die konkrete Bedienung hängt vom verwendeten Banking-Provider
und dessen App ab.

Es existiert kein allgemein standardisierter GiroCode-Deep-Link, der auf jedem
Gerät zuverlässig direkt eine bestimmte Banking-App öffnet. Deshalb darf die UI keine
garantierte Schaltfläche `In Banking-App öffnen` versprechen. Auf demselben
Smartphone stehen Download/Teilen und gegebenenfalls der Bildimport der
installierten App zur Verfügung; zuverlässig ist das Scannen von einem zweiten
Bildschirm.

### 10.3 Nullbetrag

Bei `transfer_cents = 0` wird kein GiroCode erzeugt. Die Periode und die
Berechnung werden trotzdem historisiert und die optionale Push-Nachricht lautet
"Keine Auffüllung nötig".

## 11. Push-Benachrichtigungen

### 11.1 Eigenständiger Push-Kanal

Yuvomis interne Push-Abonnements und sein Push-Service sind nicht über eine
öffentliche REST-Operation zum gezielten Versand durch Extensions verfügbar.
Der Sidecar darf weder `yuvomi.db` lesen noch private Core-Services importieren.

Das Banking-Modul verwendet deshalb einen eigenen Web-Push-Kanal:

1. Das Banking-Frontend registriert den mit dem Modul ausgelieferten Worker
   `/modules/banking/push-worker.js` mit dem Scope `/modules/banking/`. Der
   bestehende Yuvomi-Worker für die App-Shell wird dadurch nicht ersetzt.
2. Ein Benutzer aktiviert Banking-Benachrichtigungen ausdrücklich per
   Benutzerinteraktion.
3. Das Frontend übermittelt die Subscription an den Sidecar.
4. Der Sidecar verifiziert die aktuelle Yuvomi-Session und ordnet die
   Subscription ausschließlich der serverseitig ermittelten Benutzer-ID zu.
5. Die Settings-UI verbindet die öffentliche Yuvomi-Benutzerliste mit
   `GET /push/recipients`. Auswählbar sind nur Benutzer mit mindestens einer
   aktiven Banking-Subscription.
6. Der Sidecar sendet an alle aktiven Banking-Subscriptions dieses Benutzers.

Damit bleibt der Versand unabhängig vom Yuvomi-Budget und benötigt keine
Änderung am Yuvomi Core. VAPID Private Key und Subscription-Secrets bleiben im
Sidecar beziehungsweise verschlüsselt in `banking.db`.

Die persistente Grundlage verwendet `banking_push_subscriptions` mit einem
SHA-256-Endpunktfingerprint ausschließlich zur Deduplizierung. Der Endpunkt und
die Browser-Schlüssel liegen nur AES-GCM-verschlüsselt vor. `GET
/push/subscriptions` gibt deshalb ausschließlich sichere Gerätemetadaten
zurück; Anlegen und Abmelden erfordern Session, Origin-Prüfung und Banking-CSRF.
`weekly_budget_notification_deliveries` ist die idempotente Outbox: sie
speichert auch den Benachrichtigungsinhalt verschlüsselt, bevor ein künftiger
Sender ihn zustellt oder erneut versucht.

Beim Finalisieren eines Stichtags sowie bei jeder zulässigen Neuberechnung
entsteht pro aktiver Subscription eine Outbox-Zeile innerhalb derselben
Datenbanktransaktion wie der Vorschlag. Ihr Schlüssel umfasst Konfiguration,
Periodenschlüssel, Revision und Subscription. So führt ein Scheduler-Replay
weder zu einem zweiten Vorschlag noch zu einer doppelten Zustellung.

Der Versandworker least jeweils eine fällige Outbox-Zeile für höchstens 90
Sekunden. Temporäre Providerfehler werden mit Backoff erneut versucht;
`404`/`410` deaktivieren nur die betreffende Subscription und schreiben den
Delivery-Status `no_subscription`. VAPID wird nur aktiviert, wenn
`BANKING_VAPID_SUBJECT`, `BANKING_VAPID_PUBLIC_KEY` und
`BANKING_VAPID_PRIVATE_KEY` gesetzt sind. Nur der öffentliche Schlüssel ist
nach authentifizierter Abfrage über `/push/vapid-public-key` verfügbar.

Das Banking-Frontend registriert den isolierten Worker
`/modules/banking/push-worker.js` nur nach explizitem Klick. Sein Scope ist
`/modules/banking/`; der vorhandene Yuvomi-App-Shell-Worker bleibt unverändert.
Der Worker zeigt ausschließlich den serverseitig verschlüsselten Payload an und
öffnet bei Klick die relative Banking-Detail-URL.

Die Empfängerauswahl verbindet im Browser `GET /api/v1/auth/users` mit dem
geschützten Sidecar-Endpunkt `GET /push/recipients`. Dadurch sind nur bekannte
Yuvomi-Benutzer mit mindestens einer aktiven Banking-Subscription auswählbar.
Der Sidecar prüft dieselbe Voraussetzung erneut beim Speichern; eine
Benutzer-ID aus dem Formular genügt nie.

Die QR-Vorschau bleibt standardmäßig ausgeschaltet und wird in den
Wochenbudget-Einstellungen separat aktiviert. Ist sie aktiv, erzeugt der
Sidecar pro Vorschlagsrevision ein Capability-Token mit 256 Bit Zufall. In der
Datenbank liegt nur dessen SHA-256-Hash; die PNG-Antwort ist `no-store` und
läuft spätestens am nächsten Stichtag, jedenfalls innerhalb von sieben Tagen,
ab.

### 11.2 Inhalt

Für einen positiven Vorschlag:

```text
Titel: Wochenbudget: 320,00 EUR überweisen
Text:  450,00 EUR - 30,00 EUR Direkt - 100,00 EUR Budget-Konto = 320,00 EUR
Ziel:  /m/banking?view=weekly-transfer&id=<interne-id>
Tag:   banking-weekly-budget-<config-id>-<period-key>
```

Der Klick öffnet die authentifizierte Banking-Detailansicht mit dem GiroCode.
Der `tag` ersetzt bei einer Neuberechnung die alte Benachrichtigung derselben
Periode, statt Duplikate zu erzeugen.

Für einen Nullbetrag:

```text
Titel: Wochenbudget: keine Überweisung nötig
Text:  Wochenziel und Guthaben im Budget-Konto decken die neue Woche ab.
```

Für einen endgültig fehlgeschlagenen Sync:

```text
Titel: Wochenbudget konnte nicht berechnet werden
Text:  Hauptkonto oder Budget-Konto konnten nicht aktuell abgerufen werden.
```

### 11.3 QR-Bild in der Push-Nachricht

Web Notifications besitzen zwar eine `image`-Option, diese ist laut
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notification/image) aber
nicht auf allen verbreiteten Browsern verfügbar. Die QR-Vorschau ist daher eine
progressive Erweiterung und niemals der einzige Zugang zum GiroCode.

Wenn `QR-Vorschau in Push` aktiviert ist:

- der Banking-Service-Worker setzt `image` auf eine kurzlebige GiroCode-PNG-URL
- die URL enthält ein zufälliges Capability-Token mit mindestens 256 Bit
- in der Datenbank liegt nur der Hash dieses Tokens
- das Token erlaubt ausschließlich den Abruf genau dieses PNG
- Gültigkeit höchstens bis zum folgenden Stichtag, maximal sieben Tage
- Antworten tragen `Cache-Control: no-store`
- Query-Token und vollständige URL dürfen nicht geloggt werden

Ohne Unterstützung für `image` zeigt das Betriebssystem nur Titel und Text; ein
Klick führt weiterhin zur QR-Detailseite.

Da das QR-Bild Empfänger-IBAN, Betrag und Verwendungszweck codiert und auf einem
Sperrbildschirm sichtbar sein kann, ist diese Option standardmäßig aus und muss
mit einem deutlichen Datenschutzhinweis aktiviert werden.

### 11.4 Zustellung und Wiederholung

- Push-Zustellung verwendet eine Outbox mit eindeutigem Idempotenzschlüssel.
- Temporäre Fehler werden mit Backoff wiederholt.
- Eine ungültige Subscription (`404`/`410`) wird deaktiviert.
- Der Historieneintrag zeigt `pending`, `sent`, `failed` oder `no_subscription`.
- Ein fehlgeschlagener Push verändert weder Vorschlag noch GiroCode.
- Die Detailseite bleibt unabhängig von der Push-Zustellung erreichbar.

## 12. Erkennung der ausgeführten Überweisung

Ein Vorschlag wird nach späteren Synchronisierungen gegen Quell- und Zielkonto
gematcht.

Primäre Merkmale:

- Quellkonto und Zielkonto
- `counterparty_id` des jeweils anderen Kontos
- exakter Betrag
- Periodenschlüssel im Verwendungszweck
- Buchungsdatum in einem konfigurierten Fenster nach Vorschlagserzeugung

Statusfolge:

```text
proposed -> source_booked -> target_arrived
```

Weitere Endzustände:

```text
zero | dismissed | superseded | expired
```

Nur ein eindeutiges Match wird automatisch zugeordnet. Mehrere Kandidaten
werden zur manuellen Auswahl angezeigt. Das Erkennen einer Zahlung verändert
die historische Berechnung nicht, sondern ergänzt den tatsächlichen Betrag und
die Buchungsreferenzen.

## 13. Datenmodell

Alle Änderungen erfolgen durch neue append-only Migrationen. Vorhandene
Migrationen werden nicht verändert.

### 13.1 Änderungen bestehender Tabellen

`categories`:

```text
weekly_budget_default INTEGER NOT NULL DEFAULT 0
```

`transactions`:

```text
weekly_budget_override TEXT NOT NULL DEFAULT 'inherit'
  CHECK (... IN ('inherit', 'include', 'exclude'))
```

`transfer_suggestions` wird durch Tabellen-Neuaufbau in einer neuen Migration
um folgende fachliche Felder erweitert:

```text
period_id
revision
target_balance_cents
raw_computed_amount_cents
overfunded_cents
purpose
payload_sha256
calculation_version
matched_source_transaction_id
matched_target_transaction_id
generated_at
completed_at
status
```

### 13.2 Neue Tabellen

#### `weekly_budget_configs`

Speichert Konten, Zielbetrag, Empfängername des Zielkontos, Stichtag, Zeitzone,
reguläre Sync-Zeiten, Benachrichtigungsempfänger und Push-Datenschutzoptionen.
Pro Besitzer darf nur eine Konfiguration aktiv sein.

#### `account_balance_snapshots`

Speichert pro Abruf Account, normalisierte Saldoart, Betrag, Währung,
Provider-Beobachtungszeit, Abrufzeit und Kennzeichnung des verwendbaren Saldos.

#### `weekly_budget_periods`

Unveränderlicher Abschluss einer Periode mit Konfigurationssnapshot,
Periodengrenzen, Summen, Sync-Referenzen, Algorithmusversion und Status.
Empfängername und verschlüsselte Ziel-IBAN werden je Periode eingefroren, damit
ein späterer Konten-Reconnect den historischen GiroCode nicht verändert.

#### `weekly_budget_period_transactions`

Verknüpft Direktausgaben und verspätete Kandidaten mit der Periode. Die Tabelle
speichert Zustand (`included`, `late_candidate`, `removed_in_revision`), Betrag,
Kategorie-Name/-ID zum Bewertungszeitpunkt sowie Entscheidungsquelle
`transaction_override` oder `category_default`. Später ergänzte Kandidaten
ändern die eingefrorenen Periodensummen nicht.

#### `weekly_budget_job_runs`

Speichert `run_key`, Auslöser (`scheduled`, `catch_up`, `manual`), Versuch,
Start/Ende, Lease, Sync-Ergebnisse und gekürzte technische Fehlermeldung.

#### `scheduled_account_sync_runs`

Speichert den eindeutigen Schlüssel jedes der zwei täglichen Abrufslots,
Auslöser, Versuch, Lease, Ergebnis beider Konten und die Zahl verarbeiteter
Umsätze. Ein durch den Stichtagslauf abgedeckter Slot wird explizit als
`skipped` historisiert.

#### `banking_push_subscriptions`

Speichert verschlüsselte Web-Push-Subscriptiondaten, Endpoint-Fingerprint,
Yuvomi-Benutzer-ID, Gerätebezeichnung, Status und letzte erfolgreiche Nutzung.

#### `weekly_budget_notification_deliveries`

Outbox und Delivery-Historie je Vorschlagsrevision, Subscription und
Idempotenzschlüssel.

#### `girocode_image_tokens`

Speichert nur Token-Hash, Vorschlags-ID, Ablaufdatum und Widerrufsstatus für die
optionale Push-Bildvorschau.

### 13.3 Wichtige Constraints und Indizes

- eindeutig: aktive Konfiguration pro Besitzer
- eindeutig: Periode pro Konfiguration und Periodenschlüssel
- eindeutig: Revision pro Periode
- eindeutig: Job `run_key`
- eindeutig: Endpoint-Fingerprint pro Push-Subscription
- Index auf `transactions(account_id, status, booking_date)`
- Index auf fällige Jobläufe und offene Push-Outbox-Einträge
- Fremdschlüssel mit bewusst gewähltem `ON DELETE`-Verhalten; Historie darf beim
  Löschen einer Kategorie nicht verschwinden

Historienzeilen speichern deshalb zusätzlich lesbare Snapshots und hängen nicht
ausschließlich von veränderlichen Kategorie- oder Kontonamen ab.

## 14. Sidecar-API

Alle Endpunkte liegen unter `/api/extensions/banking`.

### 14.1 Übersicht und Einstellungen

```text
GET  /weekly-budget/current
GET  /weekly-budget/settings
PUT  /weekly-budget/settings
POST /weekly-budget/preview
```

`current` liefert keine Klartext-IBAN. Es liefert aktuellen Saldo, Sync-Zeit,
laufende Direktausgaben, nächsten Stichtag und den jüngsten Vorschlag.

`preview` führt nach einem frischen Sync eine unverbindliche Berechnung für die
laufende Periode aus. Sie erzeugt weder Historie noch GiroCode noch Push. Ein
normaler manueller Kontosync erzeugt ebenfalls keinen Vorschlag. Ein echter
Vorschlag entsteht nur am Stichtag oder als explizite Revision einer bereits
finalisierten Periode.

### 14.2 Kategorien und Umsätze

```text
PATCH /categories/:id/weekly-budget
PATCH /transactions/:id/weekly-budget
```

Erlaubte Bodies:

```json
{ "weekly_budget_default": true }
```

```json
{ "weekly_budget_override": "include" }
```

### 14.3 Historie und Vorschläge

```text
GET  /weekly-budget/periods
GET  /weekly-budget/periods/:id
POST /weekly-budget/periods/:id/recalculate
POST /weekly-budget/transfers/:id/dismiss
GET  /weekly-budget/transfers/:id/girocode
GET  /weekly-budget/transfers/:id/girocode.png
```

Der authentifizierte Metadaten-Endpunkt liefert Empfängername, maskierte IBAN,
Betrag, Verwendungszweck, Payload-Fingerprint und die lokale PNG-URL. Der
PNG-Endpunkt benötigt ebenfalls mindestens `ext:banking:read` und antwortet mit
`Cache-Control: private, no-store`.

Der kurzlebige Bild-Endpunkt für die optionale Notification-Vorschau akzeptiert
nur das Capability-Token und gibt keinerlei JSON-Metadaten zurück.

```text
GET /push/girocode-images/:capability.png
```

Dieser eine Endpunkt ist ohne Session abrufbar, aber auf ein einzelnes Bild,
kurze Gültigkeit, Rate Limit und ein kryptografisch zufälliges Token begrenzt.
Die komplette Pfadkomponente wird in Sidecar und Reverse Proxy redigiert.

### 14.4 Banking-Push

```text
GET    /push/vapid-public-key
GET    /push/subscriptions
POST   /push/subscriptions
DELETE /push/subscriptions/:id
GET    /push/recipients
POST   /push/test
```

- Subscription-Anlage und -Löschung benötigen Session, Origin-Prüfung und CSRF.
- Die Benutzer-ID wird nie aus dem Body übernommen.
- `recipients` liefert für die Settings-Auswahl nur Benutzer mit aktiven
  Banking-Subscriptions.
- Einstellungen und Testversand benötigen `ext:banking:write`.

## 15. Frontend

### 15.1 Wochenbudget-Übersicht

Die Seite und das Widget zeigen zuerst den verfügbaren Saldo des Budget-Kontos. Ergänzend:

- Fortschrittsdarstellung relativ zum Wochenziel
- `Stand: <Datum/Uhrzeit>` und Sync-Status
- Summe Direktausgaben, die beim nächsten Stichtag abgezogen wird
- nächsten Stichtag
- jüngsten Überweisungsvorschlag
- Warnung bei veraltetem oder fehlendem Saldo

Das Widget besitzt einen Link zur Banking-Seite, führt aber keine schreibende
Aktion direkt aus.

### 15.2 Einstellungen

- Hauptkonto und Budget-Konto
- Wochenziel
- Wochentag
- Uhrzeit
- Zeitzone
- Benachrichtigungsempfänger
- Banking-Push auf diesem Gerät aktivieren/deaktivieren
- QR-Bild auf Sperrbildschirm erlauben
- nächster berechneter Ausführungszeitpunkt als Vorschau
- Testbenachrichtigung

### 15.3 Umsatzliste

Jeder Umsatz zeigt Kategorie und wirksame Wochenbudget-Zuordnung. In der
Detailansicht ist die dreistufige Übersteuerung auswählbar. Die UI erklärt, ob
die wirksame Entscheidung vom Umsatz oder von der Kategorie stammt.

### 15.4 Vorschlagsdetail

- vollständige Drei-Faktoren-Formel
- Liste der angerechneten Direktausgaben
- Saldoart und Aktualisierungszeit
- GiroCode und Klartext-Zahlungsdaten
- Download/Teilen
- Status der Push-Zustellung
- Status der tatsächlichen Überweisung
- Revisionen und manuelle Neuberechnung

## 16. Sicherheit und Datenschutz

- Klartext-IBAN bleibt ausschließlich serverseitig und wird nur für den
  autorisierten GiroCode-Abruf entschlüsselt.
- Kategorie-, Umsatz- und Einstellungsänderungen erfordern `ext:banking:write`,
  Origin-Prüfung und Banking-CSRF.
- Leseendpunkte prüfen Besitzer beziehungsweise zulässigen Banking-Scope.
- Scheduler vertraut ausschließlich gespeicherten, zuvor validierten IDs.
- Push-Subscription-Endpoints und Schlüssel werden verschlüsselt gespeichert.
- VAPID Private Key wird als gemountetes Secret oder verschlüsseltes Secret
  bereitgestellt, nie über das Frontend.
- QR-Capability-Tokens sind zufällig, kurzlebig, gehasht gespeichert,
  widerrufbar und aus Logs zu entfernen.
- Push-Vorschauen können Finanzdaten auf dem Sperrbildschirm zeigen und sind
  deshalb Opt-in.
- GiroCode und Überweisung sind Vorschläge. Vor TAN-Freigabe müssen Betrag,
  Empfänger und IBAN in der verwendeten Banking-App geprüft werden.

## 17. Fehlerfälle

| Fall | Verhalten |
|---|---|
| Consent abgelaufen | kein Vorschlag; Fehlerstatus und Aufforderung zum Re-Consent |
| nur ein Konto synchronisiert | kein Vorschlag und kein GiroCode |
| kein verwendbarer Saldo des Budget-Kontos | kein Vorschlag; kein Fallback auf Yuvomi oder alten Saldo |
| keine relevante Direktausgabe | Abzug `0` |
| negativer Rohbetrag | Überweisung `0`, Überfinanzierung historisieren |
| fehlende/ungültige Ziel-IBAN | Berechnung speichern, GiroCode-Erzeugung als Fehler markieren |
| kein Push-Abonnement | Vorschlag bleibt verfügbar; Zustellung `no_subscription` |
| Push fehlgeschlagen | Retry; Berechnung nicht zurückrollen |
| verspäteter Umsatz | `late_candidate`; nur explizite Revision verändert Vorschlag |
| doppelter Scheduler-Start | Unique-Key/Lease verhindert zweiten Vorschlag |
| Sidecar beim Stichtag aus | jüngsten Lauf beim Start nachholen und kennzeichnen |

## 18. Tests und Abnahmekriterien

### 18.1 Unit-Tests

- Priorität `transaction override > category > false`
- technische Ausschlüsse für Transfers, Eingang, Pending und falsches Konto
- Cent-genaue Berechnung einschließlich Null-, Überziel- und Negativsaldo
- lokale Periodengrenzen und DST
- Saldoauswahl aus allen unterstützten Provider-Saldoarten
- Überweisungstext unter 140 Zeichen und innerhalb 331 Byte
- EPC-Payload-Zeilen, Reihenfolge, Zeichensatz und Betrag
- stabile Periodenschlüssel und idempotente Job-Keys
- eindeutiges Transfer-Matching und Ablehnung mehrdeutiger Kandidaten

### 18.2 Integrations-Tests

- Stichtagslauf synchronisiert beide Konten vor der Berechnung
- Fehler eines Kontos verhindert Vorschlag und GiroCode
- Beispiel `450 - 30 - 100 = 320`
- wiederholter identischer Lauf erzeugt keinen zweiten Vorschlag
- Neuberechnung erzeugt Revision und ersetzt Push per Tag
- Kategorieänderung verändert abgeschlossene Historie nicht
- verspätete Buchung wird als Kandidat erkannt
- Push-Subscription wird an serverseitig ermittelten Benutzer gebunden
- Push an den konfigurierten Benutzer, nicht an den Bearbeiter der Einstellungen
- abgelaufenes QR-Bild-Token liefert `404` oder `410`
- erkannte Transferbuchungen von Hauptkonto und Budget-Konto aktualisieren den Status

### 18.3 End-to-End-Abnahme

1. Hauptkonto und Budget-Konto sind verbunden.
2. Wochenziel ist `450,00 EUR`.
3. Das Budget-Konto meldet `100,00 EUR` verwendbaren Saldo.
4. Ein gebuchter LIDL-Umsatz über `30,00 EUR` auf dem Hauptkonto ist über Umsatz oder
   Kategorie dem Wochenbudget zugeordnet.
5. Zum eingestellten Wochentag und zur eingestellten Uhrzeit erfolgt ein frischer
   Abruf beider Konten.
6. Genau ein Vorschlag über `320,00 EUR` entsteht.
7. Der Zweck enthält Ziel, Direktausgaben, Budget-Konto-Saldo, Ergebnis und Perioden-ID.
8. Der ausgewählte Benutzer erhält genau eine Push-Nachricht.
9. Ein Klick öffnet die Detailseite; dort sind QR und Klartext identisch.
10. Eine kompatible Banking-App kann den GiroCode scannen und füllt Empfänger, IBAN,
    Betrag und Zweck vor; der Benutzer gibt die Zahlung selbst frei.
11. Ein späterer Bankabruf ordnet die Überweisung eindeutig zu.
12. Die Periode bleibt vollständig in der Historie sichtbar.

## 19. Empfohlene Umsetzungsreihenfolge

1. Datenmodell: Settings, Overrides, Saldo-Snapshots, Perioden und Revisionen
2. reine Zuordnungs- und Berechnungsservices mit Unit-Tests
3. normalisierte Saldoauswahl und persistente Balance-Snapshots
4. aktuelle Wochenbudget-API und Widget
5. Settings- und Umsatz-/Kategorie-UI
6. Stichtags-Scheduler, Locks, Retry und Catch-up
7. Historie und Revisionsablauf
8. EPC-Payload und serverseitige PNG-Erzeugung
9. Banking-eigene Web-Push-Subscriptions und Notification-Outbox
10. optionale QR-Bildvorschau in unterstützten Notifications
11. Transfer-Erkennung
12. vollständige Integrations- und End-to-End-Tests

Diese Reihenfolge hält die finanzielle Berechnung testbar, bevor Scheduler,
GiroCode und Push als Seiteneffekte hinzukommen.
