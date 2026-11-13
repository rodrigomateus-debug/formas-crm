// Remitos de entrega: la app del chofer, la lectura con Claude, el cruce con el pedido, los duplicados, la revisión y el
// estado de entrega (qué falta), contra Claude, ClickUp y Finnegans simulados (puerto 8797).
// Necesita en .dev.vars las variables de .dev.vars.example (ANTHROPIC_*, CLICKUP_* y FINNEGANS_* apuntando a localhost:8797).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
const RUN = Date.now().toString(36);
const PDV = String(50000 + Math.floor(Math.random() * 9000));
const PDV_B = String(Number(PDV) + 1);
const PDV_C = String(Number(PDV) + 2);   // un remito de dos hojas
const PDV_D = String(Number(PDV) + 3);   // dos materas de colores y un remito sin códigos
const PDV_E = String(Number(PDV) + 4);   // sin propietario en ClickUp: lo toma de Finnegans
const PDV_F = String(Number(PDV) + 5);   // el remito dice el producto con otro nombre: se asigna a mano
const PDV_G = String(Number(PDV) + 8);   // un remito de dos pedidos (G y H): cada renglón va a uno
const PDV_H = String(Number(PDV) + 9);
const NRO = (n) => `R-0001-${String(n).padStart(8, '0')}`;
const BASE_NRO = 20000 + Math.floor(Math.random() * 70000);

// CUIT con su dígito verificador.
function cuit(prefijo = '30') {
  for (;;) {
    const d = prefijo + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const suma = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((s, p, i) => s + p * Number(d[i]), 0);
    let dv = 11 - (suma % 11);
    if (dv === 11) dv = 0;
    if (dv !== 10) return `${d.slice(0, 2)}-${d.slice(2)}-${dv}`;
  }
}
const CUIT_A = cuit();
const CUIT_B = cuit('33');
const CUIT_OTRO = cuit('30');

let asUser = null;
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path.startsWith('/hooks') ? '' : '/api'}${path}`, {
    method, headers: { ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(asUser ? { 'x-dev-user': asUser } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, data: type.includes('json') ? await res.json() : await res.text() };
}
const foto = (marca) => new Blob([`\xff\xd8\xff\xe0 remito de prueba ${marca} ${RUN}`], { type: 'image/jpeg' });
function form(marca, extra = {}) {
  const f = new FormData();
  f.append('archivo', foto(marca), `${marca}.jpg`);
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
}

// ---------- Lo que «lee» el Claude simulado, según la marca escrita en la foto ----------
const item = (codigo, descripcion, cantidad) => ({ codigo, descripcion, cantidad, cantidad_texto: `${cantidad}.00` });
const base = {
  es_remito: true, legible: true, problemas_foto: [], repetir_foto: false, motivo_repetir: null, fecha: '2026-10-21', direccion_entrega: 'Nicaragua 1651, Sarandí',
  orden_compra: 'T26C830000778', bultos: 2, firmado: true, sello_recepcion: null, fecha_recepcion: '2026-10-21', aclaracion_firma: null,
  recibido_con_reservas: false, notas: null, otros_remitos_en_foto: false, dudas: [],
};
const LECTURAS = {
  OK1: { ...base, numero_remito: NRO(BASE_NRO), pdv_pedido_web: `000${PDV}`, pdv_observaciones: PDV, cliente: `CLIENTE A ${RUN} S A`, cuit_cliente: CUIT_A,
    items: [item('SIM10001273', 'Llavero corto | Merchandising', 1000)], sello_recepcion: 'Target Agencia de Marketing S.A.', recibido_con_reservas: true,
    notas: 'Se reciben bultos cerrados, mercadería a controlar', otros_remitos_en_foto: true },
  OK1B: { ...base, numero_remito: `R-1-${BASE_NRO}`, pdv_pedido_web: PDV, pdv_observaciones: PDV, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A, items: [item('SIM10001273', 'Llavero corto', 1000)] },
  OK2: { ...base, numero_remito: NRO(BASE_NRO + 3), pdv_pedido_web: PDV, pdv_observaciones: PDV, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A,
    items: [item('SIM10001273', 'Llavero corto', 500), item('GOR-1', 'Gorra bordada', 180)] },
  // El remito no dice el PDV: la app se lo pide al chofer, y con el CUIT del cliente alcanza.
  PIDEPDV: { ...base, numero_remito: NRO(BASE_NRO + 20), pdv_pedido_web: null, pdv_observaciones: null, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A, items: [item('GOR-1', 'Gorra bordada', 20)] },
  // Bien leído (PDV B en los dos lugares); el chofer lo «corrige» a otro: lo revisa Logística.
  CONTRA: { ...base, numero_remito: NRO(BASE_NRO + 30), pdv_pedido_web: PDV_B, pdv_observaciones: PDV_B, cliente: `CLIENTE B ${RUN} SRL`, cuit_cliente: CUIT_B, items: [item('GOR-1', 'Gorra bordada', 1)] },
  MALPDV: { ...base, numero_remito: NRO(BASE_NRO + 5), pdv_pedido_web: PDV, pdv_observaciones: String(Number(PDV) + 7), cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A, items: [item('GOR-1', 'Gorra', 5)] },
  // Como contesta la API real: lo que no se lee viene vacío ("") y la cantidad que no se lee, -1.
  BORROSA: { ...base, legible: false, problemas_foto: ['cortada', 'sombra'], repetir_foto: true, motivo_repetir: 'El número de PDV quedó cortado. Que se vea el remito entero.',
    numero_remito: '', pdv_pedido_web: '', pdv_observaciones: '', cliente: '', cuit_cliente: '', bultos: '', items: [{ codigo: '', descripcion: '', cantidad: -1, cantidad_texto: '' }] },
  NOREM: { ...base, es_remito: false, numero_remito: null, pdv_pedido_web: null, pdv_observaciones: null, cliente: null, cuit_cliente: null, items: [] },
  OTROCUIT: { ...base, numero_remito: NRO(BASE_NRO + 8), pdv_pedido_web: PDV_B, pdv_observaciones: PDV_B, cliente: `OTRA EMPRESA ${RUN} SA`, cuit_cliente: CUIT_OTRO, items: [item('GOR-1', 'Gorra', 50)] },
  B1: { ...base, numero_remito: NRO(BASE_NRO + 10), pdv_pedido_web: PDV_B, pdv_observaciones: PDV_B, cliente: `CLIENTE B ${RUN} SRL`, cuit_cliente: CUIT_B, items: [item('GOR-1', 'Gorra bordada', 50)] },
  CRM1: { ...base, numero_remito: NRO(BASE_NRO + 11), pdv_pedido_web: PDV_B, pdv_observaciones: null, cliente: `CLIENTE B ${RUN} SRL`, cuit_cliente: null, items: [item('GOR-1', 'Gorra bordada', 10)] },
  // Un remito largo de dos hojas (mismo número): cada hoja trae sus productos y las dos suman; otra foto de la segunda hoja
  // no suma nada nuevo y queda repetida.
  HOJA1: { ...base, numero_remito: NRO(BASE_NRO + 40), pdv_pedido_web: PDV_C, pdv_observaciones: PDV_C, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A, items: [item('SIM10001273', 'Llavero corto', 100)] },
  HOJA2: { ...base, numero_remito: NRO(BASE_NRO + 40), pdv_pedido_web: PDV_C, pdv_observaciones: PDV_C, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A, items: [item('GOR-1', 'Gorra bordada', 50)] },
  HOJA2B: { ...base, numero_remito: NRO(BASE_NRO + 40), pdv_pedido_web: PDV_C, pdv_observaciones: null, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A, items: [item('GOR-1', 'Gorra bordada', 50)] },
  // Como el PDV 2402: el remito no trae códigos, dice «(equivale a 90 unidades)» y el PDV solo en «Observaciones»; el
  // pedido tiene dos materas (negra y roja) de 1 cada una. Las dos cuentan, una en cada producto.
  MATERAS: { ...base, numero_remito: NRO(BASE_NRO + 50), pdv_pedido_web: '', pdv_observaciones: PDV_D, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A,
    items: [{ codigo: '', descripcion: 'Matera Engomada (equivale a 90 unidades)', cantidad: 1, cantidad_texto: '1' },
      { codigo: '', descripcion: 'Matera Engomada (equivale a 90 unidades)', cantidad: 1, cantidad_texto: '1' }] },
  // Como el PDV 30971: el remito dice «70 Jarro Bossa Waterdog» y el pedido, «Producción simple drinkware genérico» (100).
  JARROS: { ...base, numero_remito: NRO(BASE_NRO + 60), pdv_pedido_web: PDV_F, pdv_observaciones: PDV_F, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A,
    items: [item('GOR-1', 'Gorra bordada', 50), { codigo: '', descripcion: 'Jarro Bossa Waterdog', cantidad: 70, cantidad_texto: '70' }] },
  // Como el remito del PDV 2402: el PDV y el CUIT son del pedido, pero ningún producto se reconoce: queda para revisar.
  TAZAS: { ...base, numero_remito: NRO(BASE_NRO + 61), pdv_pedido_web: PDV_F, pdv_observaciones: PDV_F, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A,
    items: [{ codigo: '', descripcion: 'Taza misteriosa', cantidad: 20, cantidad_texto: '20' }, { codigo: '', descripcion: 'Taza misteriosa roja', cantidad: 10, cantidad_texto: '10' }] },
  // Un remito de dos pedidos (un camión, dos PDV): dice el PDV de G, pero un renglón es de G y el otro de H. Los dos
  // renglones se llaman igual; ninguno se reconoce solo.
  COMPARTIDO: { ...base, numero_remito: NRO(BASE_NRO + 70), pdv_pedido_web: PDV_G, pdv_observaciones: PDV_G, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A,
    items: [{ codigo: '', descripcion: 'Conservadora médica DLC', cantidad: 236, cantidad_texto: '236' }, { codigo: '', descripcion: 'Conservadora médica DLC', cantidad: 110, cantidad_texto: '110' }] },
  // Otra foto del mismo remito, que dice el PDV de H: es el mismo remito (ya está en H), no suma.
  COMPARTIDO_H: { ...base, numero_remito: NRO(BASE_NRO + 70), pdv_pedido_web: PDV_H, pdv_observaciones: PDV_H, cliente: `CLIENTE A ${RUN} SA`, cuit_cliente: CUIT_A,
    items: [{ codigo: '', descripcion: 'Conservadora médica DLC', cantidad: 236, cantidad_texto: '236' }, { codigo: '', descripcion: 'Conservadora médica DLC', cantidad: 110, cantidad_texto: '110' }] },
  SINPDV: { ...base, numero_remito: NRO(BASE_NRO + 12), pdv_pedido_web: null, pdv_observaciones: null, cliente: `CLIENTE B ${RUN} SRL`, cuit_cliente: CUIT_B, items: [item('GOR-1', 'Gorra', 5)] },
};
let lecturas = 0;

// ---------- ClickUp y Finnegans simulados: dos PDV, A (entregado en ClickUp) y B (en producción) ----------
const field = (name, value, type = 'short_text') => ({ name, type, value });
const pdvTask = (id, npdv, cliente, status, vendedor = 'Rodrigo Mateus') => ({
  id, name: `PDV - ${npdv}`, parent: null, url: `https://app.clickup.com/t/${id}`, date_updated: String(Date.now()), status: { status: 'pdv' },
  text_content: `Pedido: PEDVTASTP - ${npdv}\nCliente: ${cliente}\nVendedor: ${vendedor}\nEs evento: No\nFecha entrega: 30-11-2026`,
  custom_fields: [field('N° PDV', `PDV - ${npdv}`), field('CLIENTE', cliente), field('🧑‍💻 VENDEDOR', vendedor),
    { name: 'UNIDAD DE NEGOCIO', type: 'drop_down', value: { name: 'CORPORATE' } }, field('ENTREGAS (FECHA REAL)', String(Date.now() - 86_400_000), 'date')],
  subtasks: [{ id: `${id}-0`, name: 'Artículo - Proveedor', parent: id, date_updated: String(Date.now()), status: { status }, text_content: `PDV - ${npdv}\nProducto: Artículo`, custom_fields: [] }],
  attachments: [],
});
const TAREAS = () => [pdvTask(`remA${RUN}`, PDV, `Cliente A ${RUN} S.A.`, 'entregados'), pdvTask(`remB${RUN}`, PDV_B, `Cliente B ${RUN} SRL`, 'en el impresor'),
  pdvTask(`remC${RUN}`, PDV_C, `Cliente A ${RUN} S.A.`, 'en el impresor'), pdvTask(`remD${RUN}`, PDV_D, `Cliente A ${RUN} S.A.`, 'en el impresor'),
  pdvTask(`remE${RUN}`, PDV_E, `Cliente A ${RUN} S.A.`, 'en el impresor', `Nadie ${RUN}`), pdvTask(`remF${RUN}`, PDV_F, `Cliente A ${RUN} S.A.`, 'en el impresor'),
  pdvTask(`remG${RUN}`, PDV_G, `Cliente A ${RUN} S.A.`, 'en el impresor'), pdvTask(`remH${RUN}`, PDV_H, `Cliente A ${RUN} S.A.`, 'en el impresor')];
// Gmail simulado (puerto 8799, el de GOOGLE_TOKEN_URL y GMAIL_API_URL de .dev.vars): los mails de faltantes.
const mails = [];
let gmail;
let server;
before(async () => {
  gmail = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (req.url === '/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(body).get('assertion').split('.')[1], 'base64url').toString());
      return send({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (req.url === '/gmail/v1/users/me/messages/send') { mails.push(Buffer.from(JSON.parse(body).raw, 'base64url').toString()); return send({ id: `m${mails.length}` }); }
    res.statusCode = 404; send({});
  });
  await new Promise((r) => gmail.listen(8799, r));
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const send = (b, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (req.method === 'POST' && p === '/anthropic/v1/messages') {
      let body = '';
      req.on('data', (ch) => { body += ch; });
      req.on('end', () => {
        lecturas++;
        const pedido = JSON.parse(body);
        const bloque = pedido.messages[0].content.find((c) => c.source?.data);
        const texto = Buffer.from(bloque.source.data, 'base64').toString('latin1');
        const marca = texto.match(/remito de prueba (\w+)/)?.[1];
        const l = LECTURAS[marca];
        if (!l) return send({ type: 'error', error: { type: 'invalid_request_error', message: 'marca desconocida' } }, 400);
        // Lo que tiene que mandar el CRM: el modelo, la salida con esquema y el respaldo si hay un rechazo.
        assert.equal(pedido.model, 'claude-opus-5-5');
        assert.equal(pedido.output_config?.format?.type, 'json_schema');
        assert.equal(pedido.fallbacks, 'default');
        // Los límites de la API para un esquema estricto: hasta 16 campos de dos tipos (anyOf o type: [...]) y hasta 24
        // opcionales (fuera de «required»). Con más, la API contesta 400 y no lee ningún remito.
        const esquema = pedido.output_config.format.schema;
        const recorrer = (o, f) => (o && typeof o === 'object' ? f(o) + Object.values(o).reduce((n, x) => n + recorrer(x, f), 0) : 0);
        const uniones = recorrer(esquema, (o) => (!Array.isArray(o) && (o.anyOf || Array.isArray(o.type)) ? 1 : 0));
        const opcionales = recorrer(esquema, (o) => (o.type === 'object' && o.properties ? Object.keys(o.properties).filter((k) => !(o.required ?? []).includes(k)).length : 0));
        assert.ok(uniones <= 16, `el esquema tiene ${uniones} campos de dos tipos (máximo 16)`);
        assert.ok(opcionales <= 24, `el esquema tiene ${opcionales} campos opcionales (máximo 24)`);
        send({ id: `msg_${lecturas}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(l) }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 400 } });
      });
      return;
    }
    if (p === '/clickup/list/901326159292/task') {
      const tasks = TAREAS().flatMap((t) => [t, ...t.subtasks]);
      return send({ tasks, last_page: true });
    }
    const t = TAREAS().find((x) => p === `/clickup/task/${x.id}`);
    if (t) return send(t);
    if (p === '/fin/oauth/token') return res.end('"token-de-prueba"');
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV_D.padStart(8, '0')}`) {
      return send({ Cliente: 'C-REM-A', MonedaCodigo: 'PES', Items: [
        { ProductoCodigo: 'MAT-N', Cantidad: 1, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: '', IncluyeImpuesto: false },
        { ProductoCodigo: 'MAT-R', Cantidad: 1, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: '', IncluyeImpuesto: false }] });
    }
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV_F.padStart(8, '0')}`) {
      return send({ Cliente: 'C-REM-A', MonedaCodigo: 'PES', Items: [
        { ProductoCodigo: 'DRK-1', Cantidad: 100, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: 'Producción simple drinkware genérico', IncluyeImpuesto: false },
        { ProductoCodigo: 'GOR-1', Cantidad: 50, Precio: 900, Descuento1: 0, Descuento2: 0, Descripcion: 'Gorra bordada', IncluyeImpuesto: false }] });
    }
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV_G.padStart(8, '0')}`) {
      return send({ Cliente: 'C-REM-A', MonedaCodigo: 'PES', Items: [
        { ProductoCodigo: 'VAS-B', Cantidad: 110, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: 'Contigo Vaso Térmico Autoseal 532 ml Blanco', IncluyeImpuesto: false }] });
    }
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV_H.padStart(8, '0')}`) {
      return send({ Cliente: 'C-REM-A', MonedaCodigo: 'PES', Items: [
        { ProductoCodigo: 'KIT-M', Cantidad: 236, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: 'Kit de primeros auxilios', IncluyeImpuesto: false }] });
    }
    if (p === `/fin/pedidoVenta/PEDVTASTP - ${PDV_C.padStart(8, '0')}`) {
      return send({ Cliente: 'C-REM-A', MonedaCodigo: 'PES', Items: [
        { ProductoCodigo: 'SIM10001273', Cantidad: 100, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: 'Llavero corto', IncluyeImpuesto: false },
        { ProductoCodigo: 'GOR-1', Cantidad: 50, Precio: 900, Descuento1: 0, Descuento2: 0, Descripcion: 'Gorra bordada', IncluyeImpuesto: false }] });
    }
    for (const [n, cli] of [[PDV, 'C-REM-A'], [PDV_B, 'C-REM-B']]) {
      if (p === `/fin/pedidoVenta/PEDVTASTP - ${n.padStart(8, '0')}`) {
        return send({ Cliente: cli, MonedaCodigo: 'PES', Items: n === PDV
          ? [{ ProductoCodigo: 'SIM10001273', Cantidad: 1500, Precio: 100, Descuento1: 0, Descuento2: 0, Descripcion: 'Llavero corto', IncluyeImpuesto: false },
            { ProductoCodigo: 'GOR-1', Cantidad: 200, Precio: 900, Descuento1: 0, Descuento2: 0, Descripcion: 'Gorra bordada', IncluyeImpuesto: false }]
          : [{ ProductoCodigo: 'GOR-1', Cantidad: 100, Precio: 900, Descuento1: 0, Descuento2: 0, Descripcion: 'Gorra bordada', IncluyeImpuesto: false }] });
      }
    }
    if (p === '/fin/cliente/C-REM-A') return send({ IdentificacionTributariaNumero: CUIT_A, RazonSocial: `CLIENTE A ${RUN} SA` });
    if (p === '/fin/cliente/C-REM-B') return send({ IdentificacionTributariaNumero: CUIT_B, RazonSocial: `CLIENTE B ${RUN} SRL` });
    if (p.startsWith('/fin/producto/')) {
      const nombre = { 'GOR-1': 'Gorra bordada', 'MAT-N': 'Matera Engomada Negra', 'MAT-R': 'Matera Engomada Roja',
        'VAS-B': 'Contigo Vaso Térmico Autoseal 532 ml Blanco', 'KIT-M': 'Kit de primeros auxilios' }[p.split('/').pop()] ?? 'Llavero corto';
      return send({ Nombre: nombre, Descripcion: '', ProductoImagen: '' });
    }
    if (p === '/fin/reports/ApiGetDocumentosDestinoByIdentificacionExternaDeals') {
      // Finnegans tiene los remitos del pedido A (el número es la confirmación independiente del PDV).
      const origen = url.searchParams.get('PARAMWEBREPORT_IdentificacionExternaOrigen');
      return send(origen === `PEDVTASTP - ${PDV.padStart(8, '0')}` ? [BASE_NRO, BASE_NRO + 3].map((n) => ({
        TIPODOCUMENTO: 'FPREMVTA', CATEGORIATIPODOCUMENTO: -7, DESTINONOMBRE: `FPREMVTA - ${String(n).padStart(8, '0')}`, DESTINOIDENTIFICACIONEXTERNA: `FPREMVTA - ${String(n).padStart(8, '0')}`,
        DESTINOTRANSACCIONID: n, DESTINOIMPORTETOTAL: 0, OBTUVOCAE: 'NO', DESTINOFECHA: '2026-10-21' })) : []);
    }
    send({ error: 'no simulado' }, 404);
  });
  await new Promise((r) => server.listen(8797, r));
});
after(() => { server.close(); gmail.close(); });
const textoDe = (raw) => raw.split(/--fcrm\w+/).map((part) => {
  const [head, ...rest] = part.split('\r\n\r\n');
  return /base64/.test(head) ? Buffer.from(rest.join('').replace(/\s+/g, ''), 'base64').toString() : '';
}).join('\n');

const pedidoDe = async (pdv) => (await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${pdv}`)}`)).data.results.find((o) => String(o.props.pdv_finnegans) === pdv);
const remitosDe = async (id) => (await api('GET', `/records/order/${id}/remitos`)).data;
const props = async (id) => (await api('GET', `/records/order/${id}`)).data.record.props;

test('remitos: la app del chofer, la lectura con Claude, el cruce con el pedido y lo que falta entregar', async (t) => {
  asUser = null;
  const st = (await api('GET', '/integrations/pedidos')).data;
  if (!st.clickup.configured) { t.skip('wrangler dev sin CLICKUP_TOKEN de prueba (ver .dev.vars.example)'); return; }
  const compA = (await api('POST', '/records/company', { props: { name: `Cliente A ${RUN} SA`, cuit: CUIT_A } })).data;
  const compB = (await api('POST', '/records/company', { props: { name: `Cliente B ${RUN} SRL`, cuit: CUIT_B } })).data;
  const logi = (await api('POST', '/users', { email: `logistica.${RUN}@formas.ar`, name: `Logística ${RUN}`, profile: 'logistica', role: 'member' })).data;
  await api('POST', '/users', { email: `vende.rem.${RUN}@formas.ar`, name: `Vende ${RUN}`, role: 'member' });
  // Los mails de faltantes: solo a Logística y a los administradores que tienen «Avisos por mail» prendido (arranca
  // apagado). Logística y el administrador de desarrollo lo prenden; la otra persona de Logística, no.
  const logi2 = (await api('POST', '/users', { email: `logistica2.${RUN}@formas.ar`, name: `Logística dos ${RUN}`, profile: 'logistica', role: 'member' })).data;
  assert.equal(logi2.avisos_mail, 0, 'arranca apagado');
  const adminDev = (await api('GET', '/meta')).data.me;
  for (const u of [logi, adminDev]) assert.equal((await api('PATCH', `/users/${u.id}`, { avisos_mail: true })).status, 200);
  assert.ok(!(await api('POST', '/integrations/clickup/sync', { full: true })).data.error);
  const A = await pedidoDe(PDV);
  const B = await pedidoDe(PDV_B);
  assert.ok(A && B, 'los dos pedidos vinieron de ClickUp');
  assert.equal((await api('GET', `/records/order/${A.id}`)).data.associations.company[0].id, compA.id);
  // El propietario desde Finnegans: el VENDEDOR de ClickUp no es usuario, así que el pedido E entra sin propietario; con
  // el vendedor del informe de Finnegans («APELLIDO, NOMBRE») lo toma. Al que ya tiene, no se lo cambia.
  const E = await pedidoDe(PDV_E);
  assert.ok(!E.props.owner_id, 'sin propietario');
  const admin = (await api('GET', '/meta')).data.me;
  const [nom, ...ape] = admin.name.split(' ');
  const tokT = (await api('POST', '/tokens', { name: `Totales ${RUN}`, source: 'api' })).data.token;
  const tot = await api('POST', '/hooks/pedidos/totales', { totales: {}, vendedores: { [E.props.pedido_finnegans]: `${ape.join(' ').toUpperCase()}, ${nom.toUpperCase()}`, [A.props.pedido_finnegans]: 'Otra Persona' } },
    { authorization: `Bearer ${tokT}` });
  assert.equal(tot.data.propietarios, 1, JSON.stringify(tot.data));
  assert.equal((await props(E.id)).owner_id, admin.id, 'propietario: el vendedor de Finnegans');
  assert.equal((await props(A.id)).owner_id, A.props.owner_id, 'no pisa el que ya tiene');
  // Los productos del pedido (de Finnegans): lo vendido.
  assert.equal((await api('GET', `/records/order/${A.id}/products`)).data.items.length, 2);
  assert.equal((await api('GET', `/records/order/${B.id}/products`)).data.items.length, 1);
  const r0 = await remitosDe(A.id);
  if (!r0.lector) { t.skip('wrangler dev sin ANTHROPIC_API_KEY de prueba (ver .dev.vars.example)'); return; }
  // ClickUp dice «Entregado» y no hay remito: falta el remito.
  assert.equal(r0.entrega.estado, 'falta_remito');
  assert.equal((await props(A.id)).estado_entrega, 'falta_remito');

  // 1. El link del chofer: lo crea Logística (no cualquiera) y solo sirve para la app.
  asUser = `vende.rem.${RUN}@formas.ar`;
  assert.equal((await api('POST', '/choferes', { name: 'Juan' })).status, 403, 'una vendedora no crea links de chofer');
  asUser = logi.email;
  const ch = (await api('POST', '/choferes', { name: `Juan ${RUN}` })).data;
  asUser = null;
  assert.match(ch.link, /\/hooks\/chofer\/#t=fcrm_/);
  // Si lo pierde, Logística lo vuelve a copiar (una vendedora no).
  asUser = logi.email;
  assert.equal((await api('GET', `/choferes/${ch.id}/link`)).data.link, ch.link);
  asUser = `vende.rem.${RUN}@formas.ar`;
  assert.equal((await api('GET', `/choferes/${ch.id}/link`)).status, 403);
  asUser = null;
  assert.ok(!JSON.stringify((await api('GET', '/choferes')).data).includes(ch.token), 'la lista no trae los links');
  const H = { authorization: `Bearer ${ch.token}` };
  assert.deepEqual((await api('GET', '/hooks/chofer/api/yo', undefined, H)).data, { nombre: `Juan ${RUN}` });
  assert.equal((await api('GET', '/records/order', undefined, H)).status, 403, 'el link del chofer no abre el CRM');
  assert.equal((await api('POST', '/hooks/bundle', {}, H)).status, 403, 'ni las otras entradas');
  const api2 = (await api('POST', '/tokens', { name: `API ${RUN}`, source: 'api' })).data.token;
  assert.equal((await api('GET', '/hooks/chofer/api/yo', undefined, { authorization: `Bearer ${api2}` })).status, 401, 'un token común no es de chofer');
  assert.equal((await api('GET', '/hooks/chofer/api/yo')).status, 401);

  // 2. La foto del remito: PDV (dos veces), CUIT válido del cliente y el número de remito en Finnegans → va solo al pedido.
  const clave = `clave-${RUN}-1`;
  const m1 = await api('POST', '/hooks/chofer/api/remitos', form('OK1', { clave, tomada_el: new Date().toISOString(), lat: '-34.67', lng: '-58.33' }), H);
  assert.equal(m1.status, 201, JSON.stringify(m1.data));
  assert.equal(m1.data.estado, 'ok', m1.data.mensaje);
  assert.equal(m1.data.pedido.id, A.id);
  assert.equal(m1.data.pdv, PDV);
  assert.equal(m1.data.repetir, false);
  assert.match(m1.data.mensaje, new RegExp(`PDV ${PDV}`));
  assert.deepEqual(m1.data.items, [{ descripcion: 'Llavero corto | Merchandising', cantidad: 1000 }]);
  // Reintentar con la misma clave (se cortó la señal) no duplica ni vuelve a leer.
  const antes = lecturas;
  const m1b = await api('POST', '/hooks/chofer/api/remitos', form('OK1', { clave }), H);
  assert.deepEqual([m1b.status, m1b.data.id, lecturas], [200, m1.data.id, antes]);
  // La misma foto otra vez (otra clave) tampoco.
  assert.equal((await api('POST', '/hooks/chofer/api/remitos', form('OK1', { clave: `${clave}-otra` }), H)).data.id, m1.data.id);

  // Lo que falta: 500 llaveros y las 200 gorras; ClickUp dice «Entregado», así que hay alerta.
  let r = await remitosDe(A.id);
  assert.equal(r.entrega.estado, 'parcial');
  assert.deepEqual(r.entrega.lineas.map((l) => [l.code, l.vendido, l.entregado, l.falta]), [['SIM10001273', 1500, 1000, 500], ['GOR-1', 200, 0, 200]]);
  assert.match(r.entrega.alerta, /ClickUp dice «Entregado»/);
  assert.equal(r.entrega.reservas, 1, 'recibido «a controlar»');
  const r1 = r.remitos.find((x) => x.id === m1.data.id);
  assert.ok(r1.reservas && r1.otros_remitos_en_foto);
  assert.equal(r1.origen, 'chofer');
  assert.ok(r1.controles.some((c) => c.dato === 'Remito en Finnegans' && c.ok === true));
  assert.ok(r1.controles.some((c) => c.dato === 'CUIT' && c.ok === true));
  const pa = await props(A.id);
  assert.equal(pa.estado_entrega, 'parcial');
  assert.match(pa.falta_entregar, /500 Llavero corto/);
  // Filtro «Faltan entregas» de la lista de pedidos.
  const faltan = encodeURIComponent(JSON.stringify([{ prop: 'estado_entrega', op: 'in', values: ['parcial', 'diferencias', 'falta_remito'] }]));
  assert.ok((await api('GET', `/records/order?q=${encodeURIComponent(`PDV ${PDV}`)}&filters=${faltan}`)).data.results.some((o) => o.id === A.id));
  // La foto se puede ver.
  const ver = await fetch(`${BASE}/api/remitos/${m1.data.id}/archivo`);
  assert.deepEqual([ver.status, ver.headers.get('content-type')], [200, 'image/jpeg']);

  // 3. Otra foto del mismo remito (mismo número): es el mismo, no suma.
  const dup = await api('POST', '/hooks/chofer/api/remitos', form('OK1B'), H);
  assert.equal(dup.data.estado, 'duplicado');
  assert.match(dup.data.mensaje, /ya estaba/);
  assert.equal((await remitosDe(A.id)).entrega.lineas[0].entregado, 1000, 'no se cuenta dos veces');

  // 4. Lo que no cierra queda para revisar, nunca va a un pedido «parecido».
  const mal = await api('POST', '/hooks/chofer/api/remitos', form('MALPDV'), H);
  assert.deepEqual([mal.data.estado, mal.data.pide_pdv], ['revisar', true]);
  assert.match(mal.data.mensaje, /no coincide en los dos lugares/);
  const borrosa = await api('POST', '/hooks/chofer/api/remitos', form('BORROSA'), H);
  assert.deepEqual([borrosa.data.estado, borrosa.data.repetir], ['revisar', true]);
  assert.match(borrosa.data.mensaje, /quedó cortado/);
  const norem = await api('POST', '/hooks/chofer/api/remitos', form('NOREM'), H);
  assert.deepEqual([norem.data.estado, norem.data.repetir], ['revisar', true]);
  const otro = await api('POST', '/hooks/chofer/api/remitos', form('OTROCUIT'), H);
  assert.equal(otro.data.estado, 'revisar');
  const rOtro = (await api('GET', '/remitos/revisar')).data.remitos.find((x) => x.id === otro.data.id);
  assert.ok(rOtro.controles.some((c) => c.dato === 'CUIT' && c.ok === false), 'el CUIT no es el del cliente');
  const sinpdv = await api('POST', '/hooks/chofer/api/remitos', form('SINPDV'), H);
  assert.equal(sinpdv.data.estado, 'revisar');
  const rSin = (await api('GET', '/remitos/revisar')).data.remitos.find((x) => x.id === sinpdv.data.id);
  assert.ok(rSin.candidatos.some((c) => c.id === B.id), 'sin PDV: los pedidos de la empresa, para elegir');
  assert.ok((await api('GET', '/remitos/revisar/cuantos')).data.total >= 5);

  // 4b. El PDV que escribe el chofer: el remito no lo dice, la app se lo pide y, con el CUIT del cliente, va al pedido
  // (sin volver a leer la foto).
  const pide = await api('POST', '/hooks/chofer/api/remitos', form('PIDEPDV'), H);
  assert.deepEqual([pide.data.estado, pide.data.pide_pdv], ['revisar', true]);
  assert.match(pide.data.mensaje, /No se lee el número de PDV/);
  assert.equal((await api('POST', `/hooks/chofer/api/remitos/${pide.data.id}/pdv`, { pdv: 'abc' }, H)).status, 400);
  const leidasAntes = lecturas;
  const corr = await api('POST', `/hooks/chofer/api/remitos/${pide.data.id}/pdv`, { pdv: PDV }, H);
  assert.deepEqual([corr.status, corr.data.estado, corr.data.pedido?.id, corr.data.pdv_chofer, corr.data.pide_pdv], [200, 'ok', A.id, PDV, false]);
  assert.equal(lecturas, leidasAntes, 'no se vuelve a leer la foto');
  assert.ok((await remitosDe(A.id)).remitos.find((x) => x.id === pide.data.id).controles.some((c) => c.dato === 'PDV' && /chofer/.test(c.detalle)));

  // 5. La segunda entrega completa el pedido A.
  const m2 = await api('POST', '/hooks/chofer/api/remitos', form('OK2'), H);
  assert.equal(m2.data.estado, 'ok', m2.data.mensaje);
  r = await remitosDe(A.id);
  assert.equal(r.entrega.estado, 'completa');
  assert.equal(r.entrega.alerta, null);
  assert.equal((await props(A.id)).falta_entregar, undefined);

  // 6. Revisión: el del PDV que no coincide se descarta; confirmarlo en el pedido lo contaría.
  assert.equal((await api('POST', `/remitos/${mal.data.id}/revisar`, { accion: 'descartar' })).data.estado, 'descartado');
  assert.equal((await remitosDe(A.id)).entrega.estado, 'completa');
  // El que no tenía PDV: Logística elige el pedido B y lo confirma.
  asUser = logi.email;
  assert.equal((await api('POST', `/remitos/${sinpdv.data.id}/revisar`, { accion: 'confirmar', pedido: B.id })).data.estado, 'ok');
  asUser = null;

  // 6b. Un remito de dos hojas: la segunda hoja (mismo número, otros productos) suma; otra foto de esa hoja, no.
  const C = await pedidoDe(PDV_C);
  assert.equal((await api('GET', `/records/order/${C.id}/products`)).data.items.length, 2);
  assert.equal((await api('POST', '/hooks/chofer/api/remitos', form('HOJA1'), H)).data.estado, 'ok');
  assert.deepEqual((await remitosDe(C.id)).entrega.lineas.map((l) => l.falta), [0, 50]);
  const h2 = await api('POST', '/hooks/chofer/api/remitos', form('HOJA2'), H);
  assert.equal(h2.data.estado, 'ok', h2.data.mensaje);
  let rC = await remitosDe(C.id);
  assert.equal(rC.entrega.estado, 'completa');
  assert.ok(rC.remitos.find((x) => x.id === h2.data.id).controles.some((c) => c.dato === 'Hoja' && c.ok === true));
  assert.equal((await api('POST', '/hooks/chofer/api/remitos', form('HOJA2B'), H)).data.estado, 'duplicado');
  rC = await remitosDe(C.id);
  assert.deepEqual(rC.entrega.lineas.map((l) => [l.entregado, l.falta, l.excede]), [[100, 0, 0], [50, 0, 0]], 'cada hoja una vez');

  // 6c. Renglones sin código y dos productos parecidos (dos materas): se emparejan por las palabras y se reparten, uno a
  // cada producto. Antes daba «falta» en uno y «de más» en el otro.
  const D = await pedidoDe(PDV_D);
  assert.equal((await api('GET', `/records/order/${D.id}/products`)).data.items.length, 2);
  const mat = await api('POST', '/hooks/chofer/api/remitos', form('MATERAS'), H);
  assert.equal(mat.data.estado, 'ok', mat.data.mensaje);
  const rD = await remitosDe(D.id);
  assert.equal(rD.entrega.estado, 'completa');
  assert.deepEqual(rD.entrega.lineas.map((l) => [l.entregado, l.falta, l.excede]), [[1, 0, 0], [1, 0, 0]]);

  // 6d. Un renglón que el remito dice con otro nombre («Jarro Bossa Waterdog» es el «Producción simple drinkware
  // genérico» del pedido) queda «en los remitos pero no en el pedido» hasta que una persona dice a qué producto va y
  // cuánto: 70 de 100, quedan 30. Se puede repartir entre varios productos, no pasar lo que dice el remito, deshacer, y
  // sigue asignado si el remito se vuelve a leer.
  const F = await pedidoDe(PDV_F);
  assert.equal((await api('GET', `/records/order/${F.id}/products`)).data.items.length, 2);
  const jar = await api('POST', '/hooks/chofer/api/remitos', form('JARROS'), H);
  assert.equal(jar.data.estado, 'ok', jar.data.mensaje);
  let rF = (await remitosDe(F.id)).entrega;
  assert.equal(rF.estado, 'diferencias');
  assert.deepEqual(rF.extras.map((x) => [x.description, x.quantity]), [['Jarro Bossa Waterdog', 70]]);
  const iDrk = rF.lineas.findIndex((l) => l.code === 'DRK-1');
  const iGor = rF.lineas.findIndex((l) => l.code === 'GOR-1');
  const porCodigo = (e) => [e.lineas[iDrk], e.lineas[iGor]].map((l) => [l.entregado, l.falta, l.excede]);
  const claveJarro = rF.extras[0].clave;
  const asignar = (lineas, k = claveJarro) => api('POST', `/records/order/${F.id}/entrega/asignar`, { clave: k, lineas });
  const mas = await asignar([{ i: iDrk, cantidad: 80 }]);
  assert.equal(mas.status, 400, 'no más de lo que dice el remito');
  assert.match(mas.data.error, /Asignaste 80 y el remito dice 70/);
  assert.equal((await asignar([{ i: iDrk, cantidad: 1 }], 'no-existe')).status, 400);
  assert.equal((await asignar([{ i: 99, cantidad: 1 }])).status, 400, 'un producto del pedido');
  let as = await asignar([{ i: iDrk, cantidad: 70 }]);
  assert.equal(as.status, 200, JSON.stringify(as.data));
  assert.equal(as.data.estado, 'parcial');
  assert.deepEqual(porCodigo(as.data), [[70, 30, 0], [50, 0, 0]]);
  assert.deepEqual([as.data.extras.length, as.data.asignados.length, as.data.asignados[0].a[0].cantidad], [0, 1, 70]);
  assert.match((await props(F.id)).falta_entregar, /^30 /);
  // Repartido entre dos productos, sin llegar a 70: lo que sobra sigue «en los remitos pero no en el pedido».
  as = await asignar([{ i: iDrk, cantidad: 40 }, { i: iGor, cantidad: 20 }]);
  assert.deepEqual(porCodigo(as.data), [[40, 60, 0], [70, 0, 20]]);
  as = await asignar([{ i: iDrk, cantidad: 60 }]);
  assert.deepEqual(as.data.extras.map((x) => [x.quantity, x.sin_asignar]), [[10, true]]);
  // Deshacer.
  as = await asignar([]);
  assert.deepEqual([as.data.estado, as.data.asignados.length, as.data.extras[0].quantity], ['diferencias', 0, 70]);
  // Asignado y el remito se vuelve a leer: sigue asignado.
  await asignar([{ i: iDrk, cantidad: 70 }]);
  assert.equal((await api('POST', `/remitos/${jar.data.id}/revisar`, { accion: 'releer' })).status, 200);
  rF = (await remitosDe(F.id)).entrega;
  assert.deepEqual([rF.estado, ...porCodigo(rF)], ['parcial', [70, 30, 0], [50, 0, 0]], 'sigue asignado después de releer');

  // 6e. En la revisión: el PDV y el CUIT son del pedido, pero ningún producto se reconoce, así que queda para revisar.
  // Al confirmarlo se elige el par de cada producto en el pedido. Después queda en «Revisados», con quién y los pares.
  const tz = await api('POST', '/hooks/chofer/api/remitos', form('TAZAS'), H);
  assert.equal(tz.data.estado, 'revisar', tz.data.mensaje);
  assert.equal((await api('POST', `/remitos/${tz.data.id}/revisar`, { accion: 'confirmar', pedido: F.id, productos: [{ position: 5, i: iDrk }] })).status, 400, 'un renglón que no existe');
  assert.equal((await remitosDe(F.id)).remitos.find((x) => x.id === tz.data.id).estado, 'revisar', 'no cambió nada');
  const conf = await api('POST', `/remitos/${tz.data.id}/revisar`, { accion: 'confirmar', pedido: F.id, productos: [{ position: 0, i: iDrk }, { position: 1, i: iDrk }] });
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  assert.equal(conf.data.estado, 'ok');
  rF = (await remitosDe(F.id)).entrega;
  assert.deepEqual([rF.estado, ...porCodigo(rF)], ['completa', [100, 0, 0], [50, 0, 0]], '70 del jarro + 20 + 10 de las tazas');
  const rev = (await api('GET', '/remitos/revisados')).data.remitos.find((x) => x.id === tz.data.id);
  assert.ok(rev?.revisado_por && rev.revisor, 'en «Revisados», con quién lo revisó');
  assert.deepEqual(rev.pares.map((x) => [x.position, x.i, x.cantidad]), [[0, iDrk, 20], [1, iDrk, 10]]);
  assert.ok(!(await api('GET', '/remitos/revisar')).data.remitos.some((x) => x.id === tz.data.id), 'ya no está para revisar');

  // 6f. Un remito de dos pedidos (un camión, un remito, dos PDV): en la revisión se suman los dos y se dice a cuál va cada
  // renglón. Cada pedido cuenta lo suyo; el remito se ve en los dos. Lo que no se asigna a ninguno se busca en el principal.
  const G = await pedidoDe(PDV_G);
  const Hp = await pedidoDe(PDV_H);
  assert.ok(G && Hp, 'los pedidos G y H vinieron de ClickUp');
  const cmp = await api('POST', '/hooks/chofer/api/remitos', form('COMPARTIDO'), H);
  assert.equal(cmp.data.estado, 'revisar', cmp.data.mensaje);
  const revisarCmp = (body) => api('POST', `/remitos/${cmp.data.id}/revisar`, { accion: 'confirmar', pedido: G.id, ...body });
  assert.equal((await revisarCmp({ pedidos: [Hp.id], productos: [{ position: 0, pedido: B.id, i: 0 }] })).status, 400, 'un pedido que no es del remito');
  const doble = await revisarCmp({ pedidos: [Hp.id], productos: [{ position: 0, pedido: Hp.id, i: 0 }, { position: 1, pedido: G.id, i: 0 }] });
  assert.equal(doble.status, 200, JSON.stringify(doble.data));
  assert.equal(doble.data.estado, 'ok');
  const entregaDe = async (id) => (await remitosDe(id)).entrega;
  const resumen = (e) => [e.estado, e.lineas.map((l) => [l.entregado, l.falta]), e.extras.length];
  assert.deepEqual(resumen(await entregaDe(G.id)), ['completa', [[110, 0]], 0]);
  assert.deepEqual(resumen(await entregaDe(Hp.id)), ['completa', [[236, 0]], 0]);
  const enH = (await remitosDe(Hp.id)).remitos.find((x) => x.id === cmp.data.id);
  assert.deepEqual(enH?.pedidos.map((x) => x.id), [G.id, Hp.id], 'el remito se ve en H, con sus dos pedidos (el principal primero)');
  assert.equal((await props(Hp.id)).estado_entrega, 'completa');
  const revCmp = (await api('GET', '/remitos/revisados')).data.remitos.find((x) => x.id === cmp.data.id);
  assert.deepEqual(revCmp.pares.map((x) => [x.position, x.pedido, x.i, x.cantidad]), [[0, Hp.id, 0, 236], [1, G.id, 0, 110]]);
  // Desde la ficha de H: deshacer su renglón lo devuelve al principal (G, donde no se reconoce: diferencia); en H queda
  // para asignar sin ser una diferencia de H. Se vuelve a asignar desde H, sin pasar lo que dice el remito.
  const claveH = (await entregaDe(Hp.id)).asignados[0].clave;
  const asignarH = (lineas) => api('POST', `/records/order/${Hp.id}/entrega/asignar`, { clave: claveH, lineas });
  let eH = (await asignarH([])).data;
  assert.deepEqual([eH.estado, eH.extras.map((x) => [x.quantity, x.compartido])], ['parcial', [[236, G.name]]]);
  assert.equal((await entregaDe(G.id)).estado, 'diferencias');
  assert.equal((await asignarH([{ i: 0, cantidad: 300 }])).status, 400);
  eH = (await asignarH([{ i: 0, cantidad: 236 }])).data;
  assert.equal(eH.estado, 'completa');
  assert.deepEqual(resumen(await entregaDe(G.id)), ['completa', [[110, 0]], 0]);
  // Otra foto del mismo remito que dice el PDV de H: es el mismo remito, no suma.
  assert.equal((await api('POST', '/hooks/chofer/api/remitos', form('COMPARTIDO_H'), H)).data.estado, 'duplicado');
  // Quitar H del remito: deja de verse ahí y su renglón vuelve a G (donde queda como diferencia).
  assert.equal((await revisarCmp({ pedidos: [] })).status, 200);
  assert.ok(!(await remitosDe(Hp.id)).remitos.some((x) => x.id === cmp.data.id), 'ya no está en H');
  assert.equal((await props(Hp.id)).estado_entrega, undefined);
  assert.equal((await entregaDe(G.id)).estado, 'diferencias');
  // Y volver a sumarlo: lo que tenía asignado en H vuelve a valer.
  assert.equal((await revisarCmp({ pedidos: [Hp.id] })).status, 200);
  assert.deepEqual([(await entregaDe(G.id)).estado, (await entregaDe(Hp.id)).estado], ['completa', 'completa']);

  // 7. Pedido B: una entrega parcial y un remito subido en el CRM (elegido por una persona: alcanza con el PDV).
  assert.equal((await api('POST', '/hooks/chofer/api/remitos', form('B1'), H)).data.estado, 'ok');
  const crm = await api('POST', `/records/order/${B.id}/remitos`, form('CRM1'));
  assert.equal(crm.status, 201);
  assert.equal(crm.data.remito.estado, 'ok', crm.data.remito.motivo);
  assert.equal(crm.data.remito.origen, 'crm');
  r = await remitosDe(B.id);
  assert.equal(r.entrega.estado, 'parcial');
  assert.deepEqual(r.entrega.lineas.map((l) => [l.entregado, l.falta]), [[65, 35]]);

  // 8. Finalizar con faltante: solo Logística o un administrador, con el motivo; se puede reabrir.
  asUser = `vende.rem.${RUN}@formas.ar`;
  assert.equal((await api('POST', `/records/order/${B.id}/entrega/finalizar`, { motivo: 'El cliente aceptó' })).status, 403);
  asUser = logi.email;
  assert.equal((await api('POST', `/records/order/${B.id}/entrega/finalizar`, { motivo: '' })).status, 400, 'pide el motivo');
  const fin = await api('POST', `/records/order/${B.id}/entrega/finalizar`, { motivo: 'El cliente aceptó 65 de 100: el resto salió fallado.' });
  assert.equal(fin.data.estado, 'cerrada_con_faltante');
  const pb = await props(B.id);
  assert.deepEqual([pb.estado_entrega, pb.entrega_cerrada_por, pb.entrega_cerrada_motivo], ['cerrada_con_faltante', logi.id, 'El cliente aceptó 65 de 100: el resto salió fallado.']);
  assert.equal((await api('DELETE', `/records/order/${B.id}/entrega/finalizar`)).data.estado, 'parcial');
  asUser = null;
  // A un pedido completo no se le «finaliza con faltante».
  assert.equal((await api('POST', `/records/order/${A.id}/entrega/finalizar`, { motivo: 'nada' })).status, 400);

  // El mail de faltantes: a Logística y a los administradores (como el usuario de desarrollo) con los avisos prendidos;
  // a la otra persona de Logística, no. El de A no sale: se completó antes de que saliera.
  const tokA = (await api('POST', '/tokens', { name: `Avisos ${RUN}`, source: 'api' })).data.token;
  const HA = { authorization: `Bearer ${tokA}` };
  if ((await api('GET', '/hooks/avisos', undefined, HA)).data.has_credentials) {
    const admin = (await api('GET', '/meta')).data.me;
    assert.equal(admin.role, 'admin');
    await api('PUT', '/hooks/avisos', { enabled: true }, HA);
    await api('POST', '/hooks/avisos/enviar', undefined, HA);
    const para = (email) => mails.filter((m) => m.includes(`<${email}>`)).map(textoDe);
    assert.equal(para(logi2.email).length, 0, 'sin los avisos prendidos no le llega');
    for (const lista of [para(logi.email), para(admin.email)]) {
      const m = lista.find((x) => x.includes(B.name));
      assert.ok(m, 'le llegó el faltante del pedido B');
      assert.match(m, /falta 35 Gorra bordada/);
      assert.ok(!lista.some((x) => x.includes(A.name)), 'el pedido A ya está completo');
    }
  }

  await api('PATCH', `/users/${adminDev.id}`, { avisos_mail: false });

  // 9. Lo que ve el chofer: sus remitos, el más nuevo primero, con el mensaje de cada uno.
  const mios = (await api('GET', '/hooks/chofer/api/remitos', undefined, H)).data.remitos;
  assert.equal(mios[0].id, (await api('POST', '/hooks/chofer/api/remitos', form('B1', { clave: 'x' }), H)).data.id);
  assert.ok(mios.some((x) => x.estado === 'ok' && x.pedido?.id === A.id));
  // «¿No es este pedido?»: el chofer corrige un PDV bien leído. No se cambia a ciegas: deja de contar y lo revisa
  // Logística, con los dos pedidos posibles. Otro chofer no puede tocar sus remitos.
  const contra = await api('POST', '/hooks/chofer/api/remitos', form('CONTRA'), H);
  assert.deepEqual([contra.data.estado, contra.data.pedido?.id], ['ok', B.id]);
  const enB = (await remitosDe(B.id)).entrega.lineas[0].entregado;
  asUser = logi.email;
  const ch2 = (await api('POST', '/choferes', { name: `Pedro ${RUN}` })).data;
  asUser = null;
  assert.equal((await api('POST', `/hooks/chofer/api/remitos/${contra.data.id}/pdv`, { pdv: PDV }, { authorization: `Bearer ${ch2.token}` })).status, 404);
  const c2 = await api('POST', `/hooks/chofer/api/remitos/${contra.data.id}/pdv`, { pdv: PDV }, H);
  assert.equal(c2.data.estado, 'revisar');
  assert.match(c2.data.mensaje, /Logística lo revisa/);
  assert.equal((await remitosDe(B.id)).entrega.lineas[0].entregado, enB - 1, 'ya no cuenta en B');
  const rc = (await api('GET', '/remitos/revisar')).data.remitos.find((x) => x.id === contra.data.id);
  assert.ok(rc.candidatos.some((c) => c.id === A.id) && rc.candidatos.some((c) => c.id === B.id), 'los dos pedidos posibles');
  assert.equal(rc.pdv_chofer, PDV);
  // La misma foto mandada por otro chofer (reenviada): entra aparte (cada uno ve lo suyo), pero como el remito ya está
  // para revisar, este también; y si Logística confirma los dos en el mismo pedido, el segundo queda repetido.
  const otraVez = await api('POST', '/hooks/chofer/api/remitos', form('CONTRA'), { authorization: `Bearer ${ch2.token}` });
  assert.notEqual(otraVez.data.id, contra.data.id);
  assert.equal(otraVez.data.estado, 'revisar');
  asUser = logi.email;
  assert.equal((await api('POST', `/remitos/${contra.data.id}/revisar`, { accion: 'confirmar', pedido: B.id })).data.estado, 'ok');
  assert.equal((await api('POST', `/remitos/${otraVez.data.id}/revisar`, { accion: 'confirmar', pedido: B.id })).data.estado, 'duplicado');
  asUser = null;
  assert.equal((await remitosDe(B.id)).entrega.lineas[0].entregado, enB, 'contado una sola vez');
  // Dar de baja el link: deja de andar.
  asUser = logi.email;
  const lista = (await api('GET', '/choferes')).data;
  const yo = lista.find((x) => x.name === `Juan ${RUN}`);
  assert.ok(yo.remitos >= 8);
  await api('DELETE', `/choferes/${yo.id}`);
  assert.equal((await api('GET', `/choferes/${yo.id}/link`)).status, 410, 'dado de baja, el link ya no se muestra');
  asUser = null;
  assert.equal((await api('GET', '/hooks/chofer/api/yo', undefined, H)).status, 401);

  // 10. La página de la app se sirve desde /hooks (sin el login de Access), con sus archivos.
  const pag = await fetch(`${BASE}/hooks/chofer/`);
  const html = await pag.text();
  assert.equal(pag.status, 200);
  assert.match(pag.headers.get('content-type') ?? '', /text\/html/);
  assert.match(html, /\/hooks\/chofer\/assets\//);
  const js = html.match(/\/hooks\/chofer\/assets\/[^"']+\.js/)?.[0];
  assert.equal((await fetch(`${BASE}${js}`)).status, 200);
  assert.equal((await fetch(`${BASE}/hooks/chofer/no-existe.js`)).status, 404);
  assert.equal((await fetch(`${BASE}/hooks/chofer`, { redirect: 'manual' })).status, 301);
  // El manifest con el link del chofer: guardada en la pantalla de inicio (iPhone), abre ya con su link.
  const man = async (q) => { const r = await fetch(`${BASE}/hooks/chofer/manifest.webmanifest${q}`); return { tipo: r.headers.get('content-type'), cache: r.headers.get('cache-control'), m: await r.json() }; };
  const conLink = await man(`?t=${ch.token}`);
  assert.equal(conLink.m.start_url, `/hooks/chofer/#t=${ch.token}`);
  assert.deepEqual([conLink.m.id, conLink.m.scope, conLink.cache], ['/hooks/chofer/', '/hooks/chofer/', 'no-store']);
  assert.match(conLink.tipo, /manifest\+json/);
  assert.equal((await man('')).m.start_url, '/hooks/chofer/');
  assert.equal((await man('?t=<script>')).m.start_url, '/hooks/chofer/', 'solo se copia algo con forma de token');
});
