import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createHttpServer } from "../transport/httpServer.js";

describe("HTTP Server Module", () => {
  let server: Server;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Create a minimal MCP Server instance (no handlers needed for transport tests)
    server = new Server(
      { name: "test-server", version: "1.0.0" },
      { capabilities: {} }
    );

    // Start on port 0 (OS-assigned random port)
    httpServer = await createHttpServer(server, {
      port: 0,
      host: "127.0.0.1",
    });

    const addr = httpServer.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } else {
      throw new Error("Failed to determine server port");
    }
  });

  afterAll(() => {
    httpServer?.close();
  });

  describe("CORS", () => {
    it("returns CORS headers on OPTIONS preflight", async () => {
      const res = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
      expect(res.headers.get("access-control-allow-headers")).toContain(
        "Content-Type"
      );
    });
  });

  describe("POST /mcp — body parsing", () => {
    it("returns 400 for empty POST body", async () => {
      // The transport requires both Content-Type and Accept headers
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: "",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      // Transport returns a JSON-RPC parse error for empty body
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32700);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("PARSE_ERROR");
    });

    it("returns 413 for oversized POST body", async () => {
      const oversized = "x".repeat(5 * 1024 * 1024); // 5MB > 4MB limit
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized,
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("Health endpoint", () => {
    it("returns 200 on health endpoint", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBe("2.0.0");
      expect(body.uptime).toBeDefined();
      expect(body.uptimeHuman).toBeDefined();
    });
  });

  describe("Unknown routes", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });
  });
});
