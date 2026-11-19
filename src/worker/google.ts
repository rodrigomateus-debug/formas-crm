import type { Env } from './env';

// Acceso a Google con la cuenta de servicio de `GOOGLE_SA_JSON` (delegación de todo el dominio): entra como `subject`
// con el permiso que se pida (leer Gmail, mandar mails).

export function b64url(data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// El acceso de Google dura una hora. Con `guardar` (las corridas de Gmail y Calendar, cada 10 minutos) se guarda en memoria
// 50 minutos por persona y permiso: antes cada corrida pedía uno nuevo por buzón para Gmail y otro para Calendar, y eso se
// comía un tercio del tope de consultas de la corrida (auditoría del 19/11/2026). `budget`: se descuenta solo si de verdad
// hay que pedirlo.
const accesos = new Map<string, { token: string; hasta: number }>();
export async function serviceToken(env: Env, subject: string, scope = 'https://www.googleapis.com/auth/gmail.readonly',
  opts: { guardar?: boolean; budget?: { take(): void } } = {}): Promise<string> {
  const clave = `${env.GOOGLE_TOKEN_URL ?? ''}|${subject}|${scope}`;
  const guardado = opts.guardar ? accesos.get(clave) : undefined;
  if (guardado && guardado.hasta > Date.now()) return guardado.token;
  opts.budget?.take();
  const token = await pedirAcceso(env, subject, scope);
  if (opts.guardar) accesos.set(clave, { token, hasta: Date.now() + 50 * 60_000 });
  return token;
}

async function pedirAcceso(env: Env, subject: string, scope: string): Promise<string> {
  const sa = JSON.parse(env.GOOGLE_SA_JSON!) as { client_email: string; private_key: string; token_uri?: string };
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const tokenUri = env.GOOGLE_TOKEN_URL ?? sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, sub: subject, scope, aud: tokenUri, iat, exp: iat + 3600,
  }))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${b64url(sig)}`,
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!data.access_token) throw new Error(`Google no dio acceso a ${subject}: ${data.error_description ?? data.error ?? res.status}`);
  return data.access_token;
}
