import { Hono } from 'hono';
import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { authenticate } from './auth';
import { ensureSeeded } from './meta';
import { api } from './api';
import { compat } from './compat';
import { hooks } from './hooks';
import { handleMcp } from './mcp';
import { migrate } from './migrate';
import { syncAll } from './gmail';
import { correrAvisos } from './avisos';
import { Budget } from './budget';
import { actualizarFotos } from './fotos';
import { procesarSalidaClickup, syncClickup } from './clickup';
import { syncFacturas } from './finnegans';
import { refrescarFce } from './facturar';
import { StageError } from './pipelines';
import { leerPendientes } from './remitos';
import { login } from './login';

type App = { Bindings: Env; Variables: { ctx: Ctx } };
const GMAIL_CRON = '5-59/10 * * * *';   // el mismo que en wrangler.jsonc
const app = new Hono<App>();

app.onError((err, c) => {
  if (err instanceof StageError) return c.json({ error: err.message, missing: err.missing }, 400);
  if (err instanceof HttpError) return c.json({ ...(err.extra ?? {}), error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: 'Error interno del CRM.', detail: err.message }, 500);
});

app.use('*', async (c, next) => {
  await ensureSeeded(c.env.DB);
  await next();
});

const authed = async (c: { env: Env; req: { raw: Request }; set: (k: 'ctx', v: Ctx) => void }, next: () => Promise<void>) => {
  c.set('ctx', await authenticate(c.env, c.req.raw));
  await next();
};

app.use('/api/*', authed);
app.route('/api/migrate', migrate);
app.route('/api', api);

// API compatible con HubSpot para los tableros: misma ruta que api.hubapi.com (https://<crm>/crm/v3/...),
// así alcanza con cambiar el host y el token. También en /hubspot/… por claridad.
app.use('/hubspot/*', authed);
app.route('/hubspot', compat);
app.use('/crm/*', authed);
app.use('/oauth/*', authed);
app.route('/', compat);

// La carga desde HubSpot (scripts/migrate-hubspot.mjs) entra por acá con su token: /api pide el login de Cloudflare
// Access, que un script no puede pasar, y /hooks no. Solo con token (nunca con la sesión) y de administrador (migrate.ts).
// El comodín cubre /hooks/migrate y lo de abajo (/hooks/migrate/properties).
app.use('/hooks/migrate/*', async (c, next) => {
  if (!/^Bearer fcrm_/.test(c.req.header('authorization') ?? '')) throw new HttpError(401, 'Falta el token de administrador (Authorization: Bearer fcrm_…).');
  c.set('ctx', await authenticate(c.env, c.req.raw));
  await next();
});
app.route('/hooks/migrate', migrate);
app.route('/hooks', hooks);

// MCP para Claude. El token puede ir en el header Authorization o en la URL (/mcp/fcrm_…),
// porque algunos clientes (conectores personalizados de claude.ai) solo dejan cargar una URL.
app.all('/mcp', async (c) => handleMcp(c.req.raw, await authenticate(c.env, c.req.raw), c.env));
app.all('/mcp/:token', async (c) => handleMcp(c.req.raw, await authenticate(c.env, c.req.raw, c.req.param('token')), c.env));

// Links viejos de HubSpot (app.hubspot.com/contacts/47666798/record/0-3/123) → misma ficha acá.
app.get('/contacts/:portal/record/:typeId/:id', (c) => {
  const path = { '0-1': 'contacts', '0-2': 'companies', '0-3': 'deals', '0-123': 'orders' }[c.req.param('typeId')] ?? 'contacts';
  return c.redirect(`/${path}/${c.req.param('id')}`, 301);
});

app.get('/health', (c) => c.json({ ok: true }));

// Login propio con Google (login.ts): /login, /auth/google, /auth/google/callback y /auth/salir.
app.route('/', login);

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Cada 10 minutos: los avisos por mail y los mails nuevos del equipo (si Gmail está activado) y, por turnos, las facturas de Finnegans (a las
  // :00 y a las :30) o los pedidos de ClickUp (el resto). Van por turnos porque cada corrida tiene un tope de consultas a
  // otros servicios (budget.ts). Cada una corre aunque otra falle (el error queda en Configuración → Integraciones).
  async scheduled(event, env, ctx) {
    const safe = (fn: () => Promise<unknown>) => fn().catch((e) => console.error((e as Error).message));
    const turno = Math.floor(new Date(event.scheduledTime).getUTCMinutes() / 10);
    // Cada corrida tiene su propio tope de consultas (budget.ts): Gmail va en la suya (a los :05, :15…) para no
    // quitarle consultas a ClickUp y Finnegans (a los :00, :10…).
    ctx.waitUntil((async () => {
      await ensureSeeded(env.DB);
      if (event.cron === GMAIL_CRON) {
        // Primero los avisos por mail (pocos y con hora), después la lectura de Gmail con lo que quede del tope.
        const b = Budget.of(env);
        await safe(() => correrAvisos(env, b));
        await safe(() => procesarSalidaClickup(env, b));   // lo que quedó pendiente para ClickUp (pedidos a «pdv»)
        await safe(() => actualizarFotos(env, b));          // fotos de Google de los usuarios: unas pocas, una vez por semana
        await safe(() => leerPendientes(env, b, 2));        // remitos sin leer (los del chofer se leen al llegar; acá los reintentos y ClickUp)
        await safe(() => syncAll(env, b));
      }
      else {
        await safe(() => (turno === 0 || turno === 3 ? syncFacturas(env) : syncClickup(env)));
        if (turno === 1) await safe(() => refrescarFce(env));   // la lista de empresas grandes de ARCA, una vez por día
      }
    })());
  },
} satisfies ExportedHandler<Env>;
