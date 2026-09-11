# Transaction Data Enrichment – technisches Umsetzungskonzept

Stand der Analyse: aktueller `main` nach dem UI-/Detaildialog-Konzept. Dieses Dokument beschreibt verbindlich, wie Yuvomi Banking **alle technisch verfügbaren Informationen aus Enable Banking ausschöpfen** soll, bevor ein Umsatz als „nicht näher identifizierbar“ gilt.

Das konkrete Problem ist real: Manche PSD2-/AIS-Umsätze enthalten in der normalen Transaktionsliste nur Betrag, Datum, Richtung und Status. Händlername, Gegenpartei und Verwendungszweck können fehlen, obwohl die Banking-App der Bank einen Händler wie „Lidl“ anzeigt. Enable Banking kann nur die Daten weiterreichen, die der jeweilige ASPSP über seine Schnittstelle liefert. Trotzdem nutzt Yuvomi den verfügbaren Datenumfang aktuell noch nicht vollständig aus.

Dieses Dokument ergänzt `docs/TRANSACTIONS_UI_AND_DETAIL_PLAN.md`. Beide Pläne sollen zusammen umgesetzt werden.

---

## 1. Ziel

Nach der Umsetzung soll für jeden importierten Umsatz eine nachvollziehbare Enrichment-Pipeline laufen:

```text
Enable Banking transaction list
        │
        ▼
Liste vollständig und verschlüsselt speichern
        │
        ▼
Standardfelder normalisieren
        │
        ├── eindeutiger Händler vorhanden ──────────────► übernehmen
        │
        ▼
transaction_id vorhanden?
        │
      ja│                                      nein
        ▼                                        │
GET /accounts/{account}/transactions/{id}       │
        │                                        │
        ▼                                        │
Detailpayload speichern + normalisieren          │
        └───────────────────┬────────────────────┘
                            ▼
                  alle Provider-Evidenzen sammeln
                            │
                            ▼
                  lokale Merchant-Erkennung
                            │
                ┌───────────┴────────────┐
                │                        │
             Treffer                  kein Treffer
                │                        │
                ▼                        ▼
       Merchant + Quelle speichern   MCC/Kategorie nutzen
                                         │
                                         ▼
                              AI nur für Kategorie,
                              NICHT Händler erfinden
```

Zusätzlich muss ein Umsatz bei `PDNG -> BOOK` erneut bewertet werden, weil beim gebuchten Umsatz neue Daten vorhanden sein können.

---

## 2. Wichtige Enable-Banking-Eigenschaften

Die Implementierung muss sich an der aktuellen offiziellen Dokumentation orientieren:

- Transaktionsliste:
  `GET /accounts/{account_id}/transactions`
- Einzeltransaktionsdetails:
  `GET /accounts/{account_id}/transactions/{transaction_id}`
- `transaction_id` wird laut Enable Banking **nur dann geliefert, wenn zusätzliche Transaktionsdetails verfügbar sind**.
- `transaction_id` ist ausdrücklich **kein stabiler Identifikator** und darf weiterhin nicht für Deduplizierung verwendet werden.
- `entry_reference` bleibt der bevorzugte stabile Identifikator für gebuchte Umsätze.
- Bei `PDNG` können sich Eigenschaften bis zur endgültigen Buchung verändern.

Referenzen:

- https://enablebanking.com/docs/api/reference/
- https://enablebanking.com/docs/faq/
- https://enablebanking.com/blog/2024/10/29/how-to-sync-account-transactions-from-open-banking-apis-without-unique-transaction-ids

Wenn sich die aktuelle API-Dokumentation bei der Implementierung geändert hat, folgt der Code der aktuellen offiziellen Dokumentation und die Abweichung wird in diesem Dokument nachgezogen.

---

# Teil A – aktueller Code und Lücken

## 3. Vorhandene Grundlage

### `service/src/enable-banking/client.ts`

Bereits vorhanden:

```text
getAccountTransactions()
getAllAccountTransactions()
```

Nicht vorhanden:

```text
getTransactionDetails(accountId, transactionId)
```

Das wird ergänzt.

### `service/src/enable-banking/importer.ts`

Der Importer kennt bereits mehr Providerfelder, als derzeit dauerhaft gespeichert oder ausgewertet werden:

```text
entry_reference
transaction_id
status
merchant_category_code
transaction_amount
creditor / debtor
creditor_account / debtor_account
booking_date
value_date
transaction_date
reference_number
reference_number_schema
remittance_information
creditor_account_additional_identification
debtor_account_additional_identification
bank_transaction_code
note
```

Aktuell werden einige dieser Werte nur für Fingerprinting verwendet oder vollständig ignoriert. Insbesondere `note` wird derzeit nicht in `NormalizedTransaction` übernommen.

### `transactions.raw_payload_encrypted`

Die Spalte existiert bereits seit Migration `001_init.sql`, wird im aktuellen Importer aber nicht befüllt.

Das ist für die geplante vollständige Detailansicht und die Händlerdiagnose eine zentrale Lücke.

### `service/src/services/merchants.ts`

Die lokale Merchant-Registry existiert bereits, z. B.:

```text
Lidl
REWE
ALDI
EDEKA
dm
ROSSMANN
Netflix
Spotify
Amazon
Uber
```

`normalizeMerchant()` prüft aktuell nur:

```text
merchant_name
counterparty_name
purpose
```

Das ist zu wenig. Nach dem Enrichment sollen zusätzliche Provider-Evidenzen einfließen.

### `service/src/api/enable-banking-routes.ts`

Beim manuellen Sync wird aktuell:

1. die komplette Transaktionsliste geladen,
2. direkt `importTransactions()` aufgerufen,
3. der Sync beendet.

Es gibt noch keinen zweiten Enrichment-Schritt für `transaction_id`.

---

# Teil B – Provider-Rohdaten vollständig behalten

## 4. Raw-Payload-Vertrag definieren

`transactions.raw_payload_encrypted` wird zukünftig nicht einfach nur das Listenobjekt enthalten, sondern ein versioniertes Envelope.

Neue Datei:

```text
service/src/services/provider-transaction-payload.ts
```

Verbindliches internes Format:

```ts
interface StoredProviderTransactionPayloadV1 {
  version: 1;
  list: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  list_fetched_at: string;
  detail_fetched_at: string | null;
}
```

Speicherung:

```text
JSON.stringify(envelope)
    -> AES-256-GCM EncryptionService.encrypt()
    -> transactions.raw_payload_encrypted
```

Lesen:

```text
raw_payload_encrypted
    -> decrypt()
    -> JSON.parse()
    -> Schema prüfen
```

Fehler beim Dekodieren dürfen nicht zum Absturz einer kompletten Umsatzliste führen. Der vollständige Detailendpoint darf in diesem Fall `raw_payload_available=false` zurückgeben und einen serverseitig generischen Fehler loggen, jedoch keine verschlüsselten Werte ausgeben.

### Legacy-Kompatibilität

Da das Feld aktuell praktisch nicht verwendet wird, reicht eine tolerante Leseroutine:

- fehlt Wert -> kein Raw Payload
- entschlüsselte JSON-Struktur mit `version: 1` -> neues Format
- entschlüsseltes einfaches Transaction-Objekt -> als `list` behandeln, `detail=null`

Damit sind spätere Zwischenstände kompatibel.

---

## 5. Listenpayload beim Import immer speichern

Datei:

```text
service/src/enable-banking/importer.ts
```

`normalizeTransaction()` bekommt Zugriff auf das vollständige Provider-Objekt bzw. liefert zusätzlich:

```ts
rawListPayload: Record<string, unknown>
```

Beim Insert:

```text
raw_payload_encrypted = encrypt({
  version: 1,
  list: transaction,
  detail: null,
  list_fetched_at: now,
  detail_fetched_at: null
})
```

Beim Update eines bestehenden Datensatzes:

- vorhandenen Detailpayload erhalten,
- `list` durch den neuesten Listenpayload ersetzen,
- `list_fetched_at` aktualisieren.

Nicht einfach das gesamte Envelope überschreiben, weil sonst bereits abgerufene Detaildaten verloren gehen.

Dafür Helper verwenden:

```text
readStoredProviderPayload()
mergeListPayload()
mergeDetailPayload()
writeStoredProviderPayload()
```

Keine Raw-Daten unverschlüsselt loggen.

---

# Teil C – Einzeltransaktionsdetails abrufen

## 6. Client erweitern

Datei:

```text
service/src/enable-banking/client.ts
```

Neue Methode:

```ts
getTransactionDetails(
  accountId: string,
  transactionId: string
): Promise<Record<string, unknown>>
```

Implementierung:

```text
GET /accounts/{account_id}/transactions/{transaction_id}
```

Beide IDs ausschließlich über dieselbe sichere `encodePathId()`-Validierung laufen lassen.

Kein `transaction_id` aus dem Browser für Providerrequests akzeptieren. Der Sidecar liest `provider_account_id` und `transaction_id` ausschließlich aus der eigenen DB.

---

## 7. Detailabrufstatus persistieren

Wir müssen verhindern, dass bei jedem Sync immer wieder derselbe Detailendpoint abgefragt wird.

Neue append-only Migration mit der **nächsten freien Migrationsnummer** erstellen. Bestehende Migrationen niemals ändern.

Neue Spalten in `transactions`:

```sql
provider_detail_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK(provider_detail_state IN (
    'unknown',
    'available',
    'fetched',
    'unavailable',
    'failed'
  ));

provider_detail_last_attempt_at TEXT;
provider_detail_fetched_at TEXT;
provider_detail_attempt_count INTEGER NOT NULL DEFAULT 0;
```

Bedeutung:

- `unknown`: noch nicht entschieden
- `available`: `transaction_id` vorhanden, noch nicht erfolgreich abgerufen
- `fetched`: Detailpayload erfolgreich vorhanden
- `unavailable`: kein `transaction_id`; Provider sagt damit aktuell, dass kein Detailabruf verfügbar ist
- `failed`: Detailabruf ist wiederholt fehlgeschlagen; Retry-Regeln gelten

Beim Import:

```text
transaction_id vorhanden && noch kein Detailpayload
    -> available

transaction_id fehlt
    -> unavailable
```

Wichtig bei Updates:

Wenn ein Umsatz vorher `unavailable` war und bei einem späteren `BOOK`-Abruf plötzlich eine `transaction_id` bekommt:

```text
unavailable -> available
```

Wenn sich `transaction_id` ändert, wird nicht dedupliziert, aber der neue Wert darf für den nächsten Detailabruf verwendet werden.

---

## 8. Enrichment-Service als eigene Schicht

Neue Datei:

```text
service/src/services/transaction-enrichment.ts
```

Nicht die komplette Logik in `enable-banking-routes.ts` schreiben.

Public API:

```ts
interface EnrichAccountTransactionsOptions {
  database: DatabaseSync;
  client: EnableBankingClient;
  accountId: number;
  providerAccountId: string;
  encryption: EncryptionService;
  now?: Date;
  maxDetails?: number;
}

interface EnrichAccountTransactionsResult {
  candidates: number;
  attempted: number;
  fetched: number;
  unavailable: number;
  failed: number;
  merchantsResolved: number;
}

async function enrichAccountTransactions(...): Promise<...>
```

Der Service arbeitet **außerhalb einer langen SQLite-Write-Transaktion**.

Ablauf:

1. Kandidaten aus DB lesen.
2. Provider-Detailrequests durchführen.
3. Antworten im Speicher sammeln.
4. anschließend kurze DB-Updates durchführen.
5. Merchant-Normalisierung ausführen.

Keine Netzwerkrequests innerhalb `BEGIN IMMEDIATE`.

---

## 9. Welche Umsätze Detailrequests erhalten

Priorität:

### Höchste Priorität

Umsätze mit:

```text
transaction_id IS NOT NULL
AND merchant_name IS NULL
AND counterparty_name IS NULL
AND (purpose IS NULL OR purpose = '')
```

Genau solche Fälle wie die problematische Lidl-Buchung sollen zuerst aufgelöst werden.

### Zweite Priorität

```text
transaction_id IS NOT NULL
AND merchant_key IS NULL
```

Auch wenn irgendein Freitext vorhanden ist, kann der Detailpayload bessere Daten liefern.

### Dritte Priorität

`PDNG`-Umsätze, die inzwischen als `BOOK` aktualisiert wurden und bisher keinen erfolgreichen Detailabruf nach dem Booking hatten.

### Nicht abrufen

Wenn:

```text
transaction_id IS NULL
```

Dann existieren laut Enable Banking normalerweise keine zusätzlichen Details über diesen Endpoint.

---

## 10. Rate-Limit- und Retry-Verhalten

Nicht für hunderte historische Umsätze gleichzeitig Detailrequests abschießen.

Default:

```text
maxDetails pro normalem Account-Sync: 25
Concurrency: 3
```

Konstanten in `transaction-enrichment.ts`, nicht verstreut.

Retry:

```text
1. Fehler -> frühestens beim nächsten regulären Sync
2. Fehler -> mindestens 6 Stunden Pause
3+ Fehler -> höchstens einmal pro 24 Stunden
```

HTTP-Fehler:

- `404`: `unavailable`, wenn die API signalisiert, dass der Transaktionsdetaildatensatz nicht mehr existiert.
- `400/403`: nicht aggressiv wiederholen; `failed` + Backoff.
- `429`: gesamten Detailbatch abbremsen/stoppen, nicht alle Kandidaten weiterfeuern.
- `5xx`: `failed`, später erneut versuchen.

`EnableBankingApiError.status` ist bereits vorhanden und soll dafür verwendet werden.

Keine Response-Bodies mit Bankdaten in Logs schreiben.

---

# Teil D – tatsächlich alle Händler-Evidenzen auswerten

## 11. Normalisierte Providerfelder erweitern

Neue Migration – dieselbe oder eine nachfolgende neue Migration – für Felder, die für Suche, Diagnose und Merchant-Erkennung sinnvoll sind.

Empfohlene neue `transactions`-Spalten:

```text
provider_note TEXT
reference_number TEXT
reference_number_schema TEXT
bank_transaction_code TEXT
counterparty_additional_identification TEXT
merchant_evidence_source TEXT
merchant_resolution_method TEXT
```

`bank_transaction_code` wird als kompakter JSON-String oder deterministisch normalisierter Text gespeichert, nicht als `[object Object]`.

`merchant_evidence_source` enthält **nur den Pfad/Typ**, z. B.:

```text
list.creditor.name
list.remittance_information
detail.creditor.name
detail.note
detail.raw_alias_scan
manual
```

Keinen vollständigen sensiblen Freitext doppelt als Evidence-Spalte speichern.

`merchant_resolution_method`:

```text
provider_explicit
registry_alias
manual
```

Später optional:

```text
external_enrichment
```

---

## 12. Provider-Evidence-Collector implementieren

Neue Datei:

```text
service/src/services/transaction-evidence.ts
```

Public API:

```ts
interface TransactionEvidence {
  source: string;
  value: string;
  strength: 'strong' | 'medium' | 'weak';
}

function collectTransactionEvidence(
  listPayload: Record<string, unknown>,
  detailPayload?: Record<string, unknown> | null
): TransactionEvidence[]
```

### Strong evidence

Explizite Personen-/Händlerfelder aus Providerpayload:

```text
creditor.name
debtor.name
merchant_name               # falls Provider je nach ASPSP proprietär liefert
merchant.name               # falls proprietär vorhanden
card_acceptor_name           # falls proprietär vorhanden
```

Es darf generisch über bekannte Property-Namen gelesen werden, ohne auf eine bestimmte Bank fest verdrahtet zu sein.

### Medium evidence

```text
remittance_information
note
reference_number
creditor_account_additional_identification
debtor_account_additional_identification
bank_transaction_code.description
```

### Weak evidence

Weitere String-Leaf-Werte aus dem Raw-Providerpayload.

Hier liegt eine wichtige Chance: Manche ASPSPs liefern händlerspezifische Informationen in proprietären/unharmonisierten Feldern, die unser aktuelles TypeScript-Modell zwar durch `[key: string]: unknown` akzeptiert, aber komplett ignoriert.

Darum soll zusätzlich ein **kontrollierter rekursiver Raw-Alias-Scan** stattfinden.

Regeln:

- maximal 5 Ebenen tief
- nur Strings
- pro String maximal 2.000 Zeichen
- keine Schlüssel/Werte aus einer Denylist durchsuchen, falls sie Tokens/Secrets darstellen könnten
- keine Werte als Händler anzeigen, nur weil sie irgendwo stehen
- Raw-Scan dient ausschließlich dazu, bekannte Aliase der lokalen Merchant Registry zu finden

Beispiel:

```json
{
  "some_bank_specific_field": "POS LIDL 1234 LAMBRECHT"
}
```

Auch wenn Yuvomi den Feldnamen nicht kennt, darf die vorhandene Registry daraus `Lidl` erkennen.

Das ist **kein fuzzy AI guessing**. Es ist ein deterministischer Alias-Treffer auf tatsächlich gelieferten Daten.

---

## 13. Merchant-Erkennung umbauen

Datei:

```text
service/src/services/merchants.ts
```

Aktuelles:

```ts
normalizeMerchant(merchant_name, counterparty_name, purpose)
```

Zukünftig bleibt `normalizeMerchant()` als primitive Funktion erhalten, aber `normalizeMerchantsForAccount()` bekommt die volle Evidence-Pipeline.

Vorgeschlagene neue Funktion:

```ts
resolveMerchantFromEvidence(
  evidence: TransactionEvidence[]
): {
  merchant: NormalizedMerchant;
  source: string;
  method: 'provider_explicit' | 'registry_alias';
} | null
```

Priorität:

1. expliziter bereits vorhandener `merchant_name`, wenn er aus vertrauenswürdigem Providerfeld stammt
2. Registry-Alias in Strong Evidence
3. Registry-Alias in Medium Evidence
4. Registry-Alias in Weak/Raw Evidence
5. kein Treffer

Kein Levenshtein/Fuzzy-Matching für kurze Händleraliase. Sonst entstehen Fehlzuordnungen.

### Beispiel Lidl

Wenn Listenpayload leer ist, Detailpayload aber enthält:

```text
note = "POS LIDL 01537"
```

Resultat:

```text
merchant_key = lidl
merchant_name = Lidl
merchant_evidence_source = detail.note
merchant_resolution_method = registry_alias
```

Wenn auch der Detailpayload nirgendwo `LIDL` enthält, wird **nicht** geraten.

---

## 14. MCC sinnvoll, aber nicht als Händleridentität verwenden

`merchant_category_code` kann helfen, eine **Kategorie** zu erkennen, aber nicht den Händler.

Beispiel:

```text
MCC 5411 -> Grocery Stores / Supermarkets
```

Aus MCC 5411 darf Yuvomi ableiten:

```text
Kategorie möglicherweise Lebensmittel
```

aber niemals:

```text
Händler = Lidl
```

Dafür neue Datei optional:

```text
service/src/services/mcc.ts
```

Sie soll zunächst nur eine kleine lokale Mapping-Schicht bereitstellen, falls die OpenAI-Kategorisierung oder UI davon profitiert.

MCC-Mapping ist rein lokal und ohne Netzwerkrequest.

---

# Teil E – PDNG -> BOOK gezielt neu anreichern

## 15. Booking-Transition erkennen

Der Importer kann bereits `PDNG` und `BOOK` reconciliieren.

Erweitere das Update so, dass intern erkannt wird:

```text
existing.status === PDNG
incoming.status === BOOK
```

Das ImportResult sollte zusätzlich liefern:

```ts
bookedTransactionIds: number[]
```

oder allgemeiner:

```ts
enrichmentCandidateIds: number[]
```

Diese IDs werden dem Enrichment-Service bevorzugt übergeben.

Bei `PDNG -> BOOK`:

1. Listenpayload ersetzen/mergen.
2. Providerfelder erneut normalisieren.
3. wenn aktuelle `transaction_id` vorhanden: Detailabruf erneut erlauben, auch wenn vorher schon ein Pending-Detailpayload existierte.
4. Merchant-Erkennung erneut ausführen.
5. Kategorisierungsregel erst nach dieser Anreicherung anwenden.

Das reduziert Fälle, bei denen ein vorgemerkter, informationsarmer Umsatz zu früh als „unbekannt“ festgeschrieben wird.

---

# Teil F – Sync-Pipeline umbauen

## 16. Manueller Sync

Aktuell in:

```text
service/src/api/enable-banking-routes.ts
POST /accounts/:accountId/sync
```

Neuer Ablauf:

```text
1. list transactions bei Enable Banking abrufen
2. importTransactions()
3. enrichAccountTransactions()
4. category rules erneut anwenden
5. merchant normalization/enrichment finalisieren
6. last_synced_at schreiben
7. weekly budget lifecycle reconciliieren
8. Response zurückgeben
```

Wichtig:

`importTransactions()` darf weiterhin lokal atomar arbeiten, aber Provider-Detailrequests laufen danach außerhalb seiner SQLite-Transaktion.

Response-Meta erweitern:

```json
{
  "imported": {
    "inserted": 3,
    "updated": 20
  },
  "enrichment": {
    "candidates": 6,
    "attempted": 4,
    "fetched": 3,
    "failed": 1,
    "merchants_resolved": 2
  }
}
```

Das Frontend muss diese Zahlen nicht prominent anzeigen; für Debugging kann der Sync-Feedbacktext später `3 Detaildaten ergänzt` erwähnen.

---

## 17. Scheduled Sync ebenfalls dieselbe Pipeline verwenden

Nicht nur der manuelle Endpoint darf Detaildaten abrufen.

Suche im aktuellen Scheduler/Worker nach der Stelle, an der `getAllAccountTransactions()` + `importTransactions()` ausgeführt werden.

Extrahiere deshalb bevorzugt einen gemeinsamen Service:

```text
service/src/services/account-sync.ts
```

Public API:

```ts
syncBankAccount({
  database,
  client,
  account,
  hmacSecret,
  encryption,
  now,
  options
})
```

Sowohl:

```text
POST /accounts/:id/sync
```

als auch der Scheduler verwenden exakt diesen Service.

Damit gibt es keine zwei auseinanderlaufenden Sync-Implementierungen.

---

# Teil G – On-demand „alles versuchen“

## 18. Einzelnen Umsatz manuell erneut anreichern

Für problematische Fälle wie Lidl soll der Benutzer im Detaildialog gezielt sagen können:

```text
Providerdetails erneut abrufen
```

Neuer Endpoint:

```text
POST /api/extensions/banking/transactions/:transactionId/enrich
```

Anforderungen:

- `write` Permission
- CSRF
- Ownership über Transaction -> Account -> Connection -> Yuvomi User prüfen
- internen DB-Transaction-Identifier verwenden
- Provider-`transaction_id` und `provider_account_id` ausschließlich aus DB lesen
- falls keine Provider-`transaction_id`: Response mit
  `detail_available: false`
- falls vorhanden: Detailendpoint einmal gezielt abrufen
- Raw-Payload mergen
- normalisierte Felder aktualisieren
- Merchant-Pipeline erneut ausführen
- Kategorie-Regeln erneut ausführen

Antwort:

```json
{
  "data": {
    "detail_available": true,
    "detail_fetched": true,
    "merchant_resolved": true,
    "merchant_name": "Lidl"
  }
}
```

Der Button gehört in den geplanten vollständigen Umsatz-Detaildialog aus `TRANSACTIONS_UI_AND_DETAIL_PLAN.md`.

Label DE:

```text
Providerdetails neu abrufen
```

Unterhalb kann ein Diagnosehinweis stehen:

```text
Enable Banking liefert zusätzliche Transaktionsdetails nur, wenn die Bank hierfür eine transaction_id bereitstellt.
```

---

# Teil H – vollständiger Detaildialog als Diagnosewerkzeug

## 19. Detailendpoint erweitert um Enrichment-Diagnose

Der im UI-Plan vorgesehene Endpoint:

```text
GET /api/extensions/banking/transactions/:transactionId
```

soll zusätzlich liefern:

```json
{
  "enrichment": {
    "provider_detail_state": "fetched",
    "provider_detail_fetched_at": "...",
    "provider_detail_attempt_count": 1,
    "merchant_resolution_method": "registry_alias",
    "merchant_evidence_source": "detail.note",
    "transaction_id_available": true
  }
}
```

Damit kann die UI transparent erklären, **warum** ein Händler erkannt wurde oder nicht.

Beispiele:

### Händler gefunden

```text
Händler: Lidl
Quelle: Enable-Banking-Detaildaten → note
Erkennung: lokale Händlerregel
```

### Detaildaten vorhanden, aber ohne Händlerhinweis

```text
Keine Händlerkennung gefunden.
Die Bank hat zusätzliche Transaktionsdetails geliefert, aber keinen Händlerbezug.
```

### Kein `transaction_id`

```text
Keine zusätzlichen Providerdetails verfügbar.
Die Bank liefert für diesen Umsatz keine transaction_id.
```

Das ist wichtig, damit wir unterscheiden können zwischen:

- Yuvomi hat etwas nicht ausgewertet,
- Enable Banking hätte Details angeboten, Abruf schlug fehl,
- die Bank hat schlicht keine brauchbaren Händlerinformationen geliefert.

---

# Teil I – Suche ebenfalls mit angereicherten Daten verbessern

## 20. Transaction-Query erweitern

Datei:

```text
service/src/services/transactions-query.ts
```

Die freie Suche `q` prüft aktuell:

```text
merchant_name
counterparty_name
purpose
```

Nach Migration zusätzlich:

```text
provider_note
reference_number
```

Nicht den kompletten entschlüsselten Raw-Payload in SQL durchsuchen. Das wäre ineffizient und würde Verschlüsselung aushebeln.

Merchant-Erkennung sorgt ohnehin dafür, dass bekannte Händler anschließend über `merchant_name` auffindbar sind.

---

# Teil J – AI erst nach deterministischem Enrichment

## 21. Reihenfolge der Kategorisierung ändern/prüfen

OpenAI darf erst zum Einsatz kommen, nachdem folgende Schritte abgeschlossen sind:

```text
Provider list
Provider detail
Raw evidence scan
Merchant registry
Counterparty rules
Merchant rules
Text rules
MCC hints
↓
OpenAI
```

Das spart Tokens und verbessert Kategorien.

### Sehr wichtige Regel

OpenAI darf aus informationsarmen Daten **keinen Händler erfinden**.

Wenn wir nur wissen:

```text
17,39 EUR
10.09.2026
DBIT
MCC 5411
```

kann OpenAI z. B. vorschlagen:

```text
Kategorie: Lebensmittel
```

aber nicht:

```text
Händler: Lidl
```

Der Händlername muss immer auf tatsächlich gelieferter oder manuell bestätigter Evidence basieren.

---

# Teil K – manuelle Händlerzuordnung als letzter lokaler Fallback

## 22. Händler manuell setzen

Wenn Providerdaten wirklich keinen Händler enthalten, braucht Yuvomi eine saubere manuelle Möglichkeit.

Im Detaildialog:

```text
Händler
[ Nicht erkannt                       ]
[ Händler zuordnen ]
```

Der Nutzer kann:

- existierenden Merchant aus Registry wählen,
- später optional einen eigenen Merchant anlegen.

Wichtig: Eine manuelle Zuordnung darf **nicht automatisch auf alle Umsätze gleichen Betrags/Datums übertragen** werden.

Sie darf nur automatisch lernen, wenn ein stabiler Wiedererkennungsschlüssel vorhanden ist, z. B.:

```text
counterparty_id
oder belastbares wiederkehrendes Providermerkmal
```

Wenn der Umsatz wirklich nur Betrag + Datum enthält, bleibt die Zuordnung auf diesen einzelnen Umsatz beschränkt.

Neue `merchant_resolution_method = manual`.

Die eigentliche UI für Custom Merchants kann später separat ausgebaut werden; für diese Phase reicht die Auswahl aus der vorhandenen `MERCHANT_REGISTRY` plus „nur diesen Umsatz“.

---

# Teil L – Data-Quality-Metriken

## 23. Sichtbar machen, welche Bank wie gute Daten liefert

Für echte Nutzung ist es wertvoll zu wissen, ob ein ASPSP dauerhaft schwache Daten liefert.

Kein neues Analytics-System nötig. Eine serverseitige Diagnosefunktion reicht:

```text
service/src/services/transaction-data-quality.ts
```

Für ein Konto berechnen:

```text
transactions_total
with_counterparty_name
with_purpose
with_mcc
with_transaction_id
with_detail_payload
with_resolved_merchant
```

Optionaler Debug-/Settings-Endpunkt:

```text
GET /api/extensions/banking/accounts/:accountId/data-quality
```

Nur `read` und Ownership.

Beispiel:

```text
Letzte 100 gebuchte Umsätze
Händler/Gegenpartei vorhanden: 42 %
Verwendungszweck vorhanden:     51 %
Detailabruf verfügbar:          36 %
Händler erkannt:                58 %
```

Damit lässt sich objektiv beurteilen, ob eine Bank via PSD2 für Yuvomi brauchbar ist.

Nicht auf der Hauptseite anzeigen; höchstens unter Konto-Details oder Diagnose.

---

# Teil M – Enable-Banking-Control-Panel und Support

## 24. Debugging außerhalb von Yuvomi

Wenn ein konkreter Umsatz auch nach Detailabruf keinerlei Händlerdaten enthält, soll die Entwicklerdokumentation festhalten:

1. Request im Enable-Banking-Control-Panel suchen.
2. prüfen, ob der rohe Enable-Banking-Response schon informationsarm ist.
3. bei verdächtiger Integration Request-ID notieren.
4. gegebenenfalls Enable-Banking-Support mit Request-ID kontaktieren.

Yuvomi darf Request-IDs gerne als technische Diagnose speichern, **falls** Enable Banking diese in Response-Headers bereitstellt. Aktuell nicht voraussetzen; erst dokumentierte Header prüfen.

Keine Scraping-Lösung für das Control Panel bauen.

---

# Teil N – optionaler FinTS-Fallback nach Abschluss des Enable-Banking-Enrichments

## 25. Warum FinTS nur Phase 2 ist

Wenn eine deutsche Bank in ihrer eigenen App „LIDL“ anzeigt, aber weder Listen- noch Detailpayload über PSD2 einen Händlerhinweis liefern, kann Yuvomi aus Enable Banking allein nichts mehr herausholen.

Dann ist ein zweiter Datenkanal sinnvoll zu prüfen:

```text
FinTS / HBCI
```

Viele deutsche Banken liefern Kontoauszugsdaten darüber in klassischen Bankformaten wie CAMT/MT940-artigen Strukturen, die andere oder reichhaltigere Buchungstexte enthalten können.

Das ist **nicht garantiert** und technisch wesentlich komplexer (Bankzugang, SCA/TAN, Bibliothek, Providerunterschiede). Deshalb nicht mit dem Enable-Banking-Enrichment vermischen.

### Architektur vorbereiten, nicht sofort bauen

Neue Providerdetails sollen deshalb nie direkt fest in UI-Komponenten verdrahtet werden.

Langfristige Abstraktion:

```ts
interface TransactionMetadataProvider {
  enrich(transaction: LocalTransaction): Promise<ProviderEnrichmentResult>;
}
```

Provider:

```text
EnableBankingMetadataProvider   <- jetzt
FinTsMetadataProvider           <- später optional
```

Beide liefern normalisierte Evidenzen an dieselbe Merchant-/Category-Pipeline.

Keine FinTS-Credentials in dieser Phase implementieren.

---

# Teil O – konkrete Dateiänderungen

## 26. Neue Dateien

```text
service/src/services/provider-transaction-payload.ts
service/src/services/transaction-evidence.ts
service/src/services/transaction-enrichment.ts
service/src/services/account-sync.ts
service/src/services/transaction-data-quality.ts       # optional, aber empfohlen
service/src/services/mcc.ts                            # optional klein starten
service/test/transaction-enrichment.test.ts
service/test/transaction-evidence.test.ts
service/test/account-sync.test.ts
```

Zusätzlich nächste freie Migration:

```text
service/migrations/<next>_transaction_enrichment.sql
```

---

## 27. Bestehende Dateien ändern

### `service/src/enable-banking/client.ts`

- `getTransactionDetails()` ergänzen.

### `service/src/enable-banking/importer.ts`

- Raw Listenpayload verschlüsselt speichern.
- vorhandenes Detailpayload bei Listenupdates erhalten.
- `note` vollständig normalisieren.
- `reference_number`, `reference_number_schema`, `bank_transaction_code`, Additional Identification persistieren.
- `provider_detail_state` setzen.
- Booking-Transition als Enrichment-Kandidat melden.

### `service/src/services/merchants.ts`

- Evidence-basierte Merchant-Erkennung.
- Raw alias scan über `transaction-evidence.ts` nutzen.
- `merchant_evidence_source` und `merchant_resolution_method` speichern.

### `service/src/api/enable-banking-routes.ts`

- direkte Sync-Implementierung durch `syncBankAccount()` ersetzen.
- Sync-Response um Enrichment-Meta ergänzen.

### Scheduled-Sync-Datei

- denselben `syncBankAccount()` Service verwenden.

### `service/src/services/transactions-query.ts`

- Suche um neue normalisierte Providerfelder erweitern.
- Detailfelder nicht unnötig in der normalen Tabellenliste zurückgeben.

### `service/src/api/transaction-routes.ts`

Ergänzen:

```text
GET  /transactions/:transactionId
POST /transactions/:transactionId/enrich
```

Der GET-Endpoint ist mit dem UI-Detailplan abzustimmen und soll nicht doppelt implementiert werden.

### `modules/banking/index.js`

Im vollständigen Umsatzdialog:

- Enrichment-Diagnose anzeigen.
- Button `Providerdetails neu abrufen`.
- nach erfolgreichem Enrichment Dialogdaten und Tabellenzeile neu laden.

### `modules/banking/locales/de.json`
### `modules/banking/locales/en.json`

Neue Texte für Diagnose, Detailabruf und Evidence.

---

# Teil P – API-Verträge

## 28. Detailendpoint

```http
GET /api/extensions/banking/transactions/123
```

Antwortauszug:

```json
{
  "data": {
    "transaction": {
      "id": 123,
      "merchant_name": "Lidl",
      "counterparty_name": null,
      "purpose": null,
      "provider_note": "POS LIDL 01537",
      "mcc": "5411"
    },
    "enrichment": {
      "transaction_id_available": true,
      "provider_detail_state": "fetched",
      "provider_detail_fetched_at": "2026-09-11T19:20:00Z",
      "merchant_resolution_method": "registry_alias",
      "merchant_evidence_source": "detail.note"
    },
    "provider_payload": {
      "list": {},
      "detail": {}
    }
  }
}
```

`provider_payload` wird nur an den Besitzer mit Banking-Read-Permission ausgeliefert und niemals gecacht.

---

## 29. Enrich-Endpoint

```http
POST /api/extensions/banking/transactions/123/enrich
x-banking-csrf: ...
```

Antwort:

```json
{
  "data": {
    "detail_available": true,
    "detail_fetched": true,
    "merchant_resolved": true,
    "merchant_name": "Lidl",
    "provider_detail_state": "fetched"
  }
}
```

Wenn kein `transaction_id` vorhanden:

```json
{
  "data": {
    "detail_available": false,
    "detail_fetched": false,
    "merchant_resolved": false,
    "provider_detail_state": "unavailable"
  }
}
```

Kein 500 dafür – das ist ein normaler fachlicher Zustand.

---

# Teil Q – Tests

## 30. Client Tests

Test:

```text
getTransactionDetails('account-1', 'txn-123')
```

muss exakt:

```text
GET /accounts/account-1/transactions/txn-123
```

erzeugen.

Ungültige IDs werden abgewiesen.

---

## 31. Raw-Payload Tests

- Listenpayload wird verschlüsselt gespeichert.
- Klartext „LIDL“ erscheint nicht in `raw_payload_encrypted`.
- Payload lässt sich mit EncryptionService wieder lesen.
- erneuter Listenimport erhält vorhandenes `detail`.
- Detailmerge erhält aktuellen `list`-Payload.

---

## 32. Evidence Tests

### Expliziter Händler

```text
creditor.name = Lidl Dienstleistung GmbH
```

-> Lidl erkannt.

### Remittance

```text
remittance_information = ["Kartenzahlung LIDL 0123"]
```

-> Lidl erkannt.

### Note nur im Detailpayload

```text
list: kein Hinweis
detail.note = "POS LIDL 0123"
```

-> Lidl erkannt, Quelle `detail.note`.

### Proprietäres unbekanntes Feld

```json
{
  "bank_specific": {
    "pos_information": "LIDL DE1234"
  }
}
```

-> Lidl über Raw-Alias-Scan erkannt.

### Kein echter Hinweis

```text
17,39 EUR + MCC 5411
```

-> **kein Lidl**.

---

## 33. Enrichment Tests

- `transaction_id` vorhanden -> Detailrequest wird ausgeführt.
- kein `transaction_id` -> kein Request, Status `unavailable`.
- Detailrequest erfolgreich -> Raw-Detailpayload gespeichert.
- 404 -> `unavailable`.
- 500 -> `failed`, Retry möglich.
- 429 -> Batch stoppt bzw. startet keine ungebremste Requestserie.
- bereits frisch `fetched` -> kein unnötiger erneuter Request.
- `PDNG -> BOOK` erlaubt erneuten Detailabruf.

---

## 34. Ownership-/Security-Tests

`POST /transactions/:id/enrich`:

- anonymous -> 401
- anderer Yuvomi-Benutzer -> 404 oder 403 gemäß bestehender Konvention
- read permission -> 403
- write + falsches CSRF -> abweisen
- write + korrektes CSRF + owned transaction -> Erfolg

`GET /transactions/:id`:

- mindestens read
- nur owned transaction
- `Cache-Control: no-store`

Provider-Account-ID und Provider-Transaction-ID werden nicht blind aus Requestparametern übernommen.

---

## 35. Regressionstests

Unbedingt erhalten:

- bestehende Deduplizierung
- `entry_reference`-Priorität
- veränderliche `transaction_id` erzeugt kein Duplikat
- PDNG/BOOK-Reconciliation
- Wochenbudget
- Kategorisierung
- Merchant-Logos

Detail-Enrichment darf keine lokale Transaction-ID neu erzeugen.

---

# Teil R – Implementierungsreihenfolge für Codex

## 36. Schritt 1 – Providerpayload sicher persistieren

Implementiere zuerst:

```text
provider-transaction-payload.ts
Importer raw_payload_encrypted
Tests
```

Noch keine Detailrequests.

Akzeptanz:

- Raw Listenpayload verschlüsselt in DB.
- keine Regressionen.

---

## 37. Schritt 2 – Detailendpoint im EnableBankingClient

Implementiere:

```text
getTransactionDetails()
```

mit Unit-Test.

---

## 38. Schritt 3 – Migration und Enrichment-State

Nächste freie Migration erstellen und Detailstatusfelder hinzufügen.

Bestehende DB muss ohne Datenverlust migrieren.

---

## 39. Schritt 4 – Evidence Collector + Merchant Pipeline

Implementiere:

```text
transaction-evidence.ts
resolveMerchantFromEvidence()
```

inklusive Raw-Alias-Scan und Tests.

---

## 40. Schritt 5 – `transaction-enrichment.ts`

Detailrequests mit:

```text
Concurrency 3
max 25 pro normalem Sync
Retry/Backoff
```

implementieren.

Danach Integrationstest mit simuliertem Lidl-Fall.

---

## 41. Schritt 6 – gemeinsamen `account-sync.ts` Service erstellen

Manuellen und geplanten Sync darauf umstellen.

Keine duplizierte Sync-Logik behalten.

---

## 42. Schritt 7 – Detaildialog und On-demand-Enrichment

Mit `TRANSACTIONS_UI_AND_DETAIL_PLAN.md` zusammenführen:

```text
GET /transactions/:id
POST /transactions/:id/enrich
Dialog
Diagnose
Provider-Rohdaten
```

---

## 43. Schritt 8 – AI-Reihenfolge und Suchindex prüfen

Erst nach Provider-/Merchant-Enrichment kategorisieren.

Search `q` um Provider Note/Reference erweitern.

---

## 44. Schritt 9 – Data Quality Diagnose

Optional, aber vor Production empfohlen.

Damit kann für Sparkasse/N26/andere Institute quantitativ geprüft werden, wie gut die gelieferten Daten tatsächlich sind.

---

# Teil S – Definition of Done

## 45. Funktionale Akzeptanzkriterien

Die Phase gilt erst als fertig, wenn:

1. jeder neue Umsatz seinen vollständigen Listenpayload verschlüsselt lokal speichert,
2. `transaction_id` automatisch für den Detailendpoint verwendet wird,
3. Detailpayloads ebenfalls verschlüsselt gespeichert werden,
4. ein Händlerhinweis in `note`, Remittance, Gegenpartei oder proprietären Stringfeldern von der lokalen Merchant Registry erkannt werden kann,
5. `PDNG -> BOOK` einen erneuten Enrichment-Pass auslöst,
6. kein Händler nur aus Betrag/Datum/MCC erraten wird,
7. unbekannte Händler sauber unbekannt bleiben,
8. der Umsatzdialog transparent zeigt, welche Providerdaten vorhanden waren,
9. ein Nutzer einen einzelnen Umsatz manuell erneut beim Provider anreichern kann,
10. normale Listenansichten niemals entschlüsselte Rohpayloads enthalten,
11. bestehende Deduplizierung und Wochenbudgetlogik nicht regressieren,
12. `npm test` und `npm run build` vollständig grün sind.

---

# Teil T – Erwartung für den konkreten Lidl-Fall

Nach Umsetzung kann Yuvomi folgende Fälle unterscheiden:

### Fall A – Listenpayload enthält Lidl

Direkte lokale Erkennung.

### Fall B – Liste enthält nichts, Detailendpoint enthält Lidl

Automatischer Detailabruf -> Lidl wird erkannt.

### Fall C – Lidl steckt in einem unbekannten proprietären Raw-Feld

Raw-Alias-Scan -> Lidl wird erkannt.

### Fall D – nur MCC weist auf Supermarkt hin

Händler bleibt unbekannt; Kategorie kann `Lebensmittel` werden.

### Fall E – weder Liste noch Detailpayload enthalten irgendeinen Händlerhinweis

Yuvomi zeigt transparent:

```text
Händler nicht identifizierbar.
Die Bank hat über die verfügbare PSD2-Schnittstelle keinen Händlerhinweis geliefert.
```

Dann ist die Grenze von Enable Banking/ASPSP erreicht. Erst danach lohnt sich ein separater FinTS-Fallback.

---

## 46. Nicht in dieser Phase

Nicht zusammen mit diesem Paket implementieren:

- automatisches Web-Scraping nach Händlern anhand von Betrag/Datum
- Google-Suche nach möglichen Händlern
- AI-Händler-Raten
- automatische Zuordnung anhand nur desselben Betrags
- FinTS/HBCI-Zugangsdaten
- Payment Initiation

Diese Ansätze würden entweder falsche Zuordnungen erzeugen oder das Sicherheits-/Scope-Risiko unnötig erhöhen.

Der Fokus dieser Phase lautet:

> **Zuerst jede tatsächlich von Bank und Enable Banking gelieferte Information vollständig erfassen, speichern, zusammenführen und deterministisch auswerten. Erst wenn danach keine Händler-Evidence existiert, gilt der Umsatz als unbekannt.**
