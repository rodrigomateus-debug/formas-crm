# Formas CRM

CRM propio de Formas Publicitarias para reemplazar HubSpot: contactos, empresas, negocios y pedidos, con su
actividad (notas, mails, llamadas, reuniones, WhatsApp y tareas), pipelines, tablero de negocios, integración con
Claude (MCP) y una API compatible con la de HubSpot para que los tableros sigan andando.

- Qué cubre y qué falta para reemplazar el 90 % de HubSpot: [docs/ALCANCE.md](docs/ALCANCE.md).
- Cómo pasar los tableros (formas-tablero, formas-shop-tablero) al CRM: [docs/CAMBIO-TABLEROS.md](docs/CAMBIO-TABLEROS.md).
- Por qué Cloudflare, cuánto aguanta (prueba con el volumen de 5 años) y cuándo revisarlo: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Cómo está hecho

Un solo Worker de Cloudflare, igual que el tablero de Formas Shop:

| Pieza | Qué es |
|---|---|
| `src/worker/` | API (Hono) sobre D1 (SQLite). Modelo genérico como HubSpot: `records` con propiedades en JSON, `associations`, `activities`, `changes` (historial). |
| `web/` | Interfaz en React. Se compila a `dist/` y el Worker la sirve. Usa el Design System de Formas (Poppins, navy, verde). |
| `/mcp` | Servidor MCP para Claude y Cowork (`src/worker/mcp.ts`). |
| `/hooks/*` | Entradas de Darwin, prospección por LinkedIn y formularios web (`src/worker/hooks.ts`). Sin Zapier. |
| `/crm/v3/*`, `/crm/v4/*`, `/oauth/*` | API compatible con HubSpot para los tableros (`src/worker/compat.ts`). |
| `/hooks/migrate` | Carga masiva desde HubSpot (`src/worker/migrate.ts` + `scripts/migrate-hubspot.mjs`), con token de administrador. Va por `/hooks` porque `/api` pide el login de Access. |
| Cron a los :05, :15… | Registro automático de mails de Gmail (`src/worker/gmail.ts`), en su propia corrida para no quitarle consultas a ClickUp y Finnegans (a los :00, :10…). |

Quién entra: Cloudflare Access con el mail de Formas (igual que el tablero). Las integraciones y Claude entran con
tokens propios (`fcrm_…`) que se crean en Configuración → Integraciones. Los ids de todo lo migrado son los de
HubSpot, así los links y los cruces con Finnegans/ClickUp/Darwin no cambian; lo nuevo arranca en 900000000001.

## Desarrollo local

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run dev
```

Abre en http://localhost:8787 como el usuario de `DEV_USER_EMAIL` (archivo `.dev.vars`, ver `.dev.vars.example`).
Para tener datos de prueba: `node scripts/demo-seed.mjs`. Pruebas de punta a punta (con `npm run dev` corriendo):

```bash
npm test
```

La prueba de Gmail necesita las variables de `node test/gmail-dev-vars.mjs` (y reiniciar `npm run dev`); sin eso se saltea.

## Publicar en Cloudflare (una sola vez)

1. Crear la base y copiar el `database_id` que devuelve en `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create formas-crm
   ```

2. Publicar (compila la interfaz, aplica las migraciones de la base y sube el Worker):

   ```bash
   npm run deploy
   ```

3. Cloudflare Access (Zero Trust → Access → Applications): una aplicación «Formas CRM» sobre el dominio del CRM con
   la misma política de mails que el tablero, y estas rutas **sin** Access (Bypass), porque entran con token propio:
   `/mcp*`, `/hooks/*`, `/crm/*`, `/oauth/*`, `/hubspot/*`, `/health`. El «Application Audience (AUD) Tag» va en
   `ACCESS_AUD` dentro de `wrangler.jsonc` (no es secreto), junto con `ACCESS_TEAM_DOMAIN` (el equipo de Access que usa
   Formas Studio). Si se recrea la aplicación de Access, cambia el AUD y hay que actualizarlo ahí.
4. Entrar con el mail de `ADMIN_EMAIL`: queda como administrador.

**Quién entra:** la política de Access deja pasar los mails de Formas (regla «Emails ending in»: `@formas.ar`,
`@formaspublicitarias.com`) y el CRM deja entrar solo a quien está en Configuración → Usuarios y activo. Para dar acceso
a alguien, se lo agrega ahí; para sacárselo, se lo desactiva. La migración trae a los propietarios de HubSpot con su equipo.

## Migrar desde HubSpot

Necesita el token de la app privada de HubSpot (el mismo `HUBSPOT_TOKEN` de los tableros sirve si tiene permiso de
lectura de mails y pedidos) y un token de administrador del CRM (Configuración → Integraciones → tipo «API»).

```bash
HUBSPOT_TOKEN=pat-… CRM_URL=https://<crm> CRM_TOKEN=fcrm_… node scripts/migrate-hubspot.mjs --limit=50
```

Con `--limit=50` es una prueba corta. Después, la corrida completa (sin `--limit`, tarda alrededor de una hora por los
~40.000 mails) y, mientras se usen los dos sistemas, una sincronización diaria de lo cambiado:

```bash
HUBSPOT_TOKEN=pat-… CRM_URL=https://<crm> CRM_TOKEN=fcrm_… node scripts/migrate-hubspot.mjs --since=2026-11-01
```

Es repetible: no duplica y no pisa lo que ya se editó en el CRM. Trae propietarios (con su equipo), pipelines,
propiedades (crea las custom que falten y suma opciones nuevas), contactos, empresas, negocios, pedidos, asociaciones
con empresa principal, historia de etapas, notas, mails, llamadas, reuniones, tareas y WhatsApp.

## Conectar lo que hoy escribe en HubSpot

| Quién | Hoy | En el CRM |
|---|---|---|
| Claude / Cowork (prospección diaria, cargas) | Conector de HubSpot | Conector personalizado en claude.ai con la URL `https://<crm>/mcp/<token>` (token tipo «Claude (MCP)»). |
| Darwin (WhatsApp) | Workflow de Darwin con 3 pasos de HubSpot (vía Pipedream) | Un solo paso `http-request` del workflow → `POST https://<crm>/hooks/darwin` con el evento entero. Y al ganar un negocio el CRM le avisa a Darwin. Paso a paso en [docs/DARWIN.md](docs/DARWIN.md). |
| Prospección por LinkedIn | Zapier → HubSpot (~300 leads por mes, con perfiles duplicados) | La herramienta de LinkedIn → `POST https://<crm>/hooks/linkedin` directo, con token tipo «LinkedIn». Deduplica por URL del perfil. Zapier se da de baja. |
| Cualquier otra | — | `POST https://<crm>/hooks/bundle` con `{ contact, company, deal, note, task, owner_email }`. |
| Formularios web | Formularios de HubSpot | `POST https://<crm>/hooks/form/<nombre>`; cada formulario se configura con la clave `form:<nombre>` en `settings`. |
| Mails | Conexión de bandeja de HubSpot | Gmail: ver abajo. |
| Tableros | API de HubSpot | Ver [docs/CAMBIO-TABLEROS.md](docs/CAMBIO-TABLEROS.md). |

## Gmail

El CRM lee los Gmail del equipo con una cuenta de servicio de Google Workspace con delegación de dominio (puede ser
la misma de `GOOGLE_SA_JSON` de formas-tablero). En la consola de administración de Google (Seguridad → Controles de
API → Delegación de todo el dominio) hay que darle a su Client ID el permiso
`https://www.googleapis.com/auth/gmail.readonly`. Después:

el JSON de la cuenta se carga como secreto `GOOGLE_SA_JSON` del repo en GitHub (la próxima publicación se lo pasa al
CRM), y en Configuración → Integraciones → «Mails (Gmail)» se prende. Cada 10 minutos guarda los mails con contactos
(recibidos de contactos existentes; enviados, creando el contacto si no existe), deduplicados entre bandejas.

Cada corrida lee hasta unos 40 mails en total (el tope de consultas del plan gratuito de Cloudflare), empezando por la
bandeja que hace más que no se lee; lo que falta sigue en la próxima. Con token de administrador: `GET /hooks/gmail`
(estado), `PUT /hooks/gmail` (configuración, por ejemplo `{"enabled": true, "users": ["alguien@formas.ar"]}`) y
`POST /hooks/gmail/sync` (leer ahora).
