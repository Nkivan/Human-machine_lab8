import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const text = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
};

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;

export function createStaticHandler(rootDir: string): StaticHandler {
  const root = path.resolve(rootDir);
  return async function serve(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "method not allowed");
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return text(res, 400, "bad path");
    }
    if (rel.includes("\0")) return text(res, 400, "bad path");
    if (rel.endsWith("/")) rel += "index.html";

    const full = path.join(root, rel); // path.join normalizes "../"
    if (full !== root && !full.startsWith(root + path.sep)) return text(res, 403, "forbidden"); // path traversal guard

    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return text(res, 404, "not found (is the client built? npm run build)");

    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await pipeline(createReadStream(full), res).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err; // client went away: not an error
    });
  };
}
