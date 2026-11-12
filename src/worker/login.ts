import { Hono } from 'hono';
import type { Ctx, Env } from './env';
import { HttpError } from './env';
import { COOKIE_SESION, DIAS_SESION, firmar, leerCookie, leerFirmado, nuevaSesion, userByEmail } from './auth';

// Login propio del CRM (pedido de Rodrigo del 12/11/2026): una pantalla con el Design System de Formas, la imagen
// animada a un lado y «Ingresar con Google» al otro, en lugar de la pantalla genérica de Cloudflare Access. Se entra
// solo con Google: el mail tiene que ser de un dominio de Formas (LOGIN_DOMINIOS) y estar como usuario activo en
// Configuración → Usuarios (userByEmail). La sesión es una cookie firmada (auth.ts). Puesta en marcha: docs/LOGIN.md.

type App = { Bindings: Env; Variables: { ctx: Ctx } };
export const login = new Hono<App>();

const DOMINIOS = (env: Env) => (env.LOGIN_DOMINIOS ?? 'formas.ar,formaspublicitarias.com,soutex.com.ar').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
const configurado = (env: Env) => !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.SESSION_SECRET);
const COOKIE_IDA = 'crm_login';   // el estado del ida y vuelta a Google (10 minutos)
// Solo se vuelve a una página del mismo CRM («/pedidos/123»), nunca a otro sitio.
const volverSeguro = (v: string | null | undefined) => (v && /^\/(?!\/)/.test(v) && !v.startsWith('/auth/') && !v.startsWith('/login') ? v : '/');
const seguro = (req: Request) => new URL(req.url).protocol === 'https:';
const cookie = (req: Request, nombre: string, valor: string, maxAge: number, path = '/') =>
  `${nombre}=${encodeURIComponent(valor)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${seguro(req) ? '; Secure' : ''}`;
const aleatorio = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');

const ERRORES: Record<string, string> = {
  dominio: 'Esa cuenta de Google no es de Formas. Ingresá con tu mail del trabajo.',
  usuario: 'Tu mail todavía no tiene usuario en el CRM. Pedile a un administrador que te agregue en Configuración → Usuarios.',
  desactivado: 'Tu usuario está desactivado en el CRM. Hablalo con un administrador.',
  cancelado: 'No se completó el ingreso con Google. Probá de nuevo.',
  vencido: 'Pasó demasiado tiempo desde que tocaste el botón. Probá de nuevo.',
  google: 'Google no respondió bien. Probá de nuevo en un rato.',
  config: 'El ingreso con Google todavía no está configurado en el CRM.',
};

login.get('/login', async (c) => {
  // Con la sesión todavía vigente, directo al CRM.
  if (c.env.SESSION_SECRET && await leerFirmado(c.env.SESSION_SECRET, leerCookie(c.req.raw, COOKIE_SESION))) return c.redirect(volverSeguro(c.req.query('volver')));
  const error = c.req.query('error');
  const aviso = !configurado(c.env) ? ERRORES.config : error ? ERRORES[error] ?? ERRORES.cancelado : c.req.query('salio') ? 'Saliste del CRM.' : '';
  return c.html(pagina({ volver: volverSeguro(c.req.query('volver')), aviso, esError: !!error || !configurado(c.env), habilitado: configurado(c.env) }), 200,
    { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
});

// Ida a Google: el estado (al azar), el nonce y adónde volver quedan firmados en una cookie de 10 minutos.
login.get('/auth/google', async (c) => {
  if (!configurado(c.env)) return c.redirect('/login?error=config');
  const state = aleatorio(), nonce = aleatorio();
  const ida = await firmar(c.env.SESSION_SECRET!, { state, nonce, volver: volverSeguro(c.req.query('volver')), exp: Date.now() + 600_000 });
  const url = new URL(c.env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_OAUTH_CLIENT_ID!, redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, nonce, prompt: 'select_account',
  }).toString();
  c.header('set-cookie', cookie(c.req.raw, COOKIE_IDA, ida, 600, '/auth/'));
  return c.redirect(url.toString());
});

// Vuelta de Google: se canjea el código por el id_token directo con Google (con el secreto del cliente, por HTTPS:
// por eso se puede leer sin verificar la firma, como dice OpenID Connect) y se controla todo antes de abrir la sesión.
login.get('/auth/google/callback', async (c) => {
  const borrarIda = cookie(c.req.raw, COOKIE_IDA, '', 0, '/auth/');
  const fallo = (e: string, volver = '/') => { c.header('set-cookie', borrarIda); return c.redirect(`/login?error=${e}${volver !== '/' ? `&volver=${encodeURIComponent(volver)}` : ''}`); };
  if (!configurado(c.env)) return fallo('config');
  const ida = await leerFirmado<{ state: string; nonce: string; volver: string; exp: number }>(c.env.SESSION_SECRET!, leerCookie(c.req.raw, COOKIE_IDA));
  if (!ida) return fallo('vencido');
  if (c.req.query('error') || !c.req.query('code')) return fallo('cancelado', ida.volver);
  if (c.req.query('state') !== ida.state) return fallo('vencido', ida.volver);
  let claims: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean; nonce?: string } | null = null;
  try {
    const res = await fetch(c.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: c.req.query('code')!, client_id: c.env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: c.env.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`, grant_type: 'authorization_code',
      }),
    });
    const tok = (await res.json()) as { id_token?: string };
    if (!res.ok || !tok.id_token) throw new Error(`HTTP ${res.status}`);
    const parte = tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parte + '='.repeat((4 - (parte.length % 4)) % 4)), (x) => x.charCodeAt(0))));
  } catch (e) {
    console.error('Login con Google:', (e as Error).message);
    return fallo('google', ida.volver);
  }
  const ok = claims && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '') && claims.aud === c.env.GOOGLE_OAUTH_CLIENT_ID
    && (claims.exp ?? 0) * 1000 > Date.now() && claims.nonce === ida.nonce && claims.email_verified === true && !!claims.email;
  if (!ok) return fallo('google', ida.volver);
  const email = claims!.email!.toLowerCase();
  if (!DOMINIOS(c.env).includes(email.split('@')[1] ?? '')) return fallo('dominio', ida.volver);
  try {
    await userByEmail(c.env, email);
  } catch (e) {
    return fallo(e instanceof HttpError && /desactivado/.test(e.message) ? 'desactivado' : 'usuario', ida.volver);
  }
  c.header('set-cookie', borrarIda);
  c.header('set-cookie', cookie(c.req.raw, COOKIE_SESION, await nuevaSesion(c.env, email), DIAS_SESION * 86400), { append: true });
  return c.redirect(volverSeguro(ida.volver));
});

login.get('/auth/salir', (c) => {
  c.header('set-cookie', cookie(c.req.raw, COOKIE_SESION, '', 0));
  return c.redirect('/login?salio=1');
});

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

// La G de Google, con sus colores (como pide Google para el botón).
const G = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function pagina({ volver, aviso, esError, habilitado }: { volver: string; aviso: string; esError: boolean; habilitado: boolean }) {
  const href = `/auth/google${volver !== '/' ? `?volver=${encodeURIComponent(volver)}` : ''}`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ingresar · Formas CRM</title>
<meta name="color-scheme" content="light dark" />
<meta name="robots" content="noindex" />
<link rel="icon" href="/formas-favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet" />
<script>
  // El mismo tema que eligió en el CRM (web/src/theme.ts); en «Automático», el del sistema.
  (function () { var t = 'auto'; try { t = localStorage.getItem('crm-tema') || 'auto'; } catch (e) {}
    var m = function (q) { return window.matchMedia && window.matchMedia(q).matches; };
    if (t === 'auto') t = m('(prefers-contrast: more)') ? 'contrast' : m('(prefers-color-scheme: dark)') ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t); })();
</script>
<style>
  /* Design System de Formas (los mismos tokens que web/src/styles.css). */
  :root, [data-theme="light"] { color-scheme: light; --navy: #000085; --navy-2: #00006a; --green: #8cc63f; --canvas: #f4f5f9; --surface: #fff;
    --ink: #12143a; --ink-2: #4b4f6b; --ink-3: #656b85; --line: #e3e6ee; --line-strong: #c7cbd8; --neg-soft: #fbe7e5; --neg-ink: #a1312c;
    --info-soft: #e4eefa; --info-ink: #24578f; --ring: 0 0 0 3px rgba(0, 0, 133, .18); --g-bg: #fff; --g-line: #747775; --g-ink: #1f1f1f; --logo: url(/login/formas-logo.png); }
  [data-theme="dark"] { color-scheme: dark; --canvas: #0b0c1e; --surface: #12142b; --ink: #eef0fa; --ink-2: #b9bdd6; --ink-3: #9297b5; --line: #262a4a;
    --line-strong: #383d63; --neg-soft: #3a1b20; --neg-ink: #ffb4ab; --info-soft: #172744; --info-ink: #a9c8f2; --ring: 0 0 0 3px rgba(140, 198, 63, .35);
    --g-bg: #131314; --g-line: #8e918f; --g-ink: #e3e3e3; --logo: url(/formas-logo-white.png); }
  [data-theme="contrast"] { color-scheme: light; --canvas: #fff; --surface: #fff; --ink: #0b0c24; --ink-2: #272a45; --ink-3: #3d4160; --line: #6e7290;
    --line-strong: #3d4160; --g-line: #0b0c24; --logo: url(/login/formas-logo.png); }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: var(--canvas); color: var(--ink);
    -webkit-font-smoothing: antialiased; }
  .login { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(400px, 1fr); min-height: 100vh; }
  /* El lado de la imagen: el GIF sobre el azul de Formas, con el logo y una frase. */
  .hero { position: relative; overflow: hidden; background: #04095e; color: #fff; }
  .hero img.anim { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 30%; }
  .hero::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(4, 9, 94, .6) 0%, rgba(4, 9, 94, 0) 22%, rgba(4, 9, 94, 0) 52%, rgba(3, 6, 70, .82) 74%, rgba(2, 4, 52, .96) 100%); }
  .hero-top, .hero-bottom { position: absolute; left: 48px; right: 48px; z-index: 1; }
  .hero-top { top: 40px; display: flex; align-items: center; gap: 12px; }
  .hero-top img { height: 40px; width: auto; display: block; }
  .hero-top span { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: rgba(255, 255, 255, .72);
    padding-left: 12px; border-left: 1px solid rgba(255, 255, 255, .28); }
  .hero-bottom { bottom: 44px; max-width: 460px; }
  .hero-bottom h2 { margin: 0 0 10px; font-size: clamp(26px, 2.6vw, 36px); line-height: 1.15; font-weight: 600; letter-spacing: -.01em; }
  .hero-bottom h2 b { color: var(--green); font-weight: 700; }
  .hero-bottom p { margin: 0; font-size: 15px; line-height: 1.55; color: rgba(255, 255, 255, .78); }
  /* El lado del login. */
  .panel { display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 48px 32px; background: var(--surface); }
  .card { width: 100%; max-width: 380px; }
  .logo { width: 168px; height: 68px; background: var(--logo) left center / contain no-repeat; margin-bottom: 40px; }
  h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; }
  .sub { margin: 0 0 32px; color: var(--ink-2); font-size: 15px; line-height: 1.5; }
  .aviso { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 10px; font-size: 13px; line-height: 1.45; margin-bottom: 20px;
    background: var(--info-soft); color: var(--info-ink); }
  .aviso.error { background: var(--neg-soft); color: var(--neg-ink); }
  .aviso svg { flex: none; margin-top: 1px; }
  /* El botón de Google, como lo pide su guía de marca (fondo claro u oscuro, la G en colores), con las medidas del DS. */
  .google { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; height: 48px; padding: 0 16px; border-radius: 10px;
    border: 1px solid var(--g-line); background: var(--g-bg); color: var(--g-ink); font: 500 15px/1 'Roboto', 'Poppins', Arial, sans-serif; text-decoration: none;
    cursor: pointer; transition: background .16s cubic-bezier(.4, 0, .2, 1), box-shadow .16s cubic-bezier(.4, 0, .2, 1), transform .12s; }
  .google:hover { background: color-mix(in srgb, var(--g-bg) 92%, var(--navy)); box-shadow: 0 1px 2px rgba(18, 20, 58, .12), 0 4px 12px -4px rgba(18, 20, 58, .18); }
  .google:active { transform: translateY(1px); }
  .google:focus-visible { outline: none; box-shadow: var(--ring); }
  .google[aria-disabled="true"] { opacity: .5; pointer-events: none; }
  .nota { margin: 20px 0 0; font-size: 12px; line-height: 1.5; color: var(--ink-3); text-align: center; }
  .pie { margin-top: 56px; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-3); }
  .pie i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); display: inline-block; }
  @media (max-width: 900px) {
    .login { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .hero { min-height: 260px; }
    .hero::after { background: linear-gradient(180deg, rgba(4, 9, 94, .7) 0%, rgba(4, 9, 94, 0) 40%); }
    .hero-top { top: 24px; left: 24px; right: 24px; }
    .hero-top img { height: 32px; }
    .hero-bottom { display: none; }
    .panel { justify-content: flex-start; padding: 32px 16px 40px; }
    .logo { display: none; }
    .pie { margin-top: 32px; }
  }
</style>
</head>
<body>
<main class="login">
  <section class="hero" aria-hidden="true">
    <picture><source srcset="/login/hero.png" media="(prefers-reduced-motion: reduce)" /><img class="anim" src="/login/hero.gif" alt="" /></picture>
    <div class="hero-top"><img src="/formas-logo-white.png" alt="" /><span>CRM</span></div>
    <div class="hero-bottom">
      <h2>Clientes, pedidos y producción, <b>en un solo lugar.</b></h2>
      <p>Todo lo que pasa con cada cliente de Formas, desde el primer contacto hasta la entrega.</p>
    </div>
  </section>
  <section class="panel">
    <div class="card">
      <div class="logo" role="img" aria-label="Formas · Your brand loved"></div>
      <h1>Ingresá al CRM</h1>
      <p class="sub">Con tu cuenta de Google de Formas.</p>
      ${aviso ? `<div class="aviso${esError ? ' error' : ''}" role="${esError ? 'alert' : 'status'}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><span>${esc(aviso)}</span></div>` : ''}
      <a class="google" href="${esc(href)}"${habilitado ? '' : ' aria-disabled="true" tabindex="-1"'}>${G}<span>Ingresar con Google</span></a>
      <p class="nota">Solo pueden entrar las cuentas de Formas que tienen usuario en el CRM.</p>
      <div class="pie"><i></i>Formas Publicitarias</div>
    </div>
  </section>
</main>
</body>
</html>`;
}
