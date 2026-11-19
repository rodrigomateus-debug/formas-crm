import { Hono } from 'hono';
import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { authenticate } from './auth';
import { conectar, sinPermiso } from './conectar';
import { ensureSeeded } from './meta';
import { api } from './api';
import { compat } from './compat';
import { hooks } from './hooks';
import { handleMcp } from './mcp';
import { migrate } from './migrate';
import { syncAll } from './gmail';
import { syncCalendars } from './calendar';
import { correrAvisos } from './avisos';
import { Budget } from './budget';
import { actualizarFotos } from './fotos';
import { procesarSalidaClickup, syncClickup } from './clickup';
import { syncFacturas } from './finnegans';
import { sincronizarOrdenesCompra } from './ordenescompra';
import { reatarPendientes } from './productos';
import { refrescarFce } from './facturar';
import { StageError } from './pipelines';
import { leerPendientes } from './remitos';
import { cerrarPendientes } from './rendimiento';
import { login } from './login';
import { resumirPendientes } from './darwin';
import { moverAR2 } from './archivos';

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
// «Conectar con Claude» (conectar.ts): OAuth para que cada uno conecte su Claude sin copiar tokens. Sin token (o vencido),
// /mcp contesta 401 diciendo dónde pedir permiso, y Claude hace el resto.
app.route('/', conectar);
app.all('/mcp', async (c) => {
  const conToken = /^Bearer\s+\S/.test(c.req.header('authorization') ?? '');
  if (!conToken) return sinPermiso(c.req.raw, 'Falta conectar Claude con el CRM.', false);
  let ctx: Ctx;
  try { ctx = await authenticate(c.env, c.req.raw); } catch (e) {
    if (e instanceof HttpError && e.status === 401) return sinPermiso(c.req.raw, e.message, true);
    throw e;
  }
  return handleMcp(c.req.raw, ctx, c.env);
});
app.all('/mcp/:token', async (c) => handleMcp(c.req.raw, await authenticate(c.env, c.req.raw, c.req.param('token')), c.env));

// Links viejos de HubSpot (app.hubspot.com/contacts/47666798/record/0-3/123) → misma ficha acá.
app.get('/contacts/:portal/record/:typeId/:id', (c) => {
  const path = { '0-1': 'contacts', '0-2': 'companies', '0-3': 'deals', '0-123': 'orders' }[c.req.param('typeId')] ?? 'contacts';
  return c.redirect(`/${path}/${c.req.param('id')}`, 301);
});

app.get('/health', (c) => c.json({ ok: true }));

// El ícono del Hub en /favicon.ico (y .png): lo buscan claude.ai (para el conector) y otros servicios que muestran el ícono
// del sitio. Sin esto devolvía la página del CRM.
const icono = async (c: { env: Env; req: { url: string } }) => {
  const r = await c.env.ASSETS.fetch(new Request(new URL('/hub-192.png', c.req.url)));
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
};
app.get('/favicon.ico', icono);
app.get('/favicon.png', icono);

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
        // Rendimiento de los choferes: a los :45 se cierra un día que haya quedado sin medir (el de ayer, a la noche).
        if (turno === 4) await safe(() => cerrarPendientes(env, b));
        // Darwin (darwin.ts): de 0 a 6 de la mañana de Buenos Aires, el resumen del día anterior de cada conversación con
        // movimiento, de a 15 por corrida (cada una es una consulta a Claude).
        const horaUtc = new Date(event.scheduledTime).getUTCHours();
        if (horaUtc >= 3 && horaUtc < 9) await safe(() => resumirPendientes(env, { budget: b, max: 15 }));
        // Una vez por día (a las 4:25 de Buenos Aires), las estadísticas de la base: sin ellas SQLite elegía mal algunos
        // índices (las tareas abiertas recorrían todas las tareas; auditoría del 19/11/2026). Si D1 no lo permite, no pasa nada.
        if (horaUtc === 7 && turno === 2) await safe(() => env.DB.prepare('PRAGMA optimize').run());
        await safe(() => syncAll(env, b));
        await safe(() => syncCalendars(env, b));   // reuniones de Google Calendar (calendar.ts)
      }
      else {
        // Facturas: siempre las que avisó el informe de cada hora; el barrido de todos los pedidos, solo de 3 a 4 de la mañana
        // (Finnegans cobra por cantidad de consultas).
        const hora = new Date(event.scheduledTime).getUTCHours();
        const barrido = hora === 6;
        if (turno === 3) {
          // A los :30, primero las órdenes de compra (ordenescompra.ts: una consulta al informe, más algún detalle de las OC del
          // día) y después las facturas, con el mismo tope de consultas. Las OC, una vez por hora en horario de trabajo (lunes a
          // viernes de 9 a 20, cuando se cargan) con los últimos 7 días, y de noche (3:30) los últimos 60.
          const dia = new Date(event.scheduledTime).getUTCDay();
          const b = Budget.of(env);
          // Antes, los productos de los pedidos que quedaron sin su artículo de ClickUp (solo la base de datos, productos.ts).
          await safe(() => reatarPendientes(env.DB));
          if (dia >= 1 && dia <= 5 && hora >= 12 && hora <= 23) await safe(() => sincronizarOrdenesCompra(env, { budget: b }));
          else if (barrido) await safe(() => sincronizarOrdenesCompra(env, { dias: 60, budget: b }));
          await safe(() => syncFacturas(env, { barrido, budget: b }));
        }
        else await safe(() => (turno === 0 ? syncFacturas(env, { barrido }) : syncClickup(env)));
        // Los archivos que siguen en la base pasan a R2 de a poco (archivos.ts): unos pocos en cada corrida.
        await safe(() => moverAR2(env));
        if (turno === 1) await safe(() => refrescarFce(env));   // la lista de empresas grandes de ARCA, una vez por día
      }
    })());
  },
} satisfies ExportedHandler<Env>;
