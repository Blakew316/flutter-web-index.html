// Zero-dependency local server mirroring firebase.json rewrites: node scripts/dev-server.js [port]
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "public");
const port = Number(process.argv[2]) || 8080;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const spa = new Set(["/main", "/upload", "/callback"]);
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/" || spa.has(p.replace(/\/$/, ""))) p = "/index.html";
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(root, "404.html")));
  }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}`));
