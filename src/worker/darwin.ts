import Anthropic from '@anthropic-ai/sdk';
import type { Ctx, Env, User } from './env';
import { HttpError, now } from './env';
import { normPhone } from './records';
import { createActivity } from './activities';
import { primaryCompanyId } from './associations';
import { systemCtx, usuarioPorNombre } from './clickup';
import { Budget, OutOfBudget } from './budget';
import { visibleSql } from './alcance';

// Actividad diaria de Darwin en el CRM (pedido de Rodrigo del 18/11/2026; docs/DARWIN.md § 4).
//
// 1. Un workflow de Darwin («Formas Shop → CRM: actividad», disparador darwin-event) manda a /hooks/darwin/evento cada
//    evento de las conversaciones del workspace: se abre, el cliente responde, Maru se la pasa a una vendedora, Darwin la
//    analiza (resumen y campos inteligentes), se cierra. Acá se guardan tal cual (darwin_eventos) y se actualiza el estado de
//    la conversación (darwin_conversaciones): quién la tiene, cuándo habló el cliente, cuándo el equipo.
// 2. A la madrugada (index.ts), por cada conversación que tuvo movimiento el día anterior, Claude arma con eso un resumen del
//    día y saca los datos duros de lo que se consultó (consultas: categoría, tipo de producto, cantidad, fecha, ocasión…).
//    - El resumen queda como actividad de WhatsApp en el contacto (por teléfono, o por mail), su empresa y su negocio
//      abierto. Si el contacto no está en el CRM, no se crea: queda «sin contacto» (lo crea el aviso de siempre, /hooks/darwin,
//      cuando Maru pasa la conversación a una vendedora).
//    - Si ese día no hubo nada nuevo (solo un cierre automático, un saludo), no se escribe nada.
//    - Un mismo día se resume una vez; si se vuelve a correr, reemplaza el resumen y las consultas de ese día.

export const MODELO_RESUMEN = 'claude-sonnet-5-5';
const ZONA_MS = 3 * 3600_000;   // Buenos Aires, UTC−3 todo el año
export const diaBsAs = (ts: string | number | Date) => new Date(new Date(ts).getTime() - ZONA_MS).toISOString().slice(0, 10);
const hoyBsAs = () => diaBsAs(Date.now());

// La lista fija para buscar (la misma idea que el campo «Categoria» de Darwin, con el tipo de producto adentro).
// Para sumar un tipo alcanza con agregarlo acá: lo viejo queda como estaba.
export const CATALOGO: Record<string, string[]> = {
  'Drinkware': ['Botella', 'Termo', 'Vaso', 'Taza / Jarro', 'Mate / Set matero', 'Otro drinkware'],
  'Textil': ['Remera', 'Buzo / Campera', 'Chaleco', 'Gorra', 'Uniforme / Ropa de trabajo', 'Otro textil'],
  'Marroquinería': ['Mochila', 'Bolso', 'Tote / Bolsa', 'Neceser / Cartuchera', 'Riñonera', 'Billetera / Portadocumentos', 'Otra marroquinería'],
  'Escritura': ['Bolígrafo', 'Lápiz', 'Resaltador / Marcador', 'Set de escritura', 'Otra escritura'],
  'Oficina': ['Cuaderno / Libreta', 'Agenda', 'Calendario', 'Carpeta / Portafolio', 'Accesorio de escritorio', 'Otro de oficina'],
  'Tecnología': ['Auriculares', 'Parlante', 'Power bank / Cargador', 'Pendrive', 'Accesorio tecnológico', 'Otra tecnología'],
  'Gráfico': ['Impresos', 'Stickers / Etiquetas', 'Packaging / Cajas', 'Banner / Display', 'Otro gráfico'],
  'Tiempo Libre / Hogar': ['Conservadora', 'Paraguas', 'Toalla / Lona', 'Manta', 'Kit asado / Cocina', 'Abanico', 'Juego', 'Otro de tiempo libre'],
  'Kit / Combo': ['Kit'],
  'Otro': ['Otro'],
};
export const CATEGORIAS = Object.keys(CATALOGO);
export const TIPOS = [...new Set(Object.values(CATALOGO).flat())];
export const OCASIONES = ['Fin de año', 'Día de la Madre', 'Día del Padre', 'Día del Niño', 'Día de la Mujer', 'Día del Trabajador',
  'Aniversario de la empresa', 'Evento / Congreso / Feria', 'Onboarding / Bienvenida', 'Lanzamiento', 'Evento deportivo', 'Uso diario / Merchandising', 'Otra', ''];
export const OBJECIONES = ['Precio', 'Plazo de entrega', 'Stock', 'Cantidad mínima', 'Calidad / Modelo', 'Esperando aprobación', 'Sin respuesta', 'Otra', ''];

const EVENTOS_CLIENTE = ['session.replied'];

// ---------- 1. Entrada de eventos ----------

const txt = (v: unknown) => (v == null ? '' : String(v).trim());
const dato = (v: unknown) => { const s = txt(v); return /^(nolastname|null|undefined|n\/a|-)$/i.test(s) ? '' : s; };

export interface EventoDarwin { eventType?: string; evento?: string; timestamp?: string; data?: Record<string, any> }

export async function guardarEvento(env: Env, raw: Record<string, any>) {
  const body = (raw.data && typeof raw.data === 'object' && raw.data.data && typeof raw.data.data === 'object' ? raw.data : raw) as EventoDarwin;
  const d = (body.data ?? {}) as Record<string, any>;
  const tipo = txt(raw.evento ?? raw.eventType ?? body.evento ?? body.eventType ?? d.eventType);
  const conv = txt(d.conversationId ?? raw.conversation_id);
  if (!tipo || !conv) throw new HttpError(400, 'Falta el tipo de evento (eventType) o la conversación (data.conversationId).');
  const ocurrido = new Date(txt(body.timestamp ?? raw.timestamp) || d.closedAt || d.summarizedAt || Date.now());
  const ts = Number.isNaN(ocurrido.getTime()) ? now() : ocurrido.toISOString();
  const dia = diaBsAs(ts);
  const familia = txt(d.channelFamily ?? d.channelType).toLowerCase();
  const esTel = !familia || familia.startsWith('wa') || familia.startsWith('sms') || familia.startsWith('pstn') || familia.startsWith('call');
  const telefono = esTel ? normPhone(d.phoneNumber ?? d.conversationThreadId ?? conv.split('-').pop()) : null;
  const sf = (d.smartFields && typeof d.smartFields === 'object' ? d.smartFields : {}) as Record<string, unknown>;
  const email = dato(sf.email).toLowerCase() || null;
  const sessionId = Number(d.sessionId) || null;
  const link = `https://app.getdarwin.ai/agent/${Number(raw.agentId ?? (body as Record<string, unknown>).agentId) || 1986}/conversations/all/${conv}`;

  const db = env.DB;
  const asignadaUser = d.forwardedToName || d.forwardedToEmail ? await usuarioDeDarwin(db, d.forwardedToName, d.forwardedToEmail) : null;
  const esCliente = EVENTOS_CLIENTE.some((t) => tipo.startsWith(t));
  const camposLimpios = Object.fromEntries(Object.entries(sf).map(([k, v]) => [k, dato(v)]).filter(([, v]) => v !== ''));

  await db.batch([
    db.prepare('INSERT INTO darwin_eventos (conversation_id, session_id, tipo, dia, ocurrido_at, telefono, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(conv, sessionId, tipo, dia, ts, telefono, JSON.stringify(raw).slice(0, 60000)),
    db.prepare(`INSERT INTO darwin_conversaciones (conversation_id, telefono, email, titulo, link, asignada_a, asignada_user_id, asignada_at,
        ultima_respuesta_cliente, ultima_actividad_equipo, cerrada_at, abierta_at, campos, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(conversation_id) DO UPDATE SET
        telefono = COALESCE(excluded.telefono, telefono), email = COALESCE(excluded.email, email), titulo = COALESCE(excluded.titulo, titulo),
        asignada_a = COALESCE(excluded.asignada_a, asignada_a), asignada_user_id = COALESCE(excluded.asignada_user_id, asignada_user_id),
        asignada_at = COALESCE(excluded.asignada_at, asignada_at),
        ultima_respuesta_cliente = MAX(COALESCE(excluded.ultima_respuesta_cliente, ''), COALESCE(ultima_respuesta_cliente, '')),
        ultima_actividad_equipo = MAX(COALESCE(excluded.ultima_actividad_equipo, ''), COALESCE(ultima_actividad_equipo, '')),
        cerrada_at = CASE WHEN excluded.abierta_at IS NOT NULL THEN NULL ELSE COALESCE(excluded.cerrada_at, cerrada_at) END,
        abierta_at = COALESCE(excluded.abierta_at, abierta_at),
        campos = json_patch(campos, excluded.campos), updated_at = excluded.updated_at`)
      .bind(conv, telefono, email, dato(d.conversationTitle) || null, link, dato(d.forwardedToName) || null, asignadaUser,
        d.forwardedAt ? new Date(d.forwardedAt).toISOString() : null, esCliente ? ts : null,
        d.lastHumanActivityAt ? new Date(d.lastHumanActivityAt).toISOString() : null,
        tipo.startsWith('session.closed') ? (d.closedAt ? new Date(d.closedAt).toISOString() : ts) : null,
        tipo === 'session.opened' ? ts : null, JSON.stringify(camposLimpios), now()),
    // El día queda para resumir (a la madrugada siguiente). Si ya estaba hecho y llega algo más de ese día, se rehace.
    db.prepare(`INSERT INTO darwin_resumenes (conversation_id, dia, estado, updated_at) VALUES (?, ?, 'pendiente', ?)
      ON CONFLICT(conversation_id, dia) DO UPDATE SET estado = 'pendiente', intentos = 0, updated_at = excluded.updated_at`).bind(conv, dia, now()),
  ]);
  return { conversation_id: conv, tipo, dia };
}

async function usuarioDeDarwin(db: D1Database, nombre: unknown, email: unknown): Promise<number | null> {
  const users = (await db.prepare('SELECT id, name, email FROM users WHERE active = 1').all<{ id: number; name: string; email: string }>()).results;
  // Puede estar con otro dominio de Formas en Darwin (formas.ar / formaspublicitarias.com): se compara la parte antes de la @.
  const local = txt(email).toLowerCase().split('@')[0];
  const porMail = local ? users.find((u) => u.email.toLowerCase().split('@')[0] === local) : undefined;
  if (porMail) return porMail.id;
  return nombre ? usuarioPorNombre(users, txt(nombre), txt(email)) ?? null : null;
}

// ---------- 2. Resumen del día con IA ----------

interface Consulta {
  categoria: string; tipo: string; producto: string; cantidad: number | null; precio_unitario: number | null; presupuesto_total: number | null;
  fecha_necesaria: string; ocasion: string; personalizacion: string; pidio_muestra: boolean; pidio_boceto: boolean; objecion: string;
  competidor: string; entrega: string;
}
interface Respuesta { hubo_novedad: boolean; resumen: string; proximo_paso: string; consultas: Consulta[] }

const nul = (t: string) => ({ anyOf: [{ type: t }, { type: 'null' }] });
const ESQUEMA = {
  type: 'object', additionalProperties: false, required: ['hubo_novedad', 'resumen', 'proximo_paso', 'consultas'],
  properties: {
    hubo_novedad: { type: 'boolean' },
    resumen: { type: 'string' },
    proximo_paso: { type: 'string' },
    consultas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['categoria', 'tipo', 'producto', 'cantidad', 'precio_unitario', 'presupuesto_total', 'fecha_necesaria', 'ocasion', 'personalizacion',
          'pidio_muestra', 'pidio_boceto', 'objecion', 'competidor', 'entrega'],
        properties: {
          categoria: { type: 'string', enum: CATEGORIAS }, tipo: { type: 'string', enum: TIPOS }, producto: { type: 'string' },
          cantidad: nul('integer'), precio_unitario: nul('number'), presupuesto_total: nul('number'),
          fecha_necesaria: { type: 'string' }, ocasion: { type: 'string', enum: OCASIONES }, personalizacion: { type: 'string' },
          pidio_muestra: { type: 'boolean' }, pidio_boceto: { type: 'boolean' }, objecion: { type: 'string', enum: OBJECIONES },
          competidor: { type: 'string' }, entrega: { type: 'string' },
        },
      },
    },
  },
};

const INSTRUCCIONES = `Sos parte del CRM de Formas Publicitarias (Formas Shop), una empresa de Buenos Aires que vende productos promocionales personalizados con el logo de otras empresas (botellas, termos, mochilas, remeras, cuadernos, kits, etc.).
Los clientes escriben por WhatsApp. Primero los atiende Maru, la asistente con IA, y cuando el cliente está calificado se lo pasa a una vendedora del equipo.
Te paso lo que registró Darwin (la plataforma de WhatsApp) de UNA conversación durante UN día: los eventos con su hora, los resúmenes que hizo Darwin de cada sesión y los campos que juntó. También el resumen que el CRM guardó la última vez, para que digas solo lo nuevo.
Devolvé:
- hubo_novedad: false si ese día no pasó nada que le sirva a la vendedora (solo un cierre automático, un saludo sin contenido, lo mismo que ya decía el resumen anterior). Si es false, dejá el resumen vacío y sin consultas.
- resumen: 2 a 5 renglones en castellano rioplatense, para la vendedora: quién habló (Maru o la vendedora), qué pidió el cliente, qué se le respondió o cotizó y en qué quedó. Concreto, con cantidades, productos, fechas y montos si están. Sin inventar nada que no esté en los datos.
- proximo_paso: lo que quedó pendiente y de quién («Lucía tiene que mandar la cotización de 200 botellas», «el cliente va a confirmar el logo»), o vacío.
- consultas: un elemento por cada producto que el cliente consultó ESE día (si en el resumen anterior ya estaba y no cambió nada, no lo repitas). Para cada uno:
  - categoria y tipo: de las listas. El tipo tiene que ser de esa categoría: ${Object.entries(CATALOGO).map(([c, t]) => `${c}: ${t.join(', ')}`).join('; ')}. Un kit o combo de varios productos va como «Kit / Combo» / «Kit», salvo que pida cada producto por separado.
  - producto: cómo lo nombró el cliente o el modelo («Botella Stanley 1 L», «Kit Verano de abanico, gorro y botella»).
  - cantidad: unidades, número entero, o null. precio_unitario y presupuesto_total en pesos, o null (no los calcules si no están).
  - fecha_necesaria: AAAA-MM-DD si dio una fecha, o el texto («antes de fin de año»), o vacío.
  - ocasion, objecion: de las listas, o vacío.
  - personalizacion: cómo lo quiere personalizar («logo grabado láser», «bordado», «serigrafía 1 color»), o vacío.
  - pidio_muestra / pidio_boceto: si pidió muestra o boceto.
  - competidor: si nombró a otro proveedor o un precio de otro lado, cuál; si no, vacío.
  - entrega: dónde hay que entregar (ciudad o zona; «varias direcciones» si son varias), o vacío.`;

interface FilaPendiente { conversation_id: string; dia: string; intentos: number }
interface FilaConv { conversation_id: string; telefono: string | null; email: string | null; titulo: string | null; link: string | null; contact_id: number | null;
  asignada_a: string | null; asignada_user_id: number | null; campos: string; ultimo_resumen: string | null }

async function buscarContacto(db: D1Database, conv: FilaConv) {
  if (conv.telefono) {
    const r = await db.prepare("SELECT id, owner_id FROM records WHERE object_type = 'contact' AND archived = 0 AND phone = ? ORDER BY updated_at DESC LIMIT 1")
      .bind(conv.telefono).first<{ id: number; owner_id: number | null }>();
    if (r) return r;
  }
  if (conv.email) {
    const r = await db.prepare("SELECT id, owner_id FROM records WHERE object_type = 'contact' AND archived = 0 AND email = ? LIMIT 1").bind(conv.email).first<{ id: number; owner_id: number | null }>();
    if (r) return r;
  }
  if (conv.contact_id) {
    return db.prepare("SELECT id, owner_id FROM records WHERE id = ? AND object_type = 'contact' AND archived = 0").bind(conv.contact_id).first<{ id: number; owner_id: number | null }>();
  }
  return null;
}

// El negocio de esa conversación: el que tiene su link de Darwin, si no el abierto más reciente del contacto.
async function negocioDe(db: D1Database, contactId: number, convId: string) {
  const r = await db.prepare(`SELECT d.id FROM associations a JOIN records d ON d.id = a.to_id LEFT JOIN stages s ON s.id = d.stage_id
    WHERE a.from_id = ? AND a.to_type = 'deal' AND d.archived = 0
    ORDER BY (json_extract(d.props, '$.link_a_darwin') LIKE ?) DESC, COALESCE(s.is_closed, 0), d.updated_at DESC LIMIT 1`)
    .bind(contactId, `%${convId}`).first<{ id: number }>();
  return r?.id ?? null;
}

function datosParaClaude(conv: FilaConv, eventos: Array<{ tipo: string; ocurrido_at: string; payload: string }>, dia: string) {
  const resumenes: string[] = [];
  const lineas: string[] = [];
  for (const e of eventos) {
    const p = JSON.parse(e.payload) as Record<string, any>;
    const d = (p.data?.data ?? p.data ?? {}) as Record<string, any>;
    const hora = new Date(new Date(e.ocurrido_at).getTime() - ZONA_MS).toISOString().slice(11, 16);
    const quien = d.forwardedToName ? ` (a ${d.forwardedToName}${d.forwardType ? `, ${d.forwardType}` : ''})` : '';
    lineas.push(`${hora} ${e.tipo}${e.tipo.startsWith('session.forwarded') ? quien : ''}`);
    const s = txt(d.summary);
    if (s && !resumenes.includes(s)) resumenes.push(s);
  }
  return [
    `Día: ${dia}`,
    `Cliente: ${conv.titulo ?? 's/d'}${conv.telefono ? ` · tel. …${conv.telefono.slice(-4)}` : ''}`,
    `Atiende: ${conv.asignada_a ? `${conv.asignada_a} (vendedora; antes Maru)` : 'Maru (asistente con IA)'}`,
    `Eventos del día:\n${lineas.join('\n') || '(ninguno)'}`,
    `Resúmenes de Darwin:\n${resumenes.map((s) => `- ${s}`).join('\n') || '(ninguno)'}`,
    `Campos que juntó Darwin: ${conv.campos}`,
    `Resumen anterior del CRM: ${conv.ultimo_resumen ?? '(ninguno)'}`,
  ].join('\n\n');
}

async function preguntarAClaude(env: Env, datos: string): Promise<Respuesta> {
  const res = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1, timeout: 60_000 }).beta.messages.create({
    model: MODELO_RESUMEN, max_tokens: 3000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    system: INSTRUCCIONES,
    messages: [{ role: 'user', content: datos }],
  });
  const texto = res.content.map((x) => (x.type === 'text' ? x.text : '')).join('').trim();
  return JSON.parse(texto) as Respuesta;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cuerpo(r: Respuesta) {
  const lineas = [r.resumen.trim()];
  if (r.proximo_paso.trim()) lineas.push(`Próximo paso: ${r.proximo_paso.trim()}`);
  if (r.consultas.length) {
    lineas.push('Consultó:');
    for (const c of r.consultas) {
      const extra = [c.cantidad ? `${c.cantidad} u.` : '', c.fecha_necesaria ? `para ${c.fecha_necesaria}` : '', c.ocasion, c.personalizacion].filter(Boolean).join(' · ');
      lineas.push(`• ${c.tipo}${c.producto ? ` (${c.producto})` : ''}${extra ? ` — ${extra}` : ''}`);
    }
  }
  return lineas.join('\n');
}

async function marcar(db: D1Database, f: FilaPendiente, estado: string, extra: { contact_id?: number | null; activity_id?: number | null; detalle?: string | null; intento?: boolean } = {}) {
  await db.prepare(`UPDATE darwin_resumenes SET estado = ?, contact_id = COALESCE(?, contact_id), activity_id = COALESCE(?, activity_id), detalle = ?,
      intentos = intentos + ?, updated_at = ? WHERE conversation_id = ? AND dia = ?`)
    .bind(estado, extra.contact_id ?? null, extra.activity_id ?? null, extra.detalle ?? null, extra.intento ? 1 : 0, now(), f.conversation_id, f.dia).run();
}

export async function resumirConversacion(env: Env, ctx: Ctx, f: FilaPendiente) {
  const db = env.DB;
  const conv = await db.prepare('SELECT * FROM darwin_conversaciones WHERE conversation_id = ?').bind(f.conversation_id).first<FilaConv>();
  if (!conv) { await marcar(db, f, 'error', { detalle: 'No está la conversación.' }); return 'error'; }
  const contacto = await buscarContacto(db, conv);
  if (!contacto) {
    await marcar(db, f, 'sin_contacto', { detalle: conv.telefono ? `No hay contacto con el teléfono …${conv.telefono.slice(-4)}.` : 'La conversación no trae teléfono ni mail.' });
    return 'sin_contacto';
  }
  if (conv.contact_id !== contacto.id) await db.prepare('UPDATE darwin_conversaciones SET contact_id = ? WHERE conversation_id = ?').bind(contacto.id, conv.conversation_id).run();
  const { results: eventos } = await db.prepare('SELECT tipo, ocurrido_at, payload FROM darwin_eventos WHERE conversation_id = ? AND dia = ? ORDER BY ocurrido_at, id')
    .bind(f.conversation_id, f.dia).all<{ tipo: string; ocurrido_at: string; payload: string }>();

  let r: Respuesta;
  try { r = await preguntarAClaude(env, datosParaClaude(conv, eventos, f.dia)); }
  catch (e) {
    await marcar(db, f, f.intentos >= 2 ? 'error' : 'pendiente', { contact_id: contacto.id, detalle: `Claude: ${(e as Error).message}`.slice(0, 300), intento: true });
    return 'error';
  }
  const externo = `darwin:${f.conversation_id}:${f.dia}`;
  // Si el día se vuelve a resumir, se reemplaza lo anterior.
  const previa = await db.prepare("SELECT id FROM activities WHERE type = 'whatsapp' AND external_id = ?").bind(externo).first<{ id: number }>();
  await db.prepare('DELETE FROM consultas WHERE conversation_id = ? AND dia = ?').bind(f.conversation_id, f.dia).run();
  if (!r.hubo_novedad || !r.resumen.trim()) {
    if (previa) await db.prepare('UPDATE activities SET archived = 1 WHERE id = ?').bind(previa.id).run();
    await marcar(db, f, 'sin_novedad', { contact_id: contacto.id });
    return 'sin_novedad';
  }

  const empresa = await primaryCompanyId(db, contacto.id);
  const negocio = await negocioDe(db, contacto.id, f.conversation_id);
  const owner = conv.asignada_user_id ?? contacto.owner_id ?? null;
  const meta = { darwin: true, conversation_id: f.conversation_id, link: conv.link, atendio: conv.asignada_a ?? 'Maru', dia: f.dia, proximo_paso: r.proximo_paso };
  let activityId: number;
  if (previa) {
    await db.prepare("UPDATE activities SET body = ?, meta = ?, owner_id = ?, archived = 0, updated_at = ? WHERE id = ?")
      .bind(cuerpo(r), JSON.stringify(meta), owner, now(), previa.id).run();
    activityId = previa.id;
  } else {
    const a = await createActivity(db, ctx, {
      type: 'whatsapp', direction: 'in', subject: 'Resumen del día en Darwin', body: cuerpo(r), owner_id: owner,
      // A la última hora del día en Buenos Aires: queda en su lugar en la línea de tiempo.
      occurred_at: new Date(Date.parse(`${f.dia}T23:59:00Z`) + ZONA_MS).toISOString(),
      external_id: externo, thread_id: f.conversation_id, meta, links: [contacto.id, ...(negocio ? [negocio] : [])],
    });
    activityId = a.id;
  }
  if (r.consultas.length) {
    await db.batch(r.consultas.map((c) => db.prepare(`INSERT INTO consultas (contact_id, company_id, deal_id, conversation_id, dia, atendio, owner_id, categoria, tipo, producto,
        cantidad, precio_unitario, presupuesto_total, fecha_necesaria, ocasion, personalizacion, pidio_muestra, pidio_boceto, objecion, competidor, entrega, origen, link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Darwin', ?)`)
      .bind(contacto.id, empresa, negocio, f.conversation_id, f.dia, conv.asignada_a ?? 'Maru', owner, CATEGORIAS.includes(c.categoria) ? c.categoria : 'Otro',
        TIPOS.includes(c.tipo) ? c.tipo : 'Otro', txt(c.producto).slice(0, 200) || null, num(c.cantidad) == null ? null : Math.round(num(c.cantidad)!),
        num(c.precio_unitario), num(c.presupuesto_total), txt(c.fecha_necesaria) || null, txt(c.ocasion) || null, txt(c.personalizacion) || null,
        c.pidio_muestra ? 1 : 0, c.pidio_boceto ? 1 : 0, txt(c.objecion) || null, txt(c.competidor) || null, txt(c.entrega) || null, conv.link)));
  }
  await db.prepare('UPDATE darwin_conversaciones SET ultimo_resumen = ? WHERE conversation_id = ?').bind(`${f.dia}: ${r.resumen}`.slice(0, 2000), f.conversation_id).run();
  await marcar(db, f, 'hecho', { contact_id: contacto.id, activity_id: activityId });
  return 'hecho';
}

// Los días ya terminados que quedan por resumir, del más viejo al más nuevo, con el tope de consultas de la corrida.
export async function resumirPendientes(env: Env, opts: { budget?: Budget; hasta?: string; max?: number } = {}) {
  if (!env.ANTHROPIC_API_KEY) return { hechos: 0, skipped: 'Falta ANTHROPIC_API_KEY.' };
  const db = env.DB;
  const b = opts.budget ?? Budget.of(env);
  const hasta = opts.hasta ?? hoyBsAs();   // los de hoy esperan a que termine el día
  const { results } = await db.prepare("SELECT conversation_id, dia, intentos FROM darwin_resumenes WHERE estado = 'pendiente' AND dia < ? ORDER BY dia, conversation_id LIMIT ?")
    .bind(hasta, Math.max(1, Math.min(opts.max ?? 40, b.left()))).all<FilaPendiente>();
  const ctx: Ctx = { ...(await systemCtx(env)), source: 'darwin', sourceDetail: 'Resumen del día' };
  const out: Record<string, number> = {};
  for (const f of results) {
    try { b.take(); } catch (e) { if (e instanceof OutOfBudget) break; throw e; }
    const estado = await resumirConversacion(env, ctx, f);
    out[estado] = (out[estado] ?? 0) + 1;
  }
  return { ...out, quedan: (await db.prepare("SELECT COUNT(*) AS n FROM darwin_resumenes WHERE estado = 'pendiente' AND dia < ?").bind(hasta).first<{ n: number }>())?.n ?? 0 };
}

// ---------- 3. Lo que se ve en el CRM ----------

export interface FiltroConsultas { q?: string; tipo?: string; categoria?: string; desde?: string; hasta?: string; min_cantidad?: string | number; ocasion?: string;
  sin_venta?: string | boolean; contact_id?: string | number; company_id?: string | number; owner_id?: string | number; limit?: string | number; offset?: string | number }

// «Quién consultó por botellas»: por tipo o categoría, texto libre (producto, personalización, cliente), fechas, cantidad mínima,
// y «sin venta» (el contacto no tiene un negocio ganado después de la consulta). Ventas ve las de sus clientes.
export async function buscarConsultas(db: D1Database, user: User, f: FiltroConsultas) {
  const w: string[] = [`${visibleSql('ct', user)}`];
  const b: unknown[] = [];
  if (f.tipo) { w.push('c.tipo = ?'); b.push(String(f.tipo)); }
  if (f.categoria) { w.push('c.categoria = ?'); b.push(String(f.categoria)); }
  if (f.ocasion) { w.push('c.ocasion = ?'); b.push(String(f.ocasion)); }
  if (f.desde) { w.push('c.dia >= ?'); b.push(String(f.desde)); }
  if (f.hasta) { w.push('c.dia <= ?'); b.push(String(f.hasta)); }
  if (Number(f.min_cantidad) > 0) { w.push('c.cantidad >= ?'); b.push(Number(f.min_cantidad)); }
  if (Number(f.contact_id) > 0) { w.push('c.contact_id = ?'); b.push(Number(f.contact_id)); }
  if (Number(f.company_id) > 0) { w.push('c.company_id = ?'); b.push(Number(f.company_id)); }
  if (Number(f.owner_id) > 0) { w.push('c.owner_id = ?'); b.push(Number(f.owner_id)); }
  if (f.q && String(f.q).trim()) {
    const q = `%${String(f.q).trim().toLowerCase()}%`;
    w.push(`(lower(COALESCE(c.producto, '')) LIKE ? OR lower(COALESCE(c.tipo, '')) LIKE ? OR lower(COALESCE(c.categoria, '')) LIKE ?
      OR lower(COALESCE(c.personalizacion, '')) LIKE ? OR lower(ct.name) LIKE ? OR lower(COALESCE(co.name, '')) LIKE ?)`);
    b.push(q, q, q, q, q, q);
  }
  if (f.sin_venta === true || f.sin_venta === '1' || f.sin_venta === 'true') {
    w.push(`NOT EXISTS (SELECT 1 FROM associations ga JOIN records gd ON gd.id = ga.to_id JOIN stages gs ON gs.id = gd.stage_id
      WHERE ga.from_id = c.contact_id AND ga.to_type = 'deal' AND gd.archived = 0 AND gs.is_won = 1 AND substr(COALESCE(gd.close_date, gd.updated_at), 1, 10) >= c.dia)`);
  }
  const where = w.join(' AND ');
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 100));
  const offset = Math.max(0, Number(f.offset) || 0);
  const desde = `FROM consultas c JOIN records ct ON ct.id = c.contact_id AND ct.archived = 0 LEFT JOIN records co ON co.id = c.company_id AND co.archived = 0 WHERE ${where}`;
  const { results } = await db.prepare(`SELECT c.*, ct.name AS contacto, co.name AS empresa ${desde} ORDER BY c.dia DESC, c.id DESC LIMIT ? OFFSET ?`)
    .bind(...b, limit, offset).all<Record<string, unknown>>();
  const total = (await db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT c.contact_id) AS clientes, SUM(c.cantidad) AS unidades ${desde}`).bind(...b)
    .first<{ n: number; clientes: number; unidades: number | null }>())!;
  const { results: porTipo } = await db.prepare(`SELECT c.tipo, COUNT(*) AS n ${desde} GROUP BY c.tipo ORDER BY n DESC LIMIT 12`).bind(...b).all<{ tipo: string; n: number }>();
  return { consultas: results.map((r) => ({ ...r, pidio_muestra: !!r.pidio_muestra, pidio_boceto: !!r.pidio_boceto }) as Record<string, unknown>), total: total.n, clientes: total.clientes,
    unidades: total.unidades ?? 0, por_tipo: porTipo, catalogo: CATALOGO, ocasiones: OCASIONES.filter(Boolean) };
}

// Conversaciones que Maru ya pasó a una vendedora donde el cliente escribió después de la última respuesta del equipo y no
// se le contestó en `horas` (por defecto 24). Ventas ve las suyas.
export async function pendientesDeRespuesta(db: D1Database, user: User, horas = 24) {
  const limite = new Date(Date.now() - horas * 3600_000).toISOString();
  const { results } = await db.prepare(`SELECT dc.conversation_id, dc.titulo, dc.link, dc.asignada_a, dc.asignada_user_id, dc.asignada_at, dc.ultima_respuesta_cliente,
      dc.ultima_actividad_equipo, dc.contact_id, ct.name AS contacto, ct.owner_id
    FROM darwin_conversaciones dc LEFT JOIN records ct ON ct.id = dc.contact_id AND ct.archived = 0
    WHERE dc.asignada_at IS NOT NULL AND dc.ultima_respuesta_cliente IS NOT NULL AND dc.ultima_respuesta_cliente != ''
      AND dc.ultima_respuesta_cliente > MAX(COALESCE(dc.ultima_actividad_equipo, ''), dc.asignada_at)
      AND dc.ultima_respuesta_cliente <= ?
      AND (dc.cerrada_at IS NULL OR dc.cerrada_at < dc.ultima_respuesta_cliente)
      AND (dc.contact_id IS NULL OR ${visibleSql('ct', user)})
      ${user.profile === 'comercial' && user.role !== 'admin' ? `AND (dc.asignada_user_id = ${Number(user.id)} OR ct.owner_id = ${Number(user.id)})` : ''}
    ORDER BY dc.ultima_respuesta_cliente LIMIT 200`).bind(limite).all<Record<string, unknown>>();
  return { pendientes: results, horas };
}

export async function estadoDarwin(db: D1Database) {
  const r = await db.prepare(`SELECT (SELECT COUNT(*) FROM darwin_eventos WHERE created_at >= datetime('now', '-1 day')) AS eventos_24h,
      (SELECT MAX(created_at) FROM darwin_eventos) AS ultimo_evento,
      (SELECT COUNT(*) FROM darwin_resumenes WHERE estado = 'pendiente') AS pendientes,
      (SELECT COUNT(*) FROM darwin_resumenes WHERE estado = 'hecho') AS hechos,
      (SELECT COUNT(*) FROM darwin_resumenes WHERE estado = 'sin_contacto') AS sin_contacto,
      (SELECT COUNT(*) FROM darwin_resumenes WHERE estado = 'error') AS errores,
      (SELECT COUNT(*) FROM consultas) AS consultas`).first<Record<string, unknown>>();
  return r;
}
