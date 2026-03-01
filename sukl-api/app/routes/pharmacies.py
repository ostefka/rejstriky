"""Pharmacy search and detail endpoints — all AI Search query logic is server-side."""

from fastapi import APIRouter, Request, Query
from fastapi.responses import JSONResponse

from ..logger import log
from ..search_client import SearchError

router = APIRouter()

INDEX = "sukl-pharmacies"
SEMANTIC_CONFIG = "sukl-pharmacies-semantic"

# Fields returned in search results
SEARCH_FIELDS = [
    "kodPracoviste", "nazev", "adresa", "mesto", "psc",
    "telefon", "typLekarnyNazev", "pohotovost",
    "zasilkovyProdej", "lekarnik",
]

# All fields for detail
DETAIL_FIELDS = [
    "kodPracoviste", "kodLekarny", "icz", "ico",
    "nazev", "ulice", "mesto", "psc", "adresa",
    "lekarnik", "www", "email", "telefon",
    "typLekarnyNazev", "zasilkovyProdej", "pohotovost",
    "pracovniDoba", "popisek",
]

# Pharmacy type mapping
PHARMACY_TYPE_MAP = {
    "pharmacy": "Z",      # Lékárna
    "hospital": "NO",     # Nemocniční
    "outlet": "V",        # Výdejna
}


@router.get("/search")
async def search_pharmacies(
    request: Request,
    q: str | None = Query(None, description="Free-text search (name, address, pharmacist)"),
    city: str | None = Query(None, description="Filter by city name"),
    emergency: bool | None = Query(None, description="Filter emergency/on-call pharmacies"),
    mail_order: bool | None = Query(None, alias="mailOrder", description="Filter mail-order pharmacies"),
    pharmacy_type: str | None = Query(None, alias="type", description="Type: pharmacy, hospital, outlet"),
    postal_code: str | None = Query(None, alias="postalCode", description="Filter by postal code"),
    max_results: int = Query(10, ge=1, le=50, alias="maxResults"),
):
    """Search pharmacies with simple parameters."""
    try:
        search_client = request.app.state.search

        # At least one search criterion required
        if not q and not city and not emergency and not mail_order and not pharmacy_type and not postal_code:
            return JSONResponse(
                status_code=400,
                content={"error": "Zadejte alespoň jeden parametr: q, city, emergency, mailOrder, type, nebo postalCode."},
            )

        search_text = q or "*"
        filters = _build_pharmacy_filters(city, emergency, mail_order, pharmacy_type, postal_code)

        result = await search_client.search(
            INDEX,
            search=search_text,
            filter=filters,
            select=SEARCH_FIELDS,
            top=max_results,
            query_type="semantic" if q else "simple",
            semantic_config=SEMANTIC_CONFIG,
        )

        pharmacies = []
        for doc in result.get("value", []):
            pharmacies.append(_format_pharmacy_summary(doc))

        return {
            "total": result.get("@odata.count", len(pharmacies)),
            "pharmacies": pharmacies,
        }

    except SearchError as e:
        log.error("pharmacy_search_error", status=e.status, detail=e.detail)
        return JSONResponse(
            status_code=502,
            content={"error": "Vyhledávání lékáren selhalo, zkuste to prosím znovu."},
        )
    except Exception as e:
        log.error("pharmacy_search_unexpected", error=str(e))
        return JSONResponse(
            status_code=500,
            content={"error": "Interní chyba serveru."},
        )


@router.get("/{kod_pracoviste}")
async def get_pharmacy_detail(request: Request, kod_pracoviste: str):
    """Get full pharmacy detail by workplace code."""
    try:
        search_client = request.app.state.search
        key = kod_pracoviste.strip()
        if not key.isdigit():
            return JSONResponse(
                status_code=400,
                content={"error": "Kód pracoviště musí být číslo."},
            )

        doc = await search_client.get_document(INDEX, key, select=DETAIL_FIELDS)

        if doc is None:
            return JSONResponse(
                status_code=404,
                content={"error": f"Lékárna s kódem {kod_pracoviste} nebyla nalezena."},
            )

        return _format_pharmacy_detail(doc)

    except SearchError as e:
        log.error("pharmacy_detail_error", status=e.status, kod=kod_pracoviste)
        return JSONResponse(
            status_code=502,
            content={"error": "Načtení detailu lékárny selhalo, zkuste to prosím znovu."},
        )
    except Exception as e:
        log.error("pharmacy_detail_unexpected", error=str(e), kod=kod_pracoviste)
        return JSONResponse(
            status_code=500,
            content={"error": "Interní chyba serveru."},
        )


# ---------------------------------------------------------------------------
# Server-side filter construction
# ---------------------------------------------------------------------------


def _build_pharmacy_filters(
    city: str | None,
    emergency: bool | None,
    mail_order: bool | None,
    pharmacy_type: str | None,
    postal_code: str | None,
) -> str | None:
    """Build OData filter from simple parameters."""
    parts = []

    if city:
        safe_city = city.replace("'", "''")
        parts.append(f"mesto eq '{safe_city}'")

    if emergency is not None:
        parts.append(f"pohotovost eq {str(emergency).lower()}")

    if mail_order is not None:
        parts.append(f"zasilkovyProdej eq {str(mail_order).lower()}")

    if pharmacy_type:
        code = PHARMACY_TYPE_MAP.get(pharmacy_type.lower())
        if code:
            parts.append(f"typLekarny eq '{code}'")

    if postal_code:
        safe_psc = postal_code.replace("'", "''").strip()
        parts.append(f"psc eq '{safe_psc}'")

    return " and ".join(parts) if parts else None


def _format_pharmacy_summary(doc: dict) -> dict:
    """Format pharmacy for search results."""
    return {
        "kodPracoviste": doc.get("kodPracoviste", ""),
        "nazev": doc.get("nazev", ""),
        "adresa": doc.get("adresa", ""),
        "mesto": doc.get("mesto", ""),
        "psc": doc.get("psc", ""),
        "telefon": doc.get("telefon", ""),
        "typ": doc.get("typLekarnyNazev", ""),
        "pohotovost": "ano" if doc.get("pohotovost") else "ne",
        "zasilkovyProdej": "ano" if doc.get("zasilkovyProdej") else "ne",
        "lekarnik": doc.get("lekarnik", ""),
    }


def _format_pharmacy_detail(doc: dict) -> dict:
    """Format full pharmacy detail."""
    return {
        "kodPracoviste": doc.get("kodPracoviste", ""),
        "kodLekarny": doc.get("kodLekarny", ""),
        "icz": doc.get("icz", ""),
        "ico": doc.get("ico", ""),
        "nazev": doc.get("nazev", ""),
        "ulice": doc.get("ulice", ""),
        "mesto": doc.get("mesto", ""),
        "psc": doc.get("psc", ""),
        "adresa": doc.get("adresa", ""),
        "lekarnik": doc.get("lekarnik", ""),
        "www": doc.get("www", ""),
        "email": doc.get("email", ""),
        "telefon": doc.get("telefon", ""),
        "typ": doc.get("typLekarnyNazev", ""),
        "pohotovost": "ano" if doc.get("pohotovost") else "ne",
        "zasilkovyProdej": "ano" if doc.get("zasilkovyProdej") else "ne",
        "pracovniDoba": doc.get("pracovniDoba", ""),
    }
