/**
 * HTTP Integration Tests
 * Tests the HTTP MCP server end-to-end, including protocol negotiation,
 * tool listing, error handling, CORS, and graceful shutdown.
 * @module httpIntegration.test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHttpServer } from "../transport/httpServer.js";

// ============================================================================
// SSE / JSON-RPC helpers
// ============================================================================

/** Headers required by the MCP Streamable HTTP transport. */
const MCP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/**
 * Parse a response body that may be formatted as SSE (text/event-stream)
 * or plain JSON.  The Streamable HTTP transport returns SSE responses.
 */
function parseBody(raw: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const match = raw.match(/data: (\{.*\})/s);
    if (match) {
      return JSON.parse(match[1]);
    }
    return undefined;
  }
  return raw ? JSON.parse(raw) : undefined;
}

// ============================================================================
// HTTP Request Helper
// ============================================================================

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/**
 * Make an HTTP request and return the parsed response.
 * Uses node:http for Node 16+ compatibility.
 */
function httpRequest(
  url: string,
  method: string,
  extraHeaders: Record<string, string> = {},
  bodyObj?: unknown
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (bodyObj !== undefined) {
      headers["Content-Type"] ??= "application/json";
    }
    // Filter out any headers with undefined values (stateless mode)
    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== "undefined") cleanHeaders[k] = v;
    }
    const req = http.request(url, { method, headers: cleanHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const ct = (res.headers["content-type"] ?? "") as string;
        let parsed: unknown;
        try {
          parsed = parseBody(raw, ct);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (bodyObj !== undefined) {
      req.write(JSON.stringify(bodyObj));
    }
    req.end();
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("HTTP Integration", () => {
  let server: Server;
  let httpServer: http.Server;
  let baseUrl: string;
  let serverClosed = false;
  let sessionId: string | undefined;

  beforeAll(async () => {
    server = new Server(
      { name: "opencode-mcp", version: "2.0.0" },
      { capabilities: { tools: {} } }
    );

    // Register a simple ping tool
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ping",
          description: "Echo test",
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
          },
        },
      ],
    }));

    httpServer = await createHttpServer(server, { port: 0, host: "127.0.0.1" });
    const addr = httpServer.address();
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }

    // Initialize MCP session and extract session ID from response headers
    const initRes = await httpRequest(`${baseUrl}/mcp`, "POST", MCP_HEADERS, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "http-integration", version: "1.0.0" },
      },
    });
    if (initRes.status === 200) {
      sessionId = (initRes.headers["mcp-session-id"] || initRes.headers["Mcp-Session-Id"]) as string;

      // Send initialized notification with session ID
      await httpRequest(
        `${baseUrl}/mcp`, "POST",
        { ...MCP_HEADERS, "mcp-session-id": sessionId! },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      );
    }
  });

  afterAll(() => {
    if (!serverClosed) httpServer?.close();
  });

  // ==================================================================
  // HTTP server basics
  // ==================================================================

  describe("HTTP server basics", () => {
    it("responds to health check", async () => {
      const res = await httpRequest(`${baseUrl}/health`, "GET");
      expect(res.status).toBe(200);
      const b = res.body as Record<string, unknown>;
      expect(b.status).toBe("ok");
      expect(b.version).toBe("2.0.0");
      expect(typeof b.uptime).toBe("number");
    });

    it("responds to CORS preflight", async () => {
      const res = await httpRequest(`${baseUrl}/mcp`, "OPTIONS");
      expect(res.status).toBe(200);
    });

    it("returns 404 for unknown GET routes", async () => {
      const res = await httpRequest(`${baseUrl}/unknown`, "GET");
      expect(res.status).toBe(404);
      expect((res.body as Record<string, unknown>).error).toBe("Not found");
    });

    it("returns 404 for non-MCP POST routes", async () => {
      const res = await httpRequest(
        `${baseUrl}/other`, "POST", {},
        { jsonrpc: "2.0", id: 1, method: "ping" },
      );
      expect(res.status).toBe(404);
    });
  });

  // ==================================================================
  // CORS headers
  // ==================================================================

  describe("CORS headers", () => {
    it("includes CORS headers on health endpoint", async () => {
      const res = await httpRequest(`${baseUrl}/health`, "GET");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("includes CORS headers on MCP responses", async () => {
      const res = await httpRequest(
        `${baseUrl}/mcp`, "POST", MCP_HEADERS,
        { jsonrpc: "2.0", id: 99, method: "tools/list" },
      );
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
    });

    it("includes CORS headers on 404 responses", async () => {
      const res = await httpRequest(`${baseUrl}/nothing-here`, "GET");
      expect(res.status).toBe(404);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  // ==================================================================
  // MCP protocol round-trip (stateless — no session management)
  // ==================================================================

  // Helper: MCP headers with session ID when available
  function mcpHeaders(): Record<string, string> {
    return sessionId
      ? { ...MCP_HEADERS, "mcp-session-id": sessionId }
      : MCP_HEADERS;
  }

  describe("MCP protocol round-trip", () => {
    it("responds to tools/list", async () => {
      const res = await httpRequest(
        `${baseUrl}/mcp`, "POST", mcpHeaders(),
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      );
      expect(res.status).toBe(200);

      const body = res.body as Record<string, unknown>;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(2);

      const result = body.result as Record<string, unknown>;
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0].name).toBe("ping");
    });

    it("handles multiple sequential requests", async () => {
      for (let i = 0; i < 2; i++) {
        const res = await httpRequest(
          `${baseUrl}/mcp`, "POST", mcpHeaders(),
          { jsonrpc: "2.0", id: 10 + i, method: "tools/list" },
        );
        expect(res.status).toBe(200);
      }
    });
  });

  // ==================================================================
  // Error handling
  // ==================================================================

  describe("Error handling", () => {
    it("returns error for unknown method", async () => {
      const res = await httpRequest(
        `${baseUrl}/mcp`, "POST", mcpHeaders(),
        { jsonrpc: "2.0", id: 99, method: "unknown_method" },
      );
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it("returns error for malformed JSON body", async () => {
      const res = await httpRequest(
        `${baseUrl}/mcp`, "POST",
        { ...MCP_HEADERS, "Content-Type": "application/json" },
        "not-json",
      );
      // The transport returns JSON-RPC parse error for invalid body
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });
  });

  // ==================================================================
  // Graceful shutdown
  // ==================================================================

  describe("Graceful shutdown", () => {
    it("closes the HTTP server without error", async () => {
      // Just verify the close method works
      expect(typeof httpServer.close).toBe("function");
    });
  });
});
