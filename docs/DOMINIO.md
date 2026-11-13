# Formas Hub en hub.formas.ar

Pedido de Rodrigo del 12/11/2026: el CRM pasa a llamarse **Formas Hub** (ya hace mucho más que un CRM: ventas,
producción, entregas, cronograma, remitos, conversaciones y Claude) y a estar en **`hub.formas.ar`**.

Los nombres técnicos no cambian (repositorio, Worker y base siguen como `formas-crm`), así no se rompe nada.

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
- La dirección vieja (`formas-crm.rodrigo-mateus.workers.dev`) sigue andando hasta que se decida apagarla.

## 3. Después (una vez)

- **Login con Google**: en Google Cloud, sumar `https://hub.formas.ar/auth/google/callback` a las direcciones autorizadas.
- **Cloudflare Access** (si sigue delante): agregar `hub.formas.ar` a la aplicación, con las mismas rutas sin Access
  (`/mcp*`, `/.well-known/*`, `/hooks/*`, `/crm/*`, `/oauth/*`, `/hubspot/*`, `/health`).
- **Claude**: el conector «Formas Hub» con `https://hub.formas.ar/mcp` (mejor antes de que el equipo se conecte).
- **Tableros y tareas automáticas** que usan `CRM_URL` (GitHub y los otros repositorios): apuntarlos a `https://hub.formas.ar`.
- **Choferes**: sus links viejos siguen andando; los nuevos que se copien salen con la dirección nueva.
- El equipo vuelve a iniciar sesión una vez (la sesión es de cada dirección).
