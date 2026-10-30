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

export interface Stage {
  id: string;
  pipeline_id: string;
  label: string;
  display_order: number;
  probability: number;
  is_closed: number;
  is_won: number;
}

export interface Pipeline {
  id: string;
  label: string;
  display_order: number;
  team_id: number | null;
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
        this.db.prepare('SELECT id, label, display_order, team_id FROM pipelines WHERE archived = 0 ORDER BY display_order'),
        this.db.prepare('SELECT * FROM stages WHERE archived = 0 ORDER BY display_order'),
      ]);
      const stages = s.results as unknown as Stage[];
      this.pipes = (p.results as unknown as Pipeline[]).map((pl) => ({ ...pl, stages: stages.filter((st) => st.pipeline_id === pl.id) }));
    }
    return this.pipes;
  }

  async stage(id: string) {
    for (const p of await this.pipelines()) {
      const s = p.stages.find((st) => st.id === id);
      if (s) return s;
    }
    return undefined;
  }
}
