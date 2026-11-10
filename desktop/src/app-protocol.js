/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Protocole `app://cartes-ign/…` : sert les fichiers de la build web.
 * Gère les types MIME (dont .mjs pour le worker MapLibre et .pbf pour les
 * tuiles/glyphes de secours) et les requêtes Range (PMTiles locaux éventuels).
 */
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const APP_SCHEME = "app";
const APP_HOST = "cartes-ign";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pbf": "application/x-protobuf",
  ".pmtiles": "application/octet-stream",
  ".wasm": "application/wasm",
};

function notFound() {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}

function registerAppProtocol(protocol, webRoot) {
  const root = path.resolve(webRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return notFound();

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const filePath = path.resolve(root, `.${pathname}`);
    // Empêche de sortir du dossier de la build web
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return notFound();

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return notFound();
    }
    if (!stat.isFile()) return notFound();

    const headers = {
      "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
    };

    const range = request.headers.get("range");
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] !== "" || match[2] !== "")) {
      let start, end;
      if (match[1] === "") {
        // bytes=-N : N derniers octets
        start = Math.max(0, stat.size - Number(match[2]));
        end = stat.size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === "" ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
      }
      if (start > end || start >= stat.size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${stat.size}`,
        },
      });
    }

    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: { ...headers, "content-length": String(stat.size) },
    });
  });
}

module.exports = { registerAppProtocol, APP_SCHEME, APP_HOST };
