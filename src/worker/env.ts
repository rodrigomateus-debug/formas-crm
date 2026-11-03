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
  APP_URL?: string;      // dirección pública del CRM, para los links de los mails
  // Cuenta de servicio de Google Workspace con delegación de dominio (gmail.readonly) para registrar mails.
  GOOGLE_SA_JSON?: string;
  // Solo para pruebas: otras URLs de Google.
  GOOGLE_TOKEN_URL?: string;
  GMAIL_API_URL?: string;
  // ClickUp (lista PEC): los pedidos y su estado. Solo lectura.
  CLICKUP_TOKEN?: string;
  // Finnegans: las facturas de los pedidos. Solo lectura.
  FINNEGANS_CLIENT_ID?: string;
  FINNEGANS_CLIENT_SECRET?: string;
  // Solo para pruebas: ClickUp y Finnegans simulados.
  CLICKUP_API_URL?: string;
  SUBREQUESTS?: string;   // consultas a otros servicios por corrida (default 45; ver budget.ts)
  FINNEGANS_API_URL?: string;
}

// Perfiles (pedido de Rodrigo del 02/11/2026): el área de cada usuario. Admin ve y puede todo; los demás, por ahora,
// también ven todo: acá se va a colgar lo que ve cada uno cuando se restrinja. Qué puede hacer (editar, borrar, solo
// mirar) lo dice role; un admin tiene perfil admin y viceversa.
export const PROFILES = ['admin', 'comercial', 'produccion', 'logistica'] as const;
export type Profile = (typeof PROFILES)[number];

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'member' | 'viewer';
  profile: Profile;
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
