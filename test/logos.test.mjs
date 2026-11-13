// Logos del cliente: el original en curvas se guarda en la empresa (Drive simulado en el puerto 8799, test/google-falso.mjs,
// carpeta <empresa>/Logos); se revisa el formato y si los textos están en curvas; en cada producto del pedido o negocio
// se elige cuál va (o el principal), y subir uno desde un producto lo deja guardado en la empresa y elegido ahí.
// El adjunto en ClickUp junto con el boceto aprobado se prueba en test/pedidos.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { googleFalso } from './google-falso.mjs';

const CRM = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
async function api(method, path, body) {
  const res = await fetch(`${CRM}/api${path}`, { method, headers: body instanceof FormData || body === undefined ? {} : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const form = (nombre, contenido, campos = {}) => {
  const fd = new FormData();
  fd.append('archivo', new File([Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'latin1')], nombre));
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  return fd;
};
const SVG_CURVAS = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>`;
const SVG_TEXTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="0" y="8">Illumin</text></svg>`;
const AI_CON_FUENTE = `%PDF-1.5\n%âãÏÓ\n1 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n%AI9_PrivateData\n%%EOF`;
const AI_SIN_FUENTE = `%PDF-1.5\n%âãÏÓ\n1 0 obj << /Type /Page >> endobj\n%AI9_PrivateData\n%%EOF`;
const EPS_CON_FUENTE = `%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Adobe Illustrator\n%%DocumentNeededResources: procset Adobe_level2_AI5 1.2 0\n%%+ font ArialMT\n%%EOF`;
const CDR = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('CDRvvrsn'), Buffer.alloc(32)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let g;
before(async () => { g = await googleFalso(); });
after(async () => { await g.cerrar(); });

test('logos del cliente: en la empresa, revisados, y elegidos en cada producto', async (t) => {
  if (!(await api('GET', '/integrations/bocetos')).data.cuenta_de_servicio) { t.skip('wrangler dev sin GOOGLE_SA_JSON de prueba (node test/gmail-dev-vars.mjs)'); return; }
  await api('PUT', '/integrations/bocetos', { carpeta: '0ARaizDeBocetos123', usuario: 'rodrigo.mateus@formaspublicitarias.com' });
  const emp = (await api('POST', '/records/company', { props: { name: `Illumin ${RUN}` } })).data;
  const otra = (await api('POST', '/records/company', { props: { name: `Otra ${RUN}` } })).data;

  // 1. En la empresa: el primero queda como principal; cada formato con su revisión de curvas.
  const sube = (nombre, contenido, campos) => api('POST', `/records/company/${emp.id}/logos`, form(nombre, contenido, campos));
  const svg = await sube(`Logo ${RUN}.svg`, SVG_CURVAS, { etiqueta: 'Color' });
  assert.equal(svg.status, 201, JSON.stringify(svg.data));
  assert.deepEqual([svg.data.formato, svg.data.vectorial, svg.data.vista, svg.data.curvas, svg.data.principal, svg.data.etiqueta], ['svg', 1, 'svg', 'ok', 1, 'Color']);
  assert.equal((await sube('texto.svg', SVG_TEXTO)).data.curvas, 'textos', 'SVG con <text>');
  const ai = (await sube('Logo.ai', AI_CON_FUENTE)).data;
  assert.deepEqual([ai.formato, ai.vista, ai.curvas, ai.principal], ['ai', 'pdf', 'textos', 0], 'AI compatible con PDF con una fuente');
  assert.equal((await sube('Logo curvas.ai', AI_SIN_FUENTE, { curvas: 'ok' })).data.curvas, 'ok', 'lo que vio pdf.js en el navegador');
  assert.equal((await sube('Logo curvas.pdf', AI_SIN_FUENTE, { curvas: 'ok' })).data.curvas, 'ok');
  assert.equal((await sube('Logo sin pista.pdf', AI_SIN_FUENTE)).data.curvas, 'sin_verificar');
  assert.equal((await sube('Logo trucho.pdf', AI_CON_FUENTE, { curvas: 'ok' })).data.curvas, 'textos', 'si se ven las fuentes, no le cree a la pista');
  assert.equal((await sube('Logo.eps', EPS_CON_FUENTE)).data.curvas, 'textos', 'EPS con «%%+ font»');
  const cdr = (await sube('Logo.cdr', CDR)).data;
  assert.deepEqual([cdr.formato, cdr.vista, cdr.curvas], ['cdr', null, 'sin_verificar']);
  assert.deepEqual([(await sube('Logo.png', PNG)).data.curvas], ['no_vectorial']);
  assert.equal((await sube('nota.txt', 'hola')).status, 400, 'formato que no va');
  const trucho = await sube('Logo.ai', 'hola');
  assert.equal(trucho.status, 400, 'la extensión no coincide con el contenido');
  assert.match(trucho.data.error, /no parece un AI/);

  // En Drive: <raíz>/<empresa>/Logos.
  const archivo = g.drive.archivos.find((f) => f.name === `Logo ${RUN}.svg`);
  const carpeta = g.drive.carpetas.find((c) => c.id === archivo.parent);
  assert.deepEqual([carpeta.name, g.drive.carpetas.find((c) => c.id === carpeta.parent).name], ['Logos', `Illumin ${RUN}`]);

  // Se ven: el SVG encerrado (sin scripts), el CDR solo como descarga.
  const vSvg = await api('GET', `/logos/${svg.data.id}/archivo`);
  assert.equal(vSvg.status, 200);
  assert.equal(vSvg.data.toString(), SVG_CURVAS);
  assert.match(vSvg.headers.get('content-security-policy'), /sandbox/);
  const vCdr = await api('GET', `/logos/${cdr.id}/archivo`);
  assert.match(vCdr.headers.get('content-disposition'), /^attachment/);
  assert.equal(vCdr.headers.get('content-type'), 'application/octet-stream');

  // Principal: uno solo; renombrar.
  assert.equal((await api('PATCH', `/logos/${cdr.id}`, { principal: true, etiqueta: 'Negativo' })).data.principal, 1);
  let lista = (await api('GET', `/records/company/${emp.id}/logos`)).data;
  assert.deepEqual([lista.logos.filter((l) => l.principal).map((l) => l.id), lista.logos[0].etiqueta], [[cdr.id], 'Negativo'], 'el principal primero');
  assert.equal(lista.logos.length, 10);

  // 2. En el pedido: los logos de su empresa; sin elegir, va el principal.
  const ord = (await api('POST', '/records/order', { props: { hs_order_name: `PDV ${RUN}` }, associations: [emp.id] })).data;
  let enPedido = (await api('GET', `/records/order/${ord.id}/logos`)).data;
  assert.deepEqual([enPedido.company_id, enPedido.empresa, enPedido.logos.length, enPedido.elegidos], [emp.id, `Illumin ${RUN}`, 10, []]);
  // Elegir otro para un producto; uno de otra empresa, no.
  const elegido = await api('PUT', `/records/order/${ord.id}/logos/producto`, { producto: 'TAZA-1', logo_id: svg.data.id });
  assert.equal(elegido.data.logo.id, svg.data.id);
  const deOtra = (await api('POST', `/records/company/${otra.id}/logos`, form('Otra.svg', SVG_CURVAS))).data;
  assert.equal((await api('PUT', `/records/order/${ord.id}/logos/producto`, { producto: 'TAZA-1', logo_id: deOtra.id })).status, 400);
  // Subir uno nuevo desde un producto: queda en la empresa y elegido para ese producto.
  const nuevo = await api('POST', `/records/order/${ord.id}/logos`, form(`Isotipo ${RUN}.svg`, SVG_CURVAS, { producto: 'GORRA-1' }));
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.data));
  assert.equal(nuevo.data.company_id, emp.id);
  enPedido = (await api('GET', `/records/order/${ord.id}/logos`)).data;
  assert.deepEqual(enPedido.elegidos.sort((a, b) => a.producto.localeCompare(b.producto)), [{ producto: 'GORRA-1', logo_id: nuevo.data.id }, { producto: 'TAZA-1', logo_id: svg.data.id }]);
  assert.ok((await api('GET', `/records/company/${emp.id}/logos`)).data.logos.some((l) => l.id === nuevo.data.id), 'guardado entre los de la empresa');
  // Volver al principal.
  assert.equal((await api('PUT', `/records/order/${ord.id}/logos/producto`, { producto: 'TAZA-1', logo_id: null })).data.logo.id, cdr.id);

  // 3. En el negocio: el logo elegido para el producto viaja con el boceto cuando se usa en el pedido.
  const deal = (await api('POST', '/records/deal', { props: { dealname: `Abanicos ${RUN}` }, associations: [emp.id] })).data;
  const fd = new FormData();
  fd.append('archivo', new File([Buffer.from(`%PDF-1.4 boceto ${RUN}`)], `Boceto ${RUN}.pdf`, { type: 'application/pdf' }));
  fd.append('producto_nombre', 'Abanico');
  const bo = (await api('POST', `/records/deal/${deal.id}/bocetos`, fd)).data;
  await api('PUT', `/records/deal/${deal.id}/logos/producto`, { producto: 'Abanico', logo_id: ai.id });
  await api('POST', `/bocetos/${bo.id}/usar`, { order_id: ord.id, producto: 'ABAN-01', producto_nombre: 'Abanico' });
  enPedido = (await api('GET', `/records/order/${ord.id}/logos`)).data;
  assert.equal(enPedido.elegidos.find((e) => e.producto === 'ABAN-01')?.logo_id, ai.id);

  // 4. Quitar el principal: pasa a serlo el más nuevo; los productos que tenían el quitado vuelven al principal.
  assert.equal((await api('DELETE', `/logos/${nuevo.data.id}`)).status, 200);
  assert.ok(!(await api('GET', `/records/order/${ord.id}/logos`)).data.elegidos.some((e) => e.producto === 'GORRA-1'));
  assert.equal((await api('DELETE', `/logos/${cdr.id}`)).status, 200);
  lista = (await api('GET', `/records/company/${emp.id}/logos`)).data;
  assert.equal(lista.logos.filter((l) => l.principal).length, 1);
  assert.ok(!lista.logos.some((l) => l.id === cdr.id));
  assert.equal((await api('GET', `/logos/${cdr.id}/archivo`)).status, 404);
});
