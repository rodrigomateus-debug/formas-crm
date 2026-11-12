# Producción en el CRM

Pedido de Rodrigo del 12/11/2026. Producción (Ceci y Sole) trabaja en ClickUp con la vista «Estado PDV CECI» de la
lista PEC: cada PDV con sus artículos abiertos abajo. Cada artículo tiene su estado, quién lo tiene asignado,
proveedor, impresor y las fechas de ingreso y retiro. La pestaña **Producción** del CRM (`/produccion`) es esa vista, y
se edita desde ahí.

## Cómo se trabaja: de a poco, con ClickUp como fuente de verdad

- **Arranca con Formas Shop.** Ceci trabaja los PDV del Shop desde el CRM; si anda bien, se suma Corporate. Las
  unidades que se editan desde el CRM las elige un administrador («Qué se edita acá», arriba a la derecha de la
  pantalla; settings `produccion`, por defecto `["FORMAS SHOP"]`). Las otras se ven igual, pero se siguen editando en
  ClickUp (desde el CRM rebota con un aviso).
- **ClickUp sigue siendo la verdad.** Lo que se cambia en el CRM se escribe en ClickUp en el momento. Si ClickUp no lo
  acepta, en el CRM no cambia nada y sale el error. Lo que cambian en ClickUp llega con la sincronización de cada 10
  minutos. Así se puede trabajar en los dos lados a la vez, y si algo falla se vuelve a ClickUp sin perder nada.
- **Quién edita:** las usuarias con perfil **Producción** y los administradores. Las vendedoras ven la pantalla, sin
  editar.

## Qué se ve y qué se edita

| Columna | Campo de ClickUp | Se edita |
|---|---|---|
| Estado | Estado de la tarea (los de la lista PEC, con su color) | Sí (en el tablero, también arrastrando la tarjeta) |
| Asignado | Asignados de la tarea (con la foto de su usuario del CRM, o la de ClickUp) | Sí, en el artículo y en el PDV |
| Cantidad | CANTIDAD | No |
| Entrega | ENTREGAS (FECHA REAL) | Sí, en el PDV y en cada artículo |
| Proveedor | PROVEEDOR | Sí |
| Impresor | IMPRESOR | Sí |
| Ingreso prov. | INGRESO (PROVEEDOR): llega del proveedor | Sí |
| Retiro prov. | RETIROS (PROVEEDOR): se retira del proveedor | Sí |
| Egreso imp. | EGRESO (IMPRESOR): va al impresor | Sí |
| Retiro imp. | RETIRO (IMPRESOR): se retira del impresor | Sí |

«INGRESO (IMPRESOR)» no se usa (Ceci lo tiene oculto en su vista); la API acepta además «CANTIDAD CONTROLADA».

- Las fechas se ven como «mié 18/11» (el día de la semana sirve para ver qué es de esta semana). Se guardan al
  mediodía de Buenos Aires, así no cambian de día por el huso. En rojo, las que ya pasaron y todavía no están listas.
- **Cada artículo con la foto de su producto**, a la izquierda del nombre: la misma que en los productos del pedido
  (cotización del STP, ficha de Finnegans o SKU, `fotosDeRenglones`). Va por el renglón del pedido atado a ese artículo
  y, si no quedó atado, por las palabras del nombre (`fotosDeArticulos` en `productos.ts`). Sin foto, el ícono.
- **Un clic en un renglón o una tarjeta abre la vista previa del pedido**, la misma de Pedidos: datos, productos,
  comentarios y actividad de ese PDV (pedido de Rodrigo del 12/11/2026). Los clics en lo que se edita ahí mismo
  (estado, asignados, fechas, proveedor, impresor, links) no la abren. El PDV abierto queda marcado.
- **Estados como pastilla suave**, del color de ClickUp con su ícono, del ancho del texto y con mayúscula solo al
  principio, igual que la etapa del PDV. Las erratas de los nombres de ClickUp se corrigen solo a la vista
  («listo para entergar» se ve «Listo para entregar»; `nombreEstado` en `components.tsx`).
- **Lista o tablero.** La lista agrupa por PDV, como ClickUp, ordenada por fecha de entrega. El tablero (pedido de
  Rodrigo del 12/11/2026) tiene **una tarjeta por PDV**, en la columna de su etapa general (la misma de la lista y de
  Pedidos: Esperando boceto o confirmación, En producción, Listo para entregar…), con sus productos adentro como
  hijos: foto, nombre, cantidad, proveedor e impresor, y su estado y asignado, que se cambian ahí mismo. Muestra
  hasta 4 productos y el resto con «+ N productos más». Las tres etapas de producción se ven siempre; las demás,
  solo si tienen algún PDV. Como el PDV cambia de etapa solo según sus artículos, no se arrastra: se cambia el
  estado de cada producto.
- **Filtros:** unidad de negocio, asignado (yo, cada persona, sin asignar), **vendedor** y **cliente** (pedido de
  Rodrigo del 12/11/2026; las opciones son las de los PDV que se ven), búsqueda por PDV, cliente o producto, y «Ver
  entregados (30 días)». Todo se puede guardar como vista (pestañas).
- **Quién vende, con su foto**, en el renglón del PDV y en la tarjeta: el propietario del pedido en el CRM y, si el PDV
  no tiene pedido, el VENDEDOR de ClickUp.
- Sin «Ver entregados» se muestran los PDV con algún artículo abierto, y en ellos los artículos que no están
  entregados ni anulados.

## El estado del PDV sale de sus artículos

Es la misma regla que el estado del pedido (`generalStage` en `clickup.ts`, ver [PEDIDOS.md](PEDIDOS.md)):

| Si los artículos… | El PDV queda en |
|---|---|
| siguen en ingreso de pedido, pdv o personales | lo que puso la vendedora (las etapas antes de producción) |
| alguno en boceto pendiente o en espera de confirmación | Esperando boceto o confirmación |
| alguno en proveedor, depósito, impresor, revisión… | En producción |
| todos listos para entregar | Listo para entregar |
| algunos entregados / todos entregados | Entregado parcial / Entregado |
| todos anulados (o el PDV anulado) | Anulado |

Al lado, cuántos artículos están listos («2/3»; los anulados no cuentan). Cuando producción cambia el estado de un
artículo desde el CRM, el CRM relee el PDV y el pedido cambia de etapa en el momento, sin esperar la sincronización.
En el historial del pedido el cambio queda a nombre de quien lo hizo.

## Lo que ven las vendedoras

- **Cabecera de la ficha y de la vista previa del pedido** (pedido de Rodrigo del 12/11/2026): la etapa y
  «Producción:» con quién lo tiene (foto y nombre) y cuántos artículos están listos, lo mismo que la tarjeta del tablero
  de pedidos. Lo trae `GET /api/records/order/:id` (`produccion`, con `produccionDePedido`). La vista previa que se
  abre desde Producción es la misma de Pedidos, con la conversación del pedido.

- **Tarjeta del tablero de pedidos:** mientras se produce, quién lo tiene en producción (foto y nombre) y cuántos
  artículos están listos (`adjuntosSql` en `productos.ts`, con `PRODUCCION_TARJETA_SQL`).
- **Productos del pedido** (ficha y vista previa): en cada producto su estado (la misma pastilla que en Producción y en
  la conversación) y quién tiene ese artículo.

## Proveedores e impresores: empresas del CRM

Las opciones de los desplegables PROVEEDOR e IMPRESOR de ClickUp quedan atadas a empresas con tipo de relación
«Proveedor» y la propiedad nueva **«Proveedor de»** (Artículos, Impresión o las dos). Están en la tabla
`produccion_opciones` y se arman con `vincularOpciones` en cada sincronización, de a pocas por vez:

1. Las repetidas van a la misma empresa: mismo nombre sin forma societaria, signos ni espacios («FYR SA» y «FYRSA»,
   «STOCK SUR» de proveedor y «STOCKSUR» de impresor). Más un par de equivalencias que se ven claras (`MISMA`). Las
   dudosas («Dimilito» y «MAD/ DIMILITO», «ADRIA» y «ADRIANA») quedan separadas: si son la misma, se combinan las dos
   empresas en el CRM y sus opciones pasan a la que queda.
2. Si ya hay una empresa proveedora (o del equipo) con ese nombre, esa. Las de clientes no se tocan.
3. Si no, se crea la empresa.
4. «STOCK», «SIN LOGO» e «IMPRESOR A DEFINIR» no son empresas: quedan como opción suelta.

En la pantalla, cada empresa aparece una sola vez en el desplegable; al elegirla se escribe en ClickUp su primera
opción. Los importadores VIP (Zecat, Promoproductos, Nuevas Formas, Stocksur/CDO, X-Trade, Irion y Bello) se ven con su
logo y su color, como en el seguimiento de importados del tablero de Formas Shop, en el desplegable, en la celda y en
la tarjeta del tablero (pedido de Rodrigo del 12/11/2026). Se reconocen por el nombre, también con su razón social
(«IMPROM S.A.» es Promoproductos, «ENE FORMAS» es Nuevas Formas); la lista y los colores están en
`web/src/proveedores.tsx` y los isotipos, recortados de los de `formas-shop-tablero/assets/proveedores`, en
`web/public/proveedores/`. Si un importador aparece con otro nombre, se agrega en `alias`. La ficha de cada proveedor muestra **«En producción»**: los artículos abiertos que tiene, con sus fechas.

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Tablas `produccion` (una fila por PDV y por artículo), `produccion_opciones` y `clickup_personas`; propiedad `proveedor_de` | `migrations/0040_produccion.sql` |
| Lectura, vista, edición, proveedores | `src/worker/produccion.ts` |
| Se llena con la sincronización de ClickUp: la lista ya trae cada artículo con sus campos y asignados, así que no hay consultas de más. Al releer un PDV se sacan los artículos que ya no están. La primera vez hace una lectura completa de la lista (`clickup_state.produccion`). Los estados de la lista se releen una vez por día. | `src/worker/clickup.ts` (`syncClickup`) |
| API: `GET /api/produccion?unidades=…&cerrados=1`, `PATCH /api/produccion/:tarea` con `{ campo, valor }`, `GET`/`PUT /api/produccion/config`, `GET /api/records/company/:id/produccion` | `src/worker/api.ts` |
| Pantalla | `web/src/pages/Produccion.tsx` |
| Prueba de punta a punta con ClickUp simulado | `test/produccion.test.mjs` |

Los ids de los campos de ClickUp están en `CAMPOS` (`produccion.ts`). Si se recrea un campo en ClickUp, cambia su id y
hay que actualizarlo ahí. Para leer, también se reconoce por el nombre.

## Lo que sigue

- El calendario ya está: es la pestaña Cronograma ([CRONOGRAMA.md](CRONOGRAMA.md)).
- Si se suma Corporate: tildarlo en «Qué se edita acá».

## Vistas, filtros por columna y fechas

- **Pestañas de vistas** como en Pedidos (`web/src/vistas.tsx`): «Todos», «Míos» (lo asignado a mí en producción o mis
  pedidos) y las guardadas. Guardan búsqueda, unidades, asignado, vendedor, cliente, filtros por columna, entregados y
  lista o tablero.
- **Filtros por columna** (`web/src/pages/ProduccionFiltros.tsx`): el embudo de cada encabezado de la lista o «+ Filtro»
  (también en el tablero). Estado (varios), cantidad (desde/hasta), proveedor e impresor (varios, o «sin»; las opciones
  repetidas de ClickUp juntas) y cada fecha (ya pasó, hoy, esta semana, próximos 7 días, con o sin fecha, o entre dos
  fechas). Filtran **productos**: de cada PDV quedan los que cumplen y los PDV sin ninguno no se ven.
- **Fechas**: el calendario del CRM (`web/src/Fecha.tsx`) en lugar del campo del navegador; elegir un día lo guarda.
