"""SPC document search endpoint — hybrid AI search over full-text SPC documents."""

from fastapi import APIRouter, Request, Query
from fastapi.responses import JSONResponse

from ..logger import log
from ..search_client import SearchError

router = APIRouter()

INDEX = "sukl-documents"
SEMANTIC_CONFIG = "sukl-semantic"

# Fields returned (exclude the large vector field)
SELECT_FIELDS = ["chunk_id", "parent_id", "chunk", "title", "drug_codes"]


@router.get("/search")
async def search_documents(
    request: Request,
    q: str = Query(..., min_length=2, description="Search query — side effects, contraindications, interactions, dosing, etc."),
    max_results: int = Query(5, ge=1, le=10, alias="maxResults"),
):
    """Hybrid search over SPC document chunks (keyword + vector + semantic)."""
    try:
        search_client = request.app.state.search

        result = await search_client.hybrid_search(
            INDEX,
            search=q,
            select=SELECT_FIELDS,
            top=max_results,
            semantic_config=SEMANTIC_CONFIG,
            answers="extractive|count-3",
            captions="extractive|highlight-true",
        )

        # Format chunks
        chunks = []
        for doc in result.get("value", []):
            chunk_text = doc.get("chunk", "")
            # Truncate very long chunks for the response
            if len(chunk_text) > 2000:
                chunk_text = chunk_text[:2000] + "…"

            entry = {
                "title": doc.get("title", ""),
                "drugCodes": doc.get("drug_codes", ""),
                "content": chunk_text,
            }

            # Include semantic captions if available
            captions = doc.get("@search.captions")
            if captions:
                entry["highlight"] = captions[0].get("highlights") or captions[0].get("text", "")

            # Include reranker score
            score = doc.get("@search.rerankerScore")
            if score is not None:
                entry["relevance"] = round(score, 2)

            chunks.append(entry)

        # Include extractive answers if available
        response = {
            "total": result.get("@odata.count", len(chunks)),
            "results": chunks,
        }

        answers = result.get("@search.answers")
        if answers:
            response["answers"] = [
                {
                    "text": a.get("text", ""),
                    "highlight": a.get("highlights") or a.get("text", ""),
                    "confidence": round(a.get("score", 0), 2),
                }
                for a in answers
                if a.get("score", 0) > 0.5
            ]

        return response

    except SearchError as e:
        log.error("document_search_error", status=e.status, detail=e.detail, query=q)
        return JSONResponse(
            status_code=502,
            content={"error": "Vyhledávání v SPC dokumentech selhalo, zkuste to prosím znovu."},
        )
    except Exception as e:
        log.error("document_search_unexpected", error=str(e), query=q)
        return JSONResponse(
            status_code=500,
            content={"error": "Interní chyba serveru."},
        )
