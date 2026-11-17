# Referidos

Pedido de Rodrigo del 17/11/2026: cuando un cliente nos recomienda a alguien, que quede en el Hub (no en HubSpot) quién
recomendó a quién, con el negocio, la tarea para contactarlo y cómo terminó.

## Para el equipo

Un referido se carga desde dos lugares:

- **El Workspace de Formas Shop**, en «PARA HACER URGENTE»: al marcar la tarjeta como hecha con el referido, con
  «+ Referido» en el historial (si lo pasó después) o con «+ Cargar un referido» (de cualquier cliente).
- **La ficha del cliente en el Hub** (empresa o contacto), tarjeta **Referidos** → **«+ Nos recomendó a…»**: nombre,
  empresa, teléfono o mail y una nota.

Con eso el Hub crea:

1. El **contacto** del referido (si ya hay uno con ese mail o teléfono, usa ese) y su empresa, si la dijo.
2. Un **negocio en Lead** a nombre de la vendedora: «Carolina Sosa (Grupo Patagonia) - Referido de Distribuidora
   Andina SRL», con «Tipo de origen» y «Medio de origen» en Referido. Desde el Workspace va a Formas Shop (Inbound);
   desde la ficha, al pipeline del equipo de quien lo carga.
3. Una **nota** en las dos puntas: en el cliente que lo recomendó y en el referido.
4. Una **tarea** para la vendedora: contactarlo el próximo día hábil a las 10.
5. Cuando el negocio se **gana**, otra tarea: agradecerle al cliente que lo recomendó.

Dónde se ve:

- **Referidos** (menú, en CRM): todos, con quién los recomendó, la etapa del negocio, la ejecutiva y desde dónde se
  cargaron; arriba, cuántos hay, cuántos siguen en curso, cuántos se ganaron y cuánto se ganó con ellos. Se filtra por
  ejecutiva, estado o texto. El perfil Ventas ve los suyos.
- La **ficha del cliente**: a quién nos recomendó. La **ficha del referido** (contacto o negocio): quién lo recomendó.
- Los referidos de antes (cargados en HubSpot desde el tablero entre el 15/10 y el 17/11/2026, o a mano con origen
  Referido) salen también, como «Antes (HubSpot)», con quien los recomendó si se puede leer del negocio.

## Cómo está hecho (`src/worker/referidos.ts`)

- Tabla `referidos` (migración 0071): une al referido (contacto, empresa, negocio, tarea) con quien lo recomendó
  (empresa y contacto, si se encontraron, y el nombre tal como vino), los PDV, la vendedora, quién lo cargó y desde
  dónde. `clave` es única: el mismo referido no se crea dos veces.
- Quién lo recomendó, en este orden: los ids (desde la ficha); el pedido con ese N° de PDV (su empresa y su contacto);
  una empresa con ese nombre exacto; un contacto con ese mail o teléfono. Si no aparece, se guarda el nombre.
- **`POST /hooks/referidos`** (el Workspace), con token de integración «API / tableros»:
  `{ clave, owner_email, cargado_por, nota, referido: { nombre, empresa, contacto }, referidor: { nombre, pdvs } }`.
  `owner_email` encuentra a la vendedora con cualquier dominio de Formas. Con la misma `clave` devuelve lo que ya creó
  (`ya_estaba: true`). Sin teléfono ni mail, o sin nombre ni empresa, contesta 400. Queda en el registro de entradas.
- **`POST /api/referidos`** (la ficha): `{ referidor_id, nombre, empresa, contacto, nota }`. A nombre de la vendedora
  que lo carga; si lo carga un administrador, de quien tiene al cliente.
- **`GET /api/referidos?owner=`** (la pantalla) y **`GET /api/records/:type/:id/referidos`** (la tarjeta de la ficha).
- Al ganarse el negocio (`records.ts`, junto a los datos para facturar), `agradecerReferido` deja la tarea una sola vez.
- Prueba: `test/referidos.test.mjs`.

## Puesta en marcha

1. Publicar (la migración 0071 se aplica sola con `npm run deploy`).
2. Configuración → Integraciones → crear un token «API / tableros» y guardarlo como secret `CRM_TOKEN` en el repo
   `formas-shop-tablero` (la publicación del tablero lo pasa a Pages). Si el Hub cambia de dirección, cargar ahí la
   variable `CRM_URL`.
