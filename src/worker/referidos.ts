import type { Ctx, User } from './env';
import { HttpError, now } from './env';
import { associate, primaryCompanyId } from './associations';
import { createActivity } from './activities';
import { createRecord, getRow, splitName, type RecordRow } from './records';
import { findCompany, findContact, upsertCompany, upsertContact } from './upsert';
import { duenosVistos, esOperaciones, ladoComercial, visibleSql } from './alcance';
import { Meta } from './meta';
import { visiblePipelineIds } from './pipelines';

// Referidos (pedido de Rodrigo del 17/11/2026). Cuando un cliente nos recomienda a alguien, la vendedora lo carga desde el
// pedido de referidos del Workspace de Formas Shop («PARA HACER URGENTE», por /hooks/referidos con el token del tablero) o
// desde la ficha del cliente en el Hub (POST /api/referidos). Antes iba a HubSpot; ahora queda acá:
//   - el contacto del referido (si ya existe por mail o teléfono, ese) y su empresa, si la dijo;
//   - un negocio nuevo en Formas Shop (Inbound), etapa «Lead», con «Tipo de origen» y «Medio de origen» en Referido;
//   - una nota en el cliente que lo recomendó y en el referido: quién recomendó a quién;
//   - una tarea para la vendedora: contactarlo el día hábil siguiente;
//   - la fila en `referidos` que une las dos puntas: la ficha de cada uno lo muestra (tarjeta «Referidos»).
// Cuando el negocio del referido se gana, la vendedora recibe la tarea de agradecerle al cliente que lo recomendó.

export const PIPELINE_SHOP = 'default';      // Formas Shop (Inbound)
export const ETAPA_LEAD = '1000604528';      // «Lead»
const TIPO_REFERIDO = 'Referido';
const MEDIO_REFERIDO = 'Ejecutiva de cuentas';   // el valor interno de «Referido» en «Medio de origen» y «Canal de contacto»

// Teléfono para WhatsApp: 549 + área + número (sin 0 ni 15), como el tablero.
export function telAr(s: unknown) {
  let d = String(s ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 13 && d.startsWith('549')) return d;
  if (d.length === 12 && d.startsWith('54')) return `549${d.slice(2)}`;
  d = d.replace(/^0+/, '');
  if (d.length === 12 && d.slice(2, 4) === '15') d = d.slice(0, 2) + d.slice(4);   // 11 15 5555 1234
  if (d.length === 10) return `549${d}`;
  if (d.length >= 11 && d.length <= 15 && !d.startsWith('54')) return d;
  return '';
}
export const mailDe = (s: unknown) => (String(s ?? '').match(/[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+/) ?? [''])[0].toLowerCase();

// La vendedora por su mail, aunque esté con otro dominio de Formas (formas.ar / formaspublicitarias.com).
export async function usuarioPorMail(db: D1Database, email: unknown) {
  const m = String(email ?? '').trim().toLowerCase();
  if (!m.includes('@')) return null;
  const exacto = await db.prepare('SELECT id, name FROM users WHERE active = 1 AND lower(email) = ?').bind(m).first<{ id: number; name: string }>();
  if (exacto) return exacto;
  return db.prepare("SELECT id, name FROM users WHERE active = 1 AND lower(substr(email, 1, instr(email, '@'))) = ? ORDER BY id LIMIT 1")
    .bind(`${m.split('@')[0]}@`).first<{ id: number; name: string }>();
}

// El pipeline donde va el negocio de un referido que carga alguien desde el Hub: el de su equipo principal (el primero que
// ve), así una vendedora de Corporate lo tiene en Corporate. Sin equipo con pipeline, Formas Shop.
export async function pipelineDe(db: D1Database, user: User) {
  const pipes = await new Meta(db).pipelines();
  const visibles = await visiblePipelineIds(new Meta(db), user);
  const suyo = pipes.find((p) => p.team_id != null && p.team_id === user.team_id && (!visibles || visibles.includes(p.id)));
  return suyo?.id ?? PIPELINE_SHOP;
}

const txt = (v: unknown, n: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const hoyAr = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// El día hábil siguiente a las 10 de Buenos Aires (13 UTC).
export function proximoDiaHabil(desde = new Date()) {
  const d = new Date(desde.getTime() + 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(13, 0, 0, 0);
  return d.toISOString();
}

export interface ReferidoInput {
  clave?: string;
  referido: { nombre?: string; empresa?: string; telefono?: string; email?: string; contacto?: string };
  referidor: { nombre?: string; pdvs?: Array<string | number>; empresa_id?: number; contacto_id?: number; telefono?: string; email?: string };
  nota?: string;
  owner_id?: number | null;
  cargado_por?: string;
  origen?: 'tablero' | 'crm';
  // Del Hub: el pipeline de la unidad de quien carga (sin esto, Formas Shop en «Lead», que es de donde vienen los del tablero).
  pipeline?: string;
}

interface Fila {
  id: number; clave: string | null; contacto_id: number | null; empresa_id: number | null; negocio_id: number | null; tarea_id: number | null;
  referidor_empresa_id: number | null; referidor_contacto_id: number | null; referidor_nombre: string; pdvs: string; owner_id: number | null;
  cargado_por: string | null; origen: string; nota: string | null; agradecer_tarea_id: number | null; created_at: string;
}

const nombreDe = async (db: D1Database, id: number | null) =>
  id ? (await db.prepare('SELECT name FROM records WHERE id = ?').bind(id).first<{ name: string }>())?.name ?? null : null;

async function respuesta(db: D1Database, f: Fila, extra: Record<string, unknown> = {}) {
  const ref = async (id: number | null) => (id ? { id, name: await nombreDe(db, id) } : null);
  return {
    id: f.id, clave: f.clave, ...extra,
    contacto: await ref(f.contacto_id), empresa: await ref(f.empresa_id), negocio: await ref(f.negocio_id), tarea: f.tarea_id,
    referidor: { nombre: f.referidor_nombre, empresa: await ref(f.referidor_empresa_id), contacto: await ref(f.referidor_contacto_id) },
    links: { negocio: f.negocio_id ? `/deals/${f.negocio_id}` : null, contacto: f.contacto_id ? `/contacts/${f.contacto_id}` : null },
  };
}

// Quién lo recomendó: la empresa y el contacto del cliente, por lo más seguro primero.
//   1. Los ids, si vienen de la ficha del Hub.
//   2. El pedido (N° de PDV): su empresa y su contacto.
//   3. Una empresa con ese nombre exacto.
//   4. Un contacto con ese mail o teléfono.
// Si no aparece, el referido se carga igual con el nombre que mandaron.
export async function buscarReferidor(db: D1Database, r: ReferidoInput['referidor']) {
  let empresa: RecordRow | null = null;
  let contacto: RecordRow | null = null;
  const fila = async (id: unknown, tipo: 'company' | 'contact') => {
    if (!id) return null;
    const row = await getRow(db, Number(id)).catch(() => null);
    if (row && row.object_type !== tipo) throw new HttpError(400, `El registro ${id} no es ${tipo === 'company' ? 'una empresa' : 'un contacto'}.`);
    return row && !row.archived ? row : null;
  };
  empresa = await fila(r.empresa_id, 'company');
  contacto = await fila(r.contacto_id, 'contact');
  for (const p of (r.pdvs ?? []).slice(0, 20)) {
    if (empresa && contacto) break;
    const n = String(p).match(/(\d{3,8})\s*$/)?.[1];
    if (!n) continue;
    const pedido = await db.prepare(`SELECT r.id,
        (SELECT a.to_id FROM associations a JOIN records x ON x.id = a.to_id AND x.archived = 0 WHERE a.from_id = r.id AND a.to_type = 'company' ORDER BY a.is_primary DESC, a.created_at LIMIT 1) AS empresa,
        (SELECT a.to_id FROM associations a JOIN records x ON x.id = a.to_id AND x.archived = 0 WHERE a.from_id = r.id AND a.to_type = 'contact' ORDER BY a.is_primary DESC, a.created_at LIMIT 1) AS contacto
      FROM records r WHERE r.object_type = 'order' AND r.archived = 0
        AND CAST(json_extract(r.props, '$.pdv_finnegans') AS TEXT) IN (?1, 'PDV - ' || ?1, 'PDV ' || ?1)
      ORDER BY r.updated_at DESC LIMIT 1`).bind(String(Number(n))).first<{ id: number; empresa: number | null; contacto: number | null }>();
    if (!pedido) continue;
    if (!empresa && pedido.empresa) empresa = await getRow(db, pedido.empresa);
    if (!contacto && pedido.contacto) contacto = await getRow(db, pedido.contacto);
  }
  const nombre = txt(r.nombre, 160);
  if (!empresa && nombre) empresa = await findCompany(db, { name: nombre });
  if (!contacto) {
    const tel = telAr(r.telefono), email = mailDe(r.email);
    if (tel || email) contacto = await findContact(db, { email: email || undefined, mobilephone: tel || undefined });
  }
  if (!empresa && contacto) {
    const id = await primaryCompanyId(db, contacto.id);
    if (id) empresa = await getRow(db, id);
  }
  return { empresa, contacto, nombre: nombre || empresa?.name || contacto?.name || '' };
}

export async function cargarReferido(db: D1Database, ctx: Ctx, input: ReferidoInput) {
  const clave = txt(input.clave, 300) || null;
  if (clave) {
    const ya = await db.prepare('SELECT * FROM referidos WHERE clave = ?').bind(clave).first<Fila>();
    if (ya) return respuesta(db, ya, { ya_estaba: true, nuevo_contacto: false });
  }
  const r = input.referido ?? {};
  const nombre = txt(r.nombre, 100), empresaTxt = txt(r.empresa, 100);
  const tel = telAr(r.telefono) || telAr(r.contacto), email = mailDe(r.email) || mailDe(r.contacto);
  if (!nombre && !empresaTxt) throw new HttpError(400, 'Falta el nombre o la empresa del referido.');
  if (!tel && !email) throw new HttpError(400, 'Falta el teléfono o el mail del referido: sin eso no se lo puede contactar.');
  const quien = await buscarReferidor(db, input.referidor ?? {});
  if (!quien.nombre) throw new HttpError(400, 'Falta quién lo recomendó.');
  const owner = input.owner_id ?? null;
  const pdvs = (input.referidor?.pdvs ?? []).map((p) => String(p).match(/(\d{3,8})\s*$/)?.[1]).filter(Boolean).slice(0, 20) as string[];
  const nota = txt(input.nota, 1000);
  const cargo = txt(input.cargado_por, 120) || ctx.user.name;
  const desde = input.origen === 'crm' ? 'el Hub' : 'el pedido de referidos del Workspace';

  // El contacto: si ya existe (mail o teléfono), ese; solo se completa lo vacío (no cambia de propietario).
  const { row: contacto, created } = await upsertContact(db, ctx, {
    ...splitName(undefined, undefined, nombre || empresaTxt), email: email || undefined, mobilephone: tel || undefined,
    company: empresaTxt || undefined, owner_id: owner ?? undefined, tipo_de_origen: TIPO_REFERIDO, origen_del_contacto: MEDIO_REFERIDO,
  }, { autoCompany: !empresaTxt });
  let empresa: RecordRow | null = null;
  if (empresaTxt) {
    empresa = (await upsertCompany(db, ctx, { name: empresaTxt, owner_id: owner ?? undefined })).row;
    await associate(db, ctx, contacto.id, empresa.id);
  } else {
    const id = await primaryCompanyId(db, contacto.id);
    if (id) empresa = await getRow(db, id);
  }
  const quienEs = nombre ? `${nombre}${empresaTxt ? ` (${empresaTxt})` : ''}` : empresaTxt;
  const negocio = await createRecord(db, ctx, 'deal', {
    dealname: `${quienEs} - Referido de ${quien.nombre}`.slice(0, 200),
    ...(input.pipeline && input.pipeline !== PIPELINE_SHOP ? { pipeline: input.pipeline } : { pipeline: PIPELINE_SHOP, dealstage: ETAPA_LEAD }),
    owner_id: owner ?? undefined, tipo_de_origen: TIPO_REFERIDO, origen_del_negocio: MEDIO_REFERIDO,
    description: `Referido de ${quien.nombre}${pdvs.length ? ` (PDV ${pdvs.join(', ')})` : ''}. Lo cargó ${cargo} desde ${desde} el ${ddmm(hoyAr())}.${nota ? `\n\n${nota}` : ''}`.slice(0, 2000),
  }, { strict: false });
  await associate(db, ctx, negocio.id, contacto.id);
  if (empresa) await associate(db, ctx, negocio.id, empresa.id);

  // La nota, en las dos puntas: el cliente que lo recomendó y el referido.
  const datos = [tel && `WhatsApp ${tel}`, email].filter(Boolean).join(' · ');
  const ids = [contacto.id, negocio.id, empresa?.id, quien.empresa?.id, quien.contacto?.id].filter((x): x is number => !!x);
  await createActivity(db, ctx, {
    type: 'note', owner_id: owner ?? undefined, links: [...new Set(ids)], link_primary_company: false,
    body: `Referido: ${quien.nombre} nos recomendó a ${quienEs}${datos ? ` (${datos})` : ''}.${pdvs.length ? ` Pedido ${pdvs.map((p) => `PDV ${p}`).join(', ')}.` : ''}`
      + `${nota ? `\n${nota}` : ''}\nLo cargó ${cargo} desde ${desde}.`,
  });
  const tarea = await createActivity(db, ctx, {
    type: 'task', task_type: tel ? 'call' : 'email', due_at: proximoDiaHabil(), owner_id: owner ?? ctx.user.id,
    subject: `Contactar a ${quienEs} (referido de ${quien.nombre})`.slice(0, 200),
    body: `${quien.nombre} nos pasó su contacto${datos ? `: ${datos}` : ''}. Contale de parte de quién le escribís.${nota ? `\n\n${nota}` : ''}`,
    links: [contacto.id, negocio.id], link_primary_company: false,
  });
  const fila = await db.prepare(`INSERT INTO referidos (clave, contacto_id, empresa_id, negocio_id, tarea_id, referidor_empresa_id, referidor_contacto_id,
      referidor_nombre, pdvs, owner_id, cargado_por, origen, nota, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(clave, contacto.id, empresa?.id ?? null, negocio.id, tarea.id, quien.empresa?.id ?? null, quien.contacto?.id ?? null, quien.nombre,
      JSON.stringify(pdvs), owner, cargo, input.origen === 'crm' ? 'crm' : 'tablero', nota || null, ctx.user.id, now()).first<Fila>();
  return respuesta(db, fila!, { ya_estaba: false, nuevo_contacto: created });
}

// Se ganó el negocio de un referido: la vendedora le agradece al cliente que lo recomendó (una sola vez).
export async function agradecerReferido(db: D1Database, ctx: Ctx, dealId: number, ownerId: number | null) {
  const f = await db.prepare('SELECT * FROM referidos WHERE negocio_id = ? AND agradecer_tarea_id IS NULL LIMIT 1').bind(dealId).first<Fila>();
  if (!f) return null;
  const referido = (await nombreDe(db, f.contacto_id)) ?? 'su referido';
  const t = await createActivity(db, { ...ctx, source: 'automatización' }, {
    type: 'task', task_type: 'todo', due_at: proximoDiaHabil(), owner_id: ownerId ?? f.owner_id ?? undefined,
    subject: `Agradecerle a ${f.referidor_nombre}: ganamos el negocio de ${referido}`.slice(0, 200),
    body: `${f.referidor_nombre} nos recomendó a ${referido} y el negocio se ganó. Escribile para agradecerle.`,
    links: [f.referidor_contacto_id, f.referidor_empresa_id, dealId].filter((x): x is number => !!x), link_primary_company: false,
  });
  await db.prepare('UPDATE referidos SET agradecer_tarea_id = ? WHERE id = ?').bind(t.id, f.id).run();
  return t.id;
}

// ---------- Lectura: la tarjeta «Referidos» de la ficha ----------

export interface ReferidoVista {
  id: number | null; fecha: string; origen: string; cargado_por: string | null; nota: string | null; pdvs: string[];
  referidor: { nombre: string; empresa: { id: number; name: string } | null; contacto: { id: number; name: string } | null };
  contacto: { id: number; name: string } | null; empresa: { id: number; name: string } | null;
  negocio: { id: number; name: string; etapa: string | null; abierto: boolean; ganado: boolean; monto: number | null } | null;
  owner_id: number | null;
}

type Cruda = Fila & { c_name: string | null; e_name: string | null; d_id: number | null; d_name: string | null; amount: number | null; d_owner: number | null;
  etapa: string | null; is_closed: number | null; is_won: number | null; re_name: string | null; rc_name: string | null };

function vista(x: Cruda): ReferidoVista {
  const par = (id: number | null, name: string | null) => (id && name ? { id, name } : null);
  return {
    id: x.id, fecha: x.created_at, origen: x.origen, cargado_por: x.cargado_por, nota: x.nota, pdvs: JSON.parse(x.pdvs || '[]'),
    referidor: { nombre: x.referidor_nombre, empresa: par(x.referidor_empresa_id, x.re_name), contacto: par(x.referidor_contacto_id, x.rc_name) },
    contacto: par(x.contacto_id, x.c_name), empresa: par(x.empresa_id, x.e_name),
    negocio: x.d_id ? { id: x.d_id, name: x.d_name ?? '', etapa: x.etapa, abierto: !x.is_closed, ganado: !!x.is_won, monto: x.amount } : null,
    owner_id: x.d_owner ?? x.owner_id,
  };
}

// «Referido de Distribuidora Andina SRL (PDV 31139). Lo cargó…» (lo que escribía el tablero en HubSpot) o el título
// «Carolina Sosa (Grupo Patagonia) - Referido de Distribuidora Andina SRL».
export function referidorDeTexto(descripcion: unknown, titulo: unknown) {
  const d = String(descripcion ?? '').match(/Referido de (.+?)(?: \(PDV ([\d, ]+)\))?\. Lo cargó/);
  if (d) return { nombre: d[1].trim(), pdvs: (d[2] ?? '').split(/[, ]+/).filter(Boolean) };
  const t = String(titulo ?? '').match(/ - Referido de (.+)$/);
  return t ? { nombre: t[1].trim(), pdvs: [] } : null;
}

export async function listarReferidos(db: D1Database, user: User, f: { owner?: number; de?: number; recomendo?: number; limit?: number } = {}) {
  if (esOperaciones(user)) throw new HttpError(403, 'Los referidos no están en tu perfil.');
  const meta = new Meta(db);
  const pipes = await visiblePipelineIds(meta, user);
  const binds: unknown[] = [];
  const where: string[] = [];
  // Ventas: los de sus negocios (o, si el negocio se borró, los que cargó a su nombre).
  if (ladoComercial(user)) {
    const vistos = await duenosVistos(db, user);
    where.push(`((d.id IS NOT NULL AND ${visibleSql('d', user)}) OR (d.id IS NULL${vistos ? ` AND f.owner_id IN (${[...vistos].map(Number).join(', ')})` : ''}))`);
  }
  if (pipes) { where.push('(d.id IS NULL OR d.pipeline_id IN (SELECT value FROM json_each(?)))'); binds.push(JSON.stringify(pipes)); }
  if (f.owner) { where.push('COALESCE(d.owner_id, f.owner_id) = ?'); binds.push(f.owner); }
  if (f.de) { where.push('(f.contacto_id = ? OR f.negocio_id = ? OR f.empresa_id = ?)'); binds.push(f.de, f.de, f.de); }
  if (f.recomendo) { where.push('(f.referidor_empresa_id = ? OR f.referidor_contacto_id = ?)'); binds.push(f.recomendo, f.recomendo); }
  const { results } = await db.prepare(`SELECT f.*, c.name AS c_name, e.name AS e_name, d.id AS d_id, d.name AS d_name, d.amount, d.owner_id AS d_owner,
      s.label AS etapa, s.is_closed, s.is_won, re.name AS re_name, rc.name AS rc_name
    FROM referidos f
      LEFT JOIN records c ON c.id = f.contacto_id AND c.archived = 0
      LEFT JOIN records e ON e.id = f.empresa_id AND e.archived = 0
      LEFT JOIN records d ON d.id = f.negocio_id AND d.archived = 0
      LEFT JOIN stages s ON s.id = d.stage_id
      LEFT JOIN records re ON re.id = f.referidor_empresa_id AND re.archived = 0
      LEFT JOIN records rc ON rc.id = f.referidor_contacto_id AND rc.archived = 0
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.created_at DESC LIMIT ?`).bind(...binds, Math.min(f.limit ?? 500, 1000)).all<Cruda>();
  const out = results.map(vista);

  // Los negocios referidos de antes (cargados en HubSpot por el tablero o a mano, con origen «Referido»), que no tienen
  // fila propia: salen en la ficha de su negocio y de su contacto, con quien los recomendó si se puede leer del texto.
  if (!f.recomendo && (!f.de || !out.length)) {
    const w: string[] = [`d.object_type = 'deal' AND d.archived = 0`,
      `(json_extract(d.props, '$.tipo_de_origen') = '${TIPO_REFERIDO}' OR json_extract(d.props, '$.origen_del_negocio') = '${MEDIO_REFERIDO}')`,
      'd.id NOT IN (SELECT negocio_id FROM referidos WHERE negocio_id IS NOT NULL)'];
    const b: unknown[] = [];
    if (ladoComercial(user)) w.push(visibleSql('d', user));
    if (pipes) { w.push('d.pipeline_id IN (SELECT value FROM json_each(?))'); b.push(JSON.stringify(pipes)); }
    if (f.owner) { w.push('d.owner_id = ?'); b.push(f.owner); }
    if (f.de) { w.push(`(d.id = ? OR d.id IN (SELECT a.to_id FROM associations a WHERE a.from_id = ? AND a.to_type = 'deal'))`); b.push(f.de, f.de); }
    const viejos = await db.prepare(`SELECT d.id, d.name, d.amount, d.owner_id, d.created_at, json_extract(d.props, '$.description') AS descripcion,
        s.label AS etapa, s.is_closed, s.is_won,
        (SELECT x.id || char(9) || x.name FROM associations a JOIN records x ON x.id = a.to_id AND x.archived = 0 WHERE a.from_id = d.id AND a.to_type = 'contact' ORDER BY a.is_primary DESC, a.created_at LIMIT 1) AS contacto,
        (SELECT x.id || char(9) || x.name FROM associations a JOIN records x ON x.id = a.to_id AND x.archived = 0 WHERE a.from_id = d.id AND a.to_type = 'company' ORDER BY a.is_primary DESC, a.created_at LIMIT 1) AS empresa
      FROM records d LEFT JOIN stages s ON s.id = d.stage_id WHERE ${w.join(' AND ')} ORDER BY d.created_at DESC LIMIT 500`).bind(...b)
      .all<{ id: number; name: string; amount: number | null; owner_id: number | null; created_at: string; descripcion: string | null; etapa: string | null;
        is_closed: number | null; is_won: number | null; contacto: string | null; empresa: string | null }>();
    const par = (s: string | null) => { if (!s) return null; const [id, ...n] = s.split('\t'); return { id: Number(id), name: n.join('\t') }; };
    for (const d of viejos.results) {
      const ref = referidorDeTexto(d.descripcion, d.name);
      out.push({
        id: null, fecha: d.created_at, origen: 'antes', cargado_por: null, nota: null, pdvs: ref?.pdvs ?? [],
        referidor: { nombre: ref?.nombre ?? '', empresa: null, contacto: null },
        contacto: par(d.contacto), empresa: par(d.empresa),
        negocio: { id: d.id, name: d.name, etapa: d.etapa, abierto: !d.is_closed, ganado: !!d.is_won, monto: d.amount }, owner_id: d.owner_id,
      });
    }
    out.sort((a, b) => b.fecha.localeCompare(a.fecha));
  }
  return { referidos: out };
}
