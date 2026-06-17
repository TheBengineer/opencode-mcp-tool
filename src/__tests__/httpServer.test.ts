import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createHttpServer } from "../transport/httpServer.js";

describe("HTTP Server Module", () => {
  let server: Server;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = new Server(
      { name: "test-server", version: "1.0.0" },
      { capabilities: {} }
    );

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
