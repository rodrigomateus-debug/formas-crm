export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Cloudflare Access: el equipo (ej. "formas" en formas.cloudflareaccess.com) y el AUD de la aplicación.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Solo para desarrollo local: entra como este usuario sin Access.
  DEV_USER_EMAIL?: string;
  // Email del primer administrador (se crea solo la primera vez que entra).
  ADMIN_EMAIL?: string;
  // Cuenta de servicio de Google Workspace con delegación de dominio (gmail.readonly) para registrar mails.
  GOOGLE_SA_JSON?: string;
  // Solo para pruebas: otras URLs de Google.
  GOOGLE_TOKEN_URL?: string;
  GMAIL_API_URL?: string;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'member' | 'viewer';
  team_id: number | null;
  extra_teams?: string;
  active: number;
}

export interface Ctx {
  user: User;
  // De dónde viene el cambio: 'crm' (pantalla), 'mcp' (Claude), 'api', 'darwin', 'linkedin', 'gmail', 'form', 'import', 'hubspot'.
  source: string;
  sourceDetail?: string;
}

export type ObjectType = 'contact' | 'company' | 'deal' | 'order';
export const OBJECT_TYPES: ObjectType[] = ['contact', 'company', 'deal', 'order'];

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function assertType(t: string): ObjectType {
  if (!OBJECT_TYPES.includes(t as ObjectType)) throw new HttpError(404, `Tipo de objeto desconocido: ${t}`);
  return t as ObjectType;
}

export const now = () => new Date().toISOString();
