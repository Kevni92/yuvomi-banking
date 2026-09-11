# Plan: Gegenpartei-/Händlername auch ohne IBAN übernehmen

## Ziel

Kartenzahlungen und andere Umsätze sollen den vom Provider gelieferten Gegenpartei-/Händlernamen auch dann anzeigen, wenn für die Gegenpartei keine IBAN vorhanden ist.

Der konkrete Fehlerfall ist ein ausgehender Kartenumsatz mit Providerdaten wie:

```json
{
  "creditor": {
    "name": "E-Kissel SBK Lambrecht"
  },
  "creditor_account": null,
  "credit_debit_indicator": "DBIT",
  "status": "BOOK",
  "transaction_amount": {
    "currency": "EUR",
    "amount": "17.39"
  }
}
```

Aktuell erscheint dieser Umsatz in der UI als `Umsatz`, obwohl der Provider mit `creditor.name` bereits einen brauchbaren Anzeigenamen liefert.

---

## 1. Ursache im aktuellen Code

Betroffene Datei:

- `service/src/enable-banking/importer.ts`

In `normalizeTransaction()` wird für ausgehende Umsätze korrekt der Creditor als Gegenpartei gewählt:

```ts
const counterpartySource = direction === 'incoming'
  ? { party: transaction.debtor, account: transaction.debtor_account }
  : { party: transaction.creditor, account: transaction.creditor_account };
```

Danach werden Name und IBAN getrennt gelesen:

```ts
const iban = stringValue(counterpartySource.account?.iban);
const name = stringValue(counterpartySource.party?.name);
```

Der eigentliche Fehler folgt unmittelbar danach:

```ts
const counterparty = iban
  ? {
      id: counterpartyId(iban, hmacSecret),
      name,
      ibanEncrypted: encryption.encrypt(normalizeIban(iban))
    }
  : null;
```

Damit hängt nicht nur die stabile Gegenpartei-Identität, sondern fälschlicherweise auch der Gegenpartei-Name von einer vorhandenen IBAN ab.

Bei Kartenzahlungen ist `creditor_account` häufig leer. Dann wird trotz vorhandenem `creditor.name`:

```text
counterparty = null
counterparty_name = null
```

Beim INSERT und UPDATE wird derzeit ebenfalls nur

```ts
normalized.counterparty?.name ?? null
```

in `transactions.counterparty_name` geschrieben.

Dadurch geht der Providername aus der normalisierten Transaktion verloren.

---

## 2. Gewünschtes Datenmodell

Name und stabile Identität müssen getrennt behandelt werden.

### Gegenpartei-Name

Ein Providername wie

```text
E-Kissel SBK Lambrecht
```

ist ein brauchbarer Anzeigewert und soll unabhängig von einer IBAN in

```text
transactions.counterparty_name
```

gespeichert werden.

### Gegenpartei-Identität

Ein Eintrag in `counterparties` soll weiterhin nur erzeugt werden, wenn eine ausreichend stabile Identität vorhanden ist.

Im bestehenden Modell ist diese Identität die Gegenpartei-IBAN, aus der der lokale HMAC-basierte `counterparty_id` gebildet wird.

Deshalb gilt weiterhin:

```text
keine IBAN
=> kein counterparty_ref
=> kein künstlicher counterparty_id
```

Es soll ausdrücklich **keine** künstliche Identität allein aus `creditor.name` erzeugt werden. Händlernamen sind nicht global eindeutig und können sich ändern.

---

## 3. `NormalizedTransaction` erweitern

In `service/src/enable-banking/importer.ts` soll `NormalizedTransaction` ein eigenes Feld erhalten:

```ts
counterpartyName: string | null;
```

Das bestehende `counterparty`-Objekt bleibt für die IBAN-gebundene Identität bestehen:

```ts
counterparty: {
  id: string;
  name: string | null;
  ibanEncrypted: string;
} | null;
```

Semantik danach:

```text
counterpartyName
= Providername der Gegenpartei, sofern vorhanden

counterparty
= stabile lokale Gegenpartei-Identität, nur wenn IBAN vorhanden
```

---

## 4. `normalizeTransaction()` ändern

Die Ermittlung bleibt richtungsabhängig:

```ts
const counterpartySource = direction === 'incoming'
  ? { party: transaction.debtor, account: transaction.debtor_account }
  : { party: transaction.creditor, account: transaction.creditor_account };
```

Dann getrennt:

```ts
const counterpartyName = stringValue(counterpartySource.party?.name);
const iban = stringValue(counterpartySource.account?.iban);
```

Nur die stabile Gegenpartei bleibt IBAN-abhängig:

```ts
const counterparty = iban
  ? {
      id: counterpartyId(iban, hmacSecret),
      name: counterpartyName,
      ibanEncrypted: encryption.encrypt(normalizeIban(iban))
    }
  : null;
```

Im resultierenden `NormalizedTransaction` wird zusätzlich gespeichert:

```ts
counterpartyName,
```

Für den Beispielumsatz muss danach gelten:

```text
counterpartyName = "E-Kissel SBK Lambrecht"
counterparty     = null
```

---

## 5. INSERT und UPDATE korrigieren

Aktuell wird für `transactions.counterparty_name` sinngemäß verwendet:

```ts
normalized.counterparty?.name ?? null
```

Das muss an beiden Stellen durch

```ts
normalized.counterpartyName
```

ersetzt werden.

Betroffen:

- `insertTransaction.run(...)`
- `updateTransaction.run(...)`

Wichtig beim UPDATE:

Die vorhandene SQL-Semantik

```sql
counterparty_name = COALESCE(?, counterparty_name)
```

ist sinnvoll und soll erhalten bleiben. Ein neuer fehlender Providername darf einen bereits bekannten Namen nicht löschen.

---

## 6. Fingerprint ebenfalls korrigieren

Der Fehler betrifft nicht nur die Anzeige.

`fallbackTransactionKey()` verwendet aktuell:

```ts
counterparty_name: normalizeForFingerprint(value.counterparty?.name ?? null)
```

Damit wird der Providername bei Umsätzen ohne Gegenpartei-IBAN auch aus dem lokalen Fallback-Fingerprint ausgeschlossen.

Das soll geändert werden zu:

```ts
counterparty_name: normalizeForFingerprint(value.counterpartyName)
```

Damit wird aus

```text
17,39 EUR + DBIT + 2026-09-11 + "E-Kissel SBK Lambrecht"
```

ein stabilerer lokaler Fingerprint als ohne Gegenparteiname.

Der `counterparty_id` bleibt weiterhin `null`, wenn keine IBAN vorhanden ist.

---

## 7. Pending-/Booked-Reconciliation korrigieren

Auch `matchesStrongly()` verwendet den Namen aktuell indirekt über:

```ts
incoming.counterparty?.name
```

Bei Umsätzen ohne IBAN ist dieser Wert immer `null`.

Die Fallback-Prüfung soll stattdessen `incoming.counterpartyName` verwenden:

```ts
const sameCounterparty = existing.counterparty_id && incoming.counterparty?.id
  ? existing.counterparty_id === incoming.counterparty.id
  : normalizeForFingerprint(existing.counterparty_name) !== null
    && normalizeForFingerprint(existing.counterparty_name)
      === normalizeForFingerprint(incoming.counterpartyName);
```

Dadurch können PDNG-/BOOK-Varianten einer Kartenzahlung besser zusammengeführt werden, wenn der Providername übereinstimmt.

Die bestehende konservative Reconciliation darf dabei nicht aufgeweicht werden: Betrag, Währung, Richtung, Purpose und Datumsplausibilität bleiben weiterhin Teil der Prüfung.

---

## 8. Händlernormalisierung nicht mit Gegenpartei-Anzeige vermischen

Betroffene Dateien:

- `service/src/services/merchants.ts`
- `service/src/services/transaction-evidence.ts`

Die bestehende Enrichment-Pipeline erkennt `creditor.name` bzw. `debtor.name` bereits als starke Provider-Evidence.

Das ist korrekt und soll beibehalten werden.

Aktuell kann daraus aber nur dann ein normalisierter `merchant_name` entstehen, wenn der Händler in der lokalen `MERCHANT_REGISTRY` bzw. über eine bekannte Alias-Regel erkannt wird.

Das ist ein **separates Konzept**.

Die Anzeigepriorität soll fachlich bleiben:

```text
1. merchant_name
2. counterparty_name
3. purpose
4. generischer Fallback "Umsatz"
```

Daraus folgt:

```text
Provider liefert "E-Kissel SBK Lambrecht"
+ keine bekannte Merchant-Regel
=> UI zeigt trotzdem "E-Kissel SBK Lambrecht"
```

Erst wenn später eine Normalisierung existiert, kann daraus z. B. werden:

```text
merchant_name = "SBK Kissel"
counterparty_name = "E-Kissel SBK Lambrecht"
```

Damit bleibt sowohl die saubere Händleridentität als auch der originale Providername erhalten.

Es soll **nicht** einfach jeder beliebige `creditor.name` in `merchant_name` kopiert werden.

---

## 9. Bestehende Daten reparieren

Nur den Importer zu korrigieren reicht für neue bzw. erneut vom Provider gelieferte Umsätze.

Für bereits gespeicherte Umsätze muss ebenfalls ein Backfill vorgesehen werden, weil die verschlüsselten Rohdaten den Namen bereits enthalten können.

Beispiel aus dem gespeicherten Payload:

```json
{
  "list": {
    "creditor": {
      "name": "E-Kissel SBK Lambrecht"
    },
    "credit_debit_indicator": "DBIT"
  }
}
```

### Empfohlene Lösung

Eine kleine Service-Funktion ergänzen, z. B.:

```text
backfillCounterpartyNamesFromProviderPayload(...)
```

Sie soll:

1. nur Transaktionen mit leerem `counterparty_name` betrachten,
2. `raw_payload_encrypted` mit dem bestehenden Encryption-Service lesen,
3. die Richtung der Transaktion verwenden,
4. bei `outgoing` zuerst `creditor.name` lesen,
5. bei `incoming` zuerst `debtor.name` lesen,
6. nur einen nichtleeren String übernehmen,
7. vorhandene `counterparty_name` niemals überschreiben,
8. keine neue `counterparties`-Zeile erzeugen, wenn keine IBAN vorhanden ist.

Die Funktion kann accountweise im bestehenden Import-/Sync-Pfad ausgeführt werden, bevor die Merchant-Normalisierung läuft.

Empfohlene Reihenfolge nach einem Import:

```text
Provider importieren
→ fehlende counterparty_name aus gespeichertem Payload backfillen
→ Händler normalisieren
→ Kategorie-Regeln anwenden
```

Damit profitieren vorhandene Umsätze sofort von denselben Daten, ohne auf eine erneute Lieferung jedes alten Umsatzes durch Enable Banking angewiesen zu sein.

### Kein SQL-only-Migrations-Backfill

Der Payload ist verschlüsselt. Deshalb soll keine SQL-Migration versuchen, diese Daten direkt umzuschreiben.

Falls eine neue Migration überhaupt benötigt wird, dann nur für strukturelle Änderungen. Für diesen Fix ist voraussichtlich **keine Schemaänderung erforderlich**.

---

## 10. Gemeinsame Extraktionsfunktion bevorzugen

Damit Import und Backfill nicht unterschiedliche Regeln implementieren, sollte die richtungsabhängige Ermittlung des Gegenparteinamens in eine kleine pure Helper-Funktion ausgelagert werden.

Beispielkonzept:

```ts
function providerCounterpartyName(
  transaction: ProviderTransaction,
  direction: 'incoming' | 'outgoing'
): string | null
```

Semantik:

```text
outgoing -> creditor.name
incoming -> debtor.name
```

Optional kann später dieselbe Funktion um weitere sichere Provider-Fallbacks ergänzt werden.

Für diesen Fix soll sie aber bewusst eng bleiben, damit nicht versehentlich eigene Kontoinhaber-Namen oder irrelevante Rohfelder als Gegenpartei angezeigt werden.

---

## 11. UI

Eine spezielle UI-Sonderbehandlung für diesen Fehler sollte nicht notwendig sein.

Die globale Umsatzliste erhält bereits `merchant_name`, `counterparty_name` und `purpose` aus der Query-Schicht.

Sobald `counterparty_name` korrekt persistiert ist, muss die bestehende Darstellung automatisch statt

```text
Umsatz
```

folgendes anzeigen:

```text
E-Kissel SBK Lambrecht
```

Trotzdem soll ein Regressionstest sicherstellen, dass die UI-Fallback-Reihenfolge nicht versehentlich umgedreht wird.

---

## 12. Tests

### 12.1 Ausgehende Kartenzahlung ohne Creditor-IBAN

Fixture:

```json
{
  "entry_reference": "53e3bebc-1458-3dab-ad6a-ec04b9ca75ac",
  "transaction_amount": {
    "currency": "EUR",
    "amount": "17.39"
  },
  "creditor": {
    "name": "E-Kissel SBK Lambrecht"
  },
  "creditor_account": null,
  "credit_debit_indicator": "DBIT",
  "status": "BOOK",
  "booking_date": "2026-09-11",
  "value_date": "2026-09-11",
  "remittance_information": []
}
```

Erwartung:

```text
transactions.counterparty_name = "E-Kissel SBK Lambrecht"
transactions.counterparty_ref = null
```

Die Transaktion darf nicht wegen der fehlenden Gegenpartei-IBAN verworfen oder unvollständig importiert werden.

### 12.2 Eingehender Umsatz ohne Debtor-IBAN

Provider liefert:

```text
debtor.name = "Max Mustermann"
debtor_account = null
CRDT
```

Erwartung:

```text
counterparty_name = "Max Mustermann"
counterparty_ref = null
```

### 12.3 Name plus IBAN

Bei einer klassischen Überweisung mit Name und IBAN muss das bisherige Verhalten erhalten bleiben:

```text
counterparty_name = Providername
counterparty_ref != null
counterparties.display_name = Providername
```

### 12.4 Kein Name und keine IBAN

Erwartung:

```text
counterparty_name = null
counterparty_ref = null
```

Keine erfundenen Werte.

### 12.5 UPDATE bestehender Transaktion

Bestehende Zeile:

```text
counterparty_name = null
```

Provider liefert denselben Umsatz später erneut mit:

```text
creditor.name = "E-Kissel SBK Lambrecht"
```

Erwartung:

```text
counterparty_name wird ergänzt
```

### 12.6 Bestehender Name darf nicht gelöscht werden

Bestehende Zeile:

```text
counterparty_name = "E-Kissel SBK Lambrecht"
```

Spätere Providerantwort enthält keinen Namen.

Erwartung:

```text
counterparty_name bleibt unverändert
```

### 12.7 Backfill aus verschlüsseltem Raw-Payload

Vorher:

```text
counterparty_name = null
raw payload enthält creditor.name
```

Nach Backfill:

```text
counterparty_name = "E-Kissel SBK Lambrecht"
```

### 12.8 Fingerprint

Zwei ansonsten identische Kartenumsätze ohne IBAN, aber mit unterschiedlichen Gegenparteinamen, sollen unterschiedliche Fallback-Fingerprints erzeugen.

### 12.9 Reconciliation

PDNG und BOOK ohne Gegenpartei-IBAN, aber mit gleichem Gegenparteinamen und sonst identischen starken Merkmalen, sollen weiterhin als Reconciliation-Kandidaten erkannt werden.

### 12.10 Query/UI-Vertrag

`queryTransactions()` muss den gespeicherten Namen als `counterparty_name` ausliefern.

Die Frontenddarstellung muss bei

```text
merchant_name = null
counterparty_name = "E-Kissel SBK Lambrecht"
purpose = null
```

`E-Kissel SBK Lambrecht` statt `Umsatz` anzeigen.

---

## 13. Betroffene Dateien

Primär:

- `service/src/enable-banking/importer.ts`

Voraussichtlich zusätzlich:

- neue kleine Backfill-/Helper-Implementierung unter `service/src/services/` oder im Importer, falls bewusst lokal gehalten
- passende Importer-/Provider-/Transaction-Tests unter `service/test/`
- ggf. `service/test/transaction-ui-contract.test.ts` für den Anzeige-Fallback

Nur prüfen, nicht unnötig umbauen:

- `service/src/services/merchants.ts`
- `service/src/services/transaction-evidence.ts`
- `service/src/services/transactions-query.ts`
- `modules/banking/index.js`

Keine Änderung nötig an:

- Enable-Banking-API-Vertrag
- Datenbankschema, sofern kein zusätzlicher Persistenzzustand benötigt wird
- Verschlüsselungskonzept
- HMAC-basierter Gegenpartei-Identität

---

## 14. Implementierungsreihenfolge

1. `NormalizedTransaction.counterpartyName` ergänzen.
2. `normalizeTransaction()` so ändern, dass der Name unabhängig von der IBAN extrahiert wird.
3. INSERT und UPDATE auf `normalized.counterpartyName` umstellen.
4. `fallbackTransactionKey()` auf `counterpartyName` umstellen.
5. `matchesStrongly()` ebenfalls auf `counterpartyName` umstellen.
6. Tests für ausgehende und eingehende Umsätze ohne Gegenpartei-IBAN ergänzen.
7. Backfill aus `raw_payload_encrypted` implementieren.
8. Backfill vor Merchant-Normalisierung in den Account-Import integrieren.
9. Tests für Backfill und Bestandsschutz ergänzen.
10. Query/UI-Vertrag testen.
11. Gesamte Service-Test-Suite und TypeScript-Build ausführen.

---

## 15. Acceptance Criteria

Der Fix ist abgeschlossen, wenn alle folgenden Bedingungen erfüllt sind:

- Ein ausgehender Umsatz mit `creditor.name`, aber ohne `creditor_account.iban`, speichert den Creditor-Namen in `transactions.counterparty_name`.
- Ein eingehender Umsatz mit `debtor.name`, aber ohne `debtor_account.iban`, speichert den Debtor-Namen in `transactions.counterparty_name`.
- Ohne IBAN wird weiterhin kein künstlicher `counterparty_id` und kein `counterparty_ref` erzeugt.
- Vorhandene IBAN-basierte Gegenpartei-Identität funktioniert unverändert.
- Fallback-Fingerprint und Reconciliation berücksichtigen den Namen auch ohne IBAN.
- Bereits gespeicherte Umsätze können aus ihrem verschlüsselten Provider-Payload repariert werden.
- Vorhandene Namen werden durch leere spätere Providerdaten nicht gelöscht.
- Merchant-Normalisierung bleibt ein separater Schritt.
- Der Beispielumsatz vom 11.09.2026 mit `creditor.name = "E-Kissel SBK Lambrecht"` wird in der Umsatzliste als `E-Kissel SBK Lambrecht` angezeigt und nicht mehr als `Umsatz`.
- Alle bestehenden Tests bleiben grün und neue Regressionstests decken diesen Fehler dauerhaft ab.
