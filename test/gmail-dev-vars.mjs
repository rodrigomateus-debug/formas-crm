// Agrega a .dev.vars una cuenta de servicio de prueba y las URLs del Google simulado (test/gmail.test.mjs).
// Solo para desarrollo local; después de correrlo, reiniciá `wrangler dev`.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'prueba@formas-crm.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const keep = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l && !/^(GOOGLE_SA_JSON|GOOGLE_TOKEN_URL|GMAIL_API_URL)=/.test(l)) : [];
writeFileSync('.dev.vars', [...keep, `GOOGLE_SA_JSON='${JSON.stringify(sa)}'`, 'GOOGLE_TOKEN_URL=http://localhost:8799/token', 'GMAIL_API_URL=http://localhost:8799', ''].join('\n'));
console.log('.dev.vars listo para la prueba de Gmail.');
