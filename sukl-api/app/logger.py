"""Structured JSON logger for production troubleshooting & KQL dashboards."""

import json
import logging
import sys
from datetime import datetime, timezone


class JSONFormatter(logging.Formatter):
    """Emit one JSON object per log line — compatible with Container Apps log ingestion."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
        }
        # Merge extra fields passed via log.info("msg", extra={...})
        if hasattr(record, "_extra"):
            entry.update(record._extra)
        return json.dumps(entry, ensure_ascii=False, default=str)


class StructuredLogger:
    """Convenience wrapper that attaches extra kwargs to log records."""

    def __init__(self, name: str = "sukl-api"):
        self._logger = logging.getLogger(name)

    def _log(self, level: int, msg: str, **kwargs):
        record = self._logger.makeRecord(
            self._logger.name,
            level,
            "(unknown)",
            0,
            msg,
            (),
            None,
        )
        record._extra = {k: v for k, v in kwargs.items() if v is not None}  # type: ignore[attr-defined]
        self._logger.handle(record)

    def info(self, msg: str, **kwargs):
        self._log(logging.INFO, msg, **kwargs)

    def warn(self, msg: str, **kwargs):
        self._log(logging.WARNING, msg, **kwargs)

    def error(self, msg: str, **kwargs):
        self._log(logging.ERROR, msg, **kwargs)

    def debug(self, msg: str, **kwargs):
        self._log(logging.DEBUG, msg, **kwargs)


log = StructuredLogger()


def setup_logging():
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JSONFormatter())
    logger = logging.getLogger("sukl-api")
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    # Silence noisy libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
