import type { Env } from './env';

// Archivos fuera de la base (auditoría del 19/11/2026, docs/AUDITORIA.md): las fotos de los remitos, los adjuntos del chat
// y los PDF de las facturas iban como BLOB dentro de D1, que tiene un tope de 10 GB por base (a este ritmo, unos 2 años) y,
// como la foto va en el medio de la fila, cualquier consulta que leía una columna de más pasaba por la foto. Ahora van al
// bucket R2 `formas-crm-archivos` (binding ARCHIVOS, wrangler.jsonc) y en la base queda solo la clave (`r2_key`).
//
// Sin el binding (desarrollo sin R2, o una publicación que no pudo crear el bucket: scripts/ensure-r2.mjs) todo sigue como
// antes, en la base. Lo que ya estaba en la base pasa a R2 de a poco, en el cron (moverAR2).

const uid = () => crypto.randomUUID();

// Sube un archivo y devuelve su clave; sin R2, null (el que llama lo guarda en la base, como antes).
export async function subirArchivo(env: Pick<Env, 'ARCHIVOS'>, carpeta: 'remitos' | 'adjuntos' | 'facturas', bytes: ArrayBuffer | Uint8Array, mime: string | null) {
  if (!env.ARCHIVOS) return null;
  const clave = `${carpeta}/${uid()}`;
  await env.ARCHIVOS.put(clave, bytes, { httpMetadata: { contentType: mime ?? 'application/octet-stream' } });
  return clave;
}

export async function bajarArchivo(env: Pick<Env, 'ARCHIVOS'>, clave: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const o = await env.ARCHIVOS?.get(clave);
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}

export async function borrarArchivos(env: Pick<Env, 'ARCHIVOS'>, claves: Array<string | null | undefined>) {
  const lista = claves.filter((c): c is string => !!c);
  if (env.ARCHIVOS && lista.length) await env.ARCHIVOS.delete(lista);
}

const aBytes = (d: ArrayBuffer | number[] | Uint8Array) => (d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d));

// Lo que todavía está en la base: se sube a R2 y, recién cuando quedó guardado, se saca de la base. De a pocos por corrida y
// con un tope de bytes (un adjunto del chat puede pesar 20 MB y el Worker tiene 128 MB de memoria).
export async function moverAR2(env: Env, opts: { max?: number; maxBytes?: number } = {}) {
  const res = { movidos: 0, bytes: 0, quedan: 0, sin_r2: !env.ARCHIVOS };
  if (!env.ARCHIVOS) return res;
  const db = env.DB;
  const max = opts.max ?? 8, maxBytes = opts.maxBytes ?? 30_000_000;
  const alcanza = () => res.movidos < max && res.bytes < maxBytes;

  const remitos = (await db.prepare('SELECT id, mime FROM remitos WHERE data IS NOT NULL AND r2_key IS NULL ORDER BY id LIMIT ?').bind(max).all<{ id: number; mime: string | null }>()).results;
  for (const r of remitos) {
    if (!alcanza()) break;
    const fila = await db.prepare('SELECT data FROM remitos WHERE id = ?').bind(r.id).first<{ data: ArrayBuffer | number[] | null }>();
    if (!fila?.data) continue;
    const bytes = aBytes(fila.data);
    const clave = await subirArchivo(env, 'remitos', bytes, r.mime);
    await db.prepare('UPDATE remitos SET r2_key = ?, data = NULL WHERE id = ? AND r2_key IS NULL').bind(clave, r.id).run();
    res.movidos++; res.bytes += bytes.length;
  }

  const facturas = (await db.prepare('SELECT id, mime FROM files WHERE data IS NOT NULL AND r2_key IS NULL ORDER BY id LIMIT ?').bind(max).all<{ id: number; mime: string | null }>()).results;
  for (const f of facturas) {
    if (!alcanza()) break;
    const fila = await db.prepare('SELECT data FROM files WHERE id = ?').bind(f.id).first<{ data: ArrayBuffer | number[] | null }>();
    if (!fila?.data) continue;
    const bytes = aBytes(fila.data);
    const clave = await subirArchivo(env, 'facturas', bytes, f.mime);
    await db.prepare('UPDATE files SET r2_key = ?, data = NULL WHERE id = ? AND r2_key IS NULL').bind(clave, f.id).run();
    res.movidos++; res.bytes += bytes.length;
  }

  // Los adjuntos del chat van en pedazos (el primero en la fila y el resto en mensaje_adjunto_partes): se arman enteros.
  const adjuntos = (await db.prepare('SELECT id, mime, size FROM mensaje_adjuntos WHERE r2_key IS NULL AND length(data) > 0 ORDER BY id LIMIT ?').bind(max).all<{ id: number; mime: string; size: number }>()).results;
  for (const a of adjuntos) {
    if (!alcanza()) break;
    const fila = await db.prepare('SELECT data FROM mensaje_adjuntos WHERE id = ?').bind(a.id).first<{ data: ArrayBuffer | number[] }>();
    if (!fila) continue;
    const primero = aBytes(fila.data);
    let bytes = primero;
    if (a.size > primero.length) {
      const { results } = await db.prepare('SELECT data FROM mensaje_adjunto_partes WHERE adjunto_id = ? ORDER BY n').bind(a.id).all<{ data: ArrayBuffer | number[] }>();
      bytes = new Uint8Array(a.size);
      bytes.set(primero, 0);
      let pos = primero.length;
      for (const p of results) { const x = aBytes(p.data); bytes.set(x, pos); pos += x.length; }
    }
    const clave = await subirArchivo(env, 'adjuntos', bytes, a.mime);
    // `data` no admite NULL en esta tabla: queda vacío.
    await db.batch([
      db.prepare("UPDATE mensaje_adjuntos SET r2_key = ?, data = X'' WHERE id = ? AND r2_key IS NULL").bind(clave, a.id),
      db.prepare('DELETE FROM mensaje_adjunto_partes WHERE adjunto_id = ?').bind(a.id),
    ]);
    res.movidos++; res.bytes += bytes.length;
  }
  res.quedan = (await archivosEnLaBase(db)).total;
  return res;
}

// Cuántos archivos siguen dentro de la base (Configuración → Integraciones), por los índices parciales de la migración 0094.
export async function archivosEnLaBase(db: D1Database) {
  const [r, f, a] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM remitos WHERE data IS NOT NULL AND r2_key IS NULL'),
    db.prepare('SELECT COUNT(*) AS n FROM files WHERE data IS NOT NULL AND r2_key IS NULL'),
    db.prepare('SELECT COUNT(*) AS n FROM mensaje_adjuntos WHERE r2_key IS NULL AND length(data) > 0'),
  ]);
  const n = (x: D1Result) => (x.results[0] as { n: number }).n;
  return { remitos: n(r), facturas: n(f), adjuntos: n(a), total: n(r) + n(f) + n(a) };
}
