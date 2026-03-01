"""SÚKL API Proxy — reliable REST API over Azure AI Search indexes."""

import hmac
import os
import time
import uuid
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from .routes import drugs, pharmacies, documents
from .search_client import SearchClient
from .logger import setup_logging, log

VERSION = "1.6.1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize search client on startup, close on shutdown."""
    setup_logging()
    app.state.search = SearchClient(
        endpoint=os.environ["SEARCH_ENDPOINT"],
    )
    app.state.proxy_api_key = os.environ.get("PROXY_API_KEY", "")
    log.info("server_started", version=VERSION, endpoint=os.environ["SEARCH_ENDPOINT"])
    yield
    await app.state.search.close()
    log.info("server_stopped")


app = FastAPI(title="SÚKL API", version=VERSION, lifespan=lifespan)


# ---------------------------------------------------------------------------
# Middleware — structured request logging + security headers
# ---------------------------------------------------------------------------


@app.middleware("http")
async def request_middleware(request: Request, call_next):
    # API key validation (skip for health endpoint)
    if request.url.path != "/health":
        expected_key = request.app.state.proxy_api_key
        if expected_key:
            provided_key = request.headers.get("api-key") or request.query_params.get("api_key") or ""
            if not hmac.compare_digest(provided_key, expected_key):
                return JSONResponse(status_code=401, content={"error": "Invalid or missing API key."})

    request_id = str(uuid.uuid4())
    start = time.perf_counter()

    # Caller tracking (M365 Copilot headers)
    caller = (
        request.headers.get("x-forwarded-for", "")
        .split(",")[0]
        .strip()
        or "unknown"
    )
    correlation_id = request.headers.get("x-ms-correlation-id")

    response: Response = await call_next(request)

    duration_ms = round((time.perf_counter() - start) * 1000)
    response.headers["X-Request-Id"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"

    log.info(
        "http_request",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        duration_ms=duration_ms,
        caller=caller,
        correlation_id=correlation_id,
        query=str(request.query_params) if request.query_params else None,
    )

    return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


app.include_router(drugs.router, prefix="/api/drugs", tags=["drugs"])
app.include_router(pharmacies.router, prefix="/api/pharmacies", tags=["pharmacies"])
app.include_router(documents.router, prefix="/api/documents", tags=["documents"])


@app.get("/health")
async def health():
    return {"status": "ok", "server": "sukl-api", "version": VERSION}
