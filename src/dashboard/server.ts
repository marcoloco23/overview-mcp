import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { dashboardPort, SERVER_NAME, SERVER_VERSION } from "../config.js";
import type { Card, IngestPayload } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, "..", "web"); // dist/web after build

const MAX_CARDS = 200;
const MAX_IMAGES = 200;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

interface StoredImage {
  buf: Buffer;
  mimeType: string;
}

/** In-memory dashboard state — a bounded card feed + image cache + SSE clients. */
class DashboardState {
  cards: Card[] = [];
  images = new Map<string, StoredImage>();
  clients = new Set<ServerResponse>();

  addCard(payload: IngestPayload): Card {
    const { image, ...rest } = payload;
    const card: Card = { ...rest };
    if (image?.dataBase64) {
      this.images.set(card.id, {
        buf: Buffer.from(image.dataBase64, "base64"),
        mimeType: image.mimeType,
      });
      card.imageUrl = `/img/${card.id}`;
      this.evictImages();
    }
    this.cards.push(card);
    if (this.cards.length > MAX_CARDS) this.cards.shift();
    this.broadcast(card);
    return card;
  }

  private evictImages(): void {
    while (this.images.size > MAX_IMAGES) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.images.delete(oldest);
    }
  }

  broadcast(card: Card): void {
    const line = `data: ${JSON.stringify(card)}\n\n`;
    for (const res of this.clients) res.write(line);
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function readBody(req: IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Map "/" → index.html; strip query; prevent path traversal.
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
  let rel = clean === "/" || clean === "" ? "index.html" : clean.replace(/^\/+/, "");
  let filePath = join(WEB_ROOT, rel);

  if (!filePath.startsWith(WEB_ROOT)) {
    send(res, 403, "text/plain", "forbidden");
    return;
  }

  // SPA fallback: unknown path without a file extension → index.html.
  if (!existsSync(filePath)) {
    if (extname(rel) === "" && existsSync(join(WEB_ROOT, "index.html"))) {
      filePath = join(WEB_ROOT, "index.html");
      rel = "index.html";
    } else if (rel === "index.html") {
      send(res, 200, "text/html; charset=utf-8", FALLBACK_HTML);
      return;
    } else {
      send(res, 404, "text/plain", "not found");
      return;
    }
  }

  try {
    const data = await readFile(filePath);
    send(res, 200, MIME[extname(filePath)] ?? "application/octet-stream", data);
  } catch {
    send(res, 500, "text/plain", "read error");
  }
}

export function startDashboard(port = dashboardPort()): void {
  const state = new DashboardState();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS for local tooling.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === "/healthz") {
      send(res, 200, "application/json", JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (url === "/api/state") {
      send(res, 200, "application/json", JSON.stringify({ cards: state.cards }));
      return;
    }

    if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`retry: 3000\n\n`);
      for (const card of state.cards) res.write(`data: ${JSON.stringify(card)}\n\n`);
      const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
      state.clients.add(res);
      req.on("close", () => {
        clearInterval(ping);
        state.clients.delete(res);
      });
      return;
    }

    if (url.startsWith("/img/")) {
      const id = url.slice("/img/".length);
      const img = state.images.get(id);
      if (!img) {
        send(res, 404, "text/plain", "no such image");
        return;
      }
      send(res, 200, img.mimeType, img.buf);
      return;
    }

    if (url === "/ingest" && method === "POST") {
      readBody(req)
        .then((body) => {
          const payload = JSON.parse(body) as IngestPayload;
          if (!payload.id || !payload.type) throw new Error("card missing id/type");
          const card = state.addCard(payload);
          send(res, 200, "application/json", JSON.stringify({ ok: true, id: card.id }));
        })
        .catch((err: unknown) => {
          send(res, 400, "application/json", JSON.stringify({ ok: false, error: String(err) }));
        });
      return;
    }

    if (method === "GET") {
      void serveStatic(res, url);
      return;
    }

    send(res, 404, "text/plain", "not found");
  });

  server.listen(port, () => {
    process.stderr.write(
      `${SERVER_NAME} dashboard running at http://localhost:${port}  (open it in your browser)\n`,
    );
    if (!existsSync(join(WEB_ROOT, "index.html"))) {
      process.stderr.write(
        `  note: built UI not found at ${WEB_ROOT} — serving fallback shell. Run \`pnpm build\` for the full dashboard.\n`,
      );
    }
  });
}

/** Minimal shell served when the Vite build hasn't been produced yet. */
const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>overview-mcp</title>
<style>body{font:14px ui-monospace,monospace;background:#0b0f17;color:#cbd5e1;margin:0;padding:2rem}
#feed div{border:1px solid #1e293b;border-radius:8px;padding:.6rem .8rem;margin:.4rem 0}
h1{color:#38bdf8;font-size:1rem}</style></head><body>
<h1>overview-mcp dashboard (fallback shell)</h1>
<p>Run <code>pnpm build</code> for the full map UI. Live cards stream below.</p>
<div id="feed"></div>
<script>const f=document.getElementById('feed');const es=new EventSource('/events');
es.onmessage=e=>{const c=JSON.parse(e.data);const d=document.createElement('div');
d.textContent='['+c.type+'] '+c.title+(c.imageUrl?'  '+c.imageUrl:'');f.prepend(d);};</script>
</body></html>`;
