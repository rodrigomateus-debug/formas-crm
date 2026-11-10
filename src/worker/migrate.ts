import { Hono } from 'hono';
import type { Ctx, Env, ObjectType, User } from './env';
import { HttpError, now } from './env';
import { requireRole } from './auth';
import { Meta, type Property } from './meta';
import { displayName, emailDomain, mergeRecords, normDomain, normPhone, splitName, updateRecord, NATIVE_ID_START, type Props } from './records';
import { ORDER_STAGE_ALIAS } from './seed';

// Carga masiva desde HubSpot (la usa scripts/migrate-hubspot.mjs). Conserva los ids de HubSpot en registros,
// actividades y (si el usuario no existía) propietarios, así los links y los tableros siguen valiendo.
// Es repetible: un registro que ya se editó en el CRM (updated_at más nuevo) no se pisa.

type App = { Bindings: Env; Variables: { ctx: Ctx } };
export const migrate = new Hono<App>();

migrate.use('*', async (c, next) => { requireRole(c.get('ctx'), 'admin'); await next(); });

const HS_TYPES: Record<string, ObjectType> = { contacts: 'contact', companies: 'company', deals: 'deal', orders: 'order' };
const PROP_TYPE: Record<string, string> = { number: 'number', date: 'date', datetime: 'datetime', bool: 'bool', booleancheckbox: 'bool' };

async function ownerIds(db: D1Database) {
  const { results } = await db.prepare('SELECT id, hs_owner_id FROM users WHERE hs_owner_id IS NOT NULL').all<{ id: number; hs_owner_id: string }>();
  return new Map(results.map((u) => [u.hs_owner_id, u.id]));
}

// Valor de HubSpot → valor del CRM según el tipo de la propiedad. Lo que no encaja se guarda como texto.
function convert(p: Property | undefined, v: unknown, owners: Map<string, number>): unknown {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!p) return s;
  switch (p.type) {
    case 'owner': return owners.get(s) ?? null;
    case 'number': case 'currency': { const n = Number(s); return Number.isFinite(n) ? n : s; }
    case 'date': return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : /^\d{12,}$/.test(s) ? new Date(Number(s)).toISOString().slice(0, 10) : s;
    case 'datetime': return /^\d{12,}$/.test(s) ? new Date(Number(s)).toISOString() : s;
    default: return s;
  }
}

// Lo que manda ClickUp en un pedido (ver clickup.ts): en un pedido migrado vale más que lo que traía HubSpot.
const CLICKUP_PROPS = ['hs_pipeline_stage', 'unidad_de_negocio', 'cliente_clickup', 'pedido_finnegans', 'url_clickup', 'detalle_produccion', 'entregado_el', 'factura_numero'];
const clickupOrders: Array<{ id: number; pdv: string }> = [];
// Contactos y empresas que el CRM ya creó solo (Gmail, Darwin, formularios) antes de migrar: se combinan en el de HubSpot.
// Lo que ya puede estar en el CRM creado por otra vía (Gmail, Darwin): contacto por mail o teléfono, empresa por dominio y
// negocio por el link a la conversación de Darwin.
const sameKey: Array<{ id: number; type: 'contact' | 'company' | 'deal'; by: 'email' | 'phone' | 'domain' | 'darwin'; key: string }> = [];

migrate.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ kind: string; items?: any[]; offset?: number; limit?: number }>();
  const items = body.items ?? [];
  const stmts: D1PreparedStatement[] = [];
  const meta = new Meta(db);

  switch (body.kind) {
    case 'users': {
      for (const u of items) {
        const extra = JSON.stringify((u.team_hs_ids ?? []).filter((t: unknown) => String(t) !== String(u.team_hs_id ?? '')).map(Number));
        const hs = String(u.hs_owner_id);
        // Quien ya está ligado a ese propietario de HubSpot conserva su usuario aunque en HubSpot tenga otro mail
        // (ej. entra con el de formas.ar y en HubSpot figura el de formaspublicitarias.com): no se crea otro.
        // Uno eliminado en el CRM sigue eliminado: no se lo reactiva ni se lo vuelve a crear.
        stmts.push(db.prepare(`UPDATE users SET team_id = COALESCE(team_id, (SELECT id FROM teams WHERE hs_id = ?)),
            extra_teams = CASE WHEN extra_teams = '[]' THEN (SELECT json_group_array(id) FROM teams WHERE id IN (SELECT value FROM json_each(?))) ELSE extra_teams END,
            active = CASE WHEN role = 'admin' THEN active ELSE ? END
          WHERE hs_owner_id = ? AND deleted_at IS NULL`).bind(u.team_hs_id ?? null, extra, u.active ? 1 : 0, hs));
        stmts.push(db.prepare(`INSERT INTO users (id, email, name, role, team_id, extra_teams, active, hs_owner_id)
          SELECT ?, ?, ?, 'member', (SELECT id FROM teams WHERE hs_id = ?), (SELECT json_group_array(id) FROM teams WHERE id IN (SELECT value FROM json_each(?))), ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE hs_owner_id = ?)
          ON CONFLICT (email) DO UPDATE SET hs_owner_id = excluded.hs_owner_id, team_id = COALESCE(users.team_id, excluded.team_id),
            extra_teams = CASE WHEN users.extra_teams = '[]' THEN excluded.extra_teams ELSE users.extra_teams END,
            active = CASE WHEN users.role = 'admin' OR users.deleted_at IS NOT NULL THEN users.active ELSE excluded.active END`)
          .bind(Number(u.hs_owner_id), String(u.email).toLowerCase(), u.name || u.email, u.team_hs_id ?? null, extra, u.active ? 1 : 0, hs, hs));
      }
      break;
    }
    case 'pipelines': {
      for (const p of items) {
        stmts.push(db.prepare("INSERT OR IGNORE INTO pipelines (id, object_type, label, display_order) VALUES (?, 'deal', ?, ?)").bind(p.id, p.label, p.display_order ?? 99));
        for (const s of p.stages ?? []) {
          stmts.push(db.prepare('INSERT OR IGNORE INTO stages (id, pipeline_id, label, display_order, probability, is_closed, is_won) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(s.id, p.id, s.label, s.display_order ?? 0, Number(s.probability ?? 0), s.is_closed ? 1 : 0, s.is_won ? 1 : 0));
        }
      }
      break;
    }
    case 'properties': {
      // Crea las propiedades custom que falten y suma opciones nuevas a los desplegables existentes.
      const existing = await meta.properties();
      for (const p of items) {
        const type = HS_TYPES[p.object_type] ?? p.object_type;
        const name = p.name === 'hubspot_owner_id' ? 'owner_id' : p.name;
        const cur = existing.find((x) => x.object_type === type && x.name === name);
        const options = (p.options ?? []).map((o: { value: string; label: string }) => ({ value: o.value, label: o.label }));
        if (cur) {
          // El estado del pedido tiene sus estados generales (los de HubSpot se traducen en ORDER_STAGE_ALIAS): no se suman.
          if (type === 'order' && name === 'hs_pipeline_stage') continue;
          if (['enum', 'multienum'].includes(cur.type) && options.length) {
            const merged = [...cur.options, ...options.filter((o: { value: string }) => !cur.options.some((x) => x.value === o.value))];
            if (merged.length !== cur.options.length) {
              stmts.push(db.prepare('UPDATE properties SET options = ? WHERE object_type = ? AND name = ?').bind(JSON.stringify(merged), type, name));
            }
          }
          continue;
        }
        const t = p.type === 'enumeration' ? (p.fieldType === 'checkbox' ? 'multienum' : p.fieldType === 'booleancheckbox' ? 'bool' : 'enum')
          : PROP_TYPE[p.type] ?? (p.fieldType === 'textarea' ? 'text' : 'string');
        stmts.push(db.prepare(`INSERT OR IGNORE INTO properties (object_type, name, label, type, options, group_name, description, display_order)
          VALUES (?, ?, ?, ?, ?, 'Traídas de HubSpot', ?, 500)`).bind(type, name, p.label, t, JSON.stringify(options), p.description ?? ''));
      }
      break;
    }
    case 'records': {
      const owners = await ownerIds(db);
      clickupOrders.length = 0;
      sameKey.length = 0;
      for (const r of items) {
        const type = HS_TYPES[r.type] ?? r.type as ObjectType;
        const defs = await meta.properties(type);
        const props: Props = {};
        for (const [k, raw] of Object.entries(r.props ?? {})) {
          const name = k === 'hubspot_owner_id' ? 'owner_id' : k;
          const def = defs.find((d) => d.name === name);
          if (!def || def.read_only) continue;
          const v = convert(def, raw, owners);
          if (v != null) props[name] = v;
        }
        if (type === 'contact' && props.firstname && props.lastname) Object.assign(props, splitName(props.firstname, props.lastname));
        if (type === 'order' && props.hs_pipeline_stage) props.hs_pipeline_stage = ORDER_STAGE_ALIAS[String(props.hs_pipeline_stage)] ?? props.hs_pipeline_stage;
        if (type === 'order' && props.pdv_finnegans) clickupOrders.push({ id: Number(r.hs_id), pdv: String(props.pdv_finnegans).replace(/\D/g, '') });
        // El workflow de Darwin inventaba mails (incompleto<teléfono>@gmail.com) para no duplicar: acá el contacto se busca por teléfono.
        if (type === 'contact' && /^incompleto[^@]*@gmail\.com$/i.test(String(props.email ?? ''))) delete props.email;
        const id = Number(r.hs_id);
        if (!r.archived && type === 'contact' && props.email) sameKey.push({ id, type, by: 'email', key: String(props.email).trim().toLowerCase() });
        const tel = type === 'contact' ? normPhone(props.phone || props.mobilephone) : null;
        if (!r.archived && tel) sameKey.push({ id, type: 'contact', by: 'phone', key: tel });
        if (!r.archived && type === 'company' && normDomain(props.domain || props.website)) sameKey.push({ id, type, by: 'domain', key: normDomain(props.domain || props.website)! });
        // Mientras convivan los dos workflows de Darwin (HubSpot y CRM), el mismo cliente entra por los dos.
        if (!r.archived && type === 'deal' && props.link_a_darwin) sameKey.push({ id, type, by: 'darwin', key: String(props.link_a_darwin).trim() });
        const created = r.created_at ?? now();
        const updated = r.updated_at ?? created;
        const stageEntered = r.stage_entered_at ?? null;
        stmts.push(db.prepare(`INSERT INTO records (id, object_type, name, props, owner_id, email, domain, phone, pipeline_id, stage_id, amount, close_date,
            stage_entered_at, created_at, updated_at, source, source_detail, hs_id, archived)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hubspot', ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, props = excluded.props, owner_id = excluded.owner_id, email = excluded.email,
            domain = excluded.domain, phone = excluded.phone, pipeline_id = excluded.pipeline_id, stage_id = excluded.stage_id, amount = excluded.amount,
            close_date = excluded.close_date, stage_entered_at = excluded.stage_entered_at, updated_at = excluded.updated_at, archived = excluded.archived
          WHERE records.updated_at <= excluded.updated_at`)
          .bind(id, type, displayName(type, props), JSON.stringify(props), (props.owner_id as number) ?? null,
            type === 'contact' ? (props.email as string) ?? null : type === 'order' ? (props.hs_billing_address_email as string) ?? null : null,
            type === 'company' ? normDomain(props.domain || props.website) : type === 'contact' ? emailDomain(props.email) : null,
            normPhone(props.phone || props.mobilephone || props.hs_customer_phone || props.hs_billing_address_phone),
            type === 'deal' ? (props.pipeline as string) ?? null : null, type === 'deal' ? (props.dealstage as string) ?? null : null,
            type === 'deal' ? (props.amount as number) ?? null : type === 'order' ? (props.hs_total_price as number) ?? null : null,
            type === 'deal' ? (props.closedate as string) ?? null : null, stageEntered, created, updated,
            [r.source_label, r.source_detail].filter(Boolean).join(' · ') || null, String(r.hs_id), r.archived ? 1 : 0));
        // Historia de etapas (hs_v2_date_entered_<etapa>) para los tableros y la línea de tiempo.
        if (r.stage_history && Object.keys(r.stage_history).length) {
          stmts.push(db.prepare("DELETE FROM changes WHERE record_id = ? AND prop = 'dealstage' AND source = 'hubspot'").bind(id));
          for (const [stage, at] of Object.entries(r.stage_history as Record<string, string>)) {
            stmts.push(db.prepare("INSERT INTO changes (record_id, prop, new_value, changed_at, source) VALUES (?, 'dealstage', ?, ?, 'hubspot')").bind(id, stage, at));
          }
        }
      }
      break;
    }
    case 'associations': {
      for (const a of items) {
        const sql = `INSERT INTO associations (from_type, from_id, to_type, to_id, label, is_primary)
          SELECT f.object_type, f.id, t.object_type, t.id, ?, ? FROM records f, records t WHERE f.id = ? AND t.id = ?
          ON CONFLICT (from_id, to_id) DO UPDATE SET is_primary = MAX(is_primary, excluded.is_primary)`;
        stmts.push(db.prepare(sql).bind(a.label ?? null, a.primary ? 1 : 0, Number(a.from), Number(a.to)));
        stmts.push(db.prepare(sql).bind(a.label ?? null, a.primary ? 1 : 0, Number(a.to), Number(a.from)));
      }
      break;
    }
    case 'activities': {
      const owners = await ownerIds(db);
      for (const a of items) {
        const id = Number(a.hs_id);
        stmts.push(db.prepare(`INSERT INTO activities (id, type, occurred_at, owner_id, subject, body, direction, status, outcome, due_at, completed_at,
            priority, task_type, meta, thread_id, created_at, updated_at, source, hs_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hubspot', ?)
          ON CONFLICT (id) DO UPDATE SET occurred_at = excluded.occurred_at, owner_id = excluded.owner_id, subject = excluded.subject, body = excluded.body,
            status = excluded.status, outcome = excluded.outcome, due_at = excluded.due_at, completed_at = excluded.completed_at, priority = excluded.priority,
            meta = excluded.meta, updated_at = excluded.updated_at WHERE activities.updated_at <= excluded.updated_at`)
          .bind(id, a.type, a.occurred_at ?? a.created_at ?? now(), owners.get(String(a.owner_hs)) ?? null, (a.subject ?? '').slice(0, 500),
            (a.body ?? '').slice(0, 30000), a.direction ?? null, a.status ?? null, a.outcome ?? null, a.due_at ?? null, a.completed_at ?? null,
            a.priority ?? null, a.task_type ?? null, JSON.stringify(a.meta ?? {}), a.thread_id ?? null, a.created_at ?? now(), a.updated_at ?? a.created_at ?? now(), String(a.hs_id)));
        for (const rid of a.links ?? []) {
          stmts.push(db.prepare('INSERT OR IGNORE INTO activity_links (activity_id, record_id, object_type) SELECT ?, id, object_type FROM records WHERE id = ?').bind(id, Number(rid)));
        }
      }
      break;
    }
    case 'finalize': {
      // Recalcula Última actividad / Último contacto / Próxima actividad por tramos de ids.
      const limit = Math.min(body.limit ?? 2000, 5000);
      const { results } = await db.prepare('SELECT id FROM records ORDER BY id LIMIT ? OFFSET ?').bind(limit, body.offset ?? 0).all<{ id: number }>();
      if (!results.length) return c.json({ done: true });
      const ts = now();
      await db.prepare(`UPDATE records SET
        last_activity_at = (SELECT MAX(a.occurred_at) FROM activities a JOIN activity_links l ON l.activity_id = a.id
          WHERE l.record_id = records.id AND a.archived = 0 AND a.type != 'task' AND a.occurred_at <= ?1),
        last_contacted_at = (SELECT MAX(a.occurred_at) FROM activities a JOIN activity_links l ON l.activity_id = a.id
          WHERE l.record_id = records.id AND a.archived = 0 AND a.type IN ('email', 'call', 'meeting', 'whatsapp') AND a.occurred_at <= ?1 AND (a.type != 'email' OR a.direction = 'out')),
        next_activity_at = (SELECT MIN(COALESCE(a.due_at, a.occurred_at)) FROM activities a JOIN activity_links l ON l.activity_id = a.id
          WHERE l.record_id = records.id AND a.archived = 0 AND ((a.type = 'task' AND a.status != 'COMPLETED') OR (a.type = 'meeting' AND a.occurred_at > ?1)))
        WHERE id IN (SELECT value FROM json_each(?2))`).bind(ts, JSON.stringify(results.map((r) => r.id))).run();
      return c.json({ done: results.length < limit, next: (body.offset ?? 0) + results.length });
    }
    case 'stats': {
      const [r, a, u] = await db.batch([
        db.prepare('SELECT object_type, COUNT(*) AS n FROM records GROUP BY object_type'),
        db.prepare('SELECT type, COUNT(*) AS n FROM activities GROUP BY type'),
        db.prepare('SELECT COUNT(*) AS n FROM users'),
      ]);
      return c.json({ records: r.results, activities: a.results, users: u.results[0] });
    }
    default:
      throw new HttpError(400, `Tipo de lote desconocido: ${body.kind}`);
  }
  for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
  // Pedidos que ClickUp ya había creado en el CRM antes de migrar: se queda el de HubSpot (por sus asociaciones) con lo
  // que sabe ClickUp (estado, detalle, factura, remito) y el creado por ClickUp se combina en él.
  let merged = 0;
  const ctx = { user: (await db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").first<User>())!, source: 'hubspot' };
  // Contactos (por mail o teléfono), empresas (por dominio) y negocios de Darwin (por el link a la conversación) creados en
  // el CRM antes de migrar: queda el de HubSpot, con sus asociaciones y actividades más las del creado acá.
  if (body.kind === 'records') {
    const COL = { email: 'lower(email)', phone: 'phone', domain: 'domain', darwin: "CAST(json_extract(props, '$.link_a_darwin') AS TEXT)" };
    for (const k of sameKey) {
      const dup = await db.prepare(`SELECT id FROM records WHERE object_type = ? AND archived = 0 AND id >= ? AND id != ? AND ${COL[k.by]} = ?`)
        .bind(k.type, NATIVE_ID_START, k.id, k.key).first<{ id: number }>();
      if (!dup) continue;
      await mergeRecords(db, ctx, k.type, k.id, dup.id);
      merged++;
    }
  }
  if (body.kind === 'records' && clickupOrders.length) {
    for (const o of clickupOrders) {
      if (!o.pdv) continue;
      const dup = await db.prepare(`SELECT id, props FROM records WHERE object_type = 'order' AND archived = 0 AND id >= ? AND id != ?
        AND CAST(json_extract(props, '$.pdv_finnegans') AS TEXT) = ?`).bind(NATIVE_ID_START, o.id, o.pdv).first<{ id: number; props: string }>();
      if (!dup) continue;
      const p = JSON.parse(dup.props) as Props;
      await mergeRecords(db, ctx, 'order', o.id, dup.id);
      const keep = Object.fromEntries(CLICKUP_PROPS.filter((k) => p[k] != null && p[k] !== '').map((k) => [k, p[k]]));
      if (Object.keys(keep).length) await updateRecord(db, ctx, 'order', o.id, keep, { system: true, strict: false });
      merged++;
    }
  }
  return c.json({ ok: true, statements: stmts.length, merged });
});
