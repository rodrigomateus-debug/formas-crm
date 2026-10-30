# Formas CRM

CRM propio de Formas Publicitarias para reemplazar HubSpot: contactos, empresas, negocios y pedidos, con su
actividad (notas, mails, llamadas, reuniones, WhatsApp y tareas), pipelines, tablero de negocios, integración con
Claude (MCP) y una API compatible con la de HubSpot para que los tableros sigan andando.

- Qué cubre y qué falta para reemplazar el 90 % de HubSpot: [docs/ALCANCE.md](docs/ALCANCE.md).
- Cómo pasar los tableros (formas-tablero, formas-shop-tablero) al CRM: [docs/CAMBIO-TABLEROS.md](docs/CAMBIO-TABLEROS.md).

## Cómo está hecho

Un solo Worker de Cloudflare, igual que el tablero de Formas Shop:

| Pieza | Qué es |
|---|---|
| `src/worker/` | API (Hono) sobre D1 (SQLite). Modelo genérico como HubSpot: `records` con propiedades en JSON, `associations`, `activities`, `changes` (historial). |
| `web/` | Interfaz en React. Se compila a `dist/` y el Worker la sirve. Usa el Design System de Formas (Poppins, navy, verde). |
| `/mcp` | Servidor MCP para Claude y Cowork (`src/worker/mcp.ts`). |
| `/hooks/*` | Entradas de Darwin, Zapier, formularios web (`src/worker/hooks.ts`). |
| `/crm/v3/*`, `/crm/v4/*`, `/oauth/*` | API compatible con HubSpot para los tableros (`src/worker/compat.ts`). |
| `/api/migrate` | Carga masiva desde HubSpot (`src/worker/migrate.ts` + `scripts/migrate-hubspot.mjs`). |
| Cron cada 10 min | Registro automático de mails de Gmail (`src/worker/gmail.ts`). |

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
   `/mcp*`, `/hooks/*`, `/crm/*`, `/oauth/*`, `/hubspot/*`, `/health`. Copiar el «Application Audience (AUD) Tag» y cargarlo:

   ```bash
   npx wrangler secret put ACCESS_AUD
   ```

   `ACCESS_TEAM_DOMAIN` ya está en `wrangler.jsonc` (el equipo de Access que usa Formas Studio).
4. Entrar con el mail de `ADMIN_EMAIL`: queda como administrador. Los demás entran como «Miembro» y se ajustan en
   Configuración → Usuarios (la migración ya los trae con su equipo).

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
| Darwin (WhatsApp) | Pipedream → HubSpot | Pipedream → `POST https://<crm>/hooks/darwin` con `Authorization: Bearer <token>` y `{ name, phone, email, producto, cantidad, conversation_id, utm_source, utm_campaign, owner_email, summary }`. |
| Zapier (formas.shop) | Zap → HubSpot | Zap → `POST https://<crm>/hooks/zapier` (o `/hooks/bundle` con `{ contact, company, deal, note, task }`). |
| Formularios web | Formularios de HubSpot | `POST https://<crm>/hooks/form/<nombre>`; cada formulario se configura con la clave `form:<nombre>` en `settings`. |
| Mails | Conexión de bandeja de HubSpot | Gmail: ver abajo. |
| Tableros | API de HubSpot | Ver [docs/CAMBIO-TABLEROS.md](docs/CAMBIO-TABLEROS.md). |

## Gmail

El CRM lee los Gmail del equipo con una cuenta de servicio de Google Workspace con delegación de dominio (puede ser
la misma de `GOOGLE_SA_JSON` de formas-tablero). En la consola de administración de Google (Seguridad → Controles de
API → Delegación de todo el dominio) hay que darle a su Client ID el permiso
`https://www.googleapis.com/auth/gmail.readonly`. Después:

```bash
npx wrangler secret put GOOGLE_SA_JSON
```

y en Configuración → Integraciones → «Mails (Gmail)» se prende. Cada 10 minutos guarda los mails con contactos
(recibidos de contactos existentes; enviados, creando el contacto si no existe), deduplicados entre bandejas.
