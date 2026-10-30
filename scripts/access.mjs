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

let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  const cuentas = await api('GET', '/accounts');
  if (cuentas.length !== 1) throw new Error('El token ve varias cuentas: cargar CLOUDFLARE_ACCOUNT_ID.');
  account = cuentas[0].id;
}

const apps = await api('GET', `/accounts/${account}/access/apps?per_page=100`);
const app = apps.find((a) => a.domain === HOST) ?? apps.find((a) => (a.self_hosted_domains ?? []).includes(HOST));
if (!app) {
  console.error(`No hay una aplicación de Access para ${HOST}. Aplicaciones: ${apps.map((a) => a.domain).join(', ')}`);
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
