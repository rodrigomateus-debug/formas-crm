# Conectar con Claude

Pedido de Rodrigo del 12/11/2026: que cada uno conecte su Claude con el CRM como se conectan HubSpot o ClickUp, y que
desde Claude cada uno pueda editar solo lo suyo.

## Para el equipo

Abajo a la izquierda, arriba del nombre: **Conectar con Claude**. La ventana explica los tres pasos:

1. Abrir Claude → Configuración → Conectores.
2. Tocar **Conectar** en «Formas CRM» (o, si no está, «Agregar conector personalizado» con nombre `Formas CRM` y la
   dirección `https://<crm>/mcp`).
3. Claude lleva al CRM: tocar **Permitir**. Listo (claude.ai, Claude Desktop y Cowork).

En el botón se ve «Claude conectado» y, en la ventana, desde cuándo y cuándo se usó por última vez, con **Desconectar**.

## Qué puede hacer Claude

- **Ver**: lo mismo que ve la persona en el CRM (incluido el perfil Ventas, `alcance.ts`).
- **Cambiar** (`mcp.ts`, `soloLoSuyo`): los administradores, todo. Los demás, solo lo suyo: registros de los que son
  propietarios o sin propietario (para tomarlos), sus tareas y actividades; asignarse cosas solo a sí mismos. Combinar
  registros y el alta inteligente (`upsert_bundle`, que completa registros existentes sean de quien sean) quedan para los
  administradores. Todo queda en el historial a nombre de la persona, con origen «Claude».

## Una sola vez, el administrador

1. **En Claude** (plan de equipo): Configuración de la organización → Conectores → agregar «Formas CRM» con
   `https://<crm>/mcp`. Así a cada uno le aparece y solo toca «Conectar».
2. **En Cloudflare Access** (mientras siga delante del CRM): sumar `/.well-known/*` a las rutas **sin** Access (Bypass),
   junto con `/mcp*`, que ya está. Claude lee ahí cómo pedir permiso. `/conectar/*` **sigue con Access** (es la página
   de «Permitir», donde la persona tiene que estar con su sesión).

## Cómo está hecho (`src/worker/conectar.ts`)

OAuth 2.1 como lo piden los conectores remotos de Claude:

- `/mcp` sin token (o con uno vencido) contesta 401 con `WWW-Authenticate: Bearer resource_metadata=…`.
- `/.well-known/oauth-protected-resource` (RFC 9728) y `/.well-known/oauth-authorization-server` (RFC 8414).
- `/mcp/oauth/register` (RFC 7591): Claude se registra solo. Solo se aceptan direcciones de vuelta de Claude
  (`claude.ai`, `claude.com`) o de la propia computadora (Claude Desktop y Claude Code).
- `/conectar/autorizar`: la página «Permitir» (pide el login de siempre). Entrega un código de 10 minutos, de un solo
  uso, con PKCE S256.
- `/mcp/oauth/token`: el código por un token del CRM (`api_tokens`, tipo `mcp`, 30 días) y uno para renovarlo (180 días,
  se renuevan los dos cada vez). `/mcp/oauth/revoke` para revocar.
- Desconectar desde el CRM: `DELETE /api/claude/conexiones/:id` (solo las propias).
- Tablas: `oauth_clientes`, `oauth_codigos` y columnas nuevas en `api_tokens` (migración 0045).
- `wrangler.jsonc`: `/conectar/*` y `/.well-known/*` van primero al Worker (si no, se sirve la pantalla del CRM).
- Los links con token (`/mcp/fcrm_…`, Configuración → Integraciones) siguen andando para Cowork y scripts.
- Prueba: `test/claude.test.mjs`.
