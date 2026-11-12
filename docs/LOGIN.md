# Login del CRM: «Ingresar con Google»

Pedido de Rodrigo del 12/11/2026: una pantalla de ingreso propia, con el Design System de Formas, en lugar de la
genérica de Cloudflare Access. De un lado la imagen (productos promocionales con el logo de Formas, flotando sobre el
azul de Formas) y del otro el botón **Ingresar con Google**, que es la única forma de entrar.

## Quién entra

- Solo con una cuenta de Google con el mail verificado.
- El mail tiene que ser de un dominio de Formas (`LOGIN_DOMINIOS`; por defecto `formas.ar`, `formaspublicitarias.com` y
  `soutex.com.ar`).
- Y tiene que estar como usuario activo en **Configuración → Usuarios**, igual que con Access. Desactivar a alguien lo
  deja afuera en el próximo clic, aunque tenga la sesión abierta.
- La sesión dura 30 días. «Salir» está en el menú de abajo a la izquierda (donde se elige el tema).
- Los tokens (Claude, Darwin, chofer) siguen igual: no pasan por esta pantalla.

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Pantalla `/login`, ida a Google (`/auth/google`), vuelta (`/auth/google/callback`) y salir (`/auth/salir`) | `src/worker/login.ts` |
| La sesión: cookie `crm_sesion` con el mail y el vencimiento, firmada con `SESSION_SECRET` (HttpOnly, SameSite=Lax, Secure). Los cambios con la cookie solo valen desde el mismo CRM (cabecera `Origin`) | `src/worker/auth.ts` |
| Sin sesión, la API contesta 401 con `login: '/login'` y la pantalla va al login y después vuelve a donde estaba | `web/src/lib.tsx` (`http`) |
| La imagen (`hero.webp`, fija; pedido de Rodrigo del 12/11/2026): la escena del GIF que se hizo primero, rehecha en alta con `gpt-image-2.6-sunburst` de OpenAI (calidad max, 1712×2144) y el logo de Formas en cada producto | `web/public/login/` |
| Prueba de punta a punta con Google simulado | `test/login.test.mjs` |

El ida y vuelta a Google lleva un `state` y un `nonce` al azar, firmados en una cookie de 10 minutos. El `id_token` se
pide directo a Google con el secreto del cliente, y antes de abrir la sesión se controla: emisor, cliente, vencimiento,
nonce, mail verificado, dominio y usuario del CRM. Después del login solo se vuelve a una página del mismo CRM.

Mientras Cloudflare Access siga adelante del CRM, manda Access (su sesión se lee primero) y esta pantalla no aparece
sola. Se puede abrir igual en `/login` para probarla.

## Ponerlo en marcha (una sola vez)

1. **Cliente OAuth de Google.** En Google Cloud (el mismo proyecto de la cuenta de servicio sirve): APIs y servicios →
   Pantalla de consentimiento de OAuth → tipo **Interno** si los tres dominios están en el mismo Google Workspace; si
   no, **Externo** y publicada (el CRM igual controla el dominio y la lista de usuarios). Nombre «Formas CRM», logo de
   Formas. Después, Credenciales → Crear credenciales → ID de cliente de OAuth → **Aplicación web**, con este URI de
   redireccionamiento autorizado:
   `https://formas-crm.rodrigo-mateus.workers.dev/auth/google/callback`
   (si el CRM pasa a otro dominio, se agrega también el del dominio nuevo).
2. **Secretos del repo** (GitHub → Settings → Secrets and variables → Actions):
   - `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET`: los del paso 1.
   - `SESSION_SECRET`: una clave larga al azar (por ejemplo, la salida de `openssl rand -hex 32`). Cambiarla cierra todas
     las sesiones.
3. **Publicar**: correr «Probar y publicar» (o mergear cualquier cambio a main); carga los secretos en Cloudflare.
4. **Probar** con Access todavía adelante: abrir `/login`, tocar «Ingresar con Google» y ver que vuelve al CRM.
5. **Sacar Cloudflare Access del CRM**: Cloudflare → Zero Trust → Access → Applications → la aplicación de
   `formas-crm.rodrigo-mateus.workers.dev` → borrarla. Desde ese momento el que pide el login es el CRM. Si hay una
   aplicación aparte que deja pasar `/hooks` (app del chofer), puede quedar o borrarse: `/hooks` tiene su propio control.
   No borrar Access antes de los pasos 2 y 3: sin los secretos no entra nadie.

El tablero de Formas Shop no cambia: sigue con su Access.
