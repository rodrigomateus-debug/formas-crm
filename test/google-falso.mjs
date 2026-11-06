// Google simulado para las pruebas (puerto 8799, el de GOOGLE_TOKEN_URL y DRIVE_API_URL en .dev.vars; ver
// test/gmail-dev-vars.mjs): el token de la cuenta de servicio y lo justo de Drive (carpetas, subida reanudable, bajada).
import http from 'node:http';

export async function googleFalso() {
  const drive = { carpetas: [], archivos: [], tokens: [], subidas: new Map() };
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (b, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(b)); };
      if (url.pathname === '/token') {
        const assertion = new URLSearchParams(body.toString()).get('assertion') ?? '';
        const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString() || '{}');
        drive.tokens.push({ sub: claims.sub, scope: claims.scope });
        return send({ access_token: `tok:${claims.sub}:${claims.scope}`, expires_in: 3600 });
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const padre = q.match(/'([^']+)' in parents/)?.[1];
        const nombre = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\'/g, "'");
        return send({ files: drive.carpetas.filter((c) => c.parent === padre && c.name === nombre).map((c) => ({ id: c.id })) });
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
        const m = JSON.parse(body.toString());
        const c = { id: `carpeta${++n}`, name: m.name, parent: m.parents[0] };
        drive.carpetas.push(c);
        return send({ id: c.id });
      }
      if (url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') {
        const id = `subida${++n}`;
        drive.subidas.set(id, { ...JSON.parse(body.toString()), auth: req.headers.authorization });
        return send({}, 200, { location: `http://localhost:8799/subidas/${id}` });
      }
      if (url.pathname.startsWith('/subidas/') && req.method === 'PUT') {
        const s = drive.subidas.get(url.pathname.slice(9));
        const f = { id: `archivo${++n}`, name: s.name, parent: s.parents[0], mime: req.headers['content-type'], data: body, auth: s.auth };
        drive.archivos.push(f);
        return send({ id: f.id, webViewLink: `https://drive.google.com/file/d/${f.id}/view` });
      }
      const m = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (m && url.searchParams.get('alt') !== 'media') {
        const id = decodeURIComponent(m[1]);
        const c = drive.carpetas.find((x) => x.id === id) ?? (id.startsWith('0A') || id.startsWith('1') ? { name: 'Bocetos de producción' } : null);
        return c ? send({ name: c.name, driveId: id.startsWith('0A') ? id : undefined, capabilities: { canAddChildren: true } }) : send({ error: 'no está' }, 404);
      }
      if (m && url.searchParams.get('alt') === 'media') {
        const f = drive.archivos.find((x) => x.id === decodeURIComponent(m[1]));
        if (!f) return send({ error: 'no está' }, 404);
        res.writeHead(200, { 'content-type': f.mime ?? 'application/octet-stream' });
        return res.end(f.data);
      }
      send({ error: 'no simulado' }, 404);
    });
  });
  await new Promise((r) => server.listen(8799, r));
  return { drive, cerrar: () => new Promise((r) => server.close(r)) };
}
