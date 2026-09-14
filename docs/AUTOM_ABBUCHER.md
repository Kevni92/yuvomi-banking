# Automatische Abbucher-Erkennung und wiederkehrende Umsätze – Implementierungsplan

Stand der Analyse: 14.09.2026, Repository-Stand `6bdef50` (`main`).

Dieses Dokument beschreibt die technische Umsetzung einer stabilen Abbucher-Erkennung
im Yuvomi-Banking-Modul. Es ist ein Plan; es nimmt keine Änderung an der produktiven
`banking.db`, am VPS oder an Yuvomi Core vor.

---

## 1. Zielbild

Das Banking-Modul soll mehrere Umsätze desselben Abbuchers zuverlässig als zusammengehörig
erkennen. Unterhalb der bestehenden Umsatz-Tabelle erscheint eine zweite Tabelle
**„Wiederkehrende Abbucher“**. Sie enthält nur Abbucher mit mindestens zwei eindeutig
zugeordneten, gebuchten Abbuchungen.

Für jeden Abbucher kann der Benutzer:

- Name, Anzahl der Abbuchungen und letzte Abbuchung sehen;
- einen Dialog mit allen zugehörigen Umsätzen öffnen;
- direkt eine Banking-Kategorie als Standard für diesen Abbucher festlegen;
- erkennen, ob einzelne Umsätze eine abweichende manuelle Kategorie besitzen;
- die Standardkategorie wieder entfernen oder ändern.

Sobald später ein neuer Umsatz eindeutig diesem Abbucher zugeordnet wird, übernimmt der
Umsatz dessen Kategorie lokal und automatisch. Dafür findet kein OpenAI-Aufruf statt.

Die fachliche Pipeline lautet:

```text
Enable Banking
  -> Import und PDNG/BOOK-Reconciliation
  -> Provider-Beobachtungen und Detail-Enrichment
  -> vorhandene Auflösung des einzelnen Umsatzes
  -> stabile Abbucher-Identität auflösen
  -> lokale Kategorie des Abbuchers anwenden
  -> nur weiterhin ungelöste Umsätze dürfen in die AI-Kategorisierung
```

---

## 2. Begriffe und bewusste Abgrenzung

### 2.1 Abbucher

„Abbucher“ bezeichnet in der Oberfläche die wirtschaftliche Gegenpartei eines ausgehenden
Umsatzes, die wiederholt Geld abbucht oder erhält. Im Code wird dafür der neutrale Begriff
`payee` verwendet.

Ein Payee kann zum Beispiel sein:

- ein SEPA-Lastschriftgläubiger;
- ein Händler bei wiederkehrenden Kartenumsätzen;
- ein Dienstleister mit stabiler Gegenkonto-IBAN.

### 2.2 Nicht jeder Empfänger ist ein wiederkehrender Abbucher

Die neue Tabelle ist keine Liste aller Gegenparteien. Sie zeigt nur Payees mit mindestens
zwei gebuchten, ausgehenden und kanonischen Umsätzen. Nicht enthalten sind:

- eingehende Umsätze;
- eigene Umbuchungen zwischen verknüpften Konten;
- Bargeldabhebungen;
- rein technische Banken oder Settlement-Parteien;
- ein Zahlungsabwickler wie PayPal, Klarna, Stripe, Adyen, Mollie oder SumUp, wenn kein
  dahinterliegender Händler zuverlässig erkannt wurde;
- unsichere oder widersprüchliche Matches.

„Wiederkehrend“ bedeutet in dieser ersten Version nur **mindestens zweimal vorgekommen**.
Es wird keine monatliche Frequenz, kein Abonnement und kein nächster Abbuchungstermin
behauptet. Eine spätere Vertrags-/Abo-Erkennung ist ein eigener Funktionsumfang.

### 2.3 Gegenkonto, Händlerauflösung und Payee sind getrennte Ebenen

Die bestehenden Begriffe dürfen nicht vermischt werden:

| Ebene | Bestehender/Neuer Speicher | Aufgabe |
|---|---|---|
| Provider-Gegenkonto | `counterparties` | HMAC der Gegenkonto-IBAN und verschlüsselte IBAN |
| Auflösung eines einzelnen Umsatzes | `transaction_resolutions` | verständlicher Name, Händler, Zahlungsart, Intermediär, Confidence |
| Stabiler Abbucher über mehrere Umsätze | neu: `payees` + `payee_identifiers` | mehrere sichere Identitätsmerkmale zu einer wirtschaftlichen Gegenpartei verbinden |
| Kategorieentscheidung | `payees.category_id` | Standardkategorie für alle nicht manuell abweichenden Umsätze dieses Payees |

`transaction_resolutions.display_name` allein ist keine stabile Identität. Zwei Texte können
gleich aussehen und trotzdem unterschiedliche Parteien meinen; umgekehrt kann derselbe
Abbucher mit wechselnden Anzeigetexten erscheinen.

---

## 3. Analyse des aktuellen Codes

### 3.1 Bereits vorhandene Grundlagen

Der aktuelle Stand enthält wesentliche Bausteine, die weiterverwendet werden sollen:

- `service/src/enable-banking/importer.ts`
  - dedupliziert Umsätze;
  - führt `PDNG` und `BOOK` konservativ zusammen;
  - erzeugt für eine Gegenkonto-IBAN bereits eine HMAC-basierte `counterparty_id`;
  - speichert die echte IBAN ausschließlich verschlüsselt;
  - wendet lokale Kategorieregeln an.
- `service/migrations/023_transaction_identity_resolution.sql`
  - bewahrt `transaction_observations` über Statuswechsel hinweg auf;
  - trennt die abgeleitete Darstellung in `transaction_resolutions` von Providerfeldern.
- `service/src/services/transaction-resolution.ts`
  - erkennt Händler aus Listen-, Detail- und historischen PDNG-Beobachtungen;
  - erkennt eigene Umbuchungen;
  - trennt Zahlungsintermediäre vom wirtschaftlichen Händler;
  - liefert Quelle und Confidence der Auflösung.
- `service/src/services/payment-intermediaries.ts`
  - verhindert bereits, dass zum Beispiel PayPal automatisch zum Händler wird.
- `service/src/services/transaction-semantics.ts`
  - unterscheidet unter anderem Lastschrift, Kartenzahlung, Dauerauftrag, Überweisung,
    Bargeldabhebung und Bargeldeinzahlung.
- `service/src/services/category-rules.ts`
  - lernt bei einer manuellen Umsatzkategorie bereits eine benutzerbezogene
    `counterparty`-Regel, sofern eine Gegenkonto-IBAN vorhanden ist;
  - wendet die Regel auf bestehende und spätere Umsätze an;
  - überschreibt keine manuell kategorisierten Einzelumsätze.
- `service/src/services/transactions-query.ts`
  - bietet eine user-/owner-gescopte, filterbare und paginierte Umsatzabfrage;
  - liefert keine verschlüsselten Felder oder Provider-Rohdaten in der Listenansicht.
- `modules/banking/index.js`
  - besitzt bereits eine tabellarische Umsatzansicht, Kategorieauswahl, Pagination,
    sortierbare Spalten und einen vollständigen Umsatzdetaildialog.
- `service/src/auth/global-banking-session.ts`
  - behandelt Banking als gemeinsamen Haushaltsdatenbestand und mappt berechtigte Akteure
    auf den Besitzer des bestehenden Banking-Setups.

### 3.2 Aktuelle Lücke

Die bestehende Kategorieautomatik ist nur dann wirklich stabil, wenn der Provider eine
Gegenkonto-IBAN liefert. Ohne IBAN kann aktuell höchstens eine Merchant- oder Textregel
greifen. Diese Regeln bilden jedoch keine eigenständige Abbucher-Entität und liefern keine
aggregierte Liste oder einen Dialog aller zugehörigen Umsätze.

Weitere Lücken:

- eine `transaction_resolution` gehört nur zu genau einem Umsatz;
- es gibt keine dauerhafte Many-to-one-Verknüpfung „viele Umsätze -> ein Abbucher“;
- mehrere Identifikatoren desselben Abbuchers können nicht zusammengeführt werden;
- Name, Zahlungsabwickler und tatsächlicher Händler sind für Gruppierungen noch nicht
  mit expliziten Sicherheitsstufen versehen;
- eine Kategorie kann nicht direkt auf der aggregierten Gegenpartei gespeichert werden;
- das Entfernen einer gelernten Kategorie lässt sich aktuell nicht eindeutig von anderen
  `counterparty_rule`-Zuordnungen unterscheiden;
- die Oberfläche kann wiederkehrende Gegenparteien nicht separat anzeigen.

### 3.3 Warum kein reines Gruppieren nach Name genügt

Folgende Abkürzung ist ausdrücklich ungeeignet:

```sql
GROUP BY lower(counterparty_name)
```

Gründe:

- Provider können Schreibweisen, Rechtsformen und Buchungstexte ändern;
- Settlement-Banken können im gebuchten Umsatz statt des Händlers stehen;
- „PayPal“ kann Zahlungen an viele völlig verschiedene Händler abwickeln;
- identische Namen können verschiedene Firmen oder Filialen bezeichnen;
- unscharfe Stringvergleiche können eine falsche Kategorie auf künftige Bankumsätze
  übertragen.

Das Matching muss deshalb mehrere deterministische Merkmale verwenden und bei schwacher
Evidenz bewusst auf eine Bestätigung warten.

---

## 4. Fachliche Invarianten

Die Umsetzung muss folgende Regeln als Invarianten behandeln:

1. Ein Payee gehört zum global aufgelösten Banking-Owner. Jeder API-Zugriff wird über die
   bestehende Session-/Permission-Schicht authorisiert.
2. Ein Umsatz kann höchstens einem Payee zugeordnet sein.
3. Derselbe starke Identifikator kann innerhalb eines Banking-Owners höchstens einem Payee
   gehören.
4. Ein Name allein ist niemals automatisch eine „sichere“ Identität.
5. Ein Zahlungsintermediär allein darf keine wiederverwendbare Händleridentität erzeugen.
6. Eigene Umbuchungen und Bargeldbewegungen erzeugen keinen Payee.
7. Für die Wiederholungsgrenze zählen nur `direction = 'outgoing'` und `status = 'BOOK'`.
8. Ein `PDNG`-Umsatz darf durch die vorhandene Reconciliation nicht doppelt zählen.
9. Eine manuelle Kategorie auf einem einzelnen Umsatz hat immer Vorrang.
10. Eine explizite Payee-Kategorie hat Vorrang vor AI-, Merchant- und Textregeln.
11. Eine deaktivierte Kategorie wird auf keine neuen Umsätze angewendet.
12. Identifikatoren wie IBAN, Gläubiger-ID oder zusätzliche Kontoidentifikation werden
    niemals im Klartext in einer neuen Tabelle, in Logs oder im Browser gespeichert.
13. OpenAI erhält weder neue Identifikatoren noch die Payee-Matching-Evidenz.
14. Alle schreibenden Endpunkte verlangen `write`, gültige Origin und Banking-CSRF.
15. Konflikte werden nicht automatisch zusammengeführt. Im Zweifel bleibt ein Umsatz
    ungeordnet statt falsch gruppiert.

---

## 5. Identitätsmodell und Matching-Qualität

### 5.1 Unterstützte Identifikatoren

Der Resolver sammelt pro Umsatz mehrere Identitätsmerkmale. Sie werden mit dem bestehenden
`COUNTERPARTY_HMAC_SECRET` domänensepariert gehasht.

| Typ | Beispielquelle | Stärke | Verhalten |
|---|---|---:|---|
| `sepa_creditor_id` | explizit gekennzeichnete SEPA-Gläubiger-ID | stark | bevorzugter Schlüssel für Lastschriften, kann wechselnde IBANs verbinden |
| `counterparty_iban` | vorhandene `counterparties.counterparty_id` | stark | direkt wiederverwenden; Klartext-IBAN bleibt verschlüsselt |
| `account_additional_id` | schema-geprüfte `creditor_account_additional_identification` | stark/mittel | nur für freigegebene Schemes; unbekannte Schemes nicht blind verwenden |
| `merchant_key` | lokale Registry oder vertrauenswürdige manuelle Händlerzuordnung | mittel/stark | nur wenn kein Zahlungsintermediär als Händler missverstanden wird |
| `resolved_merchant_name` | kanonischer Name aus `transaction_resolutions` | Kandidat | exakt normalisiert und zahlungsartgescopet; erfordert Bestätigung |
| `counterparty_name` | richtungsspezifischer Providername | Kandidat | letzter Fallback; niemals allein automatisch bestätigen |

Die aktuelle offizielle Enable-Banking-Transaktionsstruktur enthält unter anderem
`creditor`, `creditor_account`, `creditor_account_additional_identification`,
`bank_transaction_code`, `merchant_category_code` und `remittance_information`. Die
Implementierung muss sich gegen die zum Umsetzungszeitpunkt aktuelle Referenz und echte,
redigierte Provider-Fixtures prüfen:
[Enable Banking API Reference](https://enablebanking.com/docs/api/reference/).

### 5.2 HMAC-Domänentrennung

Für neue Identifier wird nie nur der normalisierte Wert gehasht, sondern ein versionierter
Kontext:

```text
HMAC-SHA256(secret, "payee:v1:<identifier_type>:<normalized_value>")
```

Dadurch können gleich aussehende Werte aus verschiedenen Schemes nicht kollidieren. Für
`counterparty_iban` wird aus Kompatibilitätsgründen die bereits vorhandene
`counterparties.counterparty_id` als Identifier-Hash verwendet. So können bestehende
`category_rules.match_value` ohne Kenntnis der Klartext-IBAN zugeordnet werden.

Der HMAC-Wert wird niemals an das Frontend ausgeliefert.

### 5.3 Gläubiger-ID und Mandatsreferenz

Eine SEPA-Gläubiger-ID ist ein starker Payee-Schlüssel. Sie darf nur übernommen werden,
wenn sie:

- aus einem strukturierten Providerfeld stammt; oder
- in einem Buchungstext mit einem expliziten, bank-/sprachspezifisch getesteten Label wie
  „Gläubiger-ID“ beziehungsweise „Creditor ID“ vorkommt und die formale Validierung besteht.

Eine generische Suche nach irgendeiner alphanumerischen Zeichenfolge ist verboten.

Die Mandatsreferenz identifiziert häufig einen Vertrag oder ein einzelnes Mandat und nicht
den Abbucher selbst. Sie darf als zusätzliche Evidenz gespeichert werden, aber nicht als
primärer Gruppierungsschlüssel. End-to-end-ID, `entry_reference`, `transaction_id` und
Referenznummer sind transaktionsbezogen und dürfen ebenfalls keine Payee-Identität bilden.

### 5.4 Zahlungsintermediäre

`transaction_resolutions.intermediary_name` bleibt Kontext. Wenn beispielsweise PayPal in
der Gegenpartei steht und „Google Payment“ zuverlässig aus dem Verwendungszweck aufgelöst
wurde, ist Google der Payee und PayPal nur Intermediär.

Wenn kein dahinterliegender Händler aufgelöst werden kann, wird aus dem Prozessor allein
kein bestätigter Payee erstellt. Dadurch kann eine Kategorie „Abonnements“ nicht versehentlich
auf alle PayPal-Einkäufe übertragen werden.

### 5.5 Kandidat versus bestätigter Payee

Es gibt zwei normale Zustände:

- `candidate`: nur schwache, aber exakt wiederholte Evidenz wie ein normalisierter Name;
- `confirmed`: mindestens ein starker Identifikator oder eine explizite Benutzerbestätigung.

Kandidaten dürfen nach zwei gebuchten Umsätzen in der Tabelle erscheinen, werden dort aber
als „Erkennung bestätigen“ gekennzeichnet. Das Setzen einer Kategorie bestätigt zugleich
die konkrete Kandidatenidentität; vor dem Speichern zeigt die UI klar, wie viele bestehende
Umsätze und künftige Matches betroffen sind.

Eine bloße Tabellenanzeige bestätigt nichts.

### 5.6 Resolver-Algorithmus

Für jeden kanonischen ausgehenden Umsatz:

1. Zahlungsart und bestehende `transaction_resolution` lesen.
2. Bei `own_transfer`, `cash_withdrawal` oder technischer Partei den Zustand `excluded`
   setzen und beenden.
3. Alle erlaubten Identifier aus normalisierten Spalten, verschlüsseltem Listen-/Detailpayload
   und gespeicherten Beobachtungen extrahieren.
4. Nur Identifier-Hashes und Evidenzmetadaten persistieren; keine neu extrahierten Rohwerte.
5. Alle bereits bekannten Identifier im Scope des Banking-Owners nachschlagen.
6. Zeigen alle Treffer auf denselben Payee, wird der Umsatz diesem Payee zugeordnet.
7. Gibt es keinen Treffer:
   - bei starker Evidenz einen bestätigten Payee erzeugen;
   - bei ausschließlich schwacher Evidenz einen Kandidaten erzeugen beziehungsweise den
     exakt passenden Kandidaten verwenden.
8. Zeigen Identifier auf verschiedene Payees, `payee_match_state = 'ambiguous'` setzen,
   nichts automatisch mergen und keine Payee-Kategorie anwenden.
9. Neue zusätzliche Identifier nur dann an einen bestehenden Payee hängen, wenn sie im
   selben Umsatz gemeinsam mit einem bereits bestätigten starken Identifier auftreten und
   keinen Konflikt erzeugen.
10. Den Anzeigenamen nur durch bessere Evidenz ersetzen. Eine schwächere spätere BOOK-
    Darstellung darf einen guten PDNG-Händlernamen nicht verdrängen.

Wichtig für Namensidentitäten: Ein bestätigter IBAN-Payee beansprucht nicht automatisch
jeden gleichlautenden Namen. Ein Name-only-Kandidat darf erst dann um einen starken Schlüssel
ergänzt und bestätigt werden, wenn derselbe Umsatz beide Merkmale gemeinsam liefert und kein
Konflikt besteht.

---

## 6. Datenmodell

Die nächste freie append-only Migration ist zum Analysezeitpunkt `024`. Vorgeschlagener
Name:

```text
service/migrations/024_recurring_payees.sql
```

Bestehende Migrationen werden nicht verändert.

### 6.1 Tabelle `payees`

Vorgesehene Felder:

```sql
CREATE TABLE payees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  display_name_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK(status IN ('candidate', 'confirmed', 'ignored')),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, yuvomi_user_id)
);

CREATE INDEX idx_payees_owner_status
  ON payees(yuvomi_user_id, status, id);
```

`first_seen`, `last_seen` und Transaktionszahl werden nicht redundant gespeichert, sondern
aus den verknüpften Umsätzen aggregiert. So können Reconciliation, Löschungen oder ein
erneuter Resolverlauf keine Zähler driften lassen.

### 6.2 Tabelle `payee_identifiers`

```sql
CREATE TABLE payee_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payee_id INTEGER NOT NULL,
  yuvomi_user_id INTEGER NOT NULL,
  identifier_type TEXT NOT NULL
    CHECK(identifier_type IN (
      'sepa_creditor_id',
      'counterparty_iban',
      'account_additional_id',
      'merchant_key',
      'resolved_merchant_name',
      'counterparty_name'
    )),
  identifier_hash TEXT NOT NULL,
  strength TEXT NOT NULL CHECK(strength IN ('strong', 'candidate')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY(payee_id, yuvomi_user_id)
    REFERENCES payees(id, yuvomi_user_id) ON DELETE CASCADE,
  UNIQUE(yuvomi_user_id, identifier_type, identifier_hash)
);

CREATE INDEX idx_payee_identifiers_payee
  ON payee_identifiers(payee_id, strength, id);
```

Die owner-ID ist bewusst zusätzlich gespeichert. Dadurch kann SQLite mit einem eindeutigen
Constraint verhindern, dass ein Identifier innerhalb desselben Banking-Datenbestands auf
zwei Payees zeigt.

### 6.3 Tabelle `transaction_payee_evidence`

Diese Tabelle macht die Entscheidung auditierbar und bewahrt gehashte Identitätsevidenz
über spätere Provideränderungen hinweg:

```sql
CREATE TABLE transaction_payee_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL
    REFERENCES transactions(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL,
  identifier_hash TEXT NOT NULL,
  strength TEXT NOT NULL CHECK(strength IN ('strong', 'candidate', 'context')),
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(transaction_id, identifier_type, identifier_hash, source)
);

CREATE INDEX idx_transaction_payee_evidence_lookup
  ON transaction_payee_evidence(identifier_type, identifier_hash, transaction_id);
```

`source` enthält nur einen technischen Pfad wie `list.creditor_account.iban` oder
`resolution.merchant_key`, niemals den Rohwert.

### 6.4 Erweiterungen an `transactions`

```sql
ALTER TABLE transactions ADD COLUMN payee_id INTEGER
  REFERENCES payees(id) ON DELETE SET NULL;

ALTER TABLE transactions ADD COLUMN payee_match_state TEXT NOT NULL DEFAULT 'unresolved'
  CHECK(payee_match_state IN ('unresolved', 'matched', 'ambiguous', 'excluded'));

ALTER TABLE transactions ADD COLUMN payee_match_method TEXT;
ALTER TABLE transactions ADD COLUMN payee_match_confidence REAL;

ALTER TABLE transactions ADD COLUMN category_origin_payee_id INTEGER
  REFERENCES payees(id) ON DELETE SET NULL;

CREATE INDEX idx_transactions_payee_booked
  ON transactions(payee_id, direction, status, booking_date, id);

CREATE INDEX idx_transactions_category_origin_payee
  ON transactions(category_origin_payee_id, id);
```

`category_origin_payee_id` ist erforderlich, obwohl `category_source` bereits existiert.
Die vorhandene erlaubte Quelle `counterparty_rule` kann für eine Payee-Standardkategorie
weiterverwendet werden, ohne die bestehende CHECK-Constraint der `transactions`-Tabelle
riskant umzubauen. Das neue Origin-Feld macht trotzdem eindeutig, welche Zuordnung beim
Entfernen einer Payee-Kategorie zurückgenommen werden darf.

### 6.5 Kein Tabellen-Rebuild

Migration `024` soll nur neue Tabellen, nullable Spalten und Indizes ergänzen. Sie baut die
große `transactions`-Tabelle nicht neu auf. Damit bleibt das Risiko klein und ein Rollback
auf den vorherigen Anwendungscode möglich: Alter Code ignoriert die zusätzlichen Tabellen
und Spalten.

---

## 7. Backend-Services

### 7.1 `service/src/services/payee-identifiers.ts`

Neue, reine Funktionen:

- normalisieren erlaubter Identifier;
- domänensepariertes HMAC bilden;
- explizit gelabelte SEPA-Gläubiger-ID extrahieren;
- scheme-aware zusätzliche Kontoidentifikation bewerten;
- schwache Namensidentität aus Zahlungsart + exakt normalisiertem Namen erzeugen;
- Zahlungsintermediäre und technische Parteien verwerfen;
- keine Logs und keine Netzwerkzugriffe.

Die Normalisierung soll konservativ sein:

- Unicode `NFKC` beziehungsweise bei Vergleichsnamen `NFKD` mit Diakritika-Regel;
- Whitespace vereinheitlichen;
- Groß-/Kleinschreibung vereinheitlichen;
- keine aggressive Entfernung beliebiger Zahlen, weil diese Filialen oder verschiedene
  Händler unterscheiden können;
- Rechtsform-Aliase nur über getestete, explizite Regeln;
- maximal definierte Eingabelängen vor Regex-/Normalisierung.

### 7.2 `service/src/services/payee-resolution.ts`

Neue öffentliche Funktionen:

```ts
resolvePayeesForAccount({ database, accountId, encryption, hmacSecret, now })
resolvePayeeForTransaction({ database, transactionId, encryption, hmacSecret, now })
```

Der Service:

- liest nur Umsätze des betroffenen Accounts;
- verwendet `transaction_resolutions`, `transaction_observations`, normalisierte Spalten
  und das bereits verschlüsselt gespeicherte Providerpayload;
- schreibt Evidenz, Payees, Identifier und Transaction-Link atomar;
- ist idempotent;
- liefert nur Zähler wie `considered`, `matched`, `created`, `ambiguous`, `excluded`;
- protokolliert weder Namen, Zwecke noch Identifier-Hashes.

### 7.3 `service/src/services/recurring-payees.ts`

Dieser Service kapselt Aggregation und Kategorieänderung:

```ts
listRecurringPayees(database, query)
getRecurringPayee(database, ownerId, payeeId)
listPayeeTransactions(database, query)
setPayeeCategory(database, input)
clearPayeeCategory(database, input)
```

Keine SQL-Abfrage aus der Route oder dem Frontend darf die Ownership-Regeln duplizieren.

### 7.4 Zentrale Kategorie-Priorität

Die Kategorie-Pipeline muss in einer zentralen Reihenfolge laufen:

1. `category_source = 'manual'` bleibt unverändert;
2. bestätigte Payee-Kategorie;
3. bestehende manuelle Counterparty-Regel für Legacy-Kompatibilität;
4. andere Counterparty-/Merchant-/Text-/Semantikregeln;
5. AI nur für weiterhin unkategorisierte Umsätze.

Praktisch kann der bestehende Import intern weiterhin frühe Regeln ausführen. Nach der
vollständigen Transaction- und Payee-Auflösung wird die Payee-Kategorie abschließend
angewendet und gewinnt damit vor AI und nichtmanuellen Regeln.

Beim Schreiben einer Payee-Kategorie:

- Payee gehört dem aufgelösten Banking-Owner;
- Kategorie existiert, ist aktiv und vom Typ `expense`;
- Kandidat wird nach ausdrücklicher Bestätigung zu `confirmed`;
- alle zugehörigen nichtmanuellen Umsätze erhalten die neue Kategorie;
- `category_source = 'counterparty_rule'`;
- `category_confidence = 1`;
- `category_origin_payee_id = payee.id`;
- zugehörige offene AI-Reviews werden als `applied` abgeschlossen;
- manuelle Einzelkategorien bleiben unverändert und werden als Ausnahmen gezählt.

Beim Ändern der Payee-Kategorie werden nur nichtmanuelle Umsätze überschrieben. Beim
Entfernen werden nur Zuordnungen gelöscht, deren `category_origin_payee_id` genau dieser
Payee ist. Danach können niedrigere lokale Regeln erneut laufen. Fremde manuelle,
AI- oder anderweitig erzeugte Kategorien werden nicht pauschal gelöscht.

### 7.5 Bestehende Einzelumsatz-Kategorisierung

`assignManualTransactionCategory()` bleibt der Pfad für eine Einzelentscheidung. Seine
`rememberCounterparty`-Semantik wird kompatibel erweitert:

- wenn der Umsatz bereits einem Payee zugeordnet ist und „merken“ aktiv ist, setzt der
  gemeinsame Payee-Service dessen Standardkategorie;
- der konkret angeklickte Umsatz bleibt `manual` und damit eine explizite Entscheidung;
- ohne Payee, aber mit Gegenkonto-HMAC, bleibt die bisherige Counterparty-Regel als
  Fallback erhalten;
- in der Payee-Dialogtabelle wird eine abweichende Kategorie eines einzelnen Umsatzes
  immer mit `remember_counterparty: false` gespeichert, damit eine Ausnahme nicht
  versehentlich den ganzen Payee umkategorisiert.

Alle anderen Category-Writer (`transaction-categorization.ts`, Semantic Rules und
Category Rules) müssen beim eigenen Schreiben `category_origin_payee_id = NULL` setzen.
Damit bleibt die Herkunft eindeutig.

---

## 8. Einbindung in Sync, Enrichment und Backfill

### 8.1 Gemeinsame Account-Sync-Pipeline

`service/src/services/account-sync.ts` ist der zentrale Produktionspfad für manuelle und
geplante Kontosynchronisationen. Er wird wie folgt erweitert:

```text
1. getAllAccountTransactions
2. importTransactions
3. captureProviderObservationsForAccount
4. enrichAccountTransactions
5. resolveTransactionsForAccount                 (bestehend)
6. resolvePayeesForAccount                        (neu)
7. applyCategoryRulesForAccount                   (bestehend)
8. applyPayeeCategoriesForAccount                 (neu, höchste lokale Default-Priorität)
9. Sync-Ergebnis nur um anonyme Zähler erweitern
```

Damit gilt die automatische Kategorie bereits im selben Sync-Lauf, in dem ein neuer Umsatz
erstmals erscheint.

### 8.2 On-demand-Enrichment

Nach `POST /transactions/:transactionId/enrich` muss dieselbe fachliche Reihenfolge für den
betroffenen Umsatz beziehungsweise Account laufen:

- Providerdetails aktualisieren;
- einzelne Transaction-Resolution erneuern;
- Payee erneut auflösen;
- lokale Regeln und Payee-Kategorie anwenden;
- Detail- und Tabellenansicht aktualisieren.

So kann neu verfügbare Provider-Evidenz einen bisherigen Kandidaten sicher bestätigen.

### 8.3 AI-Kategorisierung

Vor `unresolvedTransactions()` muss sichergestellt sein, dass Payee-Auflösung und lokale
Payee-Kategorien gelaufen sind. Ein Umsatz mit aktiver Payee-Kategorie darf nicht an OpenAI
gesendet werden.

An den OpenAI-Payload werden keine Felder wie `payee_id`, Identifier-Hash,
Gläubiger-ID-Hinweis oder Match-Evidenz angehängt. Der vorhandene pseudonymisierte Vertrag
bleibt unverändert.

### 8.4 Bestehende Daten backfillen

Die neue Tabelle muss unmittelbar nach Einführung auch historische Umsätze zeigen. Dafür
wird kein ungeprüfter Auto-Merge beim SQL-Migrationslauf durchgeführt.

Vorgesehener CLI-Pfad:

```text
node dist/src/server.js --backfill-payees
node dist/src/server.js --backfill-payees --apply
```

Dry-run ist Standard und meldet nur:

- Anzahl betrachteter Umsätze;
- bestätigte Payees;
- Kandidaten;
- mehrfache Payees;
- Ambiguitäten;
- ausgeschlossene Umsätze;
- übernommene Legacy-Regeln;
- Konflikte bei Legacy-Kategorien.

Keine Namen, IBAN-Fragmente, Zwecke oder Hashes werden ausgegeben.

Der Apply-Lauf:

- arbeitet owner- und accountweise in kleinen Transaktionen;
- ist idempotent und nach Unterbrechung fortsetzbar;
- liest Provider-Rohdaten nur über den vorhandenen Entschlüsselungsservice;
- schreibt keine Rohdaten in die neuen Tabellen;
- übernimmt vorhandene manuelle `counterparty`-Regeln, wenn der HMAC eindeutig genau einem
  Payee zugeordnet werden kann;
- wählt bei widersprüchlichen Legacy-Kategorien niemals automatisch einen Gewinner;
- lässt Legacy-Regeln zunächst bestehen, damit Rollback und bestehende IBAN-Fälle weiter
  funktionieren.

Für große Bestände werden Batches von beispielsweise 250 bis 500 kanonischen Umsätzen
verwendet. Die konkrete Batchgröße wird mit einer anonymisierten lokalen Fixture und dem
Produktions-Ist-Stand festgelegt, nicht geraten.

---

## 9. API-Verträge

Alle Routen liegen weiterhin ausschließlich unter:

```text
/api/extensions/banking
```

Alle Responses erhalten `Cache-Control: no-store`.

### 9.1 Wiederkehrende Payees auflisten

```http
GET /api/extensions/banking/payees?recurring=1&limit=50&offset=0&sort=last_date&order=desc
```

Serverseitige Regeln:

- `read`-Permission;
- Ownership über den vorhandenen globalen Banking-Session-Resolver;
- `recurring=1` bedeutet mindestens zwei gebuchte ausgehende Umsätze;
- sortierbar nur über Allowlist: `name`, `transaction_count`, `last_date`, `category`;
- `limit` maximal 100;
- Kandidaten dürfen erscheinen, Ambiguitäten nicht als sichere Gruppe.

Beispiel:

```json
{
  "data": {
    "payees": [
      {
        "id": 17,
        "display_name": "Beispiel Energie",
        "status": "confirmed",
        "identity_quality": "strong",
        "booked_transaction_count": 8,
        "pending_transaction_count": 1,
        "account_count": 1,
        "first_booking_date": "2026-01-15",
        "last_booking_date": "2026-08-15",
        "last_amount": "84.20",
        "currency": "EUR",
        "category": {
          "id": 4,
          "name": "Wohnen",
          "active": true
        },
        "manual_exception_count": 1
      }
    ],
    "pagination": {
      "total": 1,
      "limit": 50,
      "offset": 0
    }
  }
}
```

Nicht enthalten sind interne Identifier, HMACs, IBANs, Provider-IDs oder Rohpayloads.

Wenn ein Payee Umsätze in mehreren Währungen besitzt, liefert die API keine irreführende
Gesamtsumme. `currency` ist dann `null`; die Tabelle zeigt stattdessen „mehrere Währungen“.

### 9.2 Umsätze eines Payees

```http
GET /api/extensions/banking/payees/:payeeId/transactions?sort=date&order=desc&limit=25&offset=0
```

Die Response verwendet dieselbe `PublicTransaction`-Form und dieselbe Pagination wie
`GET /transactions`. Die Implementierung erweitert `transactions-query.ts` intern um einen
owner-geprüften `payeeId`-Filter, statt eine zweite abweichende Umsatzabfrage zu bauen.

Zusätzlich enthält die Response eine kleine, öffentliche Payee-Zusammenfassung für den
Dialogkopf. Eine fremde oder nicht vorhandene Payee-ID ergibt `404`, nicht `403`, damit
keine IDs eines anderen Datenbestands bestätigt werden.

### 9.3 Payee-Kategorie setzen oder ändern

```http
PATCH /api/extensions/banking/payees/:payeeId/category
Content-Type: application/json
X-Banking-CSRF: <token>

{
  "category_id": 4,
  "confirm_candidate": true
}
```

Response:

```json
{
  "data": {
    "id": 17,
    "category_id": 4,
    "status": "confirmed",
    "affected_transactions": 7,
    "manual_exceptions": 1,
    "resolved_ai_reviews": 2
  }
}
```

Regeln:

- `write`-Permission, Origin und CSRF;
- nur aktive Expense-Kategorie;
- `confirm_candidate: true` ist für Kandidaten zwingend;
- Mutation und Bulk-Update laufen in einer SQLite-Transaktion;
- keine ungeprüfte Zahl von IDs aus dem Browser: Betroffenheit wird serverseitig über den
  Payee und Owner bestimmt.

### 9.4 Payee-Kategorie entfernen

Entweder derselbe PATCH mit `category_id: null` oder ein eigener DELETE. Empfohlen ist der
explizite, idempotente Vertrag:

```http
DELETE /api/extensions/banking/payees/:payeeId/category
X-Banking-CSRF: <token>
```

Er entfernt den Default und nur die eindeutig von diesem Payee stammenden automatischen
Zuordnungen. Manuelle Ausnahmen und fremde Herkunft bleiben erhalten.

### 9.5 Kein öffentlicher Rebuild-Endpunkt

Der historische Backfill bleibt ein lokaler CLI-/Deployment-Schritt. Ein Browser-Endpunkt,
der den gesamten Banking-Datenbestand neu gruppiert, ist für die gewünschte UI nicht nötig
und vergrößert nur Angriffs- und Fehlbedienungsfläche.

---

## 10. Frontend-Umsetzung

### 10.1 Position und Aufbau

In `renderTransactionsPanelMarkup()` wird innerhalb desselben Umsatz-Panels nach der
bestehenden Umsatzpagination und vor den Dialogen ergänzt:

```text
Umsätze
  [Filter / Spalten]
  [bestehende Umsatz-Tabelle]
  [bestehende Pagination]

  Wiederkehrende Abbucher
  Abbucher | Abbuchungen | Letzte Abbuchung | Kategorie | Aktion
```

Die Funktion bleibt auf derselben `data`-komponierten Banking-Seite. Es werden keine eigene
Seitenbreite, keine neuen Page-Gutters und keine Änderung an Yuvomi Core eingeführt.

### 10.2 Tabelle „Wiederkehrende Abbucher“

Empfohlene Spalten:

| Spalte | Inhalt |
|---|---|
| Abbucher | stabiler Anzeigename, optional vorhandenes lokales Händlerlogo |
| Abbuchungen | Anzahl gebuchter Umsätze; ausstehende zusätzlich, aber nicht in Schwelle eingerechnet |
| Letzte Abbuchung | Datum und letzter Betrag |
| Kategorie | aktive Expense-Kategorie oder „Keine feste Kategorie“ |
| Aktion | „Umsätze anzeigen“ |

Ein Kandidat erhält einen sachlichen Hinweis „Erkennung noch nicht bestätigt“. Beim ersten
Kategorie-Setzen öffnet sich eine Bestätigung mit Name und Anzahl betroffener Umsätze.

Leere Zustände:

- noch keine wiederkehrenden Abbucher: „Noch keine mehrfachen Abbucher erkannt.“;
- nur unsichere/ambige Evidenz: keine falsche Gruppe anzeigen; optional neutraler Hinweis,
  dass weitere Bankdaten für sichere Zuordnungen benötigt werden;
- Lade-/Fehlerzustand ausschließlich im neuen Bereich, ohne die Haupt-Umsatzliste zu
  zerstören.

### 10.3 Payee-Dialog

Ein eigener `<dialog data-banking-payee-dialog>` zeigt:

- festen Dialogkopf mit Payee-Name und Schließen-Button;
- Standardkategorie im Kopf;
- Zusammenfassung aus Anzahl, erstem und letztem Buchungsdatum;
- Hinweis auf manuelle Kategorieausnahmen;
- scrollbaren Body mit tabellarischer Umsatzliste;
- eigene Pagination und Sortierung.

Die vorhandene Transaktionstabelle wird dafür in einen wiederverwendbaren Renderer
refaktoriert. Der Dialog soll keine vereinfachte, fachlich abweichende Liste bauen. Er nutzt
dieselben Zellen/Formatter für:

- Datum;
- Händler/Empfänger und Zweck;
- Konto;
- Kategorie;
- Wochenbudget;
- Status;
- Betrag.

Im Payee-Dialog gelten zwei wichtige Unterschiede:

1. Die Abfrage ist serverseitig fest auf `payee_id` gescopet; ein Frontendfilter kann diesen
   Scope nicht überschreiben.
2. Eine Kategorieänderung an einer einzelnen Dialogzeile ist eine manuelle Ausnahme und
   wird mit `remember_counterparty: false` gespeichert.

Der bestehende Umsatzdetaildialog darf nicht gleichzeitig verschachtelt modal geöffnet
werden. Beim Klick auf eine Umsatzdetailaktion wird der Payee-Dialog geschlossen, sein
lokaler Zustand gemerkt und danach der vorhandene Umsatzdetaildialog geöffnet.

### 10.4 Client-State

Zusätzlich zu `createTransactionState()` entstehen getrennte Zustände:

```js
createPayeeListState()
createPayeeTransactionState(payeeId)
```

Beide besitzen eigene `AbortController` und `requestId`, damit schnelle Sortier-, Seiten-
oder Dialogwechsel keine veraltete Antwort rendern.

Nach diesen Aktionen werden gezielt Daten erneuert:

- Payee-Kategorie geändert: Payee-Zeile, offener Payee-Dialog, Haupt-Umsatztabelle,
  Kategorisierungs-Summary und Wochenbudget aktualisieren;
- einzelne Umsatzkategorie geändert: Dialogtabelle, Haupt-Umsatztabelle und
  `manual_exception_count` aktualisieren;
- neuer Account-Sync: Konten, Umsatzliste und Payee-Liste aktualisieren.

Kein kompletter Seiten-Neuaufbau ist nötig.

### 10.5 Read-only, Barrierefreiheit und responsive Verhalten

- Benutzer mit `read` dürfen Tabelle und Dialog sehen, aber keine Kategorie verändern.
- Tabellenköpfe verwenden `scope="col"`; Sortierung verwendet `aria-sort`.
- „Umsätze anzeigen“ ist ein benannter Button und nicht nur ein Drei-Punkte-Symbol.
- Dialog besitzt `aria-labelledby`, fokussierbaren Schließen-Button und eine einzige
  vertikal scrollende Body-Fläche.
- Untrusted Namen, Zwecke und Kategorien werden weiterhin ausschließlich über `esc()` oder
  `textContent` ausgegeben.
- Breite Tabellen liegen im vorhandenen horizontalen Scroll-Wrapper; auf Desktop wird der
  Scrollbalken nicht versteckt.
- Responsive Regeln werden an die vorhandenen Modul-/Dialogmuster angehängt, ohne eine
  neue Seitengeometrie oder willkürliche Viewportbreite zu erfinden.

### 10.6 Locales

Mindestens folgende Keys kommen in `modules/banking/locales/de.json` und `en.json`:

```text
recurringPayeesTitle
recurringPayeesDescription
recurringPayee
recurringPayeeCount
recurringPayeeLastDebit
recurringPayeeCategory
recurringPayeeShowTransactions
recurringPayeeTransactionsTitle
recurringPayeeNoCategory
recurringPayeeCandidate
recurringPayeeConfirmTitle
recurringPayeeConfirmDescription
recurringPayeeCategorySaved
recurringPayeeCategoryRemoved
recurringPayeeManualExceptions
recurringPayeePendingCount
recurringPayeesEmpty
recurringPayeesMultipleCurrencies
```

„Abbucher“ wird in der deutschen UI verwendet; in API und Code bleibt `payee`.

---

## 11. Bestehende Dateien ändern und neue Dateien anlegen

### 11.1 Neue Dateien

```text
service/migrations/024_recurring_payees.sql
service/src/services/payee-identifiers.ts
service/src/services/payee-resolution.ts
service/src/services/recurring-payees.ts
service/src/api/payee-routes.ts
service/test/payee-identifiers.test.ts
service/test/payee-resolution.test.ts
service/test/recurring-payees.test.ts
service/test/payee-routes.test.ts
service/test/recurring-payees-frontend.test.ts
```

Optional, wenn der CLI-Code sonst `server.ts` überlädt:

```text
service/src/cli/payee-backfill.ts
```

### 11.2 Bestehende Dateien

| Datei | Änderung |
|---|---|
| `service/src/services/account-sync.ts` | Payee-Auflösung und -Kategorie in die gemeinsame Sync-Pipeline aufnehmen |
| `service/src/services/transaction-enrichment.ts` | bei Detailänderung Transaction- und Payee-Auflösung erneut ausführen |
| `service/src/services/transaction-categorization.ts` | Payee-Kategorien vor AI garantieren; Origin-Feld bei AI-Schreibzugriff klären |
| `service/src/services/category-rules.ts` | Priorität/Origin-Feld, kompatibles Lernen über Payee, manuelle Ausnahmen |
| `service/src/services/transactions-query.ts` | internen `payeeId`-Filter und gegebenenfalls wiederverwendbare Query-Helfer ergänzen |
| `service/src/api/transaction-routes.ts` | On-demand-Enrichment vollständig nachziehen |
| `service/src/api/weekly-budget-routes.ts` | bestehendes Category-PATCH auf den erweiterten Shared Service führen |
| `service/src/app.ts` | `createPayeeRouter()` unter dem bestehenden Prefix mounten |
| `service/src/server.ts` | sicheren Dry-run-/Apply-Backfillmodus einhängen |
| `modules/banking/index.js` | Payee-Tabelle, Dialog, Renderer-Wiederverwendung, Events und Refresh-Flows |
| `modules/banking/style.css` | Tabellen-/Dialogkomponenten im bestehenden Designsystem |
| `modules/banking/locales/de.json` | deutsche Texte |
| `modules/banking/locales/en.json` | englische Texte |
| `docs/DATA_MODEL.md` | Payee, Identifier, Evidence und Category-Origin dokumentieren |
| `docs/ARCHITECTURE.md` | neue lokale Resolverstufe ergänzen |
| `docs/IMPLEMENTATION_PLAN.md` | neue Phase/Statuszeile aufnehmen |
| `README.md` | Funktionsübersicht nach Fertigstellung aktualisieren |

Vor Implementierung ist noch einmal mit `rg` zu prüfen, ob seit diesem Plan weitere
Category-Writer oder Sync-Pfade hinzugekommen sind. Jeder Writer muss die Origin-Invariante
einhalten.

---

## 12. Tests

### 12.1 Migration

- Migration `024` läuft auf leerer Datenbank.
- Migration läuft auf einer Fixture mit Schema `023` und bestehenden Umsätzen/Regeln.
- alle neuen Foreign Keys und Unique Constraints greifen.
- erneutes Starten des Migration Runners ist idempotent.
- vorheriger Anwendungscode kann eine migrierte Datenbank weiterhin öffnen.

### 12.2 Identifier-Normalisierung

- dieselbe IBAN mit Leerzeichen/Kleinschreibung ergibt dieselbe bestehende
  `counterparty_id`;
- verschiedene Identifier-Typen mit gleichem Text ergeben verschiedene HMACs;
- Gläubiger-ID wird nur mit explizitem Label und gültigem Format erkannt;
- Mandatsreferenz wird nicht als primärer Payee verwendet;
- `entry_reference`, `transaction_id` und Referenznummer werden abgelehnt;
- unbekannte `additional_identification`-Schemes werden nicht als stark eingestuft;
- überlange oder missgebildete Providerwerte verursachen keinen Regex-/Speicherangriff;
- kein Testfehler oder Log enthält Klartext-IBAN oder echte Bankdaten.

### 12.3 Resolver

- zwei Lastschriften mit gleicher Gegenkonto-HMAC ergeben einen Payee;
- zwei Lastschriften mit verschiedener IBAN, aber gleicher starker Gläubiger-ID ergeben
  einen Payee;
- gleiche Namen mit unterschiedlichen starken IDs werden nicht automatisch gemergt;
- ein Name-only-Match bleibt Kandidat;
- Kategoriezuweisung bestätigt einen Kandidaten;
- PayPal + zwei verschiedene erkannte Händler ergibt zwei Payees;
- PayPal ohne erkannten Händler erzeugt keinen bestätigten Payee;
- Settlement-Bank im BOOK-Datensatz verdrängt nicht den Händler aus PDNG-Beobachtung;
- eigener Kontotransfer wird ausgeschlossen;
- Bargeldabhebung wird ausgeschlossen;
- eingehender Umsatz erzeugt keinen wiederkehrenden Abbucher;
- mehrdeutige Identifier führen zu `ambiguous` und keiner automatischen Kategorie;
- Resolver ist bei Wiederholung idempotent;
- derselbe Payee in zwei eigenen Konten wird ownerweit zusammengefasst;
- ein anderer Banking-Owner könnte denselben Identifier unabhängig besitzen.

### 12.4 Aggregation

- ein gebuchter Umsatz reicht nicht für die Tabelle;
- zwei gebuchte Umsätze reichen;
- ein `PDNG` plus ein `BOOK` derselben reconcilierten Transaktion zählt einmal;
- ein zusätzlicher unreconciliierter `PDNG` wird separat als pending, aber nicht für die
  Wiederholungsgrenze gezählt;
- erste/letzte Daten und letzter Betrag sind deterministisch;
- mehrere Währungen erzeugen keine falsche Summe;
- manuelle Ausnahmen werden korrekt gezählt;
- inaktive/ignorierte Payees erscheinen nach definierter Filterregel nicht.

### 12.5 Kategorien

- aktive Expense-Kategorie kann gesetzt werden;
- inaktive, Income- oder fremde Kategorie wird abgelehnt;
- alle nichtmanuellen Payee-Umsätze werden aktualisiert;
- manuelle Einzelkategorie bleibt unverändert;
- neues eindeutig passendes Importresultat erhält im selben Sync die Kategorie;
- neuer Umsatz wird deshalb nicht an OpenAI übergeben;
- Ändern ersetzt nur zulässige nichtmanuelle Zuordnungen;
- Entfernen löscht nur Zeilen mit passender `category_origin_payee_id`;
- offene AI-Reviews der betroffenen Umsätze werden sauber abgeschlossen;
- bestehende Legacy-Counterparty-Regel bleibt funktionsfähig;
- Einzelumsatzänderung aus dem Payee-Dialog verändert nicht ungewollt den Payee-Default.

### 12.6 API und Security

- `read` sieht Liste und Dialogdaten;
- `none` erhält `403`;
- `read` kann nicht schreiben;
- fehlende/falsche Origin oder CSRF wird abgelehnt;
- fremde Payee-ID ergibt `404`;
- Pagination, Sortier-Allowlist und Limits werden validiert;
- Response enthält keine Identifier-Hashes, verschlüsselten Werte, Provider-IDs oder
  Raw-Payloads;
- Kategorieänderung bestimmt betroffene Umsätze ausschließlich serverseitig;
- Shared-Banking-Owner-Verhalten entspricht den bestehenden Account-/Transaction-Routen.

### 12.7 Frontend

- Payee-Tabelle steht nach Umsatzpagination;
- leere, Lade- und Fehlerzustände sind vorhanden;
- alle untrusted Texte werden escaped;
- Read-only deaktiviert Kategoriecontrols;
- Kandidatenbestätigung wird vor Mutation verlangt;
- Dialog verwendet Tabellenmarkup und eigene Pagination;
- Einzelkategorie im Dialog sendet `remember_counterparty: false`;
- Detaildialog wird nicht modal in einen offenen Payee-Dialog verschachtelt;
- nach Kategorieänderung werden alle abhängigen Bereiche aktualisiert;
- Tastaturbedienung, Dialogtitel und Sortier-Aria sind vorhanden;
- Tabellen scrollen auf schmalen Flächen ohne die Seite horizontal zu sprengen.

### 12.8 Gesamtprüfung

Nach jeder Implementierungsphase:

```powershell
Set-Location service
npm test
npm run build
```

Zusätzlich sind die vorhandenen Transaction-, Category-, Import-, Resolution-,
Weekly-Budget-, Security- und Frontend-Contract-Tests als Regression auszuführen.

Für die Aggregatabfragen soll eine Fixture mit mindestens 10.000 Umsätzen per
`EXPLAIN QUERY PLAN` bestätigen, dass Payee-/Owner-/Status-Indizes verwendet werden. Es ist
kein externer Benchmarkdienst nötig.

---

## 13. Umsetzungsphasen

### Phase 0 – Vertrag und redigierte Fixtures

1. Aktuellen Code/Schema erneut lesen und freie Migrationsnummer prüfen.
2. Offizielle Enable-Banking-Transaktionsfelder gegen die aktuelle API-Referenz prüfen.
3. Redigierte Fixtures für Lastschrift, Kartenumsatz, PayPal-Händler, PayPal-unbekannt,
   PDNG/BOOK, eigene Umbuchung und fehlende IBAN erstellen.
4. Identifikator-Allowlist und Gläubiger-ID-Parser als Tests festschreiben.
5. Keine Produktionsdaten in Fixtures übernehmen.

Ergebnis: reproduzierbarer fachlicher Vertrag, noch keine UI.

### Phase 1 – Append-only Datenmodell

1. Migration `024_recurring_payees.sql` anlegen.
2. Migrationstests von Schema `023` auf `024` ergänzen.
3. Foreign Keys, Constraints und Indizes prüfen.
4. `docs/DATA_MODEL.md` aktualisieren.

Ergebnis: additive, rollback-kompatible Persistenzgrundlage.

### Phase 2 – Identifier und Payee-Resolver

1. `payee-identifiers.ts` implementieren.
2. Evidenz extrahieren und ausschließlich gehasht persistieren.
3. `payee-resolution.ts` mit Kandidat-/Confirmed-/Ambiguous-Logik implementieren.
4. Payment-Intermediary- und Own-Transfer-Regeln wiederverwenden.
5. Resolver-Tests vollständig grün machen.
6. Dry-run-Backfill ergänzen, noch nicht produktiv anwenden.

Ergebnis: bestehende und neue Umsätze können idempotent gruppiert werden.

### Phase 3 – Kategorieautomatik

1. Shared Service für Payee-Kategorie und Bulk-Anwendung implementieren.
2. `category_origin_payee_id` in allen Category-Writern korrekt setzen/löschen.
3. bestehende Einzelumsatz-„merken“-Semantik kompatibel auf Payee erweitern.
4. Account-Sync, On-demand-Enrichment und AI-Vorbereitung integrieren.
5. Legacy-Counterparty-Regeln konfliktfrei übernehmen/spiegeln.
6. Kategorie- und Sync-Regressionstests ausführen.

Ergebnis: ein neuer eindeutig erkannter Umsatz erhält automatisch lokal die Payee-Kategorie.

### Phase 4 – Read-/Write-API

1. `recurring-payees.ts` Query-/Mutation-Service implementieren.
2. `payee-routes.ts` mit Liste, Transaktionen, Set und Clear implementieren.
3. Router in `app.ts` unter vorhandenem Prefix mounten.
4. Ownership, Permission, Origin, CSRF, `no-store` und Response-Redaction testen.
5. Query-Plan und Pagination testen.

Ergebnis: stabiler, sicherer Frontend-Vertrag.

### Phase 5 – Tabelle und Dialog

1. Markup unterhalb der bestehenden Umsatzpagination ergänzen.
2. Payee-Tabellenrenderer und State implementieren.
3. bestehenden Transaction-Renderer für den Dialog wiederverwendbar machen.
4. Kategorie setzen/entfernen, Kandidatenbestätigung und manuelle Ausnahmen umsetzen.
5. Refresh-Flows, Abort-Verhalten und Dialogwechsel implementieren.
6. CSS und deutsche/englische Locales ergänzen.
7. Frontend-Contract- und responsive Sichtprüfung ausführen.

Ergebnis: vollständiger gewünschter Benutzerworkflow.

### Phase 6 – Historischer Backfill und Produktionsrollout

Diese Phase ist eine produktive Änderung und unterliegt vollständig dem VPS-`AGENTS.md`.

1. Serverzustand ausschließlich lesend erfassen.
2. unmittelbar vorher vollständiges verschlüsseltes Offsite-Backup starten und Erfolg,
   Hash-/Decrypt-Test sowie Upload prüfen;
3. Image/Artefakt mit festem Versionsstand bauen;
4. Compose-Konfiguration mit `docker compose config --quiet` validieren, ohne Secrets
   auszugeben;
5. neuen Sidecar-Code starten und Migrationserfolg prüfen;
6. Backfill zunächst im Dry-run ausführen und nur anonyme Zähler prüfen;
7. bei Ambiguitäts-/Konfliktrate außerhalb der erwarteten Testwerte abbrechen;
8. Backfill mit `--apply` ausführen;
9. fachlich Payee-Liste, Dialog, Kategoriezuweisung und einen kontrollierten neuen Import
   prüfen;
10. Container, Logs, öffentliche HTTPS-Healthchecks, offene Ports und `systemctl --failed`
    prüfen;
11. Backup-Zeitstempel, Änderung, Tests, Ergebnis und Rollback in `CHANGELOG.md`
    dokumentieren.

Rollback:

- vorheriges Sidecar-/Modul-Artefakt wieder deployen;
- zusätzliche Tabellen/Spalten in `banking.db` nicht destruktiv entfernen;
- Legacy-Counterparty-Regeln bleiben erhalten;
- wenn Datenrestauration notwendig wird, ausschließlich die dokumentierte, konsistente
  Backup-/Restore-Prozedur verwenden und nie die Live-SQLite-Datei blind kopieren.

---

## 14. Akzeptanzkriterien

- [ ] Unter der Umsatz-Tabelle gibt es eine Tabelle „Wiederkehrende Abbucher“.
- [ ] Angezeigt werden nur Payees mit mindestens zwei gebuchten ausgehenden Umsätzen.
- [ ] PDNG/BOOK-Reconciliation erzeugt keine künstliche Wiederholung.
- [ ] Eigene Umbuchungen, Bargeld und reine Zahlungsintermediäre werden nicht als Abbucher
      kategorisiert.
- [ ] Derselbe starke Identifier führt ownerweit und kontoübergreifend zum selben Payee.
- [ ] Gleiche Namen allein führen nicht ungeprüft zu einer bestätigten Identität.
- [ ] Ambige Identität wird nicht automatisch zusammengeführt oder kategorisiert.
- [ ] Jeder Payee öffnet einen Dialog mit seinen Umsätzen in tabellarischer Form.
- [ ] Die Dialogtabelle verwendet denselben öffentlichen Umsatzvertrag und dieselben
      Formatter wie die Haupttabelle.
- [ ] Eine aktive Expense-Kategorie kann direkt am Payee gesetzt werden.
- [ ] Bestehende nichtmanuelle Umsätze des Payees übernehmen diese Kategorie sofort.
- [ ] Manuelle Einzelkategorien bleiben als Ausnahmen erhalten.
- [ ] Ein neuer eindeutig erkannter Umsatz erhält beim Import automatisch die
      Payee-Kategorie.
- [ ] Dieser Umsatz wird nicht zusätzlich zur AI-Kategorisierung geschickt.
- [ ] Entfernen einer Payee-Kategorie löscht keine fremden/manuellen Zuordnungen.
- [ ] Read-only-Benutzer können ansehen, aber nicht verändern.
- [ ] Alle Mutationen verlangen `write`, Origin-Prüfung und CSRF.
- [ ] Keine IBAN, Gläubiger-ID, Identifier-HMACs oder Provider-Rohdaten verlassen die
      sichere Backendschicht.
- [ ] Yuvomi Core und `yuvomi.db` bleiben unverändert.
- [ ] Migration ist append-only und der Rollback benötigt keine Schema-Löschung.
- [ ] `npm test` und `npm run build` sind grün.
- [ ] Produktion erfüllt Backup-, Healthcheck-, Port-, Log- und Changelog-Gates aus dem
      VPS-`AGENTS.md`.

---

## 15. Bewusste Nicht-Ziele

Nicht Teil dieser ersten Umsetzung:

- Vorhersage des nächsten Abbuchungsdatums;
- Erkennung oder Kündigung von Abonnements/Verträgen;
- automatische Zusammenführung widersprüchlicher Payees;
- fuzzy Matching mit Levenshtein, Embeddings oder externer AI;
- Versand echter Bankdaten an OpenAI;
- frei editierbare Regex-Regeln im Browser;
- externe Händler-/Identity-Datenbank;
- Änderung von Yuvomi Core oder direkter Zugriff auf `yuvomi.db`;
- Löschen alter Kategorie-Regeln direkt beim ersten Rollout;
- umfangreiche Merge-/Split-Verwaltungsoberfläche für Payees.

Eine spätere Merge-/Split-UI kann auf dem vorgeschlagenen Identifier-Modell aufbauen. Sie
ist erst sinnvoll, nachdem reale, redigierte Ambiguitätsfälle ausgewertet wurden.

---

## 16. Wichtigste Designentscheidung

Die Funktion darf „gleicher Abbucher“ nicht mit „ähnlicher Buchungstext“ gleichsetzen.
Deshalb wird die bestehende Auflösung einzelner Umsätze nicht ersetzt, sondern um eine
eigene, stabile und auditierbare Payee-Schicht ergänzt:

```text
einzelner Umsatz
  -> verständliche Transaction-Resolution
  -> mehrere gehashte Identitätsevidenzen
  -> genau ein bestätigter oder bewusst unbestätigter Payee
  -> lokale Standardkategorie mit manuellen Ausnahmen
```

Diese Trennung erfüllt den gewünschten Komfort, ohne bei Bankdaten eine unsichere
Namensähnlichkeit als eindeutige Identität auszugeben.
