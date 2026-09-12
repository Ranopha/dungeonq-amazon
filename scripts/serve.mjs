#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
});

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store"
});

function isPublicPath(pathname) {
  return (
    pathname === "/index.html" ||
    /^\/assets\/[a-z0-9._-]+\.(?:css|mjs)$/u.test(pathname) ||
    /^\/src\/[a-z0-9._-]+\.mjs$/u.test(pathname) ||
    /^\/scenarios\/[a-z0-9._-]+\.json$/u.test(pathname) ||
    /^\/schemas\/[a-z0-9._-]+\.json$/u.test(pathname)
  );
}

function sendPlain(response, statusCode, message) {
  response.writeHead(statusCode, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

export function createStaticServer({ rootUrl = new URL("../public/", import.meta.url) } = {}) {
  const rootPath = rootUrl instanceof URL ? fileURLToPath(rootUrl) : resolve(rootUrl);
  const normalizedRoot = resolve(rootPath);

  return createServer(async (request, response) => {
    if (!new Set(["GET", "HEAD"]).has(request.method ?? "")) {
      sendPlain(response, 405, "Method not allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      sendPlain(response, 400, "Bad request");
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    if (pathname.includes("\0") || pathname.includes("\\") || !isPublicPath(pathname)) {
      sendPlain(response, 404, "Not found");
      return;
    }

    const filePath = resolve(normalizedRoot, `.${pathname}`);
    if (!filePath.startsWith(`${normalizedRoot}${sep}`)) {
      sendPlain(response, 404, "Not found");
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("NOT_FILE");
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
        "Content-Length": fileStat.size
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      sendPlain(response, 404, "Not found");
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const rootUrl = pathToFileURL(`${dirname(fileURLToPath(import.meta.url))}/../public/`);
  const parsedPort = Number.parseInt(process.env.DUNGEONQ_PORT ?? "4174", 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535 ? parsedPort : 4_174;
  const server = createStaticServer({ rootUrl });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`DungeonQ: http://127.0.0.1:${port}\n`);
  });
}
