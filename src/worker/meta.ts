import type { ObjectType } from './env';
import { seedConfig } from './seed';

export interface Property {
  object_type: ObjectType;
  name: string;
  label: string;
  type: string;
  options: { value: string; label: string }[];
  group_name: string;
  description: string;
  display_order: number;
  system: number;
  read_only: number;
  in_create_form: number;
  required: number;
}

export interface StageConfig {
  // Propiedades que hay que completar para pasar a esta etapa (HubSpot: «propiedades condicionales de etapa»).
  required_props?: string[];
  // Tarea que se crea sola al entrar a la etapa, para el propietario del negocio.
  task?: { subject: string; due_days?: number; task_type?: string } | null;
}

export interface PipelineConfig {
  rules?: {
    no_skip?: boolean;          // no saltear etapas abiertas hacia adelante
    no_backward?: boolean;      // no volver a una etapa anterior (ni reabrir un cerrado)
    require_company?: boolean;  // el negocio tiene que tener una empresa asociada
    create_stages?: string[];   // etapas en las que se puede crear un negocio (vacío = todas)
  };
  card_props?: string[];        // datos de las tarjetas del tablero
  key_props?: string[];         // «Acerca de este negocio» en la ficha
}

export interface Stage {
  id: string;
  pipeline_id: string;
  label: string;
  display_order: number;
  probability: number;
  is_closed: number;
  is_won: number;
  config: StageConfig;
}

export interface Pipeline {
  id: string;
  label: string;
  display_order: number;
  team_id: number | null;
  config: PipelineConfig;
  stages: Stage[];
}

let seeded = false;

export async function ensureSeeded(db: D1Database) {
  if (seeded) return;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'seeded'").first<{ value: string }>();
  if (!row) await seedConfig(db);
  seeded = true;
}

export class Meta {
  private props?: Property[];
  private pipes?: Pipeline[];
  constructor(private db: D1Database) {}

  async properties(type?: ObjectType) {
    if (!this.props) {
      const { results } = await this.db.prepare('SELECT * FROM properties WHERE archived = 0 ORDER BY object_type, display_order, label').all<Property & { options: string }>();
      this.props = results.map((p) => ({ ...p, options: JSON.parse(p.options as unknown as string) }));
    }
    return type ? this.props.filter((p) => p.object_type === type) : this.props;
  }

  async property(type: ObjectType, name: string) {
    return (await this.properties(type)).find((p) => p.name === name);
  }

  async pipelines() {
    if (!this.pipes) {
      const [p, s] = await this.db.batch([
        this.db.prepare('SELECT id, label, display_order, team_id, config FROM pipelines WHERE archived = 0 ORDER BY display_order'),
        this.db.prepare('SELECT * FROM stages WHERE archived = 0 ORDER BY display_order'),
      ]);
      const parse = (v: unknown) => { try { return JSON.parse(String(v ?? '{}')); } catch { return {}; } };
      const stages = (s.results as Array<Stage & { config: string }>).map((st) => ({ ...st, config: parse(st.config) }));
      this.pipes = (p.results as Array<Pipeline & { config: string }>).map((pl) => ({ ...pl, config: parse(pl.config), stages: stages.filter((st) => st.pipeline_id === pl.id) }));
    }
    return this.pipes;
  }

  async pipelineOf(stageId: string) {
    return (await this.pipelines()).find((p) => p.stages.some((s) => s.id === stageId));
  }

  async stage(id: string) {
    for (const p of await this.pipelines()) {
      const s = p.stages.find((st) => st.id === id);
      if (s) return s;
    }
    return undefined;
  }
}
