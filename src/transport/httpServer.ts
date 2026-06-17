import http, { ServerResponse } from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { HTTP } from "../constants.js";

export interface HttpOptions {
  port?: number;
  host?: string;
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function applyCorsHeaders(res: ServerResponse): void {
  const headers = HTTP.CORS_HEADERS;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  applyCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function createHttpServer(
  server: Server,
  options: HttpOptions = {}
): Promise<http.Server> {
  // Stateful Streamable HTTP transport with per-request session management.
  // Each POST to /mcp gets its own session. The session ID is returned
  // in the `Mcp-Session-Id` header and must be included in subsequent requests.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  const startTime = Date.now();

  await server.connect(transport);

  transport.onclose = () => {};

  const httpServer = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`
      );
      const path = url.pathname;

      if (method === "OPTIONS") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && path === "/health") {
        const uptime = Date.now() - startTime;
        sendJson(res, 200, {
          status: "ok",
          version: "2.0.0",
          uptime,
          uptimeHuman: formatUptime(uptime),
        });
        return;
      }

      if (path === "/mcp") {
        applyCorsHeaders(res);

        if (method === "POST") {
          await transport.handleRequest(req, res);
        } else if (method === "GET" || method === "DELETE") {
          await transport.handleRequest(req, res);
        } else {
          sendJson(res, 404, {
            error: "Not found",
            code: "NOT_FOUND",
          });
        }
        return;
      }

      sendJson(res, 404, {
        error: "Not found",
        code: "NOT_FOUND",
      });
    } catch {
      if (res.headersSent) return;
      sendJson(res, 500, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      });
    }
  });

  const host = options.host ?? HTTP.DEFAULT_HOST;
  const port = options.port ?? HTTP.DEFAULT_PORT;

  return new Promise<http.Server>((resolve, reject) => {
    httpServer.listen(port, host, () => {
      resolve(httpServer);
    });
    httpServer.once("error", (err) => {
      reject(err);
    });
  });
}
