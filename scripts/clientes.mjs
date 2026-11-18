// Compras de cada cliente: Finnegans → empresas del CRM. Corre cada noche en GitHub Actions (.github/workflows/clientes.yml).
//
// Trae los pedidos de venta de Finnegans (desde 2023), les suma el histórico de facturas anterior (2020-2022, que el CRM
// guarda en compras_historicas), pasa cada compra al dólar MEP de su día y calcula por cliente el estado (con los umbrales
// del tablero de márgenes), la última compra, la compra histórica, el ticket promedio, el ritmo de compra y el saldo.
// Después lo cruza con las empresas del CRM (código de Finnegans, CUIT o nombre) y lo aplica. Detalle en docs/CLIENTES.md.
//
//   CRM_URL=https://formas-crm.rodrigo-mateus.workers.dev CRM_TOKEN=fcrm_… FIN_CLIENT_ID=… FIN_SECRET=… node scripts/clientes.mjs
//   DRY_RUN=1 calcula y muestra el resumen sin aplicar nada.
//
// EL REPO ES PÚBLICO: este script nunca imprime nombres, CUIT ni montos, solo cantidades.
import { pathToFileURL } from 'node:url';

const FIN = (process.env.FINNEGANS_API_URL ?? 'https://api.finneg.com/api').replace(/\/$/, '');
const MEP_URL = process.env.MEP_URL ?? 'https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa';
const DESDE_PEDIDOS = '2023-01-01';
const EMPRESAS = ['EMPRE01', '7'];   // Formas Publicitarias SA y FP DEMO
const DIA = 86_400_000;
// Umbrales del tablero de márgenes (refresh_margenes.py): 12 meses para recuperado/perdido; en riesgo, más de 90 días y
// más de 2,5 veces su ritmo sin comprar, para clientes con 3 compras o más desde 2024.
const MESES_12 = 365;
const RECUPERO = 12 * 30.44;
const RIESGO_PISO = 90;
const RIESGO_RATIO = 2.5;
const RIESGO_DESDE = '2024-01-01';

// ---------- Utilidades ----------

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Igual que en el CRM (clickup.ts): sin puntos ni la forma societaria del final.
export const companyKey = (s) => norm(s).replace(/[.,]/g, '').replace(/(\s(s ?r ?l|s ?a ?s|s ?a ?u|s ?a ?i ?c|s ?a ?c ?i ?f|s ?a|s ?h))+$/, '').trim();
export const cuitDigits = (s) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length === 11 ? d : null; };
const cuitFmt = (d) => `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
export const dmy = (s) => { const m = String(s ?? '').match(/^(\d{2})-(\d{2})-(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}/.test(s ?? '') ? s.slice(0, 10) : null); };
const dias = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DIA);
const masDias = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DIA).toISOString().slice(0, 10);
const moda = (xs) => { const c = new Map(); for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
const mediana = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- Reglas de qué cuenta como compra (las del tablero) ----------

export function unidadDe(subtipo, texto, vendedor) {
  if (/no[\s\-_]*estr?e+s+/i.test(texto) || /^noestres$/i.test(vendedor ?? '')) return 'NoEstres';
  if (/- ?FP\b/i.test(subtipo)) return 'Corporate';
  if (/- ?STP\b/i.test(subtipo)) return 'Formas Shop';
  if (/meli/i.test(subtipo)) return 'Mercado Libre';
  if (/marketshell/i.test(subtipo)) return 'MarketShell';
  if (/noestres/i.test(subtipo)) return 'NoEstres';
  return 'Otros';
}

// Un pedido de venta (todas sus líneas) → una compra, o null si no cuenta.
export function compraDePedido(lineas) {
  const l0 = lineas[0];
  const subtipo = moda(lineas.map((l) => l.TRANSACCONSUBTIPONOMBRE)) ?? '';
  if (/objetivo/i.test(subtipo) || lineas.every((l) => /anulad/i.test(l.ESTADO ?? ''))) return null;
  const fecha = lineas.map((l) => dmy(l.FECHA)).filter(Boolean).sort()[0];
  const importe = lineas.reduce((s, l) => s + Number(l.IMPORTEMONPRINCIPAL ?? l.IMPORTE ?? 0), 0);
  const cliente = (moda(lineas.map((l) => String(l.CLIENTE ?? '').replace(/\s+/g, ' ').trim())) ?? '').trim();
  const texto = lineas.map((l) => [l.USRNUMOC, l.DESCRIPCION, l.DESCITEM, l.PRODUCTO, l.FAMILIA].filter(Boolean).join(' ')).join(' ');
  const vendedor = moda(lineas.map((l) => String(l.VENDEDOR ?? '').trim()).filter((v) => v && !/^stp$/i.test(v)));
  const unidad = unidadDe(subtipo, texto, vendedor);
  if (!fecha || !cliente || !(importe > 0)) return null;
  if (/benefic/i.test(texto)) return null;                                                    // beneficios al personal
  if (unidad === 'Formas Shop' && /trafigura|refiner[ií]a\s+bah[ií]a\s+blanca/i.test(texto)) return null;
  if (/^\s*formas\s+publicitarias/i.test(cliente) && !/anti[\s\-]?estr[eé]?s|pelot/i.test(texto)) return null;   // ventas a Formas
  if (unidad === 'Mercado Libre' || unidad === 'MarketShell') return null;                   // canales sin cliente
  return { doc: `${l0.EMPRESA ?? ''}:${l0.DOCNROINT}`, fecha, importe, cliente, cuit: cuitDigits(moda(lineas.map((l) => l.NRODEIDENTIFICACION))), vendedor, unidad };
}

export function agruparPedidos(rows) {
  const porDoc = new Map();
  for (const r of rows) {
    if (!r.DOCNROINT) continue;
    const k = `${r.EMPRESA ?? ''}:${r.DOCNROINT}`;
    if (!porDoc.has(k)) porDoc.set(k, []);
    porDoc.get(k).push(r);
  }
  return [...porDoc.values()].map(compraDePedido).filter(Boolean);
}

// ---------- Estado del cliente ----------

// compras: [{fecha, usd, pedido: bool}] de un cliente. Devuelve las propiedades de la empresa.
export function calcular(compras, hoy) {
  const cs = compras.filter((c) => c.fecha <= hoy).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const reales = cs.filter((c) => c.usd > 0);   // las notas de crédito restan plata pero no son compras
  if (!reales.length) return null;
  const fechas = reales.map((c) => c.fecha);
  const primera = fechas[0];
  const ultima = fechas[fechas.length - 1];
  const silencio = dias(ultima, hoy);
  const hace12 = masDias(hoy, -MESES_12);
  const desdeRiesgo = fechas.filter((f) => f >= RIESGO_DESDE);
  const gaps = desdeRiesgo.slice(1).map((f, i) => dias(desdeRiesgo[i], f));
  const cadencia = desdeRiesgo.length >= 3 ? mediana(gaps) : null;
  const recupero = fechas.some((f, i) => i > 0 && f > hace12 && dias(fechas[i - 1], f) > RECUPERO);
  let estado;
  if (silencio > 2 * MESES_12) estado = 'Dormido';
  else if (silencio > MESES_12) estado = 'Perdido';
  else if (cadencia && silencio > Math.max(RIESGO_PISO, RIESGO_RATIO * cadencia)) estado = 'En riesgo';
  else if (primera > hace12) estado = 'Nuevo';
  else if (recupero) estado = 'Recuperado';
  else estado = 'Activo';
  const total = cs.reduce((s, c) => s + c.usd, 0);
  const ult12 = cs.filter((c) => c.fecha > hace12);
  return {
    estado_cliente: estado,
    fecha_primera_compra: primera,
    fecha_ultima_compra: ultima,
    cantidad_de_compras: reales.length,
    compra_historica_usd: Math.round(total),
    compra_12m_usd: Math.round(ult12.reduce((s, c) => s + c.usd, 0)),
    ticket_promedio_usd: Math.round(total / reales.length),
    cada_cuanto_compra: cadencia == null ? null : Math.round(cadencia),
    vendedora_finnegans: moda(ult12.map((c) => c.vendedor)) ?? [...cs].reverse().find((c) => c.vendedor)?.vendedor ?? null,
    unidad_finnegans: moda((ult12.length ? ult12 : cs).map((c) => c.unidad)) ?? null,
  };
}

// ---------- Dólar MEP ----------

export function mepPorFecha(serie) {
  const pts = serie.map((x) => [x.fecha, Number(x.venta ?? x.compra)]).filter(([f, v]) => f && v > 0).sort((a, b) => a[0].localeCompare(b[0]));
  return (fecha) => {
    let lo = 0, hi = pts.length - 1, ans = pts[0];
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= fecha) { ans = pts[mid]; lo = mid + 1; } else hi = mid - 1; }
    return ans?.[1] ?? null;
  };
}

// ---------- Acceso a Finnegans y al CRM ----------

async function getJson(url, init, intentos = 4) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(url, init);
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(txt);   // la API de Finnegans a veces corta la respuesta: se reintenta
    } catch (e) { ultimo = e; await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
  throw new Error(`${url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')}: ${ultimo.message}`);
}

async function finToken() {
  const id = process.env.FINNEGANS_CLIENT_ID || process.env.FIN_CLIENT_ID;
  const secret = process.env.FINNEGANS_CLIENT_SECRET || process.env.FIN_SECRET;
  if (!id || !secret) throw new Error('Faltan FINNEGANS_CLIENT_ID y FINNEGANS_CLIENT_SECRET.');
  const res = await fetch(`${FIN}/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`);
  if (!res.ok) throw new Error(`Finnegans token: HTTP ${res.status}`);
  return (await res.text()).trim().replace(/^"|"$/g, '');
}

const finUrl = (tok, path, params = {}, raw = '') => `${FIN}/${path}?${new URLSearchParams({ ...params, ACCESS_TOKEN: tok })}${raw}`;

async function traerPedidos(tok, hasta) {
  const rows = [];
  for (const emp of EMPRESAS) {
    for (let d = DESDE_PEDIDOS; d <= hasta; d = masDias(d, 31)) {
      const h = masDias(d, 30) < hasta ? masDias(d, 30) : hasta;
      const r = await getJson(finUrl(tok, 'reports/AnalisisdePedidosdeVentaPorProducto', { PARAMWEBREPORT_FechaDesde: d, PARAMWEBREPORT_FechaHasta: h, PARAMWEBREPORT_Empresa: emp }));
      if (Array.isArray(r)) rows.push(...r.map((x) => ({ ...x, EMPRESA: x.EMPRESA ?? emp })));
    }
  }
  return rows;
}

async function traerSaldos(tok, hoy) {
  // Las dos empresas juntas, con la coma y los corchetes sin escapar (si no, el reporte vuelve vacío).
  const r = await getJson(finUrl(tok, 'reports/COMPOSICIONSALDOSCLIENTES', { PARAMWEBREPORT_fecha: hoy }, `&PARAMWEBREPORT_Empresa=[${EMPRESAS.join(',')}]`));
  const porCuit = new Map();
  const codigoDe = new Map();
  for (const x of Array.isArray(r) ? r : []) {
    if (x.CUENTA !== 'Deudores en Cta. Cte.') continue;
    const cuit = cuitDigits(x.CUIT);
    if (!cuit) continue;
    if (x.ORGANIZACIONCODIGO) codigoDe.set(String(x.ORGANIZACIONCODIGO), cuit);
    const imp = Number(x.IMPORTEMONPPAL ?? 0);
    if (!(imp > 0)) continue;   // los recibos sin aplicar van aparte (no se netean), como en el tablero
    const s = porCuit.get(cuit) ?? { saldo: 0, vencido: 0, nombre: x.ORGANIZACION };
    s.saldo += imp;
    const vto = dmy(x.FECHAVTO);
    if (vto && vto < hoy) s.vencido += imp;
    porCuit.set(cuit, s);
  }
  return { porCuit, codigoDe };
}

async function crm(path, init = {}) {
  const base = (process.env.CRM_URL ?? '').replace(/\/$/, '');
  if (!base || !process.env.CRM_TOKEN) throw new Error('Faltan CRM_URL y CRM_TOKEN.');
  const res = await fetch(`${base}${path}`, { ...init, redirect: 'manual', headers: { authorization: `Bearer ${process.env.CRM_TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`CRM ${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------- Armado ----------

export function armarClientes({ pedidos, historico, mep, saldos, hoy }) {
  const clientes = new Map();   // clave (CUIT o n:nombre) → { cuit, nombres:Set, compras:[] }
  const cuitDeNombre = new Map();
  for (const p of pedidos) if (p.cuit) cuitDeNombre.set(companyKey(p.cliente), p.cuit);
  const cliente = (cuit, nombre) => {
    const k = cuit ?? cuitDeNombre.get(companyKey(nombre)) ?? `n:${companyKey(nombre)}`;
    if (!clientes.has(k)) clientes.set(k, { clave: k, cuit: k.startsWith('n:') ? null : k, nombres: new Set(), compras: [], ultimo: ['', null] });
    const c = clientes.get(k);
    if (nombre) c.nombres.add(nombre);
    return c;
  };
  const anotar = (c, compra, nombre) => { c.compras.push(compra); if (nombre && compra.fecha >= c.ultimo[0]) c.ultimo = [compra.fecha, nombre]; };
  const desdePedidos = pedidos.map((p) => p.fecha).sort()[0] ?? DESDE_PEDIDOS;
  for (const p of pedidos) anotar(cliente(p.cuit, p.cliente), { fecha: p.fecha, usd: p.importe / (mep(p.fecha) ?? NaN), vendedor: p.vendedor, unidad: p.unidad, pedido: true }, p.cliente);
  // El histórico solo antes del primer pedido de Finnegans (después ya están los pedidos: no se cuenta dos veces).
  for (const h of historico) {
    if (h.fecha >= desdePedidos || /^\s*formas\s+publicitarias/i.test(h.cliente) || h.tipo === 'Anticipo') continue;
    const neto = h.tipo === 'Nota de crédito' ? -Math.abs(Number(h.neto)) : Number(h.neto);
    anotar(cliente(cuitDigits(h.cuit), h.cliente), { fecha: h.fecha, usd: neto / (mep(h.fecha) ?? NaN), vendedor: null, unidad: null, pedido: false }, h.cliente);
  }
  for (const [cuit, s] of saldos.porCuit) {
    const c = clientes.get(cuit) ?? cliente(cuit, s.nombre);
    c.saldo = s;
  }
  const out = [];
  for (const c of clientes.values()) {
    const props = calcular(c.compras.filter((x) => Number.isFinite(x.usd)), hoy) ?? {};
    if (c.saldo) { props.saldo_pendiente = Math.round(c.saldo.saldo); props.saldo_vencido = Math.round(c.saldo.vencido); }
    else if (Object.keys(props).length) { props.saldo_pendiente = 0; props.saldo_vencido = 0; }
    if (!Object.keys(props).length) continue;
    // El nombre de la compra más reciente, para completar la razón social de la empresa si no la tiene.
    out.push({ clave: c.clave, cuit: c.cuit, nombres: [...c.nombres], razon_social: c.ultimo[1] ?? [...c.nombres][0] ?? null, props });
  }
  return out;
}

// Cruce con las empresas del CRM: código de Finnegans, CUIT o nombre (solo si el nombre es de un único cliente).
export function cruzar(empresas, clientes, { codigoDe = new Map(), nombreDeCodigo = new Map() } = {}) {
  const porCuit = new Map(clientes.filter((c) => c.cuit).map((c) => [c.cuit, c]));
  const porNombre = new Map();
  for (const c of clientes) for (const n of c.nombres) {
    const k = companyKey(n);
    if (!k) continue;
    porNombre.set(k, porNombre.has(k) && porNombre.get(k) !== c ? 'varios' : c);
  }
  const updates = [];
  const via = { codigo: 0, cuit: 0, nombre: 0 };
  const sinCruce = [];
  for (const e of empresas) {
    let c = null, como = null;
    const codigo = e.codigo ? String(e.codigo).trim() : null;
    if (codigo) {
      const cu = codigoDe.get(codigo);
      if (cu && porCuit.get(cu)) { c = porCuit.get(cu); como = 'codigo'; }
      else if (nombreDeCodigo.get(codigo)) { const x = porNombre.get(companyKey(nombreDeCodigo.get(codigo))); if (x && x !== 'varios') { c = x; como = 'codigo'; } }
    }
    if (!c && cuitDigits(e.cuit) && porCuit.get(cuitDigits(e.cuit))) { c = porCuit.get(cuitDigits(e.cuit)); como = 'cuit'; }
    if (!c) for (const n of [e.razon_social, e.name]) {
      const x = n && porNombre.get(companyKey(n));
      if (x && x !== 'varios') { c = x; como = 'nombre'; break; }
    }
    if (!c) { sinCruce.push(e); continue; }
    via[como]++;
    const codigoFin = [...codigoDe.entries()].find(([, cu]) => cu === c.cuit)?.[0];
    updates.push({ id: e.id, props: c.props, completar: { cuit: c.cuit ? cuitFmt(c.cuit) : null, codigo_de_finnegans: codigoFin ?? null, razon_social: c.razon_social }, clave: c.clave });
  }
  return { updates, via, sinCruce };
}

// ---------- Corrida ----------

async function main() {
  const hoy = process.env.HOY ?? new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const t0 = Date.now();
  const tok = await finToken();
  const [rows, historico, serie, saldos, lista, empresas] = await Promise.all([
    traerPedidos(tok, hoy),
    crm('/hooks/clientes/historico'),
    getJson(MEP_URL),
    traerSaldos(tok, hoy),
    getJson(finUrl(tok, 'cliente/list')).catch(() => []),
    crm('/hooks/clientes/empresas'),
  ]);
  const pedidos = agruparPedidos(rows);
  const clientes = armarClientes({ pedidos, historico, mep: mepPorFecha(serie), saldos, hoy });
  const nombreDeCodigo = new Map((Array.isArray(lista) ? lista : []).map((x) => [String(x.codigo), x.nombre]));
  let { updates, via, sinCruce } = cruzar(empresas, clientes, { codigoDe: saldos.codigoDe, nombreDeCodigo });
  // Empresas con código de Finnegans que no cruzaron: el CUIT sale de la ficha del cliente.
  const codigoDe = new Map(saldos.codigoDe);
  const faltan = sinCruce.filter((e) => e.codigo && !codigoDe.has(String(e.codigo).trim())).slice(0, 300);
  for (const e of faltan) {
    const f = await getJson(finUrl(tok, `cliente/${encodeURIComponent(String(e.codigo).trim())}`), undefined, 2).catch(() => null);
    const cu = cuitDigits(f?.IdentificacionTributariaNumero ?? f?.identificacionTributariaNumero);
    if (cu) codigoDe.set(String(e.codigo).trim(), cu);
  }
  if (faltan.length) ({ updates, via, sinCruce } = cruzar(empresas, clientes, { codigoDe, nombreDeCodigo }));
  const cruzadas = new Set(updates.map((u) => u.id));
  const limpiar = empresas.filter((e) => e.estado && !cruzadas.has(e.id)).map((e) => e.id);
  const usadas = new Set(updates.map((u) => u.clave));
  const estados = {};
  for (const u of updates) estados[u.props.estado_cliente ?? 'Sin compras'] = (estados[u.props.estado_cliente ?? 'Sin compras'] ?? 0) + 1;
  const estadosTodos = {};
  for (const c of clientes) estadosTodos[c.props.estado_cliente ?? 'Solo saldo'] = (estadosTodos[c.props.estado_cliente ?? 'Solo saldo'] ?? 0) + 1;
  const resumen = {
    hoy, pedidos: pedidos.length, clientes: clientes.length, estados_clientes: estadosTodos,
    clientes_12m: clientes.filter((c) => c.props.compra_12m_usd > 0).length,
    empresas: empresas.length, cruzadas: updates.length, via, estados, limpiadas: limpiar.length,
    clientes_sin_empresa: clientes.filter((c) => !usadas.has(c.clave)).length,
    clientes_12m_sin_empresa: clientes.filter((c) => !usadas.has(c.clave) && c.props.compra_12m_usd > 0).length,
    segundos: Math.round((Date.now() - t0) / 1000),
  };
  console.log(JSON.stringify(resumen, null, 1));
  if (process.env.DRY_RUN) return;
  let aplicado = { actualizadas: 0, completadas: 0, limpiadas: 0 };
  for (let i = 0; i < Math.max(updates.length, 1); i += 100) {
    const last = i + 100 >= updates.length;
    const r = await crm('/hooks/clientes/aplicar', { method: 'POST', body: JSON.stringify({
      updates: updates.slice(i, i + 100).map(({ clave, ...u }) => u), limpiar: last ? limpiar : [], resumen: last ? resumen : undefined,
    }) });
    for (const k of Object.keys(aplicado)) aplicado[k] += r[k] ?? 0;
  }
  console.log(`Aplicado: ${aplicado.actualizadas} empresas con cambios, ${aplicado.completadas} datos de facturación completados, ${aplicado.limpiadas} limpiadas.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
