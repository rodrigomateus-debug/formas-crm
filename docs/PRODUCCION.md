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
| Asignado | Asignados de la tarea (con la foto de su usuario del CRM, o la de ClickUp) | Sí, en el artículo y en el PDV, en todas las unidades (ver «Reasignar») |
| Cantidad | CANTIDAD | No |
| Pactada | La fecha de entrega del pedido de venta en Finnegans (la que puso el comercial) | No: se cambia en Finnegans |
| Real | ENTREGAS (FECHA REAL), la de producción | Sí, en el PDV y en cada artículo |
| OC | La orden de compra al proveedor en Finnegans, con link a la OC en Finnegans GO (ver «Órdenes de compra») | No |
| Proveedor | PROVEEDOR | Sí |
| Impresor | IMPRESOR | Sí |
| Ingreso prov. | INGRESO (PROVEEDOR): llega del proveedor | Sí |
| Retiro prov. | RETIROS (PROVEEDOR): se retira del proveedor | Sí |
| Egreso imp. | EGRESO (IMPRESOR): va al impresor | Sí |
| Retiro imp. | RETIRO (IMPRESOR): se retira del impresor | Sí |

**Reasignar** (pedido de Rodrigo del 17/11/2026). Cualquiera de Producción (o un administrador) reasigna cualquier PDV,
también los de otra persona y los de las unidades que se siguen trabajando en ClickUp (el resto de los campos de esas
unidades no). La lista ofrece a quienes tienen perfil **Producción** en el CRM y usuario en ClickUp (Ceci, Sole y quien
entre después: la gente del espacio de ClickUp se lee una vez por día, así aparece aunque todavía no tenga nada asignado),
más los que ya están asignados para poder sacarlos. Sumar a alguien sin perfil Producción rebota. Reasignar el **PDV**
(en la fila de la lista o en la tarjeta del tablero, que muestra a todos los que tienen algo del PDV) pasa también sus
artículos abiertos a las mismas personas (no los entregados, anulados ni servicios); después cada artículo se cambia
aparte. Se escribe en ClickUp en el momento; si ClickUp no acepta algún artículo, el PDV queda reasignado y se avisa
cuántos artículos quedaron como estaban (`reasignarArticulos` en `produccion.ts`).

**Costo del logo** (pedido de Rodrigo del 17/11/2026). Al lado del nombre de cada artículo (lista y tablero), «Logo $X/u»:
lo que se tomó para el logo en la cotización del STP, por unidad (costo del logo + setup prorrateado). Al pasar el mouse,
el detalle y el total por la cantidad. «Logo $0/u» (apagado) es que la cotización no tomó nada para el logo; sin la
pastilla, el producto no está en una cotización del STP (pedidos cargados directo en Finnegans) o todavía no se cruzó.

- Sale de dos exports del STP, cada hora con las fotos (`scripts/stp-costos-logo.mjs` en
  `.github/workflows/pedidos-totales.yml`): `cotizaciones_modo_costos` (LOGOS y SETUP que cargó la vendedora, desde
  septiembre de 2026) y, si el producto no está ahí con COSTO TOTAL, `pedidos_sku_formas` (COSTO EXTRA y SETUP
  PRORRATEADO). Es la misma regla del costo teórico del tablero de Formas (`formas-tablero`, `claude/comisiones.py`).
  Los pedidos cancelados no van. El setup ya viene prorrateado por unidad en el STP.
- Se cruza por el PDV de Finnegans del pedido y el SKU del artículo. Si el SKU se repite en el pedido (los genéricos
  `_GE_`, o el mismo producto con dos logos), el de la misma cantidad y, si no, el que más se parece por el nombre.
- Si el setup se cobró aparte como servicio («Setup Logo» en Finnegans) y no en la cotización, no está acá: se ve en los
  productos del pedido como servicio.

| Qué | Dónde |
|---|---|
| Tabla `stp_costos_logo` | `migrations/0071_costos_logo.sql` |
| Guardar y cruzar con los artículos | `src/worker/costoslogo.ts` (`POST /hooks/productos/costos-logo`, token de administrador) |
| Prueba de punta a punta | `test/produccion.test.mjs` |

**Entrega pactada y entrega real** (pedido de Rodrigo del 13/11/2026). La pactada es la del comercial: la fecha de
entrega del pedido de venta en Finnegans. Es del PDV entero y puede cambiar después de creado: cada vez que el CRM relee
el pedido de Finnegans (al menos una vez por día mientras está activo), si la fecha es otra la actualiza en «Fecha de
entrega» del pedido, y queda en su historial. La real es la de producción, por artículo. Cuando la real queda para
después de la pactada, al lado dice cuántos días se corrió («+5 d»); «Pasadas de lo pactado» filtra esos PDV. En el
Cronograma la tarjeta de la entrega avisa «Pactada para el …». El nombre del campo en Finnegans no está documentado: se
toma el que habla de la fecha de entrega (`fechaEntregaDeFinnegans` en `finnegans.ts`); si un pedido no lo trae, queda la
fecha que tenía el PDV al crearse y el registro del Worker anota qué campos de fecha llegaron.

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

## Órdenes de compra (OC)

Pedido de Rodrigo del 17/11/2026: en Producción y en Pedidos, una columna **OC** con el número de la orden de compra al
proveedor de cada producto («OC 4321»); un clic la abre en Finnegans GO.

- **De dónde salen** (lo investigó una sesión en el entorno de Finnegans el 17/11/2026, con datos reales): las OC
  (categoría «Orden de Compra», subtipo `OC`, id 71) no son documentos destino del pedido de venta; cada renglón lleva el
  pedido en la dimensión `PEDVTA`. Un renglón puede repartirse entre varios pedidos y una OC puede juntar pedidos
  distintos.
- **Cómo se leen:** la tarea de cada hora (`scripts/pedidos-productos.mjs` → `POST /hooks/ordenes-compra/sincronizar`)
  pide una vez el informe `reports/ANALISISORDENESCOMPRA` de los últimos 30 días (la primera vez, 120) con
  `Empresa=EMPRE01` y `dimension=PEDVTA`: un renglón por producto y por pedido, con el número interno de la OC
  (`DOCNROINT`, «OC - 11394»), la transacción, el proveedor, el código del producto y el pedido (`DIMENSIONVALOR`, por
  nombre: «PEDVTASTP - 31546»). Las filas sin código son IVA y conceptos; las OC anuladas no van. Las OC de ese rango se
  reemplazan cada vez; las más viejas quedan como estaban. Tabla `ordenes_compra` (migraciones `0072` y `0074`).
- **Las OC del día:** el informe a veces todavía no tiene el pedido de una OC recién creada («Sin dimensión valor»). Para
  las de hoy y ayer con renglones sin pedido se lee el detalle (`ordenCompra/<id>`, la dimensión `PEDVTA` de cada renglón),
  hasta 25 por corrida.
- **De qué producto:** cada OC queda en el pedido (cruzado por su número: «PEDVTASTP - 00031577» y «PEDVTASTP - 31577»
  son el mismo) con los códigos de sus renglones de ese pedido; el artículo se cruza por su SKU (el «Código:» de ClickUp o
  el del renglón atado). Una OC de un pedido que no se pudo atar a ningún artículo se ve en la fila del PDV.
- **El link:** el visor de documentos de Finnegans GO con `pk` = la transacción de la OC y `docId=71` (confirmado con una
  OC real).
- **Cuánto consulta:** una por corrida (unos 2 MB para 30 días), más una por cada OC del día que salió sin pedido. La
  tarea imprime solo cantidades (el repo es público): cuántas OC, cuántas atadas a pedidos del CRM, sin pedido y anuladas.
- Prueba en `test/produccion.test.mjs`.

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

## Servicios: los renglones que no se producen

Pedido de Rodrigo del 13/11/2026. Un pedido puede traer cobros que no son productos: el envío, el setup de logo, un
servicio de arte o un adicional cargado como «Artículos varios». Venían como un producto más: pedían logo y boceto,
contaban como artículo y dejaban el PDV en «Entregado parcial» por un adicional que nadie produce ni entrega.

- **Vienen marcados como servicio** por su código de Finnegans: los de rubro Servicios de Arte, Servicios de Logística u
  Otros servicios (`ProductoRubroCodigo` `SDA`, `SDL`, `OS`: Setup Logo, Tulogo en 24 hs, bordado, tampografía, DTF…) y
  los códigos de cobro que no tienen rubro: `1161` Artículos varios, `1113` Costo de Envío, `1170` Costo de Envío al
  Interior, `ML_SHIPPING`, `2008` Mercaderías servicios y `1218` Financiación. Son los que se usaron en los pedidos de
  Finnegans desde 2024. La lista está en `src/worker/servicios.ts` (`CODIGOS_SERVICIO`).
- **Un servicio** se ve en los productos del pedido con la marca «Servicio», sin estado de producción, logo ni boceto.
  Suma en el total y se factura igual. No aparece en Producción, no cuenta en «2/3 listos» ni en los bocetos de la
  tarjeta, y no pesa en el estado del pedido: con los productos entregados, el pedido queda Entregado aunque el
  adicional siga en «ingreso de pedido» en ClickUp. Un PDV al que solo le quedan servicios abiertos no se ve en
  Producción (sí con «Ver entregados»).
- **Solo un administrador cambia el tipo**, desde los productos del pedido («Pasar a producto» / «Pasar a servicio»).
  Vale para ese código en ese pedido (tabla `line_item_tipos`): «Artículos varios» casi siempre es un adicional, pero a
  veces es mercadería, y cambiarlo en un pedido no lo cambia en los demás.
- **El estado del pedido** se calcula al leer el PDV de ClickUp (`readPdv`), sin sus artículos de servicio (por el renglón
  del pedido atado al artículo o por el «Código:» del artículo). Si se sabe que un renglón es un servicio después (al
  leer los productos de Finnegans, o porque lo cambió un administrador), el CRM pide volver a leer ese PDV y la
  sincronización de cada 10 minutos lo actualiza.

| Qué | Dónde |
|---|---|
| Tipo de cada código (`products.tipo` y `rubro`) y excepciones por pedido (`line_item_tipos`) | `migrations/0056_servicios.sql` |
| Reglas, cambio de tipo y relectura del PDV | `src/worker/servicios.ts` |
| API: `PUT /api/records/order/:id/products/tipo` con `{ code, tipo }` (administrador) | `src/worker/api.ts` |
| Prueba de punta a punta | `test/servicios.test.mjs` |

## Lo que ven las vendedoras

- **Lista de Pedidos** (pedido de Rodrigo del 17/11/2026): cada pedido con sus productos abajo, como acá pero
  simplificado: foto, estado (la etapa del pedido: esperando boceto, en producción, listo para entregar, entregado),
  quién lo tiene y la fecha real que propuso Producción. Ver [PEDIDOS.md](PEDIDOS.md#los-productos-de-cada-pedido-en-la-lista).
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

### El proveedor que falta sale del SKU

Pedido de Rodrigo del 13/11/2026. Si un artículo no tiene PROVEEDOR en ClickUp y su SKU empieza con el prefijo de un
importador, el CRM le pone ese proveedor y lo escribe en ClickUp, así se ve igual en los dos lados:

| Prefijo | Proveedor |
|---|---|
| ZEC | Zecat |
| IMP | Promoproductos |
| CDO | Stocksur |
| ZOM | Irion |
| NFM | Nuevas Formas |
| XTR | X-Trade |
| MYA | Maya |

- **El SKU** es la línea «Código:» de la subtarea del artículo en ClickUp (columna `codigo`) o, si no la tiene, el
  código del renglón del pedido atado a ese artículo.
- **Cuándo:** en cada sincronización de ClickUp, de a 5 artículos por corrida (cada uno es una escritura en ClickUp y
  deja lugar para revisar PDV). Solo los artículos abiertos (no entregados ni anulados) de las unidades que se editan
  desde el CRM («Qué se edita acá»); los de las otras unidades se siguen completando en ClickUp.
- **No pisa nada:** solo se completa si está vacío, y una sola vez por artículo (`proveedor_auto` guarda la opción que
  puso el CRM). Si después lo cambian o lo vacían, el CRM no lo vuelve a poner.
- **La opción:** la del desplegable PROVEEDOR con ese nombre o, si no, la atada a esa empresa del CRM
  (`PROVEEDOR_POR_SKU` en `produccion.ts`, con los nombres con que puede aparecer). Si el desplegable no tiene opción
  para ese importador, no se hace nada: hay que agregar la opción en ClickUp.
- En la lista, al pasar por la celda del proveedor se ve «Por el SKU ZEC-…» mientras siga el que puso el CRM.
- Migración `0058_proveedor_por_sku.sql`; prueba en `test/produccion.test.mjs`.

### Notas de producto

Pedido de Rodrigo del 16/11/2026. Producción documenta lo que pasa con un producto de importador («la serigrafía se sale»,
«el bordado tapa el bolsillo», «la tinta se borra», «es de mala calidad») y la nota queda atada al **SKU**, no al pedido:
cada vez que ese producto se vuelve a vender, aparece sola.

- **Dónde se carga:** en Producción, «+ Nota» al lado del artículo (aparece al pasar el mouse); también en los productos
  del pedido y en la pantalla **Notas de productos** («Abrir un SKU»). Cada nota tiene un **tipo** (serigrafía, bordado,
  grabado láser, tampografía, sublimación, calidad del producto, durabilidad de la impresión, otro), una **gravedad**
  (Dato útil, Ojo, No recomendado), una foto opcional (en Drive: `Notas de productos/<SKU>`) y queda con el pedido y el
  artículo donde pasó.
- **Todos los colores:** si el SKU termina en una variante corta («IMP_P18.030**.03**», «ZEC-1234**-AZ**»), se puede
  marcar «Vale para todos los colores» y la nota se ve en todos los SKU de ese modelo (`modeloDe`). Si no se puede
  separar el color con seguridad, la nota es solo de ese SKU.
- **Los SKU genéricos** (`_GE_`, como `PS_GE_2000`) no llevan notas: el mismo código es vasos, naipes y paletas.
- **Dónde se ve:** en Producción y en los productos del pedido, un aviso al lado del producto («Ojo», «Evitar», «2 notas»,
  con el color de la más grave). Un clic abre la **ficha del SKU**: sus notas (las vigentes primero, las más graves
  arriba), cargar otra, y **dónde se vendió** (los pedidos con ese SKU que quien mira puede ver).
- **Aviso:** cuando se leen los productos de un pedido abierto (al entrar o al abrirlo) y un SKU tiene una nota vigente
  «Ojo» o «No recomendado» escrita en otro pedido, llega a la campanita de la vendedora del pedido y de Producción. Uno
  solo por persona, pedido y SKU; solo en el CRM, no por mail.
- **Quién:** escriben Producción y los administradores; ven todos (también Ventas). Cambiar o borrar una nota: quien la
  escribió o un administrador. Si el problema ya no pasa (el importador cambió el producto o el lote), cualquiera de
  Producción la marca **«Ya no aplica»**: deja de avisar y queda en el historial.
- Código: `src/worker/notasproducto.ts`, `web/src/notasProducto.tsx`, `web/src/pages/NotasProductos.tsx`. API:
  `GET /api/productos/notas`, `GET /api/productos/sku/:sku`, `POST /api/productos/sku/:sku/notas` (JSON o formulario con
  `foto`), `PATCH`/`DELETE /api/productos/notas/:id`, `GET /api/productos/notas/:id/foto`. Migración
  `0067_notas_producto.sql`; prueba en `test/notas-producto.test.mjs`.

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
