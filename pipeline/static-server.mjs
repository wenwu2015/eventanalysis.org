#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseLocale } from "../lib/language-routing.mjs";

const root = resolve(fileURLToPath(new URL("../dist/client/", import.meta.url)));
const port = Number(process.env.PORT || 3000);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

const server = (await import("node:http")).createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const locale = chooseLocale(request.headers["accept-language"]);
      response.writeHead(302, {
        "cache-control": "private, no-store",
        location: `/${locale}/${url.search}`,
        vary: "Accept-Language",
      });
      response.end();
      return;
    }
    let path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) throw new Error("Invalid path");
    try {
      if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    } catch {
      if (!extname(pathname)) path = resolve(path, "index.html");
    }
    await access(path);
    response.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    createReadStream(resolve(root, "404.html")).pipe(response);
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Static server running on http://127.0.0.1:${port}`));
