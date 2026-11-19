// Usado por el workflow de publicación (como ensure-d1.mjs): si el bucket R2 «formas-crm-archivos» no existe, lo crea. Ahí van
// las fotos de los remitos, los adjuntos del chat y los PDF de las facturas (src/worker/archivos.ts, docs/AUDITORIA.md).
// Si no se puede (R2 sin activar en la cuenta de Cloudflare, o el token sin permiso de R2), saca el binding de
// wrangler.jsonc (solo en la copia de CI) y avisa: la publicación sigue y el Hub guarda los archivos en la base, como antes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BUCKET = 'formas-crm-archivos';
const wrangler = (...a) => execFileSync('npx', ['wrangler', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  if (!wrangler('r2', 'bucket', 'list').includes(BUCKET)) {
    console.log(`Creando el bucket R2 ${BUCKET}…`);
    wrangler('r2', 'bucket', 'create', BUCKET);
  }
  console.log(`Bucket R2 ${BUCKET}: listo.`);
} catch (e) {
  const detalle = String(e.stderr || e.message || e).split('\n').find((l) => l.trim()) ?? '';
  console.log(`::warning::No se pudo usar el bucket R2 ${BUCKET} (${detalle.trim()}). Se publica sin él: los archivos siguen en la base. Para activarlo: Cloudflare → R2 (activarlo en la cuenta) y un token de API con permiso «Workers R2 Storage: Edit».`);
  const cfg = readFileSync('wrangler.jsonc', 'utf8').replace(/\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*"r2_buckets": \[[^\]]*\],/, '');
  if (cfg.includes('"r2_buckets"')) throw new Error('No se pudo sacar el binding de R2 de wrangler.jsonc.');
  writeFileSync('wrangler.jsonc', cfg);
}
