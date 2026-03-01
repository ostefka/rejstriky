# SÚKL Agent — Architecture Document

## Overview

Declarative M365 Copilot agent providing Czech drug database, pharmacy lookup, and drug leaflet (SPC/PIL) search powered by Azure AI Search.

**Language**: Czech (all data, all queries, all agent responses)

## Azure Infrastructure

| Resource | Name | Tier | Location |
|----------|------|------|----------|
| Azure AI Search | `search-airlift-s1` | Standard S1 | Sweden Central |
| Resource Group | `rg-airlift-rag` | — | Sweden Central |

### AI Search S1 Capabilities
- **25 GB** storage per partition
- **Up to 12 indexes** (10 existing, adding 3 = 13 — may need to drop unused ones or use 2 combined indexes)
- **Semantic search**: Enabled (`standard`)
- **Vector search**: Supported (built-in vectorizers available)
- **Indexers**: Blob indexer with built-in document cracking (PDF, DOC, DOCX)
- **AI enrichment**: Skillsets for text extraction, OCR, key phrase extraction

---

## Data Sources (from opendata.sukl.cz)

### Index 1: `sukl-drugs` — Databáze léčivých přípravků (DLP)

**Source**: Monthly ZIP from `https://opendata.sukl.cz/soubory/SOD{YYYYMMDD}/DLP{YYYYMMDD}.zip`
**Encoding**: win-1250, semicolon-delimited CSV

#### Source Tables (30 CSV files)

| Table | Records | Purpose | Used in Index |
|-------|---------|---------|--------------|
| dlp_lecivepripravky | 68,082 | Main drug records (44 columns) | **Primary** — all fields |
| dlp_slozeni | 785,046 | Composition (drug→substance mapping with amounts) | Join → `slozeni` array |
| dlp_synonyma | 271,341 | Substance name synonyms (CZ, EN, INN) | Join → `synonyma` for search boost |
| dlp_nazvydokumentu | 60,944 | Mapping KOD_SUKL → SPC/PIL/OBAL filenames | Join → `spcFile`, `pilFile` |
| dlp_latky | 21,276 | Substance master list (codes, INN names) | Join → resolve substance names |
| dlp_dopinglp | 9,493 | Doping classification per drug | Join → `doping` flag |
| dlp_atc | 6,999 | ATC classification tree | Join → `atcNazev`, `atcNazevEn` |
| dlp_lecivelatky | 3,359 | Active substance list | Reference |
| dlp_organizace | 3,537 | Registration holders & manufacturers | Join → `drzitelNazev`, `vyrobceNazev` |
| dlp_formy | 637 | Dosage form codes | Join → `formaNazev` |
| dlp_cesty | 176 | Administration route codes | Join → `cestaNazev` |
| dlp_indikacniskupiny | 88 | Indication groups | Join → `indikacniSkupinaNazev` |
| dlp_obaly | 82 | Packaging codes | Join → `obalNazev` |
| dlp_jednotky | 71 | Unit codes | Reference |
| dlp_pravnizakladreg | 18 | Legal basis for registration | Reference |
| dlp_stavyreg | 16 | Registration states | Join → `stavRegNazev` |
| dlp_slozenipriznak | 14 | Composition flags | Reference |
| dlp_doping | 13 | Doping categories | Join → `dopingNazev` |
| dlp_vydej | ~10 | Dispensing type codes | Join → `vydejNazev` |
| dlp_regproc | 7 | Registration procedure types | Reference |
| dlp_narvla | 6 | Narcotic substance classifications | Reference |
| dlp_vpois | ~60K | Marketing authorization holder contact | Join → `vpoisNazev` |
| dlp_typlp | ~5 | Drug type codes | Reference |
| dlp_soli | 3,005 | Salt forms | Reference |
| dlp_splp | 618 | Related preparations | Reference |
| dlp_zavislost | ~5 | Dependency classification | Reference |
| dlp_zdroje | ~5 | Data sources | Reference |
| dlp_zeme | ~250 | Country codes | Reference |
| dlp_zruseneregistrace | variable | Cancelled registrations | Used for filtering only |
| dlp_platnost | 1 | Data validity date | Metadata |

#### Denormalized Index Schema: `sukl-drugs`

Each document = one drug (by KOD_SUKL). ~68K documents.

```json
{
  "name": "sukl-drugs",
  "fields": [
    {"name": "id", "type": "Edm.String", "key": true, "filterable": true},
    {"name": "kodSukl", "type": "Edm.String", "filterable": true, "sortable": true},
    {"name": "nazev", "type": "Edm.String", "searchable": true, "filterable": true, "sortable": true},
    {"name": "doplnekNazvu", "type": "Edm.String", "searchable": true},
    {"name": "sila", "type": "Edm.String", "searchable": true, "filterable": true},
    {"name": "forma", "type": "Edm.String", "filterable": true},
    {"name": "formaNazev", "type": "Edm.String", "searchable": true, "filterable": true},
    {"name": "baleni", "type": "Edm.String", "searchable": true},
    {"name": "cesta", "type": "Edm.String", "filterable": true},
    {"name": "cestaNazev", "type": "Edm.String", "searchable": true},
    {"name": "drzitelKod", "type": "Edm.String", "filterable": true},
    {"name": "drzitelNazev", "type": "Edm.String", "searchable": true, "filterable": true},
    {"name": "drzitelZeme", "type": "Edm.String", "filterable": true},
    {"name": "regCislo", "type": "Edm.String", "searchable": true, "filterable": true},
    {"name": "stavRegistrace", "type": "Edm.String", "filterable": true},
    {"name": "stavRegistraceNazev", "type": "Edm.String", "searchable": true},
    {"name": "atc", "type": "Edm.String", "filterable": true, "sortable": true},
    {"name": "atcNazev", "type": "Edm.String", "searchable": true},
    {"name": "ucinneLatky", "type": "Edm.String", "searchable": true},
    {"name": "vydej", "type": "Edm.String", "filterable": true},
    {"name": "vydejNazev", "type": "Edm.String", "searchable": true},
    {"name": "dodavky", "type": "Edm.String", "filterable": true},
    {"name": "indikacniSkupina", "type": "Edm.String", "filterable": true},
    {"name": "indikacniSkupinaNazev", "type": "Edm.String", "searchable": true},
    {"name": "obal", "type": "Edm.String", "filterable": true},
    {"name": "obalNazev", "type": "Edm.String", "searchable": true},
    {"name": "doping", "type": "Edm.Boolean", "filterable": true},
    {"name": "dopingKategorie", "type": "Edm.String", "filterable": true},
    {"name": "datumRegistrace", "type": "Edm.String", "filterable": true},
    {"name": "datumPlatnosti", "type": "Edm.String"},
    {"name": "spcSoubor", "type": "Edm.String"},
    {"name": "pilSoubor", "type": "Edm.String"},
    {"name": "obalSoubor", "type": "Edm.String"},
    {"name": "slozeni", "type": "Edm.String", "searchable": true},
    {"name": "synonyma", "type": "Edm.String", "searchable": true},
    {"name": "popisek", "type": "Edm.String", "searchable": true}
  ],
  "semanticConfiguration": {
    "name": "sukl-drugs-semantic",
    "prioritizedFields": {
      "titleField": {"fieldName": "nazev"},
      "contentFields": [
        {"fieldName": "popisek"},
        {"fieldName": "ucinneLatky"},
        {"fieldName": "slozeni"},
        {"fieldName": "synonyma"}
      ],
      "keywordsFields": [
        {"fieldName": "atcNazev"},
        {"fieldName": "formaNazev"},
        {"fieldName": "indikacniSkupinaNazev"}
      ]
    }
  }
}
```

**Notes on `popisek` field**: A generated Czech-language text summary combining key info for better semantic search:
```
"PARALEN 500 - tablety, 500mg paracetamol, perorální podání, volně prodejný, 
ATC: N02BE01 (Paracetamol), indikační skupina: analgetika-antipyretika, 
držitel: Zentiva, dodávky: ano"
```

### Index 2: `sukl-pharmacies` — Seznam lékáren

**Source**: Monthly ZIP from `https://opendata.sukl.cz/soubory/SOD{YYYYMMDD}/LEKARNY{YYYYMMDD}.zip`

#### Source Tables

| Table | Records | Purpose |
|-------|---------|---------|
| lekarny_seznam | 2,671 | Main pharmacy list |
| lekarny_prac_doba | 20,240 | Working hours per day |
| lekarny_typ | 10 | Pharmacy type codes |

#### Denormalized Index Schema: `sukl-pharmacies`

Each document = one pharmacy. ~2.7K documents.

```json
{
  "name": "sukl-pharmacies",
  "fields": [
    {"name": "id", "type": "Edm.String", "key": true, "filterable": true},
    {"name": "nazev", "type": "Edm.String", "searchable": true, "filterable": true, "sortable": true},
    {"name": "kodPracoviste", "type": "Edm.String", "filterable": true},
    {"name": "kodLekarny", "type": "Edm.String", "filterable": true},
    {"name": "icz", "type": "Edm.String", "filterable": true},
    {"name": "ico", "type": "Edm.String", "filterable": true},
    {"name": "mesto", "type": "Edm.String", "searchable": true, "filterable": true, "facetable": true},
    {"name": "ulice", "type": "Edm.String", "searchable": true},
    {"name": "psc", "type": "Edm.String", "filterable": true},
    {"name": "adresa", "type": "Edm.String", "searchable": true},
    {"name": "lekarnikPrijmeni", "type": "Edm.String", "searchable": true},
    {"name": "lekarnikJmeno", "type": "Edm.String", "searchable": true},
    {"name": "lekarnikTitul", "type": "Edm.String"},
    {"name": "www", "type": "Edm.String"},
    {"name": "email", "type": "Edm.String"},
    {"name": "telefon", "type": "Edm.String"},
    {"name": "fax", "type": "Edm.String"},
    {"name": "erp", "type": "Edm.String", "filterable": true},
    {"name": "typLekarny", "type": "Edm.String", "filterable": true, "facetable": true},
    {"name": "typLekarnyNazev", "type": "Edm.String", "searchable": true, "filterable": true},
    {"name": "zasilkovyProdej", "type": "Edm.String", "filterable": true},
    {"name": "pohotovost", "type": "Edm.String", "filterable": true},
    {"name": "pracovniDoba", "type": "Edm.String", "searchable": true},
    {"name": "popisek", "type": "Edm.String", "searchable": true}
  ],
  "semanticConfiguration": {
    "name": "sukl-pharmacies-semantic",
    "prioritizedFields": {
      "titleField": {"fieldName": "nazev"},
      "contentFields": [
        {"fieldName": "popisek"},
        {"fieldName": "pracovniDoba"},
        {"fieldName": "adresa"}
      ],
      "keywordsFields": [
        {"fieldName": "mesto"},
        {"fieldName": "typLekarnyNazev"}
      ]
    }
  }
}
```

**Notes on `pracovniDoba` field**: Formatted working hours string:
```
"PO: 07:30-16:00, ÚT: 07:30-16:00, ST: 07:30-18:00, ČT: 07:30-16:00, PÁ: 07:30-14:00"
```

**Notes on `popisek` field**: Generated summary:
```
"Adamova lékárna, Václavské náměstí 775/8, Praha, 11000, typ: Lékárna s OOVL, zásilkový prodej: ANO"
```

### Index 3: `sukl-documents` — SPC/PIL (Drug Leaflets)

**Source**: Monthly ZIPs:
- SPC: `https://opendata.sukl.cz/soubory/SOD{YYYYMMDD}/SPC{YYYYMMDD}.zip` — **2,461 MB** (PDF/DOC)
- PIL: `https://opendata.sukl.cz/soubory/SOD{YYYYMMDD}/PIL{YYYYMMDD}.zip` — **2,705 MB** (PDF/DOC)
- OBAL: `https://opendata.sukl.cz/soubory/SOD{YYYYMMDD}/OBAL{YYYYMMDD}.zip` — **1,158 MB** (PDF/DOC)
- Weekly delta: `https://opendata.sukl.cz/soubory/SOD{YYYYMMDD}i/SOD{YYYYMMDD}i.zip` — **~63 MB**

**Total**: ~6.3 GB of documents (compressed), ~60K documents

#### Document-to-Drug Mapping

The `dlp_nazvydokumentu.csv` table provides the mapping:
```
KOD_SUKL;PIL;DAT_ROZ_PIL;SPC;DAT_ROZ_SPC;OBAL_TEXT;DAT_ROZ_OBAL;NR;DAT_NPM_NR
0000009;PI223082.pdf;05.06.2025;SPC223083.pdf;05.06.2025;OBAL223081.pdf;05.06.2025;;
```

Each drug has up to 3 documents: SPC (professional summary), PIL (patient leaflet), OBAL (packaging text).

#### Ingestion Strategy for Documents

**Architecture**: Blob Storage → AI Search Blob Indexer → `sukl-documents` index

1. Upload PDFs/DOCs to Azure Blob Storage container
2. Use AI Search **blob indexer** with built-in document cracking (extracts text from PDF/DOC natively)
3. Use **custom skillset** or **field mappings** to extract KOD_SUKL from filename pattern (e.g., `SPC223083.pdf` → lookup in mapping table)
4. Alternatively: rename files to include KOD_SUKL in blob metadata before upload

```json
{
  "name": "sukl-documents",
  "fields": [
    {"name": "id", "type": "Edm.String", "key": true},
    {"name": "kodSukl", "type": "Edm.String", "filterable": true},
    {"name": "nazevLeku", "type": "Edm.String", "searchable": true, "filterable": true},
    {"name": "typDokumentu", "type": "Edm.String", "filterable": true, "facetable": true},
    {"name": "nazevSouboru", "type": "Edm.String"},
    {"name": "datumRozhodnuti", "type": "Edm.String"},
    {"name": "obsah", "type": "Edm.String", "searchable": true},
    {"name": "contentVector", "type": "Collection(Edm.Single)", "searchable": true, "dimensions": 1536}
  ],
  "semanticConfiguration": {
    "name": "sukl-documents-semantic",
    "prioritizedFields": {
      "titleField": {"fieldName": "nazevLeku"},
      "contentFields": [
        {"fieldName": "obsah"}
      ],
      "keywordsFields": [
        {"fieldName": "typDokumentu"},
        {"fieldName": "kodSukl"}
      ]
    }
  },
  "vectorSearch": {
    "algorithms": [{"name": "hnsw-algo", "kind": "hnsw"}],
    "profiles": [{"name": "vector-profile", "algorithm": "hnsw-algo", "vectorizer": "text-embedding"}],
    "vectorizers": [{"name": "text-embedding", "kind": "azureOpenAI", "azureOpenAIParameters": {"deploymentId": "TBD", "resourceUri": "TBD", "modelName": "text-embedding-3-small"}}]
  }
}
```

**Notes on vector search**: 
- Requires Azure OpenAI deployment with `text-embedding-3-small` or `text-embedding-3-large`
- If no Azure OpenAI available, can use semantic search only (still very effective for document search)
- Vector search is optional enhancement — semantic search alone handles Czech well

#### SPC/PIL Ingestion Challenges

| Challenge | Mitigation |
|-----------|-----------|
| **Total size 6.3 GB** (compressed) | Use Azure Blob Storage as staging. S1 has 25 GB — fits comfortably even uncompressed. |
| **~60K documents** | Well within S1 limits. Blob indexer handles batches. |
| **PDF/DOC mixed formats** | AI Search blob indexer cracks both natively. |
| **Document-to-drug mapping** | Use `dlp_nazvydokumentu.csv` to know which `SPC*.pdf`/`PIL*.pdf` belongs to which KOD_SUKL. Set blob metadata before upload. |
| **Some SPC/PIL are links to EMA** (for EU-centralized registrations starting with EU reg number) | These won't have local PDF files. Skip or fetch from EMA separately. |
| **Large PDFs (>16MB)** | AI Search indexer limit is 16MB per blob. Most leaflets are small. Monitor for failures. |
| **Monthly full refresh** | Download full ZIPs monthly, re-upload to blob, re-index. Or use weekly delta ZIP (~63 MB) for incremental updates. |
| **OBAL (packaging texts)** | Lower value for agent queries. Consider skipping initially to save index space. Focus on SPC + PIL. |

---

## Agent Design Constraints

### Declarative Agent Limitations
- **GET methods only** — no POST bodies
- **Max ~10-15 API operations** in OpenAPI plugin
- **Response size** — keep `$top=10` and `$select` to limit response size
- **API key authentication** — supported in OpenAPI spec header
- **All in Czech** — agent instructions, search queries, responses

### Proposed API Operations (~10 total, all GET)

| # | Operation | Path | Purpose |
|---|-----------|------|---------|
| 1 | Search drugs by name | `GET /indexes/sukl-drugs/docs?search={query}&searchFields=nazev,doplnekNazvu,synonyma` | "najdi lék Paralen" |
| 2 | Lookup drug by SUKL code | `GET /indexes/sukl-drugs/docs?$filter=kodSukl eq '{code}'` | "lék s kódem 0000009" |
| 3 | Search by active substance | `GET /indexes/sukl-drugs/docs?search={substance}&searchFields=ucinneLatky,slozeni,synonyma` | "léky s ibuprofenem" |
| 4 | Search by ATC code | `GET /indexes/sukl-drugs/docs?$filter=atc eq '{atc}'` | "léky ATC N02BE01" |
| 5 | Filter drugs by dispensing | `GET /indexes/sukl-drugs/docs?$filter=vydej eq '{type}'` | "volně prodejné léky" |
| 6 | Search pharmacies | `GET /indexes/sukl-pharmacies/docs?search={query}` | "lékárny v Brně" |
| 7 | Filter pharmacies by city | `GET /indexes/sukl-pharmacies/docs?$filter=mesto eq '{city}'` | "lékárny Praha" |
| 8 | Filter pharmacies by type | `GET /indexes/sukl-pharmacies/docs?$filter=typLekarny eq '{type}'` | "nemocniční lékárny" |
| 9 | Search drug documents (SPC/PIL) | `GET /indexes/sukl-documents/docs?search={query}&searchFields=obsah` | "nežádoucí účinky paracetamol" |
| 10 | Get document for specific drug | `GET /indexes/sukl-documents/docs?$filter=kodSukl eq '{code}'&$filter=typDokumentu eq '{type}'` | "SPC pro Paralen" |

### Azure AI Search REST API — GET Compatibility

AI Search supports all search operations via GET:
```
GET https://{service}.search.windows.net/indexes/{index}/docs?api-version=2024-07-01&search={query}&$filter={filter}&$select={fields}&$top={count}&queryType=semantic&semanticConfiguration={config}
```

Headers: `api-key: {admin-or-query-key}`

This is **native REST**, no custom server needed.

---

## Czech Language Support

| Layer | Czech Handling |
|-------|---------------|
| **Index analyzers** | Use `cs.microsoft` (Czech Microsoft analyzer) for all searchable text fields |
| **Semantic search** | Azure AI Search semantic ranker supports Czech natively |
| **Vector search** | `text-embedding-3-small` supports Czech (multilingual model) |
| **Agent instructions** | All in Czech — prompt, examples, response format |
| **Data** | Source data is Czech (win-1250 encoding, convert to UTF-8 during ingestion) |
| **Queries** | Users query in Czech, AI Search processes Czech tokens correctly |

### Czech Analyzer Configuration

All searchable string fields should use:
```json
{
  "name": "nazev",
  "type": "Edm.String",
  "searchable": true,
  "analyzer": "cs.microsoft"
}
```

The `cs.microsoft` analyzer handles:
- Czech diacritics (háčky, čárky)
- Czech stemming (léků → lék, lékárny → lékárna)
- Czech stop words
- Proper tokenization

---

## Ingestion Pipeline

### Phase 1: Drugs + Pharmacies (structured CSV)

**Tool**: Python script running locally (or as Azure Function for automation)

```
1. Download ZIP from opendata.sukl.cz
2. Extract CSVs (win-1250 encoding)  
3. Parse CSVs with pandas (sep=';', encoding='cp1250')
4. Denormalize: JOIN drug + substances + ATC + org + forms + routes + document mapping
5. Generate 'popisek' text field for semantic search
6. Convert to JSON documents
7. Push to Azure AI Search via REST API (POST /indexes/{name}/docs/index)
8. Upload batch (1000 docs per batch)
```

### Phase 2: SPC/PIL Documents (PDF/DOC)

```
1. Download SPC and PIL ZIPs (~5 GB total)
2. Extract to local temp
3. Parse dlp_nazvydokumentu.csv to build filename→KOD_SUKL mapping
4. Upload files to Azure Blob Storage with metadata (kodSukl, typDokumentu, nazevLeku)
5. Create blob indexer + skillset in AI Search
6. Indexer auto-cracks PDFs, extracts text into 'obsah' field
7. Optional: vectorize with Azure OpenAI embedding
```

### Update Strategy

| Dataset | Cadence | Strategy |
|---------|---------|----------|
| DLP (drugs) | Monthly | Full re-index from new ZIP |
| Pharmacies | Monthly | Full re-index from new ZIP |
| SPC/PIL | Monthly full + weekly delta | Monthly: full re-upload. Weekly: incremental update from delta ZIP (~63 MB) |

---

## Index Count Consideration

Current AI Search has 10 indexes + we want 3 = 13 total.
S1 limit is 50 indexes — no problem.

---

## Estimated Index Sizes

| Index | Documents | Estimated Size |
|-------|-----------|---------------|
| sukl-drugs | ~68K | ~100-200 MB (with synonyms and generated text) |
| sukl-pharmacies | ~2.7K | ~5-10 MB |
| sukl-documents | ~60K | ~5-15 GB (full text from PDFs) |
| **Total** | ~130K | ~5-15 GB |

S1 capacity: 25 GB per partition — should fit. Monitor after initial ingestion.

---

## Decision: OBAL (Packaging Texts)

**Recommendation**: Skip OBAL initially. 
- SPC contains the most detailed professional information (dosage, interactions, contraindications)
- PIL contains patient-friendly information (side effects, how to use)
- OBAL is just packaging text — adds 1.1 GB but minimal search value
- Can add later if needed

**Total without OBAL**: SPC (2.5 GB) + PIL (2.7 GB) = ~5.2 GB compressed

---

## Next Steps

1. ☐ Create `sukl-drugs` index with Czech analyzers + semantic configuration
2. ☐ Create `sukl-pharmacies` index with Czech analyzers + semantic configuration
3. ☐ Build Python ingestion script for drugs (CSV → denormalize → push)
4. ☐ Build Python ingestion script for pharmacies
5. ☐ Run ingestion, verify search works
6. ☐ Set up Blob Storage for SPC/PIL documents
7. ☐ Create `sukl-documents` index with semantic + vector configuration
8. ☐ Create blob indexer + skillset for document cracking
9. ☐ Upload SPC/PIL PDFs with metadata
10. ☐ Build OpenAPI spec for declarative agent
11. ☐ Create declarative agent with Czech instructions
12. ☐ Test end-to-end
