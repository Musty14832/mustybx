// Local server that mimics Vercel: static files from public/ with cleanUrls,
// /api/* serverless functions, and the rewrites in vercel.json. Test-only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function rewrite(p) {
  for (const r of vercel.rewrites || []) if (r.source === p) return r.destination;
  return p;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = rewrite(url.pathname);

  const m = /^\/api\/([a-z-]+)$/.exec(p);
  if (m) {
    const file = path.join(ROOT, 'api', `${m[1]}.js`);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    req.url = p + url.search;
    try {
      return await require(file)(req, res);
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      return res.end('function crashed');
    }
  }

  let rel = p === '/' ? '/index.html' : p;
  if (!path.extname(rel)) rel += '.html';
  const file = path.join(ROOT, vercel.outputDirectory || 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log(`app on http://localhost:${PORT}`));
