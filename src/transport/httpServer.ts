import http, { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { HTTP } from "../constants.js";

/**
 * Options for creating the HTTP MCP server.
 */
export interface HttpOptions {
  /** Port to listen on (default: 3100) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Custom session ID generator (default: crypto.randomUUID) */
  sessionIdGenerator?: () => string;
}

/**
 * Formats uptime in milliseconds to a human-readable string.
 */
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

/**
 * Buffers and parses an HTTP request body as JSON.
 * Respects the specified max size limit.
 */
function parseBody(req: IncomingMessage, maxSize: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let limitExceeded = false;

    req.on("data", (chunk: Buffer) => {
      if (limitExceeded) return;
      size += chunk.length;
      if (size > maxSize) {
        limitExceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (limitExceeded) {
        reject(new Error("Body too large"));
        return;
      }
      const body = Buffer.concat(chunks).toString();
      if (!body) {
        resolve(undefined);
      } else {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new SyntaxError("Invalid JSON body"));
        }
      }
    });

    req.on("error", reject);
  });
}

/**
 * Applies CORS headers to a ServerResponse.
 */
function applyCorsHeaders(res: ServerResponse): void {
  const headers = HTTP.CORS_HEADERS;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

/**
 * Sends a JSON response with CORS headers.
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  applyCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Creates a Node.js HTTP server with MCP Streamable HTTP transport support.
 *
 * The returned server instance should be used for graceful shutdown
 * (call `httpServer.close()`).
 *
 * @param server - The MCP Server instance (already configured with tool/prompt handlers)
 * @param options - Server configuration options
 * @returns A Promise resolving to the created http.Server
 */
export async function createHttpServer(
  server: Server,
  options: HttpOptions = {}
): Promise<http.Server> {
  const sessionIdGenerator =
    options.sessionIdGenerator ?? (() => crypto.randomUUID());

  // Create the stateful Streamable HTTP transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator,
  });

  const startTime = Date.now();

  // Connect the MCP server to the transport (one-time, for the lifetime of the server).
  // This also calls transport.start() internally.
  await server.connect(transport);

  // Optional cleanup on transport close
  transport.onclose = () => {
    // Resources cleaned up on transport close
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`
      );
      const path = url.pathname;

      // ----- CORS preflight -----
      if (method === "OPTIONS") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ----- Health endpoint -----
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

      // ----- MCP endpoint -----
      if (path === "/mcp") {
        // Apply CORS headers before transport handles the response
        applyCorsHeaders(res);

        if (method === "POST") {
          try {
            const body = await parseBody(req, HTTP.MAX_BODY_SIZE);
            await transport.handleRequest(req, res, body);
          } catch (err) {
            if (err instanceof SyntaxError) {
              sendJson(res, 400, {
                error: "Invalid JSON body",
                code: "PARSE_ERROR",
              });
            } else if (
              err instanceof Error &&
              err.message === "Body too large"
            ) {
              sendJson(res, 413, {
                error: "Request body too large",
                code: "PAYLOAD_TOO_LARGE",
              });
            } else {
              throw err;
            }
          }
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

      // ----- Unknown route -----
      sendJson(res, 404, {
        error: "Not found",
        code: "NOT_FOUND",
      });
    } catch {
      sendJson(res, 500, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      });
    }
  });

  // Start listening on the configured port
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
