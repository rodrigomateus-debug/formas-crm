// Agrega a .dev.vars una cuenta de servicio de prueba y las URLs del Google simulado (Gmail, Drive y el perfil: test/gmail.test.mjs,
// test/avisos.test.mjs, test/bocetos.test.mjs, test/fotos.test.mjs). Lo corre también la prueba de GitHub.
// Solo para desarrollo local; después de correrlo, reiniciá `wrangler dev`.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'prueba@formas-crm.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const keep = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l && !/^(GOOGLE_SA_JSON|GOOGLE_TOKEN_URL|GMAIL_API_URL|DRIVE_API_URL|GOOGLE_USERINFO_URL)=/.test(l)) : [];
writeFileSync('.dev.vars', [...keep, `GOOGLE_SA_JSON='${JSON.stringify(sa)}'`, 'GOOGLE_TOKEN_URL=http://localhost:8799/token', 'GMAIL_API_URL=http://localhost:8799', 'DRIVE_API_URL=http://localhost:8799', 'GOOGLE_USERINFO_URL=http://localhost:8799/oauth2/v3/userinfo', ''].join('\n'));
console.log('.dev.vars listo para la prueba de Gmail.');
