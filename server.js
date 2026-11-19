/* Servidor local para testar no computador:  node server.js  (lê o arquivo .env) */
"use strict";
const fs = require("fs"), path = require("path"), http = require("http");
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) {}
const { handle, diagnose } = require("./lib/loja");
const PUB = path.join(__dirname, "public"), PORT = +process.env.PORT || 3000;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.startsWith("/api/")) return handle(req, res);
  const fp = path.normalize(path.join(PUB, p.endsWith("/") ? p + "index.html" : p));
  if (!fp.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end() }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Página não encontrada.") }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(buf);
  });
}).listen(PORT, async () => {
  console.log(`DNight Store rodando em http://localhost:${PORT}  (admin: /admin.html)`);
  for (const l of await diagnose()) console.log(l);
});
