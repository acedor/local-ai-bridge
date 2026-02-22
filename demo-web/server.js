const http = require("http");
const { readFile } = require("fs/promises");
const path = require("path");

const host = "127.0.0.1";
const port = Number(process.env.DEMO_WEB_PORT || 3001);
const root = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function safePathFromUrl(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const cleaned = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(root, cleaned);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${host}:${port}`);
    const filePath = safePathFromUrl(requestUrl.pathname);

    if (!filePath.startsWith(root)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = contentTypes[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(port, host, () => {
  console.log(`Demo web running at http://${host}:${port}`);
});
