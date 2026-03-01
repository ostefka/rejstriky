"""Azure AI Search client with retry logic, managed identity, and structured logging."""

import asyncio
from typing import Any

import httpx
from azure.identity import DefaultAzureCredential

from .logger import log

# Retry config
MAX_RETRIES = 3
RETRY_DELAYS = [1.0, 3.0, 8.0]  # exponential-ish backoff
TIMEOUT = 30.0
SEARCH_SCOPE = "https://search.azure.com/.default"

# Status codes worth retrying
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


class SearchClient:
    """Thin async wrapper around Azure AI Search REST API with retry.

    Uses managed identity (DefaultAzureCredential) for authentication.
    """

    def __init__(self, endpoint: str):
        self.endpoint = endpoint.rstrip("/")
        self._credential = DefaultAzureCredential()
        self._token: str | None = None
        self._client = httpx.AsyncClient(
            base_url=self.endpoint,
            headers={"Content-Type": "application/json"},
            timeout=TIMEOUT,
        )

    def _refresh_token(self):
        """Get or refresh the access token for Azure AI Search."""
        token = self._credential.get_token(SEARCH_SCOPE)
        self._token = token.token
        self._client.headers["Authorization"] = f"Bearer {self._token}"

    async def close(self):
        await self._client.aclose()
        self._credential.close()

    # ------------------------------------------------------------------
    # Core: POST search with retry
    # ------------------------------------------------------------------

    async def search(
        self,
        index: str,
        *,
        search: str = "*",
        filter: str | None = None,
        select: list[str] | None = None,
        top: int = 10,
        skip: int = 0,
        order_by: str | None = None,
        query_type: str = "semantic",
        semantic_config: str | None = None,
        count: bool = True,
        answers: str | None = None,
        captions: str | None = None,
    ) -> dict[str, Any]:
        """Execute a search query against an index with auto-retry."""

        body: dict[str, Any] = {
            "search": search,
            "queryType": query_type,
            "top": top,
            "skip": skip,
            "count": count,
        }
        if filter:
            body["filter"] = filter
        if select:
            body["select"] = ",".join(select)
        if order_by:
            body["orderby"] = order_by
        if semantic_config and query_type == "semantic":
            body["semanticConfiguration"] = semantic_config
        if answers:
            body["answers"] = answers
        if captions:
            body["captions"] = captions

        url = f"/indexes/{index}/docs/search?api-version=2024-07-01"
        self._refresh_token()
        return await self._post_with_retry(url, body, context=f"search:{index}")

    async def hybrid_search(
        self,
        index: str,
        *,
        search: str,
        vector_fields: str = "chunk_vector",
        vectorizer: str = "openai-vectorizer",
        select: list[str] | None = None,
        top: int = 5,
        semantic_config: str | None = None,
        answers: str | None = "extractive|count-3",
        captions: str | None = "extractive|highlight-true",
    ) -> dict[str, Any]:
        """Hybrid search: keyword + vector + semantic reranking."""

        body: dict[str, Any] = {
            "search": search,
            "queryType": "semantic",
            "top": top,
            "count": True,
            "vectorQueries": [
                {
                    "kind": "text",
                    "text": search,
                    "fields": vector_fields,
                    "k": top,
                }
            ],
        }
        if select:
            body["select"] = ",".join(select)
        if semantic_config:
            body["semanticConfiguration"] = semantic_config
        if answers:
            body["answers"] = answers
        if captions:
            body["captions"] = captions

        url = f"/indexes/{index}/docs/search?api-version=2024-07-01"
        self._refresh_token()
        return await self._post_with_retry(url, body, context=f"hybrid:{index}")

    # ------------------------------------------------------------------
    # Core: GET document by key
    # ------------------------------------------------------------------

    async def get_document(
        self,
        index: str,
        key: str,
        select: list[str] | None = None,
    ) -> dict[str, Any] | None:
        """Fetch a single document by key. Returns None if not found."""

        params = {"api-version": "2024-07-01"}
        if select:
            params["$select"] = ",".join(select)

        url = f"/indexes/{index}/docs('{key}')"
        self._refresh_token()
        return await self._get_with_retry(url, params, context=f"doc:{index}/{key}")

    # ------------------------------------------------------------------
    # Retry helpers
    # ------------------------------------------------------------------

    async def _post_with_retry(
        self, url: str, body: dict, context: str
    ) -> dict[str, Any]:
        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                start = asyncio.get_event_loop().time()
                resp = await self._client.post(url, json=body)
                duration_ms = round((asyncio.get_event_loop().time() - start) * 1000)

                log.info(
                    "upstream_call",
                    api="AzureSearch",
                    method="POST",
                    path=url.split("?")[0],
                    status=resp.status_code,
                    duration_ms=duration_ms,
                    attempt=attempt + 1,
                )

                if resp.status_code == 200:
                    return resp.json()

                if resp.status_code in RETRYABLE_STATUS:
                    last_error = SearchError(resp.status_code, resp.text)
                    log.warn(
                        "upstream_retry",
                        status=resp.status_code,
                        attempt=attempt + 1,
                        context=context,
                    )
                    await asyncio.sleep(RETRY_DELAYS[attempt])
                    continue

                # Non-retryable error
                raise SearchError(resp.status_code, resp.text)

            except httpx.TimeoutException:
                last_error = SearchError(504, "Request timeout")
                log.warn("upstream_timeout", attempt=attempt + 1, context=context)
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAYS[attempt])

            except httpx.HTTPError as e:
                last_error = SearchError(502, str(e))
                log.warn("upstream_network_error", error=str(e), attempt=attempt + 1)
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAYS[attempt])

        raise last_error or SearchError(500, "All retries exhausted")

    async def _get_with_retry(
        self, url: str, params: dict, context: str
    ) -> dict[str, Any] | None:
        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                start = asyncio.get_event_loop().time()
                resp = await self._client.get(url, params=params)
                duration_ms = round((asyncio.get_event_loop().time() - start) * 1000)

                log.info(
                    "upstream_call",
                    api="AzureSearch",
                    method="GET",
                    path=url.split("?")[0],
                    status=resp.status_code,
                    duration_ms=duration_ms,
                    attempt=attempt + 1,
                )

                if resp.status_code == 200:
                    return resp.json()
                if resp.status_code == 404:
                    return None

                if resp.status_code in RETRYABLE_STATUS:
                    last_error = SearchError(resp.status_code, resp.text)
                    log.warn(
                        "upstream_retry",
                        status=resp.status_code,
                        attempt=attempt + 1,
                        context=context,
                    )
                    await asyncio.sleep(RETRY_DELAYS[attempt])
                    continue

                raise SearchError(resp.status_code, resp.text)

            except httpx.TimeoutException:
                last_error = SearchError(504, "Request timeout")
                log.warn("upstream_timeout", attempt=attempt + 1, context=context)
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAYS[attempt])

            except httpx.HTTPError as e:
                last_error = SearchError(502, str(e))
                log.warn("upstream_network_error", error=str(e), attempt=attempt + 1)
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAYS[attempt])

        raise last_error or SearchError(500, "All retries exhausted")


class SearchError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(f"Search API error ({status}): {detail}")
