# Formas Hub en hub.formas.ar

Pedido de Rodrigo del 12/11/2026: el CRM pasa a llamarse **Formas Hub** (ya hace mucho más que un CRM: ventas,
producción, entregas, cronograma, remitos, conversaciones y Claude) y a estar en **`hub.formas.ar`**.

Los nombres técnicos no cambian (repositorio y base siguen como `formas-crm`), así no se rompe nada.

## Mientras tanto: hub.formas.workers.dev (18/11/2026)

Hasta tener el dominio propio, el Hub está en **`https://hub.formas.workers.dev`** (gratis). Cloudflare arma esas
direcciones como `<nombre del Worker>.<subdominio de la cuenta>.workers.dev`, así que hubo que cambiar las dos partes:
el Worker pasó de `formas-crm` a `hub` (`wrangler.jsonc`) y el subdominio de la cuenta de `rodrigo-mateus` a `formas`.
La dirección vieja (`formas-crm.rodrigo-mateus.workers.dev`) deja de existir y no puede redirigir: con el cambio de
subdominio Cloudflare la apaga.

Pasos (una vez, en este orden):

1. Cloudflare → Workers & Pages → *Account details* → **Subdomain** → *Change* → `formas` (si está tomado, elegir otro y
   cambiar `APP_URL` en `wrangler.jsonc`). Cambia la dirección de **todos** los Workers de la cuenta.
2. Mergear a main: «Probar y publicar» crea el Worker `hub` con la misma base y los mismos secretos.
3. Google Cloud → el cliente OAuth del login → sumar `https://hub.formas.workers.dev/auth/google/callback`.
   **Sin esto nadie puede iniciar sesión.**
4. Probar que se entra y que corren las tareas programadas; recién ahí, Cloudflare → Workers & Pages → `formas-crm`
   → *Settings* → *Delete*. Mientras siga, sus tareas programadas (Gmail, ClickUp, Finnegans) corren dos veces.
5. Actualizar quien usa la dirección: la variable `CRM_URL` de GitHub (y de los otros repositorios), el conector «Formas
   Hub» de Claude (`https://hub.formas.workers.dev/mcp`), los webhooks que apuntan a `/hooks/…` (Darwin, Formas Shop,
   app del chofer) y los tableros que usan `/hubspot`. Si sigue la aplicación de Cloudflare Access, cambiarle el dominio.
6. El equipo vuelve a iniciar sesión una vez; los links viejos de los choferes hay que volver a mandarlos.

Cuando esté el dominio propio, se sigue con lo de abajo (y `APP_URL` pasa a ese dominio).

## Por qué hay que mover el DNS

El CRM corre en Cloudflare (Workers). Para servirlo en un subdominio propio, el DNS de ese dominio tiene que estar en
Cloudflare: un CNAME en GoDaddy apuntando a `*.workers.dev` no anda (Cloudflare no lo acepta ni da el certificado), y
delegar solo un subdominio es de los planes Enterprise. formas.ar hoy tiene el DNS en GoDaddy (`ns41/ns42.domaincontrol.com`)
y el mail en Google Workspace.

## 1. Pasar el DNS de formas.ar a Cloudflare (Rodrigo, una vez)

El dominio sigue registrado en GoDaddy; solo cambian los servidores de nombres.

1. Cloudflare (la misma cuenta del CRM) → *Add a domain* → `formas.ar` → plan **Free**. Cloudflare copia los registros.
2. Revisar que estén todos, comparando con la lista de DNS de GoDaddy, sobre todo:
   - los 5 MX de Google: `aspmx.l.google.com` (1), `alt1`/`alt2.aspmx.l.google.com` (5), `alt3`/`alt4.aspmx.l.google.com` (10);
   - TXT de SPF (`v=spf1 include:_spf.google.com …`), DKIM (`google._domainkey`), DMARC (`_dmarc`) y verificaciones;
   - la página (`@`, `www`): dejarlos como estaban (si hay dudas, en «DNS only», nube gris).
3. GoDaddy → formas.ar → DNS → *Nameservers* → *Change* → «I'll use my own nameservers» → los dos que da Cloudflare.
4. Esperar a que Cloudflare marque formas.ar como **Active** (de minutos a unas horas).

## 2. Conectar hub.formas.ar (en el código, cuando formas.ar esté activo)

Si se publica antes de que formas.ar esté activo en Cloudflare, la publicación falla: por eso va después.

- `wrangler.jsonc`: `"routes": [{ "pattern": "hub.formas.ar", "custom_domain": true }]` (Cloudflare crea el registro
  y el certificado solo) y `APP_URL` = `https://hub.formas.ar` (los links de los mails de avisos).
- La dirección `hub.formas.workers.dev` sigue andando hasta que se decida apagarla.

## 3. Después (una vez)

- **Login con Google**: en Google Cloud, sumar `https://hub.formas.ar/auth/google/callback` a las direcciones autorizadas.
- **Cloudflare Access** (si sigue delante): agregar `hub.formas.ar` a la aplicación, con las mismas rutas sin Access
  (`/mcp*`, `/.well-known/*`, `/hooks/*`, `/crm/*`, `/oauth/*`, `/hubspot/*`, `/health`).
- **Claude**: el conector «Formas Hub» con `https://hub.formas.ar/mcp` (mejor antes de que el equipo se conecte).
- **Tableros y tareas automáticas** que usan `CRM_URL` (GitHub y los otros repositorios): apuntarlos a `https://hub.formas.ar`.
- **Choferes**: sus links viejos siguen andando; los nuevos que se copien salen con la dirección nueva.
- El equipo vuelve a iniciar sesión una vez (la sesión es de cada dirección).
