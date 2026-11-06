// Google simulado para las pruebas (puerto 8799, el de GOOGLE_TOKEN_URL, DRIVE_API_URL y GOOGLE_USERINFO_URL en .dev.vars;
// ver test/gmail-dev-vars.mjs): el token de la cuenta de servicio, lo justo de Drive (carpetas, subida reanudable, bajada)
// y la foto del perfil de cada usuario (por el perfil o por Drive). `perfil` cambia lo que contesta: sin el permiso de
// perfil o de Drive en la delegación, o mails que Google no conoce.
import http from 'node:http';

export async function googleFalso() {
  const drive = { carpetas: [], archivos: [], tokens: [], subidas: new Map() };
  const perfil = { negar: new Set(), sinCuenta: new Set() };
  const PERFIL = 'https://www.googleapis.com/auth/userinfo.profile';
  const DRIVE = 'https://www.googleapis.com/auth/drive';
  const quien = (req) => (req.headers.authorization ?? '').split(':')[1];
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
        if ((claims.scope === PERFIL && perfil.negar.has('perfil')) || (claims.scope === DRIVE && perfil.negar.has('drive'))) {
          return send({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.' }, 401);
        }
        if (perfil.sinCuenta.has(claims.sub)) return send({ error: 'invalid_grant', error_description: 'Invalid email or User ID' }, 400);
        return send({ access_token: `tok:${claims.sub}:${claims.scope}`, expires_in: 3600 });
      }
      // La misma foto por las dos formas (cada una con su tamaño): el CRM la deja en 96 px.
      if (url.pathname === '/oauth2/v3/userinfo') return send({ sub: '1', picture: `https://lh3.googleusercontent.com/a/foto-${quien(req)}=s96-c` });
      if (url.pathname === '/drive/v3/about') return send({ user: { photoLink: `https://lh3.googleusercontent.com/a/foto-${quien(req)}=s64` } });
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
  return { drive, perfil, cerrar: () => new Promise((r) => server.close(r)) };
}
