# Manuelles GiroCode-/Push-Testwerkzeug – technischer Umsetzungsplan

Stand der Analyse: `main` auf Commit `febbc4c081d057c54ce029283bc2fe4925a8aa40`.

Ziel dieser Iteration ist ein kleines, bewusst isoliertes Testwerkzeug innerhalb des Banking-Moduls. Der Benutzer soll Zahlungsempfänger, IBAN, Betrag und Verwendungszweck manuell eingeben können, daraus einen echten EPC-/SEPA-GiroCode erzeugen, ihn unmittelbar in der UI prüfen und denselben QR-Code anschließend gezielt per Banking-Web-Push an ein registriertes Gerät – insbesondere das Smartphone – senden können.

Das Werkzeug initiiert **keine Überweisung**. Es erzeugt ausschließlich einen GiroCode und eine Push-Benachrichtigung. Die eigentliche Zahlung bleibt vollständig in der Banking-App und unterliegt deren Freigabe/SCA.

---

## 1. Bereits vorhandene Infrastruktur

Für dieses Feature darf keine parallele GiroCode- oder Push-Implementierung entstehen. Der aktuelle Code enthält bereits fast alle benötigten Bausteine.

### 1.1 GiroCode

`service/src/services/girocode.ts` besitzt bereits:

- `buildEpcQrPayload()`
- vollständige IBAN-Prüfung inklusive MOD-97
- optionale BIC-Prüfung
- EPC-Betragsformatierung
- Prüfung auf maximal 331 UTF-8-Bytes
- Prüfung auf QR-Version <= 13
- `renderGiroCodePng()`
- `giroCodePayloadSha256()`

Diese Funktionen sind die verbindliche Single Source of Truth. Das Testwerkzeug darf EPC-Payload oder QR-Code nicht selbst implementieren.

### 1.2 Push

Vorhanden sind bereits:

- registrierte Push-Abonnements in `banking_push_subscriptions`
- `GET /push/subscriptions`
- `POST /push/test`
- Outbox über `enqueuePushDelivery()`
- Push Delivery Worker
- VAPID-Konfiguration
- `modules/banking/push-worker.js`

Der Service Worker unterstützt bereits das Feld `payload.image` und übergibt es als `NotificationOptions.image` an `showNotification()`.

### 1.3 GiroCode-Bilder in Push

Für echte Wochenbudget-Vorschläge existiert bereits:

- `girocode_image_tokens`
- `createGiroCodeImageCapability()`
- `GET /push/girocode-images/:token`

Der Endpoint ist absichtlich ohne Yuvomi-Session abrufbar, weil Android/Chrome bzw. das Betriebssystem das Bild selbst nachladen muss. Sicherheit entsteht durch einen kryptographisch zufälligen Capability-Token.

Der bestehende Mechanismus ist allerdings fest an `transfer_suggestions.id` gebunden. Für einen manuell erzeugten Test-GiroCode existiert keine Transfer-Suggestion. Genau diese Lücke wird mit diesem Feature geschlossen.

---

# 2. Ziel-UX

Das Werkzeug wird in den Banking-Einstellungen als eigener, einklappbarer Bereich angelegt:

```text
GiroCode-/Benachrichtigungstest

Mit diesem Werkzeug kann ein GiroCode manuell erzeugt und an ein
registriertes Gerät gesendet werden. Es wird keine Zahlung ausgeführt.

Empfänger             [Kevin Krone                    ]
IBAN                   [DE............................ ]
BIC (optional)         [                               ]
Betrag                 [25,00                          ] EUR
Verwendungszweck       [Yuvomi GiroCode Test           ]

Zielgerät              [Pixel 9 / Chrome              v]

[QR-Code erzeugen]

┌─────────────────────────────┐
│                             │
│          QR CODE            │
│                             │
└─────────────────────────────┘

25,00 EUR
Kevin Krone
DE12 •••• •••• 1234
Yuvomi GiroCode Test

[PNG öffnen] [Test-Benachrichtigung senden]
```

Nach erfolgreichem Versand:

```text
Test-Benachrichtigung wurde an „Pixel 9 / Chrome“ eingereiht.
```

Auf dem Smartphone:

```text
Yuvomi Banking
GiroCode-Test: 25,00 EUR
Kevin Krone · Yuvomi GiroCode Test

[QR-Bild in der Notification, falls Plattform unterstützt]
```

Beim Antippen der Notification öffnet sich Yuvomi Banking auf einer Testansicht, die denselben QR-Code nochmals groß darstellt. Das ist der notwendige Fallback für Plattformen, welche `NotificationOptions.image` nicht oder nur eingeschränkt anzeigen.

---

# 3. Platzierung im Frontend

Datei:

`modules/banking/index.js`

In `renderSettingsMarkup()` nach dem bestehenden Abschnitt „Banking-Benachrichtigungen“ und vor der Kategorieverwaltung einen neuen `<details>`-Block einfügen:

```text
GiroCode-/Benachrichtigungstest
```

Der Bereich soll standardmäßig geschlossen sein.

Empfohlene Marker:

```text
data-girocode-test
data-girocode-test-form
data-girocode-test-beneficiary
data-girocode-test-iban
data-girocode-test-bic
data-girocode-test-amount
data-girocode-test-remittance
data-girocode-test-subscription
data-girocode-test-preview
data-girocode-test-feedback
data-action="generate-girocode-test"
data-action="send-girocode-test-push"
```

Die UI wird nur für `ext:banking=write` editierbar. Bei `read` darf der Block entweder gar nicht gerendert oder vollständig read-only dargestellt werden. Da es sich um ein Test-/Mutationswerkzeug handelt, ist „nicht rendern bei read“ vorzuziehen.

---

# 4. Eingabefelder und Validierung

## 4.1 Empfängername

Pflichtfeld.

Backend-Validierung erfolgt ausschließlich durch die bereits vorhandene `buildEpcQrPayload()`-Logik.

Frontend darf lediglich offensichtliche Leerwerte abfangen.

## 4.2 IBAN

Pflichtfeld.

Keine eigene Browser-IBAN-Logik als zweite Wahrheit implementieren.

Backend nutzt:

```ts
buildEpcQrPayload(...)
```

und damit indirekt `assertValidIban()`.

In API-Responses wird die vollständige IBAN nach erfolgreicher Validierung **nicht** zurückgegeben. Für die Vorschau nur `maskIban()` verwenden.

## 4.3 BIC

Optional.

Wenn angegeben, wird die existierende BIC-Prüfung aus `girocode.ts` verwendet.

## 4.4 Betrag

Frontend akzeptiert deutsche Schreibweise:

```text
25
25,5
25,50
25.50
```

Parsing zu Integer-Cents analog der vorhandenen Wochenbudget-UI.

Backend erhält ausschließlich `amount_cents` und validiert über `buildEpcQrPayload()` erneut.

Kein Float persistieren oder für Berechnungen verwenden.

## 4.5 Verwendungszweck

Pflichtfeld.

Maximale EPC-Länge wird serverseitig von `buildEpcQrPayload()` kontrolliert.

Für den Test standardmäßig vorbelegen:

```text
Yuvomi GiroCode Test
```

---

# 5. Zielgerät

Das Werkzeug soll nicht blind an alle Geräte senden.

Bestehenden Endpoint verwenden:

```text
GET /api/extensions/banking/push/subscriptions
```

Im Select nur aktive Subscriptions des eingeloggten Benutzers anzeigen.

Label möglichst aus:

```text
device_name
```

Fallback:

```text
Gerät #<id>
```

Der ausgewählte `subscription_id` wird beim Versand serverseitig erneut geprüft:

```text
subscription.id = request.subscription_id
AND subscription.yuvomi_user_id = eingeloggter Benutzer
AND status = 'active'
```

Damit kann ein Browser niemals eine Subscription eines anderen Yuvomi-Nutzers ansteuern.

---

# 6. API-Design

Neuen Router anlegen:

`service/src/api/girocode-test-routes.ts`

In `service/src/app.ts` unter dem vorhandenen Banking-Prefix registrieren.

Alle mutierenden Requests benötigen:

- `ext:banking=write`
- Yuvomi-Session
- `mutationIsAllowed()` / CSRF
- `Cache-Control: no-store`

## 6.1 POST `/tools/girocode/preview`

Request:

```json
{
  "beneficiary_name": "Kevin Krone",
  "iban": "DE...",
  "bic": null,
  "amount_cents": 2500,
  "remittance": "Yuvomi GiroCode Test"
}
```

Ablauf:

1. User mit `write` auflösen.
2. CSRF prüfen.
3. Requestfelder strikt typisieren.
4. `buildEpcQrPayload()` aufrufen.
5. `renderGiroCodePng()` aufrufen.
6. SHA-256 über `giroCodePayloadSha256()` berechnen.
7. IBAN maskieren.
8. PNG **nicht persistent speichern**.
9. PNG für die UI als Data-URL oder Base64-Feld zurückgeben.

Empfohlene Response:

```json
{
  "data": {
    "beneficiary_name": "Kevin Krone",
    "iban_masked": "DE12••••1234",
    "amount_cents": 2500,
    "currency": "EUR",
    "remittance": "Yuvomi GiroCode Test",
    "payload_sha256": "...",
    "png_data_url": "data:image/png;base64,..."
  }
}
```

Die UI zeigt exakt diese serverseitig erzeugte Vorschau an.

Wichtig: die komplette EPC-Payload und die vollständige IBAN müssen für die normale Vorschau nicht wieder an den Browser zurückgegeben werden.

---

## 6.2 POST `/tools/girocode/notify`

Request:

```json
{
  "beneficiary_name": "Kevin Krone",
  "iban": "DE...",
  "bic": null,
  "amount_cents": 2500,
  "remittance": "Yuvomi GiroCode Test",
  "subscription_id": 12
}
```

Der Server erzeugt die GiroCode-Daten **erneut aus dem Request**. Er vertraut keinem Preview-Hash aus dem Browser.

Ablauf:

1. Session/`write`/CSRF prüfen.
2. Subscription-Ownership prüfen.
3. `buildEpcQrPayload()`.
4. Capability-Asset für das Push-Bild anlegen.
5. `enqueuePushDelivery()` für genau diese Subscription aufrufen.
6. `notification_type = 'test'` weiterverwenden; kein neuer Notification-Type erforderlich.
7. zufällige Idempotency-Key-Komponente verwenden, weil jeder manuelle Test absichtlich erneut versendbar sein soll.

Payload:

```ts
{
  title: `GiroCode-Test: ${formatEuroCents(amountCents)} EUR`,
  body: `${beneficiaryName} · ${remittance}`,
  url: `/m/banking?view=girocode-test&token=<browser-token>`,
  tag: `banking-girocode-test-${crypto.randomUUID()}`,
  image: `/api/extensions/banking/push/girocode-test-images/<image-token>`
}
```

Response:

```json
{
  "data": {
    "queued": true,
    "subscription_id": 12,
    "expires_at": "..."
  }
}
```

---

# 7. Temporärer, sicherer QR-Asset-Speicher

Der bestehende `girocode_image_tokens`-Mechanismus kann nicht direkt verwendet werden, weil er zwingend auf `transfer_suggestions.id` verweist.

Für Test-GiroCodes soll **keine Fake-Transfer-Suggestion** erzeugt werden. Das würde Wochenbudget-Historie und Transfermatching verunreinigen.

Stattdessen neue Migration:

`service/migrations/018_girocode_test_assets.sql`

Vorgeschlagenes Schema:

```sql
CREATE TABLE girocode_test_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  image_token_hash TEXT NOT NULL UNIQUE,
  browser_token_hash TEXT NOT NULL UNIQUE,
  payload_encrypted TEXT NOT NULL,
  beneficiary_name TEXT NOT NULL,
  iban_masked TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  remittance TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_girocode_test_assets_expiry
  ON girocode_test_assets(expires_at);
```

### Warum die Payload verschlüsselt speichern?

Die EPC-Payload enthält die vollständige IBAN.

Daher:

```text
payload_encrypted = createEncryptionService().encrypt(payload)
```

Nicht speichern:

- Klartext-IBAN
- Klartext-EPC-Payload
- Push-Endpoint
- VAPID-Keys

### TTL

Für Test-Assets reichen **30 Minuten**.

Nach Ablauf liefern die Capability-Endpunkte `404`.

Optional im Worker/Scheduler regelmäßig löschen:

```sql
DELETE FROM girocode_test_assets WHERE expires_at <= ?
```

Die Löschung ist Hygiene, nicht Security-Grenze; die Route muss immer zusätzlich das Ablaufdatum prüfen.

---

# 8. Capability-Tokens

Neue Service-Datei:

`service/src/services/girocode-test-assets.ts`

Aufgaben:

```text
createGiroCodeTestAsset(...)
findGiroCodeTestImage(...)
findOwnedGiroCodeTestView(...)
cleanupExpiredGiroCodeTestAssets(...)
```

Beim Anlegen zwei unabhängige 32-Byte-Tokens erzeugen:

```text
imageToken
browserToken
```

Nur SHA-256-Hashes der Tokens persistieren.

Warum zwei Tokens?

- `imageToken` darf ausschließlich das PNG liefern.
- `browserToken` darf nach Login die Testdetailansicht identifizieren.
- ein geleakter Notification-Image-Link darf nicht automatisch Zugang zu weiteren Testinformationen gewähren.

---

# 9. Öffentlicher Image-Endpoint für die Notification

Neuer Endpoint:

```text
GET /push/girocode-test-images/:token
```

Dieser Endpoint ist wie der bestehende Wochenbudget-Image-Endpoint absichtlich **ohne Session** abrufbar.

Ablauf:

1. Tokenformat prüfen.
2. Token SHA-256 hashen.
3. nicht abgelaufenes Asset suchen.
4. `payload_encrypted` entschlüsseln.
5. `renderGiroCodePng(payload)`.
6. `Content-Type: image/png`.
7. `Cache-Control: no-store`.
8. bei jedem Fehler nur `404`, keine Information über Ursache.

Der Endpoint gibt ausschließlich PNG-Bytes zurück – niemals IBAN, Payload oder Metadaten.

---

# 10. Fallback-Ansicht beim Antippen der Notification

Nicht darauf verlassen, dass Android/iOS/Desktop-Browser das `image`-Feld sichtbar darstellen.

`push-worker.js` unterstützt das Bild zwar bereits, Browser-/OS-Unterstützung variiert.

Daher muss die Notification beim Klick öffnen:

```text
/m/banking?view=girocode-test&token=<browserToken>
```

`render()` in `modules/banking/index.js` um einen dritten View erweitern:

```text
main
settings
girocode-test
```

Neue API:

```text
GET /tools/girocode/view/:browserToken
```

Diese Route benötigt eine normale Yuvomi-Session und mindestens `read`.

Zusätzlich Ownership:

```text
asset.yuvomi_user_id === eingeloggter Benutzer
```

Response enthält nur:

```text
beneficiary_name
iban_masked
amount_cents
currency
remittance
expires_at
png_data_url
```

Damit sieht der Benutzer nach Antippen auf dem Smartphone denselben QR-Code groß und zuverlässig, selbst wenn das Betriebssystem kein Notification-Image rendert.

---

# 11. Frontend-Verhalten

## 11.1 Preview

Beim Klick auf `QR-Code erzeugen`:

1. Formular clientseitig grob validieren.
2. Betrag zu Integer-Cents parsen.
3. CSRF laden.
4. `POST tools/girocode/preview`.
5. Preview-Bereich aktualisieren.
6. Buttons `PNG öffnen` und `Test-Benachrichtigung senden` aktivieren.

Wichtig:

Wenn danach irgendein Eingabefeld geändert wird, muss die alte Preview als **veraltet** markiert oder entfernt werden.

Der Nutzer darf nicht glauben, dass ein alter QR-Code zu neuen Formularwerten gehört.

Einfachste Regel:

```text
change/input -> Preview löschen -> Send-Button deaktivieren
```

## 11.2 Versand

Beim Klick auf `Test-Benachrichtigung senden`:

1. aktuelle Formulardaten erneut einlesen.
2. ausgewählte Subscription prüfen.
3. `POST tools/girocode/notify`.
4. Feedback ausgeben.

Der Server generiert den QR-Code nochmals, damit der Versand niemals von manipulierten Browser-Preview-Daten abhängt.

---

# 12. PNG lokal öffnen / speichern

Für den Test ist ein Button `PNG öffnen` sinnvoll.

Dieser verwendet die `png_data_url` der Preview und öffnet sie in neuem Tab bzw. erzeugt einen temporären Download-Link.

Keinen externen QR-Dienst verwenden.

---

# 13. Vorausfüllen aus dem Budget-Konto

Das Testwerkzeug soll zunächst vollständig manuell funktionieren.

Zusätzlich kann die UI später einen Komfortbutton erhalten:

```text
[Budget-Konto übernehmen]
```

Dieser darf jedoch die vollständige IBAN nicht aus `GET /accounts` beziehen, weil die Browser-API diese bewusst nicht offenlegt.

Falls dieser Komfort später umgesetzt wird, muss dafür ein eigener serverseitiger Flow vorgesehen werden, bei dem das Backend das ausgewählte eigene Konto anhand seiner internen Account-ID auflöst und die IBAN nur intern in den GiroCode einsetzt.

**Nicht Bestandteil der ersten Iteration.**

---

# 14. Sicherheitsregeln

Verbindlich:

1. keine Zahlungsinitiierung;
2. kein PISP-/Enable-Banking-Payment-Endpoint;
3. alle Form-POSTs `write` + CSRF;
4. Zielsubscription muss dem eingeloggten Benutzer gehören;
5. Test-Payload verschlüsselt at rest;
6. Capability-Tokens kryptographisch zufällig;
7. nur Token-Hashes speichern;
8. kurze TTL (30 Minuten);
9. Image-Capability liefert ausschließlich PNG;
10. Browser-View benötigt zusätzlich Login + Ownership;
11. vollständige IBAN nicht in API-Responses, Logs, URLs, Notification-Body oder Notification-Titel;
12. keine EPC-Payload im Notification-JSON;
13. `Cache-Control: no-store` für Preview/View/Image-Antworten;
14. Fehler des öffentlichen Image-Endpoints immer als generisches `404` behandeln.

---

# 15. Notification-Inhalt

Die Push-Nachricht soll eindeutig als Test erkennbar sein, damit sie niemals mit einem echten Wochenbudget-Vorschlag verwechselt wird.

Verbindlicher Titel:

```text
GiroCode-Test: 25,00 EUR
```

Body:

```text
Kevin Krone · Yuvomi GiroCode Test
```

Nicht verwenden:

```text
„Jetzt überweisen“
„Zahlung fällig“
```

Das Werkzeug ist Diagnostik/Test und keine Zahlungsaufforderung.

---

# 16. Push-Plattform-Fallback

Die Implementierung muss davon ausgehen, dass `NotificationOptions.image` nicht überall sichtbar ist.

Erfolgskriterium ist daher **nicht ausschließlich**, dass der QR-Code direkt groß in der Systemnotification erscheint.

Erfolgskriterium:

1. Plattform unterstützt `image` -> QR wird direkt angezeigt.
2. Plattform unterstützt `image` nicht -> Notification erscheint ohne QR-Bild.
3. Antippen öffnet immer die Yuvomi-Testansicht mit großem QR-Code.

Damit bleibt der Flow auf Android/Chrome, Desktop und anderen Browsern robust.

---

# 17. Betroffene Dateien

## Neu

```text
service/migrations/018_girocode_test_assets.sql
service/src/services/girocode-test-assets.ts
service/src/api/girocode-test-routes.ts
service/test/girocode-test-tool.test.ts
```

## Ändern

```text
service/src/app.ts
service/src/api/push-routes.ts
modules/banking/index.js
modules/banking/style.css
modules/banking/locales/de.json
modules/banking/locales/en.json
```

`service/src/services/girocode.ts` soll möglichst **nicht** geändert werden. Seine vorhandenen Funktionen werden wiederverwendet.

`modules/banking/push-worker.js` muss voraussichtlich ebenfalls nicht geändert werden, da `payload.image` bereits unterstützt wird. Nur ändern, wenn ein Test zeigt, dass zusätzliche NotificationOptions erforderlich sind.

---

# 18. Tests

Mindestens folgende automatisierte Tests ergänzen.

## GiroCode Preview

- gültige Daten -> 200
- Response enthält PNG Data URL
- Response enthält nur maskierte IBAN
- ungültige IBAN -> 400
- ungültige BIC -> 400
- Betrag 0 -> 400
- ungültiger Betrag -> 400
- zu langer Verwendungszweck/Payload -> 400
- read-only Benutzer -> 403
- fehlendes CSRF -> abweisen

## Test-Asset

- Payload wird verschlüsselt gespeichert
- Klartext-IBAN ist nicht in DB-Spalte sichtbar
- zwei Tokens sind unabhängig
- nur Hashes der Tokens stehen in DB
- Asset nach 30 Minuten abgelaufen
- abgelaufener Image-Token -> 404
- ungültiger Token -> 404

## Notification

- nur eigene aktive Subscription akzeptieren
- fremde Subscription -> 404 oder 403, bevorzugt 404
- deaktivierte Subscription -> ablehnen
- Push-Payload besitzt `image`
- Push-Payload besitzt Browser-Fallback-URL
- Notification-Titel enthält `GiroCode-Test`
- Notification enthält keine vollständige IBAN
- erneuter Test darf bewusst erneut queued werden

## Browser-Fallback

- eingeloggter Owner kann Asset laden
- anderer Benutzer nicht
- abgelaufenes Asset nicht
- Response enthält QR-Bild + maskierte IBAN
- keine vollständige IBAN

---

# 19. Manueller End-to-End-Test

Nach Implementierung exakt diesen Ablauf durchführen:

1. Banking im Browser öffnen.
2. Smartphone als Push-Gerät registrieren.
3. In Einstellungen `GiroCode-/Benachrichtigungstest` öffnen.
4. echte eigene Test-Ziel-IBAN oder ein bewusst kontrolliertes Konto eintragen.
5. z. B. `1,00 EUR` verwenden.
6. `QR-Code erzeugen`.
7. QR mit Banking-App testweise scannen/importieren.
8. prüfen, dass Empfänger, IBAN, Betrag und Verwendungszweck korrekt vorausgefüllt werden.
9. Zahlung **nicht erforderlich**; Scan/Import reicht für den Funktionstest.
10. Smartphone als Zielgerät auswählen.
11. `Test-Benachrichtigung senden`.
12. prüfen, ob die Notification erscheint.
13. prüfen, ob QR direkt als Notification-Bild erscheint.
14. Notification antippen.
15. prüfen, ob Yuvomi den QR-Code groß und korrekt öffnet.
16. nach >30 Minuten prüfen, dass alte Bild-/View-Tokens nicht mehr funktionieren.

---

# 20. Implementierungsreihenfolge für Codex

Codex soll die Arbeit in dieser Reihenfolge ausführen:

### Schritt 1 – Tests für vorhandene Bausteine lesen

Vor Änderungen:

```text
service/test/girocode.test.ts
service/test/push-subscriptions.test.ts
service/test/push-delivery-worker.test.ts
service/src/services/girocode.ts
service/src/services/push-outbox.ts
service/src/api/push-routes.ts
modules/banking/push-worker.js
```

Keine bestehende Logik duplizieren.

### Schritt 2 – Migration + Asset-Service

`018_girocode_test_assets.sql` und `girocode-test-assets.ts` implementieren.

Zuerst Unit Tests für:

- Verschlüsselung
- Tokenhashes
- TTL
- Ownership

### Schritt 3 – Backend-Router

`girocode-test-routes.ts` mit:

```text
POST /tools/girocode/preview
POST /tools/girocode/notify
GET  /tools/girocode/view/:token
GET  /push/girocode-test-images/:token
```

Den öffentlichen Image-Endpoint alternativ im bestehenden `push-routes.ts` halten, wenn dadurch die Capability-Semantik klarer bleibt.

### Schritt 4 – UI

Settings-Testformular, Preview und Subscription-Auswahl implementieren.

### Schritt 5 – Fallback-View

`view=girocode-test` ergänzen.

### Schritt 6 – Integrationstests

Alle API- und Security-Fälle testen.

### Schritt 7 – vollständiger Build

```text
npm test
npm run build
```

### Schritt 8 – manueller Smartphone-Test

Erst danach das Feature als fertig betrachten.

---

# 21. Acceptance Criteria

Das Feature ist fertig, wenn:

- [ ] in den Banking-Einstellungen manuell Empfänger, IBAN, BIC, Betrag und Verwendungszweck eingegeben werden können;
- [ ] daraus serverseitig mit der bestehenden EPC-Implementierung ein gültiger GiroCode erzeugt wird;
- [ ] der QR-Code unmittelbar als Vorschau erscheint;
- [ ] keine vollständige IBAN aus der API zurückgeleakt wird;
- [ ] ein konkretes aktives Push-Gerät ausgewählt werden kann;
- [ ] die Testnotification gezielt nur an dieses Gerät gesendet wird;
- [ ] die Notification eine kurzlebige QR-Image-Capability enthält;
- [ ] die Capability keine Session benötigt, aber nur das PNG offenlegt;
- [ ] das Bild spätestens nach 30 Minuten nicht mehr abrufbar ist;
- [ ] beim Antippen eine authentifizierte Yuvomi-Fallback-Ansicht mit demselben QR-Code erscheint;
- [ ] keine Transfer-Suggestion oder Wochenbudget-Historie durch Tests verschmutzt wird;
- [ ] keine Zahlung automatisch ausgeführt wird;
- [ ] alle bestehenden GiroCode-/Push-Tests weiterhin grün sind;
- [ ] `npm test` und `npm run build` erfolgreich durchlaufen.

---

# 22. Nicht Teil dieser Iteration

Noch nicht umsetzen:

- beliebige Zahlungsvorlagen dauerhaft speichern;
- Kontakte/Empfängerbuch;
- automatisches Ausführen von Überweisungen;
- Enable-Banking-Payment-Initiation;
- wiederkehrende manuelle GiroCodes;
- externe QR-Code-Dienste;
- vollständige IBAN im Browser aus bestehenden Bankkonten auslesen.

Dieses Feature ist bewusst ein kleines, sicheres Diagnosewerkzeug, mit dem der gesamte reale Pfad

```text
manuelle Werte
-> EPC-Payload
-> QR PNG
-> Web Push
-> Smartphone
-> QR-Anzeige
```

isoliert geprüft werden kann, bevor der automatische Wochenbudget-Versand mit echten Daten produktiv eingesetzt wird.
