import type { Ctx, User } from './env';
import { HttpError } from './env';
import type { Meta, Pipeline, Stage } from './meta';
import { createActivity } from './activities';

// Reglas y automatizaciones de cada pipeline (como en HubSpot: propiedades condicionales de etapa, reglas del
// pipeline y tareas automáticas al entrar a una etapa). La migración desde HubSpot no pasa por acá.

type Props = Record<string, unknown>;

// La carga histórica y la importación traen datos como están: no se les aplican reglas.
const exempt = (ctx: Ctx) => ['hubspot', 'import'].includes(ctx.source);

export class StageError extends HttpError {
  constructor(message: string, public missing: string[] = []) {
    super(400, message);
  }
}

export async function checkRequired(meta: Meta, stage: Stage, props: Props) {
  const missing = (stage.config.required_props ?? []).filter((p) => props[p] == null || props[p] === '');
  if (!missing.length) return;
  const labels = await Promise.all(missing.map(async (m) => (await meta.property('deal', m))?.label ?? m));
  throw new StageError(`Para pasar a «${stage.label}» falta completar: ${labels.join(', ')}.`, missing);
}

export async function checkCreate(meta: Meta, ctx: Ctx, pipeline: Pipeline, stage: Stage, props: Props) {
  if (exempt(ctx)) return;
  if (!canSee(ctx.user, pipeline)) throw new HttpError(403, `No tenés acceso al pipeline «${pipeline.label}».`);
  const allowed = pipeline.config.rules?.create_stages ?? [];
  if (allowed.length && !allowed.includes(stage.id)) {
    const names = pipeline.stages.filter((s) => allowed.includes(s.id)).map((s) => s.label).join(', ');
    throw new HttpError(400, `En «${pipeline.label}» los negocios se crean en: ${names}.`);
  }
  await checkRequired(meta, stage, props);
}

export async function checkMove(meta: Meta, ctx: Ctx, pipeline: Pipeline, from: Stage | undefined, to: Stage, props: Props) {
  if (exempt(ctx)) return;
  if (!canSee(ctx.user, pipeline)) throw new HttpError(403, `No tenés acceso al pipeline «${pipeline.label}».`);
  const rules = pipeline.config.rules ?? {};
  // Como en HubSpot, los administradores pueden saltear las reglas de movimiento (no las propiedades obligatorias).
  if (from && from.pipeline_id === to.pipeline_id && ctx.user.role !== 'admin') {
    if (rules.no_backward && (to.display_order < from.display_order || (from.is_closed && !to.is_closed))) {
      throw new HttpError(400, `En «${pipeline.label}» un negocio no vuelve a una etapa anterior (de «${from.label}» a «${to.label}»).`);
    }
    if (rules.no_skip && !to.is_closed && !from.is_closed) {
      const open = pipeline.stages.filter((s) => !s.is_closed);
      const i = open.findIndex((s) => s.id === from.id);
      if (open.findIndex((s) => s.id === to.id) - i > 1) {
        throw new HttpError(400, `En «${pipeline.label}» no se saltean etapas: de «${from.label}» sigue «${open[i + 1].label}».`);
      }
    }
  }
  await checkRequired(meta, to, props);
}

// Empresas de un negocio nuevo: las asociadas directo más la empresa principal de cada contacto asociado
// (HubSpot asocia sola la empresa principal del contacto).
export async function companiesFor(db: D1Database, ids: number[]) {
  if (!ids.length) return [] as number[];
  const { results } = await db.prepare(
    `SELECT id FROM records WHERE id IN (SELECT value FROM json_each(?1)) AND object_type = 'company'
     UNION SELECT a.to_id FROM associations a JOIN records r ON r.id = a.from_id AND r.object_type = 'contact'
       WHERE a.from_id IN (SELECT value FROM json_each(?1)) AND a.to_type = 'company' AND a.is_primary = 1`,
  ).bind(JSON.stringify(ids)).all<{ id: number }>();
  return results.map((r) => r.id);
}

export function requireCompany(ctx: Ctx, pipeline: Pipeline | undefined, companyCount: number) {
  if (exempt(ctx) || !pipeline?.config.rules?.require_company || companyCount > 0) return;
  throw new HttpError(400, `En «${pipeline.label}» el negocio tiene que tener una empresa asociada.`);
}

// Tarea automática al entrar a una etapa, para el propietario del negocio.
export async function stageAutomation(db: D1Database, ctx: Ctx, dealId: number, stage: Stage, ownerId: number | null, dealName: string) {
  const t = stage.config.task;
  if (exempt(ctx) || !t?.subject) return;
  const due = new Date(Date.now() + (Number(t.due_days ?? 1)) * 86_400_000);
  due.setUTCHours(13, 0, 0, 0); // 10 de la mañana en Argentina
  await createActivity(db, { ...ctx, source: 'automatización' }, {
    type: 'task', subject: t.subject.replace('{negocio}', dealName), body: `Tarea automática al entrar a «${stage.label}».`,
    due_at: due.toISOString(), owner_id: ownerId ?? undefined, task_type: t.task_type ?? 'todo', links: [dealId], link_primary_company: false,
  });
}

// ---------- Quién ve cada pipeline ----------
// Un pipeline sin equipos elegidos lo ven todos. Con equipos, lo ven sus integrantes (equipo principal o extra)
// y los administradores. Devuelve null cuando el usuario ve todos.
export function teamsOf(user: User) {
  let extra: number[] = [];
  try { extra = JSON.parse(user.extra_teams ?? '[]'); } catch { /* sin equipos extra */ }
  return new Set([user.team_id, ...extra].filter((t): t is number => t != null).map(Number));
}

export function canSee(user: User, pipeline: Pipeline) {
  const teams = pipeline.config.visible_teams ?? [];
  if (user.role === 'admin' || !teams.length) return true;
  const mine = teamsOf(user);
  return teams.some((t) => mine.has(Number(t)));
}

export async function visiblePipelineIds(meta: Meta, user: User): Promise<string[] | null> {
  const all = await meta.pipelines();
  const ids = all.filter((p) => canSee(user, p)).map((p) => p.id);
  return ids.length === all.length ? null : ids;
}

export async function assertDealVisible(meta: Meta, user: User, pipelineId: string | null | undefined) {
  const p = (await meta.pipelines()).find((x) => x.id === pipelineId);
  if (p && !canSee(user, p)) throw new HttpError(403, `No tenés acceso al pipeline «${p.label}».`);
}
