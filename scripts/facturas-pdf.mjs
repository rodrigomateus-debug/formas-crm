// Baja de Finnegans GO el PDF de las facturas que el CRM ya adjuntó a los pedidos (con su número interno) y lo sube al CRM.
// La API de Finnegans no da el PDF: sale de Finnegans GO con la sesión iniciada (Sr2, el mismo PDF que «Previsualizar»).
// Solo lee de Finnegans. Lo corre el workflow «Facturas de pedidos (PDF)» cada hora en horario de oficina.
//
//   CRM_URL=https://formas-crm.rodrigo-mateus.workers.dev CRM_TOKEN=fcrm_… \
//   FINNEGANS_GO_USUARIO=… FINNEGANS_GO_PASSWORD=… [FINNEGANS_GO_ESPACIO_DE_TRABAJO=…] node scripts/facturas-pdf.mjs
//
// El token tiene que ser de un administrador del CRM. Nunca se imprimen las credenciales.
import { chromium } from 'playwright';

const CRM = (process.env.CRM_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.CRM_TOKEN;
const USER = process.env.FINNEGANS_GO_USUARIO;
const PASS = process.env.FINNEGANS_GO_PASSWORD;
const SPACE = process.env.FINNEGANS_GO_ESPACIO_DE_TRABAJO;
// Empresa de cada factura → id de empresa de Teamplace para el PDF (EMPRE01 = 16). FP DEMO no tiene CAE: no se baja.
const EMPRESA_ID = { EMPRE01: 16 };

if (!CRM || !TOKEN) { console.error('Faltan CRM_URL y CRM_TOKEN.'); process.exit(1); }
const crm = (path, init = {}) => fetch(`${CRM}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

// Las pendientes, de a 100. La corrida sigue hasta bajarlas todas (o hasta 20 minutos): GitHub a veces saltea corridas
// programadas y, de a 50 por corrida, se acumulaban.
const saltear = new Set();   // las que Finnegans no devolvió en esta corrida
async function pendientes() {
  const res = await crm('/hooks/facturas/pendientes?limit=100');
  if (!res.ok) { console.error(`CRM: HTTP ${res.status} ${await res.text()}`); process.exit(1); }
  const total = Number(res.headers.get('x-total') ?? 0);
  return { total, list: (await res.json()).filter((f) => f.transaccion_id && EMPRESA_ID[f.empresa ?? 'EMPRE01'] && !saltear.has(f.id)) };
}
let { total, list: pending } = await pendientes();
console.log(`${total || pending.length} facturas sin PDF.`);
if (!pending.length) process.exit(0);
if (!USER || !PASS) { console.error('Faltan FINNEGANS_GO_USUARIO y FINNEGANS_GO_PASSWORD.'); process.exit(1); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://go.finneg.com/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loginname', { timeout: 60000 });
await page.fill('#loginname', USER);
await page.fill('#loginpassword', PASS);
if (SPACE && await page.locator('#logincompany').isVisible().catch(() => false)) await page.fill('#logincompany', SPACE);
await page.click('[name=standardSubmit]');
await page.waitForTimeout(15000);
if (!page.url().includes('go.finneg.com')) { console.error('No se pudo iniciar sesión en Finnegans GO.'); await browser.close(); process.exit(1); }
// Abrir la vista de facturas deja abierta la sesión de Teamplace; su dirección cambia cada tanto (13.teamplace → oneteam).
await page.goto('https://go.finneg.com/mas/vista?viewID=140');
await page.waitForTimeout(15000);
const frame = page.frames().map((f) => f.url()).find((u) => u.includes('/BSA/'));
const host = frame ? new URL(frame).host : 'oneteam.finneg.com';

let ok = 0, fallidas = 0;
const hasta = Date.now() + 20 * 60_000;
while (pending.length && Date.now() < hasta) {
for (const f of pending) {
  const url = `https://${host}/BSA/Sr2?XMLFILE=FacturaSF.jrxml&DATASOURCE=SOUTEXVF_0240&primaryKey=${f.transaccion_id}`
    + `&MULTIREPORTPARAMS=FacturaSF.jrxml%7CSOUTEXVF_0240%7CFACTURA%20DE%20VENTA%20FP%7C1%7C&EMPRESAIDTRANSACCION=${EMPRESA_ID[f.empresa ?? 'EMPRE01']}`;
  const pdf = await ctx.request.get(url);
  const body = await pdf.body();
  if (!pdf.ok() || body.subarray(0, 5).toString() !== '%PDF-') { console.error(`${f.numero}: Finnegans no devolvió el PDF (HTTP ${pdf.status()}).`); saltear.add(f.id); fallidas++; continue; }
  const up = await crm(`/hooks/facturas/${f.id}/pdf`, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body });
  if (up.ok) { ok++; console.log(`${f.numero}: listo (${body.length} bytes).`); } else { console.error(`${f.numero}: el CRM respondió ${up.status} ${await up.text()}`); saltear.add(f.id); fallidas++; }
}
({ list: pending } = await pendientes());
}
await browser.close();
console.log(`${ok} PDF subidos${fallidas ? `, ${fallidas} no se pudieron bajar` : ''}${pending.length ? `; quedan ${pending.length} para la próxima corrida` : ''}.`);
process.exit(fallidas ? 1 : 0);
