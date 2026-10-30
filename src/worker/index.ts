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
import { StageError } from './pipelines';

type App = { Bindings: Env; Variables: { ctx: Ctx } };
const app = new Hono<App>();

app.onError((err, c) => {
  if (err instanceof StageError) return c.json({ error: err.message, missing: err.missing }, 400);
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
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

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Cada 10 minutos: registra los mails nuevos del equipo (si Gmail está activado en Configuración).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => { await ensureSeeded(env.DB); await syncAll(env); })());
  },
} satisfies ExportedHandler<Env>;
