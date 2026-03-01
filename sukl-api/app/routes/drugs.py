"""Drug search and detail endpoints — all AI Search query logic is server-side."""

import re
from fastapi import APIRouter, Request, Query
from fastapi.responses import JSONResponse

from ..logger import log
from ..search_client import SearchError

router = APIRouter()

INDEX = "sukl-drugs"
SEMANTIC_CONFIG = "sukl-drugs-semantic"

# Fields returned in search results (compact)
SEARCH_FIELDS = [
    "kodSukl", "nazev", "sila", "formaNazev", "cestaNazev",
    "drzitelNazev", "atc", "atcNazev", "ucinneLatky",
    "vydejNazev", "indikacniSkupinaNazev", "dodavky", "doping",
]

# All fields for detail view
DETAIL_FIELDS = [
    "kodSukl", "nazev", "doplnekNazvu", "sila",
    "formaNazev", "baleni", "cestaNazev", "obalNazev",
    "drzitelNazev", "drzitelZeme", "regCislo",
    "stavRegistraceNazev", "atc", "atcNazev", "ucinneLatky",
    "vydejNazev", "dodavky", "indikacniSkupinaNazev",
    "doping", "ean", "datumRegistrace", "platnostDo",
    "spcSoubor", "pilSoubor", "slozeni", "synonyma", "popisek",
]

# Dispensing mode mapping: friendly name → SUKL code
# R = na lékařský předpis (62k), F = volně prodejné (3.8k),
# V = vyhrazená léčiva (483), L = s omezením §39 (17), P = bez předpisu s omezením RLPO (12)
DISPENSING_MAP = {
    "prescription": "R",   # na lékařský předpis
    "otc": "F",            # volně prodejné léčivé přípravky
    "restricted": "L",     # s omezením (§ 39)
    "reserved": "V",       # vyhrazená léčiva
    "otc-restricted": "P", # bez lékařského předpisu s omezením (RLPO)
}

# Max text lengths in search results (detail returns full)
MAX_SLOZENI_SEARCH = 500
MAX_SYNONYMA_SEARCH = 300


@router.get("/search")
async def search_drugs(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query — drug name, active substance, indication, etc."),
    atc: str | None = Query(None, description="ATC code filter (e.g. N02BE01)"),
    holder: str | None = Query(None, description="Marketing auth holder name filter"),
    dispensing: str | None = Query(None, description="Dispensing mode: prescription, otc, restricted"),
    doping: bool | None = Query(None, description="Filter doping-flagged drugs"),
    available: bool | None = Query(None, description="Filter drugs with active deliveries (D=dodávky)"),
    form: str | None = Query(None, description="Dosage form filter (e.g. tableta, injekce)"),
    max_results: int = Query(10, ge=1, le=50, alias="maxResults"),
):
    """Search drugs with simple parameters — proxy builds the AI Search query."""
    try:
        search_client = request.app.state.search

        # Build OData filter server-side — LLM never sees OData syntax
        filters = _build_drug_filters(atc, holder, dispensing, doping, available, form)

        result = await search_client.search(
            INDEX,
            search=q,
            filter=filters,
            select=SEARCH_FIELDS,
            top=max_results,
            query_type="semantic",
            semantic_config=SEMANTIC_CONFIG,
        )

        drugs = []
        for doc in result.get("value", []):
            drugs.append(_format_drug_summary(doc))

        return {
            "total": result.get("@odata.count", len(drugs)),
            "drugs": drugs,
        }

    except SearchError as e:
        log.error("drug_search_error", status=e.status, detail=e.detail, query=q)
        return JSONResponse(
            status_code=502,
            content={"error": "Vyhledávání léků selhalo, zkuste to prosím znovu."},
        )
    except Exception as e:
        log.error("drug_search_unexpected", error=str(e), query=q)
        return JSONResponse(
            status_code=500,
            content={"error": "Interní chyba serveru."},
        )


@router.get("/{kod_sukl}")
async def get_drug_detail(request: Request, kod_sukl: str):
    """Get full drug detail by SÚKL code."""
    try:
        search_client = request.app.state.search

        # Pad to 7 digits (SUKL codes are zero-padded, numeric only)
        key = kod_sukl.strip().zfill(7)
        if not key.isdigit():
            return JSONResponse(
                status_code=400,
                content={"error": "Kód SÚKL musí být číslo."},
            )

        doc = await search_client.get_document(INDEX, key, select=DETAIL_FIELDS)

        if doc is None:
            return JSONResponse(
                status_code=404,
                content={"error": f"Léčivý přípravek s kódem {kod_sukl} nebyl nalezen."},
            )

        return _format_drug_detail(doc)

    except SearchError as e:
        log.error("drug_detail_error", status=e.status, kod=kod_sukl)
        return JSONResponse(
            status_code=502,
            content={"error": "Načtení detailu léku selhalo, zkuste to prosím znovu."},
        )
    except Exception as e:
        log.error("drug_detail_unexpected", error=str(e), kod=kod_sukl)
        return JSONResponse(
            status_code=500,
            content={"error": "Interní chyba serveru."},
        )


# ---------------------------------------------------------------------------
# Server-side query construction — the key reliability improvement
# ---------------------------------------------------------------------------


def _build_drug_filters(
    atc: str | None,
    holder: str | None,
    dispensing: str | None,
    doping: bool | None,
    available: bool | None,
    form: str | None,
) -> str | None:
    """Build OData $filter string from simple parameters.

    The LLM passes e.g. dispensing='otc' and we translate to
    vydej eq 'F' — no OData leaks to the model.
    """
    parts = []

    if atc:
        # ATC codes contain only letters and digits (e.g. N02BE01)
        atc_clean = atc.strip().upper()
        if not re.fullmatch(r"[A-Z0-9]+", atc_clean):
            pass  # ignore invalid ATC — no filter added
        elif len(atc_clean) < 7:
            # Full ATC codes are 7 chars (e.g. N02BE01) — shorter means prefix search
            parts.append(f"search.ismatch('{atc_clean}*', 'atc')")
        else:
            parts.append(f"atc eq '{atc_clean}'")

    if holder:
        # Use search.ismatch for partial holder name matching
        # Escape single quotes in holder name
        safe_holder = holder.replace("'", "''")
        parts.append(f"search.ismatch('{safe_holder}', 'drzitelNazev')")

    if dispensing:
        code = DISPENSING_MAP.get(dispensing.lower())
        if code:
            parts.append(f"vydej eq '{code}'")

    if doping is not None:
        parts.append(f"doping eq {str(doping).lower()}")

    if available is not None:
        if available:
            parts.append("dodavky eq '1'")
        else:
            parts.append("dodavky eq '0'")

    if form:
        safe_form = form.replace("'", "''")
        parts.append(f"search.ismatch('{safe_form}', 'formaNazev')")

    return " and ".join(parts) if parts else None


def _format_drug_summary(doc: dict) -> dict:
    """Format a drug document for search results — compact, no huge fields."""
    return {
        "kodSukl": doc.get("kodSukl", ""),
        "nazev": doc.get("nazev", ""),
        "sila": doc.get("sila", ""),
        "forma": doc.get("formaNazev", ""),
        "cesta": doc.get("cestaNazev", ""),
        "drzitel": doc.get("drzitelNazev", ""),
        "atc": doc.get("atc", ""),
        "atcNazev": doc.get("atcNazev", ""),
        "ucinneLatky": doc.get("ucinneLatky", ""),
        "vydej": doc.get("vydejNazev", ""),
        "indikace": doc.get("indikacniSkupinaNazev", ""),
        "dodavky": "ano" if doc.get("dodavky") == "1" else "ne",
        "doping": doc.get("doping", False),
    }


def _format_drug_detail(doc: dict) -> dict:
    """Format full drug detail — clean field names, human-readable values."""
    # Truncate composition only if extremely long (>5000 chars in detail)
    slozeni = doc.get("slozeni", "") or ""
    if len(slozeni) > 5000:
        slozeni = slozeni[:5000] + " … (zkráceno)"

    return {
        "kodSukl": doc.get("kodSukl", ""),
        "nazev": doc.get("nazev", ""),
        "doplnekNazvu": doc.get("doplnekNazvu", ""),
        "sila": doc.get("sila", ""),
        "forma": doc.get("formaNazev", ""),
        "baleni": doc.get("baleni", ""),
        "cesta": doc.get("cestaNazev", ""),
        "obal": doc.get("obalNazev", ""),
        "drzitel": doc.get("drzitelNazev", ""),
        "drzitelZeme": doc.get("drzitelZeme", ""),
        "regCislo": doc.get("regCislo", ""),
        "stavRegistrace": doc.get("stavRegistraceNazev", ""),
        "atc": doc.get("atc", ""),
        "atcNazev": doc.get("atcNazev", ""),
        "ucinneLatky": doc.get("ucinneLatky", ""),
        "vydej": doc.get("vydejNazev", ""),
        "dodavky": "ano" if doc.get("dodavky") == "1" else "ne",
        "indikace": doc.get("indikacniSkupinaNazev", ""),
        "doping": doc.get("doping", False),
        "ean": doc.get("ean", ""),
        "datumRegistrace": doc.get("datumRegistrace", ""),
        "platnostDo": doc.get("platnostDo", ""),
        "suklUrl": _build_detail_url(doc.get("kodSukl")),
        "slozeni": slozeni,
        "synonyma": doc.get("synonyma", ""),
    }


def _build_detail_url(kod_sukl: str | None) -> str | None:
    """Build URL to SUKL drug detail page (prehledy.sukl.cz)."""
    if not kod_sukl:
        return None
    return f"https://prehledy.sukl.cz/prehled_leciv.html#/leciva/{kod_sukl}"
