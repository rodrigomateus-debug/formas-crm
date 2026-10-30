// Datos ficticios para probar la interfaz en local (npm run dev + node scripts/demo-seed.mjs).
// No usar contra producción: crea usuarios, empresas, contactos, negocios y actividades inventados.
const BASE = process.env.CRM_URL ?? 'http://localhost:8787';
if (!/localhost|127\.0\.0\.1/.test(BASE) && !process.env.FORCE) {
  console.error('Este script es solo para la base local. Usá FORCE=1 si de verdad querés otra URL.');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}

const day = 86_400_000;
const ago = (d, h = 10) => { const t = new Date(Date.now() - d * day); t.setHours(h, 0, 0, 0); return t.toISOString(); };
const pick = (xs, i) => xs[i % xs.length];

const team = [
  ['Elizabeth Reynoso', 'elizabeth.reynoso@formaspublicitarias.com', 57132078],
  ['Jorgelina Carrasco', 'jorgelina.carrasco@formas.ar', 57132078],
  ['Lucía Senini', 'lucia.senini@formas.ar', 57132078],
  ['Carmen Donoso', 'carmen.donoso@formaspublicitarias.com', 58079782],
  ['Sonia Andersen', 'sonia@formaspublicitarias.com', 58079782],
];

const companies = [
  ['Lácteos del Sur SA', 'lacteosdelsur.com.ar', 'FOOD_PRODUCTION', 'Rafaela', 'a_cotizacion_mensual'],
  ['Andes Energía SRL', 'andesenergia.com.ar', 'OIL_ENERGY', 'Neuquén', 'b_cotizacion_trimestral'],
  ['Banco Pampa', 'bancopampa.com.ar', 'BANKING', 'CABA', 'a_cotizacion_mensual'],
  ['Logística Norte', 'logisticanorte.com', 'LOGISTICS_AND_SUPPLY_CHAIN', 'Tucumán', 'c_cotizacion_semestral'],
  ['Farmacia Central SA', 'farmaciacentral.com.ar', 'PHARMACEUTICALS', 'Córdoba', 'b_cotizacion_trimestral'],
  ['Estudio Ribera & Asoc.', 'estudioribera.com.ar', 'LAW_PRACTICE', 'Rosario', null],
  ['Agro Llanura', 'agrollanura.com.ar', 'FARMING', 'Pergamino', 'b_cotizacion_trimestral'],
  ['TecnoRed Argentina', 'tecnored.com.ar', 'INFORMATION_TECHNOLOGY_AND_SERVICES', 'CABA', 'a_cotizacion_mensual'],
];
const people = [
  ['María', 'Gómez', 'Compras'], ['Julián', 'Pereyra', 'Marketing'], ['Sofía', 'Martínez', 'RR.HH.'], ['Tomás', 'Herrera', 'Gerente comercial'],
  ['Valentina', 'Ruiz', 'Marketing'], ['Lucas', 'Fernández', 'Compras'], ['Camila', 'López', 'Eventos'], ['Martín', 'Sosa', 'Dirección'],
  ['Paula', 'Acosta', 'RR.HH.'], ['Diego', 'Romero', 'Compras'], ['Florencia', 'Díaz', 'Marketing'], ['Nicolás', 'Molina', 'Administración'],
];
const productos = ['Botellas térmicas', 'Remeras bordadas', 'Kits de bienvenida', 'Cuadernos A5', 'Mochilas', 'Gorras trucker', 'Tazas', 'Regalos de fin de año'];

const users = [];
for (const [name, email, team_id] of team) {
  try { users.push(await api('POST', '/users', { name, email, role: 'member', team_id })); }
  catch { users.push((await api('GET', '/users')).find((u) => u.email === email)); }
}
const me = await api('GET', '/me');
const owners = [me, ...users];

const meta = await api('GET', '/meta');
const pipes = Object.fromEntries(meta.pipelines.map((p) => [p.id, p]));

let ci = 0;
for (const [name, domain, industry, city, tipo] of companies) {
  const owner = pick(owners, ci);
  const company = await api('POST', '/records/company', { props: { name, domain, industry, city, tipo_de_empresa_cotizacion: tipo, owner_id: owner.id, lifecyclestage: ci % 3 ? 'customer' : 'opportunity', objetivo_economico_anual: 3_000_000 + ci * 1_500_000 } });
  const contacts = [];
  for (let k = 0; k < 2; k++) {
    const [fn, ln, job] = pick(people, ci * 2 + k);
    contacts.push(await api('POST', '/records/contact', { props: { firstname: fn, lastname: ln, jobtitle: job, email: `${fn.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.${ln.toLowerCase()}@${domain}`, mobilephone: `+54 9 11 ${4000 + ci * 37 + k}-${1000 + ci * 91}`, owner_id: owner.id, lifecyclestage: 'customer', origen_del_contacto: pick(['Contacto por email', 'Contacto por Whatsapp', 'Ejecutiva de cuentas'], ci + k) } }));
  }
  const pipeline = ci < 4 ? '674405796' : 'default';
  const stages = pipes[pipeline].stages;
  for (let k = 0; k < 3; k++) {
    const st = stages[(ci + k * 2) % stages.length];
    const prod = pick(productos, ci + k);
    const qty = 50 * (1 + ((ci + k) % 6));
    const deal = await api('POST', '/records/deal', {
      props: {
        dealname: `${name.split(' ')[0]} - ${prod} - ${qty}`, pipeline, dealstage: stages[0].id, amount: qty * (4500 + 900 * k), owner_id: owner.id,
        closedate: new Date(Date.now() + (k * 12 - 6) * day).toISOString().slice(0, 10), producto: prod, cantidad: String(qty),
        tipo_de_producto: pick(['Productos importados', 'Producción simple', 'Mix de categorías'], k), origen_del_negocio: pick(['Contacto por email', 'Contacto por Whatsapp', 'Ejecutiva de cuentas'], ci),
      },
      associations: [company.id, contacts[k % 2].id],
    });
    if (st.id !== stages[0].id) {
      await api('PATCH', `/records/deal/${deal.id}`, { props: { dealstage: st.id, ...(st.is_closed && !st.is_won ? { motivo_de_cierre_perdido: 'Precio' } : {}) } });
    }
    await api('POST', '/activities', { type: 'email', direction: 'out', subject: `Cotización ${prod}`, body: `Hola ${contacts[k % 2].props.firstname}, te paso la cotización de ${qty} ${prod.toLowerCase()} con logo. Quedo atenta.`, occurred_at: ago(12 - k * 3, 11), links: [deal.id, contacts[k % 2].id], meta: { from: owner.email, to: contacts[k % 2].props.email } });
    if (k === 0) await api('POST', '/activities', { type: 'email', direction: 'in', subject: `RE: Cotización ${prod}`, body: '¡Gracias! ¿Podrían enviarnos una muestra antes de confirmar? Necesitamos la entrega antes de fin de mes.', occurred_at: ago(6, 15), links: [deal.id, contacts[0].id], meta: { from: contacts[0].props.email, to: owner.email } });
  }
  await api('POST', '/activities', { type: 'call', direction: 'out', outcome: 'Conectada', body: 'Revisamos el calendario de eventos del año. Piden propuesta para fin de año.', occurred_at: ago(3, 16), links: [contacts[0].id] });
  await api('POST', '/activities', { type: 'note', body: `Cliente ${tipo ? 'recurrente' : 'nuevo'}. Prefieren entregas en dos tandas y factura A.`, occurred_at: ago(20), links: [company.id] });
  await api('POST', '/activities', { type: 'whatsapp', direction: 'in', body: 'Hola! Les escribo por los kits para el evento de noviembre.', occurred_at: ago(1, 9), links: [contacts[1].id] });
  await api('POST', '/activities', { type: 'task', subject: pick(['Llamar para seguimiento', 'Enviar muestra', 'Confirmar boceto', 'Pedir orden de compra'], ci), due_at: new Date(Date.now() + (ci % 3 - 1) * day + 3600_000).toISOString(), owner_id: owner.id, priority: pick(['high', 'medium', 'none'], ci), links: [contacts[0].id] });
  if (ci % 2 === 0) await api('POST', '/activities', { type: 'meeting', subject: 'Presentación de catálogo', body: 'Mostrar novedades de textil y tecnología.', occurred_at: new Date(Date.now() + (ci + 1) * day).toISOString(), links: [company.id, contacts[0].id], meta: { location: 'Google Meet' } });
  ci++;
}
// Un par de leads de Darwin (WhatsApp) sin empresa.
const tok = await api('POST', '/tokens', { name: 'Demo Darwin', source: 'darwin' });
for (const [name, phone, prod, qty] of [['Juana Ibarra', '5493415551234', 'Kit Verano', 40], ['Rodolfo Paz', '5491165554321', 'Botellas térmicas', 120]]) {
  await fetch(`${BASE}/hooks/darwin`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ name, phone, producto: prod, cantidad: qty, conversation_id: `15552-${phone}`, utm_source: 'META_ADS', owner_email: team[0][1], summary: `Pide precio por ${qty} unidades de ${prod.toLowerCase()} con logo.` }) });
}
console.log('Listo: datos de demostración cargados.');
