// Login del CRM en Cloudflare Access: deja pasar los mails de Formas, así quien entra lo decide la lista de
// Configuración → Usuarios del CRM (agregar a alguien ahí alcanza; desactivarlo lo deja afuera).
//
// Agrega (o actualiza) en la aplicación de Access del CRM una política propia, «Mails de Formas (CRM)», con los
// dominios de abajo. No toca las otras políticas: si la aplicación usa la lista «Equipo Formas» del tablero, sigue
// igual (cambiarla afectaría al tablero). Lo corre el workflow «Login de Cloudflare» con CLOUDFLARE_API_TOKEN.
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const HOST = process.env.CRM_HOST ?? 'formas-crm.rodrigo-mateus.workers.dev';
const DOMINIOS = (process.env.CRM_DOMINIOS ?? 'formas.ar,formaspublicitarias.com,soutex.com.ar').split(',').map((d) => d.trim()).filter(Boolean);
const NOMBRE = 'Mails de Formas (CRM)';
if (!TOKEN) { console.error('Falta CLOUDFLARE_API_TOKEN.'); process.exit(1); }

async function api(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`${method} ${path}: ${JSON.stringify(data.errors)}`);
  return data.result;
}

// Busca la aplicación en la cuenta de CLOUDFLARE_ACCOUNT_ID y, si no está, en las demás cuentas que vea el token.
const cuentas = await api('GET', '/accounts').catch(() => []);
const ids = [...new Set([process.env.CLOUDFLARE_ACCOUNT_ID, ...cuentas.map((c) => c.id)].filter(Boolean))];
let account, app;
for (const id of ids) {
  const nombre = cuentas.find((c) => c.id === id)?.name ?? id;
  try {
    const apps = await api('GET', `/accounts/${id}/access/apps?per_page=100`);
    console.log(`Cuenta «${nombre}»: ${apps.length} aplicaciones de Access${apps.length ? ` (${apps.map((a) => a.domain).join(', ')})` : ''}.`);
    app = apps.find((a) => a.domain === HOST) ?? apps.find((a) => (a.self_hosted_domains ?? []).includes(HOST));
    if (app) { account = id; break; }
  } catch (e) {
    console.log(`Cuenta «${nombre}»: no se pudo leer Access (${e.message}).`);
  }
}
if (!app) {
  console.error(`No encontré la aplicación de Access de ${HOST}. Si arriba dice 0 aplicaciones, al token le falta el permiso`
    + ' «Access: Apps and Policies → Edit» (Cloudflare → My Profile → API Tokens → editar el token del repo).');
  process.exit(1);
}
const ruta = `/accounts/${account}/access/apps/${app.id}/policies`;
const previas = await api('GET', ruta);
const politica = { name: NOMBRE, decision: 'allow', include: DOMINIOS.map((domain) => ({ email_domain: { domain } })) };
const actual = previas.find((p) => p.name === NOMBRE);
if (actual) {
  await api('PUT', `${ruta}/${actual.id}`, { ...politica, precedence: actual.precedence });
} else {
  await api('POST', ruta, { ...politica, precedence: Math.max(0, ...previas.map((p) => p.precedence ?? 0)) + 1 });
}
const final = await api('GET', ruta);
console.log(`Aplicación «${app.name}» (${HOST}).`);
for (const p of final) {
  const quienes = (p.include ?? []).map((i) => i.email_domain?.domain ? `@${i.email_domain.domain}` : i.email?.email ?? Object.keys(i)[0]).join(', ');
  console.log(`- ${p.name} [${p.decision}]: ${quienes}`);
}
console.log('Listo: entra cualquier mail de esos dominios que esté como usuario activo en el CRM.');
