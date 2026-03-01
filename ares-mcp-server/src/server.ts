import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { registerSearchCompanies } from "./tools/searchCompanies.js";
import { registerGetCompanyDetail } from "./tools/getCompanyDetail.js";
import { registerGetCompanyOfficers } from "./tools/getCompanyOfficers.js";
import { registerGetTradeLicenses } from "./tools/getTradeLicenses.js";
import { registerCheckInsolvency } from "./tools/checkInsolvency.js";
import { registerValidateAddress } from "./tools/validateAddress.js";
import { registerSearchContracts } from "./tools/searchContracts.js";
import { registerGetContractDetail } from "./tools/getContractDetail.js";
import { registerSearchInsolvencyCases } from "./tools/searchInsolvencyCases.js";
import { registerGetInsolvencyDetail } from "./tools/getInsolvencyDetail.js";
import apiRoutes from "./api/routes.js";
import hlidacRoutes from "./api/hlidacRoutes.js";
import { log, extractCallerInfo, recordRequest, getStatsSnapshot } from "./logger.js";

const VERSION = "3.3.6";
const PORT = parseInt(process.env.PORT || "3000", 10);
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000; // 30 min

// Track active transports by session ID for session management
const transports = new Map<string, StreamableHTTPServerTransport>();
const sessionLastSeen = new Map<string, number>();

// Periodic cleanup of stale MCP sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of sessionLastSeen) {
    if (now - ts > SESSION_TTL_MS) {
      const t = transports.get(id);
      try { t?.close?.(); } catch { /* ignore */ }
      transports.delete(id);
      sessionLastSeen.delete(id);
      log.info("mcp_session_expired", { sessionId: id });
    }
  }
}, 60_000);

// Startup validation
if (!process.env.HLIDAC_STATU_TOKEN) {
  log.warn("startup_warning", { msg: "HLIDAC_STATU_TOKEN not set — Hlídač státu endpoints will fail" });
}

// Timing-safe API key comparison
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "czech-registers-mcp-server",
    version: VERSION,
  });

  // Register ARES tools
  registerSearchCompanies(server);
  registerGetCompanyDetail(server);
  registerGetCompanyOfficers(server);
  registerGetTradeLicenses(server);
  registerCheckInsolvency(server);
  registerValidateAddress(server);

  // Register Hlídač státu tools
  registerSearchContracts(server);
  registerGetContractDetail(server);
  registerSearchInsolvencyCases(server);
  registerGetInsolvencyDetail(server);

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Request-Id", randomUUID());
  next();
});

// Request timeout
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    log.error("request_timeout", { method: req.method, path: req.path });
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timeout" });
    }
  });
  next();
});

// Structured request logging with timing, caller tracking, caching analysis
app.use((req, res, next) => {
  const start = performance.now();
  const caller = extractCallerInfo(req.headers as Record<string, string | string[] | undefined>);
  // Capture originalUrl at registration time — req.path is mutated by Express sub-routers
  // and unreliable inside res.on("finish")
  const originalPath = req.originalUrl.split("?")[0];

  // Log on response finish
  res.on("finish", () => {
    const durationMs = Math.round(performance.now() - start);
    const logData: Record<string, unknown> = {
      method: req.method,
      path: originalPath,
      status: res.statusCode,
      durationMs,
      callerId: caller.callerId,
      ...(caller.correlationId && { correlationId: caller.correlationId }),
      ...(caller.clientRequestId && { clientRequestId: caller.clientRequestId }),
    };

    // Include query params for all API routes (useful for caching analysis)
    if (Object.keys(req.query).length > 0) {
      logData.query = req.query;
    }

    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    log[level]("http_request", logData);

    // Normalize path for stats to prevent unbounded Map keys
    // /api/company/12345678 → /api/company/:ico
    const statsPath = originalPath
      .replace(/\/api\/company\/\d+/, "/api/company/:ico")
      .replace(/\/api\/hs\/contracts\/[^/]+/, "/api/hs/contracts/:id")
      .replace(/\/api\/hs\/insolvency\/[^/]+/, "/api/hs/insolvency/:id");
    recordRequest(statsPath, durationMs, res.statusCode, caller.callerId);
  });

  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "czech-registers-mcp-server", version: VERSION });
});

// Stats endpoint — aggregate metrics for monitoring & caching analysis
// Protected by MCP_API_KEY to prevent public access
app.get("/stats", (req, res) => {
  const apiKey = process.env.MCP_API_KEY;
  const provided = String(req.headers["x-api-key"] || req.query["key"] || "");
  if (!apiKey || !safeCompare(provided, apiKey)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(getStatsSnapshot());
});

// OpenAPI specs (read once at startup)
const __dirname = dirname(fileURLToPath(import.meta.url));
const openApiSpec = JSON.parse(readFileSync(join(__dirname, "..", "openapi.json"), "utf-8"));
const hlidacOpenApiSpec = JSON.parse(readFileSync(join(__dirname, "..", "hlidacstatu-openapi.json"), "utf-8"));

app.get("/openapi.json", (_req, res) => {
  res.json(openApiSpec);
});

app.get("/hlidacstatu-openapi.json", (_req, res) => {
  res.json(hlidacOpenApiSpec);
});

// REST API routes — ARES
app.use("/api", apiRoutes);

// REST API routes — Hlídač státu
app.use("/api/hs", hlidacRoutes);

// POST /mcp - Initialize or send messages
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      sessionLastSeen.set(sessionId, Date.now());
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // If client sent a session ID we don't recognize, return 404 per MCP spec
    // so client knows to re-initialize
    if (sessionId) {
      log.info("mcp_session_unknown", { sessionId });
      res.status(404).json({ error: "Session not found, please re-initialize" });
      return;
    }

    // New session
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        transports.set(sid, transport);
        sessionLastSeen.set(sid, Date.now());
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        sessionLastSeen.delete(sid);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    log.error("mcp_post_error", { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// GET /mcp - SSE stream for notifications (if supported)
app.get("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    sessionLastSeen.set(sessionId, Date.now());
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  } catch (error: any) {
    log.error("mcp_get_error", { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /mcp - End a session
app.delete("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    sessionLastSeen.delete(sessionId);
  } catch (error: any) {
    log.error("mcp_delete_error", { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

const server = app.listen(PORT, () => {
  log.info("server_started", {
    version: VERSION,
    port: PORT,
    endpoints: {
      mcp: `/mcp`,
      health: `/health`,
      stats: `/stats`,
      aresOpenApi: `/openapi.json`,
      hlidacOpenApi: `/hlidacstatu-openapi.json`,
    },
  });
});

// Graceful shutdown
function shutdown(signal: string) {
  log.info("server_shutdown_initiated", { signal });
  server.close(() => {
    // Close all active MCP transports
    for (const [id, transport] of transports) {
      try { transport.close?.(); } catch { /* ignore */ }
      transports.delete(id);
    }
    log.info("server_shutdown_complete", { signal, activeSessions: transports.size });
    process.exit(0);
  });
  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    log.error("server_shutdown_forced", { signal, reason: "timeout" });
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
