// Usado por el workflow de publicación: si la base D1 «formas-crm» no existe la crea, y escribe su id en
// wrangler.jsonc (solo en la copia de CI). Así la primera publicación no necesita pasos a mano.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const wrangler = (...a) => execFileSync('npx', ['wrangler', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const list = JSON.parse(wrangler('d1', 'list', '--json'));
let db = list.find((d) => d.name === 'formas-crm');
if (!db) {
  console.log('Creando la base D1 formas-crm…');
  wrangler('d1', 'create', 'formas-crm');
  db = JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === 'formas-crm');
}
const id = db.uuid ?? db.database_id ?? db.id;
const cfg = readFileSync('wrangler.jsonc', 'utf8').replace(/"database_id": "[^"]*"/, `"database_id": "${id}"`);
writeFileSync('wrangler.jsonc', cfg);
console.log(`Base D1 formas-crm: ${id}`);
