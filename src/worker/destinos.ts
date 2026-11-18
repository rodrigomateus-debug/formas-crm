import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { companyKey, norm } from './clickup';
import { actualizarLugares, claveDireccion, direccionLugar, hoyBsAs, puedeEditarCronograma, sumarDias, ubicar } from './cronograma';

// La base de destinos (pestaña Destinos de Recorridos), rediseñada el 18/11/2026 para que los destinos estén bien:
//
// - **Empresa y sucursales**: cada destino es una dirección; los de una misma empresa (casa central, depósito, otra
//   sucursal) se juntan en un grupo (`destino_grupos`). El Hub sugiere qué juntar (la misma empresa del CRM o el mismo
//   nombre) y Logística confirma.
// - **Tipo**: cliente, proveedor, impresor, taller, expreso u otro. Se pone solo lo que se sabe (la empresa del CRM y su
//   tipo de relación, los expresos del cronograma, palabras del nombre como «imprenta» o «transporte»; la IA, con ≥ 90 %);
//   lo que se pone a mano no lo pisa nada (`tipo_origen = 'manual'`).
// - **Dirección en partes**: calle y altura, localidad, provincia y código postal, con el lugar de Google Maps cuando se
//   eligió de Google, y el punto en el mapa (el mismo de la ruta del cronograma: `geocodigos`).
// - **Contacto** de cada destino (nombre, teléfono, WhatsApp, mail) y **viajes**: cuántos se hicieron (6 meses y en total),
//   el último y el próximo.
// - **Qué le falta** a cada uno (localidad, provincia, mapa, contacto, tipo), para filtrar los incompletos.

export const TIPOS = ['cliente', 'proveedor', 'impresor', 'taller', 'expreso', 'otro'] as const;
export type TipoDestino = (typeof TIPOS)[number];
export const esTipo = (v: unknown): v is TipoDestino => TIPOS.includes(v as TipoDestino);
const organiza = puedeEditarCronograma;

// ---------- El tipo, deducido ----------

const POR_NOMBRE: Array<[TipoDestino, RegExp]> = [
  ['expreso', /\b(expreso|transporte|transportes|cargas|encomiendas?|logistica|correo|andreani|oca|via cargo)\b/],
  ['impresor', /\b(imprenta|impresion(es)?|serigraf\w*|bordad\w*|sublima\w*|grafica|estampad\w*|tampograf\w*|laser|grabado\w*)\b/],
  ['taller', /\b(taller|costur\w*|confecci\w*|textil)\b/],
];

// Les pone tipo a los que no tienen (o tienen uno deducido que ya no vale): por la empresa del CRM, los expresos y el
// nombre. Lo puesto a mano o por la IA no se toca.
async function clasificar(db: D1Database) {
  const { results } = await db.prepare(`SELECT l.id, l.nombre, l.tipo, l.tipo_origen, json_extract(r.props, '$.tipo_de_relacion') AS rel, r.id AS empresa
    FROM lugares l LEFT JOIN records r ON r.id = l.company_id AND r.archived = 0
    WHERE l.activo = 1 AND (l.tipo IS NULL OR l.tipo_origen IN ('crm', 'expreso', 'nombre'))`)
    .all<{ id: number; nombre: string; tipo: string | null; tipo_origen: string | null; rel: string | null; empresa: number | null }>();
  if (!results.length) return;
  const expresos = new Set((await db.prepare("SELECT nombre FROM transportistas WHERE tipo = 'expreso' AND activo = 1").all<{ nombre: string }>()).results.map((x) => norm(x.nombre)));
  const stmts: D1PreparedStatement[] = [];
  for (const l of results) {
    const n = norm(l.nombre);
    let tipo: TipoDestino | null = null, origen: string | null = null;
    if ([...expresos].some((x) => x.length >= 3 && (n === x || n.startsWith(`${x} `) || n.includes(x)))) { tipo = 'expreso'; origen = 'expreso'; }
    else {
      const p = POR_NOMBRE.find(([, re]) => re.test(n));
      if (p) { tipo = p[0]; origen = 'nombre'; }
      else if (l.empresa) { tipo = l.rel === 'proveedor' ? 'proveedor' : l.rel === 'equipo' || l.rel === 'otro' ? 'otro' : 'cliente'; origen = 'crm'; }
    }
    if (tipo !== l.tipo || (tipo && origen !== l.tipo_origen)) stmts.push(db.prepare('UPDATE lugares SET tipo = ?, tipo_origen = ? WHERE id = ?').bind(tipo, tipo ? origen : null, l.id));
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
}

// ---------- Sugerencias de grupo ----------

const GENERICAS = new Set(['imprenta', 'deposito', 'oficina', 'oficinas', 'taller', 'expreso', 'transporte', 'transportes', 'sucursal', 'casa', 'central', 'planta', 'fabrica',
  'local', 'grupo', 'logistica', 'cargas', 'grafica', 'textil', 'industria', 'industrias', 'distribuidora', 'comercial', 'argentina', 'buenos', 'aires', 'nuevo', 'nueva',
  'santa', 'san', 'calle', 'avenida', 'showroom', 'administracion', 'retiro', 'entrega', 'muestras']);
function raiz(nombre: string) {
  const palabras = norm(nombre).replace(/[^a-z0-9ñ ]/g, ' ').split(' ').filter((w) => w.length >= 4 && !GENERICAS.has(w) && !/^\d+$/.test(w));
  return palabras[0] ?? null;
}

// ---------- La empresa del CRM de cada destino ----------

// El nombre para comparar un destino con una empresa del CRM: sin lo que va entre paréntesis («GADOR (DEPÓSITO)»), sin la
// forma societaria («Gador S.A.») y, en el segundo intento, sin las palabras de lugar («Depósito Gador»).
const DE_LUGAR = new Set(['deposito', 'depositos', 'oficina', 'oficinas', 'sucursal', 'planta', 'fabrica', 'showroom', 'administracion', 'recepcion', 'sede']);
const claveEmpresa = (s: string) => companyKey(s.replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
const sinLugar = (k: string) => k.split(' ').filter((w) => !DE_LUGAR.has(w)).join(' ');
const sirve = (k: string) => k.length >= 2 && !/^\d+$/.test(k);

// Relaciona con su empresa del CRM los destinos (y los grupos) que todavía no tienen una: la que se llama igual. Si hay
// varias con ese nombre, la que es cliente; si sigue habiendo varias, la que tiene dominio y, entre esas, la más vieja.
// Las direcciones de un grupo ya relacionado toman la empresa del grupo. Lo que se eligió o se quitó a mano
// (`empresa_origen = 'manual'`) no se toca.
export async function vincularEmpresas(db: D1Database) {
  const [lug, grp] = await db.batch([
    db.prepare('SELECT id, nombre, grupo_id FROM lugares WHERE activo = 1 AND company_id IS NULL AND empresa_origen IS NULL'),
    db.prepare('SELECT id, nombre, company_id, empresa_origen FROM destino_grupos'),
  ]);
  const lugares = lug.results as Array<{ id: number; nombre: string; grupo_id: number | null }>;
  const grupos = grp.results as Array<{ id: number; nombre: string; company_id: number | null; empresa_origen: string | null }>;
  const gruposSin = grupos.filter((g) => !g.company_id && !g.empresa_origen);
  if (!lugares.length && !gruposSin.length) return;
  const { results: empresas } = await db.prepare(`SELECT id, name, json_extract(props, '$.tipo_de_relacion') AS rel, NULLIF(json_extract(props, '$.domain'), '') AS dominio
    FROM records WHERE object_type = 'company' AND archived = 0 ORDER BY id`).all<{ id: number; name: string; rel: string | null; dominio: string | null }>();
  const porClave = new Map<string, typeof empresas>();
  for (const e of empresas) { const k = claveEmpresa(e.name ?? ''); if (sirve(k)) porClave.set(k, [...(porClave.get(k) ?? []), e]); }
  const elegir = (k: string) => {
    let c = sirve(k) ? porClave.get(k) ?? [] : [];
    if (c.length > 1) { const clientes = c.filter((e) => !e.rel || e.rel === 'cliente'); if (clientes.length) c = clientes; }
    if (c.length > 1) { const conDominio = c.filter((e) => e.dominio); if (conDominio.length) c = conDominio; }
    return c[0]?.id ?? null;
  };
  const buscar = (nombre: string) => { const k = claveEmpresa(nombre); return elegir(k) ?? (sinLugar(k) !== k ? elegir(sinLugar(k)) : null); };

  const stmts: D1PreparedStatement[] = [];
  const deGrupo = new Map(grupos.filter((g) => g.company_id).map((g) => [g.id, g.company_id!]));
  for (const g of gruposSin) {
    const id = buscar(g.nombre);
    if (!id) continue;
    deGrupo.set(g.id, id);
    stmts.push(db.prepare("UPDATE destino_grupos SET company_id = ?, empresa_origen = 'nombre' WHERE id = ? AND company_id IS NULL AND empresa_origen IS NULL").bind(id, g.id));
  }
  for (const l of lugares) {
    const delGrupo = l.grupo_id ? deGrupo.get(l.grupo_id) ?? null : null;
    const id = delGrupo ?? buscar(l.nombre);
    if (id) stmts.push(db.prepare('UPDATE lugares SET company_id = ?, empresa_origen = ? WHERE id = ? AND company_id IS NULL AND empresa_origen IS NULL').bind(id, delGrupo ? 'grupo' : 'nombre', l.id));
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
}

interface Fila {
  id: number; nombre: string; sucursal: string | null; direccion: string | null; localidad: string | null; provincia: string | null; codigo_postal: string | null; zona: string | null;
  horario: string | null; contacto: string | null; telefono: string | null; whatsapp: string | null; email: string | null; observaciones: string | null; company_id: number | null;
  origen: string; editado: number; created_by: number | null; tipo: string | null; tipo_origen: string | null; grupo_id: number | null; place_id: string | null;
  ia_estado: string | null; ia_nota: string | null; ia_antes: string | null; ia_sugerida: string | null; empresa: string | null; dominio: string | null; empresa_origen: string | null;
}

// ---------- La lista ----------

export async function listarDestinos(env: Env, user: User) {
  const db = env.DB;
  const cfg = await actualizarLugares(env, organiza(user));
  await vincularEmpresas(db);
  await clasificar(db);
  const hoy = hoyBsAs(), desde = sumarDias(hoy, -182);
  const [lugares, viajes, grupos] = await db.batch([
    db.prepare(`SELECT l.*, r.name AS empresa, NULLIF(json_extract(r.props, '$.domain'), '') AS dominio FROM lugares l
      LEFT JOIN records r ON r.id = l.company_id AND r.archived = 0 WHERE l.activo = 1 ORDER BY l.nombre LIMIT 5000`),
    db.prepare(`SELECT lugar_id, COUNT(*) AS total, SUM(fecha >= ?1) AS seis, MAX(fecha) AS ultimo FROM encargos
      WHERE lugar_id IS NOT NULL AND fecha <= ?2 AND estado NOT IN ('cancelado', 'no_se_pudo') GROUP BY lugar_id`).bind(desde, hoy),
    db.prepare(`SELECT g.*, r.name AS empresa, NULLIF(json_extract(r.props, '$.domain'), '') AS dominio FROM destino_grupos g
      LEFT JOIN records r ON r.id = g.company_id AND r.archived = 0 ORDER BY g.nombre`),
  ]);
  const proximos = (await db.prepare(`SELECT lugar_id, MIN(fecha) AS fecha FROM encargos WHERE lugar_id IS NOT NULL AND fecha > ? AND estado = 'pendiente' GROUP BY lugar_id`).bind(hoy)
    .all<{ lugar_id: number; fecha: string }>()).results;
  const filas = lugares.results as unknown as Fila[];
  const v = new Map((viajes.results as Array<{ lugar_id: number; total: number; seis: number; ultimo: string }>).map((x) => [x.lugar_id, x]));
  const prox = new Map(proximos.map((x) => [x.lugar_id, x.fecha]));

  // El punto de cada dirección en el mapa (el mismo de la ruta del cronograma).
  const dirs = new Map(filas.map((l) => [l.id, direccionLugar(l)]));
  const claves = [...new Set([...dirs.values()].map(claveDireccion).filter(Boolean))];
  const puntos = new Map<string, { lat: number | null; lng: number | null; ok: number; manual: number }>();
  for (let i = 0; i < claves.length; i += 400) {
    const { results } = await db.prepare('SELECT clave, lat, lng, ok, manual FROM geocodigos WHERE clave IN (SELECT value FROM json_each(?))').bind(JSON.stringify(claves.slice(i, i + 400)))
      .all<{ clave: string; lat: number | null; lng: number | null; ok: number; manual: number }>();
    for (const r of results) puntos.set(r.clave, r);
  }
  const json = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  // Sin los campos vacíos: son miles de destinos y la mitad de los datos son null.
  const sinVacios = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== false && v !== '')) as T;
  const destinos = filas.map((l) => {
    const dir = dirs.get(l.id)!, k = claveDireccion(dir), g = k ? puntos.get(k) : undefined;
    const mapa = !k ? 'sin_direccion' : !g ? 'sin_buscar' : g.ok && g.lat != null ? 'ok' : 'no_encontrado';
    const x = v.get(l.id);
    const faltan: string[] = [];
    if (!l.direccion?.trim()) faltan.push('direccion');
    if (!l.localidad?.trim()) faltan.push('localidad');
    if (!l.provincia?.trim()) faltan.push('provincia');
    if (mapa !== 'ok') faltan.push('mapa');
    if (!l.telefono?.trim() && !l.whatsapp?.trim()) faltan.push('contacto');
    if (!l.tipo) faltan.push('tipo');
    return {
      id: l.id, nombre: l.nombre, sucursal: l.sucursal, tipo: l.tipo, tipo_origen: l.tipo_origen, grupo_id: l.grupo_id,
      // La empresa del CRM (si se archivó, como si no tuviera) y su dominio, de donde sale el logo.
      company_id: l.empresa ? l.company_id : null, empresa: l.empresa, dominio: l.empresa ? l.dominio?.trim().toLowerCase() || null : null, empresa_origen: l.empresa ? l.empresa_origen : null,
      direccion: l.direccion, localidad: l.localidad, provincia: l.provincia, codigo_postal: l.codigo_postal, zona: l.zona, completa: dir, place_id: l.place_id,
      lat: mapa === 'ok' ? g!.lat : null, lng: mapa === 'ok' ? g!.lng : null, mapa, punto_manual: !!g?.manual,
      horario: l.horario, contacto: l.contacto, telefono: l.telefono, whatsapp: l.whatsapp, email: l.email, observaciones: l.observaciones,
      viajes: { seis: x?.seis ?? 0, total: x?.total ?? 0, ultimo: x?.ultimo ?? null, proximo: prox.get(l.id) ?? null },
      origen: l.origen, editado: !!l.editado, faltan,
      ia_estado: l.ia_estado, ia_nota: l.ia_nota, ia_antes: json(l.ia_antes), ia_sugerida: json(l.ia_sugerida),
      puede_editar: organiza(user) || (l.origen === 'hub' && l.created_by === user.id),
      // Borrar es sacarlo de la libreta (activo = 0): los encargos viejos lo siguen nombrando.
      puede_borrar: organiza(user) || (l.origen === 'hub' && l.created_by === user.id),
    };
  });
  const salida = destinos.map(sinVacios);

  // Qué conviene juntar: los sueltos de la misma empresa del CRM o con el mismo nombre («ZECAT (DEPÓSITO)» y «ZECAT
  // OFICINA»). Si ya hay un grupo con ese nombre, se suman ahí.
  const sueltos = filas.filter((l) => !l.grupo_id);
  const porClave = new Map<string, Fila[]>();
  for (const l of sueltos) {
    const k = l.company_id ? `c${l.company_id}` : raiz(l.nombre) ? `n${raiz(l.nombre)}` : null;
    if (k) porClave.set(k, [...(porClave.get(k) ?? []), l]);
  }
  const gruposLista = (grupos.results as Array<{ id: number; nombre: string; tipo: string | null; company_id: number | null; empresa: string | null; dominio: string | null; empresa_origen: string | null }>)
    .map((g) => ({ ...g, company_id: g.empresa ? g.company_id : null, dominio: g.empresa ? g.dominio?.trim().toLowerCase() || null : null }));
  const sugeridos: Array<{ nombre: string; ids: number[]; grupo_id: number | null }> = [];
  for (const [k, ls] of porClave) {
    const existente = gruposLista.find((g) => (k.startsWith('c') && g.company_id === Number(k.slice(1))) || raiz(g.nombre) === k.slice(1));
    if (ls.length < 2 && !existente) continue;
    const nombre = existente?.nombre ?? (ls[0].empresa || k.slice(1).toUpperCase());
    sugeridos.push({ nombre, ids: ls.map((l) => l.id), grupo_id: existente?.id ?? null });
  }
  sugeridos.sort((a, b) => b.ids.length - a.ids.length);

  const total = destinos.length;
  return {
    total, organiza: organiza(user), ia: !!env.ANTHROPIC_API_KEY, maps: !!env.GOOGLE_MAPS_API_KEY,
    copia: { at: cfg.at, filas: cfg.filas, error: cfg.error ?? null },
    resumen: {
      en_mapa: destinos.filter((d) => d.mapa === 'ok').length, completos: destinos.filter((d) => !d.faltan.length).length,
      sin_buscar: destinos.filter((d) => d.mapa === 'sin_buscar').length, para_revisar: destinos.filter((d) => d.ia_estado === 'dudoso').length,
    },
    grupos: gruposLista.map((g) => ({ ...g, n: filas.filter((l) => l.grupo_id === g.id).length })).filter((g) => g.n > 0),
    sugeridos: organiza(user) ? sugeridos.slice(0, 40) : [],
    destinos: salida,
  };
}

// Busca en el mapa las direcciones que todavía no se buscaron (de a pocas: la pantalla vuelve a pedir mientras falten).
export async function ubicarDestinos(env: Env) {
  const { results } = await env.DB.prepare('SELECT direccion, localidad, provincia, zona FROM lugares WHERE activo = 1 AND direccion IS NOT NULL').all<{ direccion: string; localidad: string | null; provincia: string | null; zona: string | null }>();
  const r = await ubicar(env, results.map((l) => direccionLugar(l)), true);
  return { pendientes: r.pendientes };
}

// ---------- Grupos (empresa con varias sucursales) ----------

const exigir = (ctx: Ctx) => { if (!organiza(ctx.user)) throw new HttpError(403, 'Agrupar destinos es de Logística.'); };
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200) : []);

// Junta destinos en un grupo: uno nuevo (con `nombre`) o uno que ya está (`grupo_id`). El tipo del grupo pasa a sus destinos.
export async function agrupar(db: D1Database, ctx: Ctx, b: { nombre?: unknown; grupo_id?: unknown; ids?: unknown; tipo?: unknown }) {
  exigir(ctx);
  const lista = ids(b.ids);
  if (!lista.length) throw new HttpError(400, 'Elegí los destinos a agrupar.');
  let id = Number(b.grupo_id) || null;
  const tipo = esTipo(b.tipo) ? b.tipo : null;
  if (id) {
    if (!(await db.prepare('SELECT 1 FROM destino_grupos WHERE id = ?').bind(id).first())) throw new HttpError(404, 'Ese grupo ya no está.');
  } else {
    const nombre = String(b.nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!nombre) throw new HttpError(400, 'Ponele un nombre al grupo (la empresa).');
    const empresas = (await db.prepare('SELECT DISTINCT company_id FROM lugares WHERE company_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(lista)).all<{ company_id: number }>()).results;
    id = (await db.prepare('INSERT INTO destino_grupos (nombre, tipo, company_id, created_by, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(nombre, tipo, empresas.length === 1 ? empresas[0].company_id : null, ctx.user.id, now()).first<{ id: number }>())!.id;
  }
  const stmts = [db.prepare('UPDATE lugares SET grupo_id = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))').bind(id, now(), JSON.stringify(lista))];
  if (tipo) stmts.push(db.prepare("UPDATE lugares SET tipo = ?, tipo_origen = 'manual' WHERE grupo_id = ?").bind(tipo, id));
  await db.batch(stmts);
  await limpiarGrupos(db);
  return { grupo_id: id };
}

// Cambiar el nombre o el tipo del grupo (el tipo pasa a todos sus destinos).
export async function editarGrupo(db: D1Database, ctx: Ctx, id: number, b: { nombre?: unknown; tipo?: unknown; company_id?: unknown }) {
  exigir(ctx);
  const stmts: D1PreparedStatement[] = [];
  if (b.nombre !== undefined) {
    const nombre = String(b.nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!nombre) throw new HttpError(400, 'El grupo necesita un nombre.');
    stmts.push(db.prepare('UPDATE destino_grupos SET nombre = ?, updated_at = ? WHERE id = ?').bind(nombre, now(), id));
  }
  if (b.tipo !== undefined) {
    const tipo = esTipo(b.tipo) ? b.tipo : null;
    stmts.push(db.prepare('UPDATE destino_grupos SET tipo = ?, updated_at = ? WHERE id = ?').bind(tipo, now(), id));
    if (tipo) stmts.push(db.prepare("UPDATE lugares SET tipo = ?, tipo_origen = 'manual' WHERE grupo_id = ?").bind(tipo, id));
  }
  // La empresa del CRM del grupo, elegida (o quitada) a mano: pasa a sus direcciones, salvo las que tienen una puesta a mano.
  if (b.company_id !== undefined) {
    const empresa = Number(b.company_id) || null;
    if (empresa && !(await db.prepare("SELECT 1 FROM records WHERE id = ? AND object_type = 'company' AND archived = 0").bind(empresa).first())) throw new HttpError(404, 'Esa empresa ya no está en el CRM.');
    stmts.push(db.prepare("UPDATE destino_grupos SET company_id = ?, empresa_origen = 'manual', updated_at = ? WHERE id = ?").bind(empresa, now(), id));
    stmts.push(empresa
      ? db.prepare("UPDATE lugares SET company_id = ?, empresa_origen = 'grupo' WHERE grupo_id = ? AND (empresa_origen IS NULL OR empresa_origen != 'manual')").bind(empresa, id)
      // Quitada: sus direcciones tampoco se vuelven a relacionar solas con esa empresa.
      : db.prepare("UPDATE lugares SET company_id = NULL, empresa_origen = 'manual' WHERE grupo_id = ? AND empresa_origen IN ('grupo', 'nombre')").bind(id));
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true };
}

// Deshacer el grupo (o sacar algunos destinos, con `ids`).
export async function desagrupar(db: D1Database, ctx: Ctx, id: number, b: { ids?: unknown } = {}) {
  exigir(ctx);
  const lista = ids(b.ids);
  // Las que tenían la empresa del CRM por ser del grupo la sueltan (el Hub la vuelve a buscar por su nombre).
  const SUELTA = `grupo_id = NULL, company_id = CASE WHEN empresa_origen = 'grupo' THEN NULL ELSE company_id END, empresa_origen = CASE WHEN empresa_origen = 'grupo' THEN NULL ELSE empresa_origen END`;
  if (lista.length) await db.prepare(`UPDATE lugares SET ${SUELTA} WHERE grupo_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(id, JSON.stringify(lista)).run();
  else await db.prepare(`UPDATE lugares SET ${SUELTA} WHERE grupo_id = ?`).bind(id).run();
  await limpiarGrupos(db);
  return { ok: true };
}

const limpiarGrupos = (db: D1Database) => db.prepare('DELETE FROM destino_grupos WHERE id NOT IN (SELECT grupo_id FROM lugares WHERE grupo_id IS NOT NULL)').run();
