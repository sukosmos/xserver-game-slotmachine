import { readFileSync } from 'node:fs';

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/client.js', ['client.js', 'text/javascript']], ['/format.js', ['format.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']], ['/icons.svg', ['icons.svg', 'image/svg+xml']],
]);
export function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method) || !assets.has(pathname)) return false;
  const [name, mime] = assets.get(pathname);
  const content = readFileSync(new URL(`../../web/${name}`, import.meta.url));
  res.writeHead(200, {
    'Content-Type': `${mime}; charset=utf-8`, 'Content-Length': content.length, 'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(req.method === 'HEAD' ? undefined : content);
  return true;
}
