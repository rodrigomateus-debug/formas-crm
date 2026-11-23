# Productos con talle

Pedido de Rodrigo del 20/11/2026. En el rubro, una prenda con talles es **un solo producto**: la «Campera Stone negra»
lleva un logo, un boceto y un precio por logo, aunque Finnegans y ClickUp la tengan en un renglón (y una subtarea) por
talle. En el Hub se ve así: un renglón con el producto (el nombre sin el talle, la cantidad de todos los talles, el desglose
«XS 3 · S 4 · M 8 · L 12 · XL 3») y, en su rama, cada talle.

**Solo talles, y solo de prendas.** Se juntan únicamente los renglones que son el mismo producto, del mismo color y el
mismo material, y cambian solo en el talle. Otro color o material es otro producto (la campera negra y la azul son dos).
Fuera de la ropa no hay talles: el «Moleskine Large» y el «XL», la «Botella Landscape S» y la «L» o el «Bolso Medium» y el
«Large» son productos distintos, no talles.

## Dónde se ve

| Pantalla | Qué cambia |
|---|---|
| Producción, lista | Un renglón por producto: foto, nombre sin el talle, los talles con su cantidad (cada uno con el borde del color de su estado), el aviso del logo, el costo del logo y las notas, la cantidad total. Cada columna muestra el valor de los talles si es el mismo, o «Varios». La flecha abre la rama con cada talle. |
| Producción, tablero | Un hijo por producto en la tarjeta del PDV, con los talles y la cantidad. «+ N productos más» cuenta productos. |
| Productos del pedido (ficha y vista previa) | Un producto con un solo «+ Boceto» y un solo logo, la cantidad y el precio de todos los talles, los talles y el subtotal. «Ver talles» muestra cada renglón (talle, cantidad, precio, estado, código). |
| «Cargar en un producto» (un boceto o un logo mandado por la conversación) | La lista para elegir trae cada producto una vez, con el nombre sin el talle; lo cargado va al producto entero, como el «+ Boceto» de la tarjeta (`productosParaElegir`, `web/src/talles.ts`). |
| Lista y tablero de Pedidos | Un renglón por producto con el desglose de talles; su estado es el de todos o, si están en etapas distintas, el del producto entero (la misma regla que el pedido). |
| Cuentas | «2/3 listos», «N productos», los bocetos de la tarjeta («3/5») y «N artículos» de Producción cuentan el producto una vez. Está listo cuando lo están todos sus talles; tiene boceto si alguno de sus talles lo tiene. |
| Claude (`get_record`) | Cada renglón de una prenda con talles trae `talle` y `producto` (el nombre sin el talle), igual para todos sus talles. |
| Cronograma | La tarjeta (semana, día expandido y Colgados) muestra el producto una vez, con la suma y los talles como pastillas («XS 3 · S 4 …»); lo hecho de cada talle se tacha y un clic en un talle anota su demasía. Si los talles van a impresores distintos, cada tarjeta lleva los suyos. «Listos para entregar, sin fecha», igual. |
| Ruta del día y app del chofer | Cada parada lista el producto una vez: «Egreso 85 Remera Regent Hombre - Blanco (S 11 · M 18 · L 35 …)». En la app del chofer, los talles van abajo del producto. |
| Remito de traslado (egreso) | Un renglón por producto: «69 · Pantalón Cargo Unisex - Beige (34 2 · 36 3 · 38 5 …)». |
| Celular (Ventas, Producción y Logística) | Ventas: los artículos del pedido, uno por producto con la cantidad de todos y los talles completos («Varios estados» si están en etapas distintas). Producción: el producto en un artículo; al tocarlo, la hoja cambia todos los talles a la vez y abajo lista cada talle para cambiarlo solo. Logística: tarjetas, paradas, «sin fecha» (un «Poner día» para todos los talles) y «Retiran», con el producto una vez. |
| Entrega (remitos) | Cada talle sigue contándose aparte (cada uno es su renglón en el remito), pero se ve el producto con lo entregado de todos y abajo cada talle. «Falta entregar» lo resume por producto: «12 Campera Stone - Negro (M 8 · L 4)». |
| Direcciones (entregar en varios lugares) | Se reparte talle por talle (cuántos de cada talle van a cada lugar), con el producto como encabezado y cada talle abajo; «N productos» y «Quedan N sin repartir» cuentan el producto una vez. |
| Conversación del pedido | Los cambios de estado de los talles de una prenda hechos juntos (mismo cambio, misma persona, en el mismo par de minutos) van en uno: «pasó «Campera Stone - Negro» (5 talles: XS, S, M, L, XL) de … a …». |
| Ficha del proveedor o impresor («En producción»), Inicio («Producciones en curso») y el detalle de producción del pedido («3 en el impresor») | Cuentan y muestran el producto una vez. |
| Notas de producto | Valen para todos los talles (ver abajo). |

## Editar en Producción

- **Desde el renglón del producto**, el cambio va a **todos sus talles**: estado, asignados, proveedor, impresor y las
  fechas. Cada talle es su subtarea en ClickUp y se escriben a la vez (`PATCH /api/produccion/grupo` con
  `{ tareas, campo, valor }`; solo artículos del mismo PDV). Si ClickUp no acepta alguno, los otros quedan cambiados y se
  avisa cuántos no; la pantalla muestra cómo quedó.
- **Desde la rama**, cada talle aparte, como cualquier artículo.

## El costo del logo

El del producto entero, por unidad. El STP prorratea el setup en cada talle por separado (PDV 31725: «Logo $79.999/u» en
3 XS y «$29.999/u» en 8 M, los dos $239.998 en total): si todos los talles traen el mismo setup total, es **uno solo** y se
reparte entre todas las unidades ($239.998 / 30 = $8.000/u). Al pasar el mouse lo dice. Si los setups son distintos, se
suman. (`costoLogoDeGrupo` en `talles.ts`.)

## Notas de producto: de todos los talles

Una nota escrita en un talle (o desde el renglón del producto) vale para **todos los talles** de esa prenda, del mismo
color y material: guarda la **raíz** de su SKU (el SKU sin el talle: `ZEC_99030777273D··D62D54`) y se ve en cualquier SKU con
la misma raíz, también en las ventas que vengan después en otros talles. El aviso a la vendedora y a Producción sale uno
por producto (no uno por talle). La ficha del SKU dice «todos los talles» y «Dónde se vendió» suma todos los talles; la
pantalla «Notas de productos» tiene una fila por producto. Las notas escritas antes se completan solas en el cron.
(`raizTalle` en `talles.ts`, `raizDeSku` en `tallesdb.ts`, `APLICA` en `notasproducto.ts`; columna `producto_notas.raiz`.)

## Boceto y logo

Uno por producto. Se guardan con el código de su primer talle (así el boceto aprobado va a ClickUp como siempre, a la
subtarea de ese talle; alcanza, ClickUp se va a dejar de usar) y valen para todos: el logo elegido para el producto lo ven
todos los talles en Producción («Sin logo», curvas) y los bocetos de cualquier talle se ven en el producto.

## Cómo se reconoce el talle

Relevado el 20/11/2026 en el catálogo de formas.shop (los 1.610 productos; 160 SKU de prendas por talle) y en pedidos
reales.

**1. Que sea una prenda** (`esPrenda`): el nombre dice qué es (remera, chomba, buzo, campera, camperón, chaleco, camisa,
camiseta, musculosa, polera, pantalón, bermuda, short, jogger, calza, legging, sweater, cardigan, hoodie, rompevientos,
windbreaker, softshell, parka, chaqueta, casaca, blazer, vestido, pollera, falda, overol, mameluco, ambo, guardapolvo,
delantal, filipina, uniforme, pijama, guantes, t-shirt…) o el SKU es de una línea textil (Soutex `ST_`, Maya `MYA_TEX`).
No van «polo» (hay gorros «Polo»), «polar» (mantas), «canguro» (la riñonera), «campero» (el mate) ni «gorro».

**2. El talle, en el nombre** (`talleDeNombre`):

| Cómo viene | Ejemplo |
|---|---|
| En palabras, como nombra Zecat | «Campera Stone **X Small** - Negro - Algodon 100%», «XX Large», «3 X Large» |
| Con «Talle» | «Chomba Piqué **Talle L**», «Pantalón **Talle 44**» |
| En letras | «Remera Soul Negro **XS**», «2XL», «XXL» (no «M/C» ni «M/L», ni «1 L» o «500 M», que son medidas) |
| Un número antes de « - » | «Pantalón Cargo Unisex **34** - Beige»: puede ser el modelo («Gorro 36»), así que solo vale si el SKU lo confirma |

**3. El talle, en el SKU**, según el proveedor (`talleDeSku`, `raicesSku`):

| Proveedor | SKU | Talle |
|---|---|---|
| Zecat | `ZEC_99030777273`·**`D00`**·`D62D54` | Un tramo `D##`: D00 XS, D01 S, D02 M, D03 L, D04 XL, D05 2XL, D06 3XL, D07 4XL; D34…D60 los numéricos. No siempre es el primero (Buzo Hoodie Snake: `D55`·`D00`·`D54`) y los colores usan los mismos códigos (`D01` es S y también amarillo), así que se usa con el talle del nombre. |
| Zecat (Cardon) | `ZEC_99030540300759799`·**`002`** | Los 3 últimos dígitos: 002 XS, 003 S, 004 M, 005 L, 006 XL, 007 2XL, 008 3XL, 010 4XL. |
| Soutex | `ZZ_ST_RM_JSMC_M_NE_`·**`XS`** | El último tramo, tal cual (también 38…60). |
| Maya (Suco) | `MYA_TEX3051617`·**`54`** | Los 2 últimos dígitos: 54 S, 55 M, 56 L, 57 XL, 58 2XL. |
| Otro | `ABC-1234-`**`M`** o `ABC-1234-`**`02`** | Un tramo del SKU que es el talle, o un código numérico que sube con el talle (como Cardon y Maya). Un tramo con letras que cambia (un color) no es un talle. |

**4. Se juntan** (`agruparTalles`) los renglones del mismo pedido (o artículos del mismo PDV) con:

- el **nombre sin el talle idéntico** (color y material incluidos), y
- el **SKU sin el tramo del talle idéntico** (el modelo, el color y el material, iguales). Sin SKU (o con uno genérico,
  `_GE_`), solo entre ellos, por el nombre.
- Talles distintos. Si un talle se repite (el mismo producto con dos logos), en tandas seguidas, cada una con sus talles.

**5. El orden**, el del shop: 3XS 2XS XS S M L XL 2XL 3XL 4XL 5XL 6XL, y después los numéricos de menor a mayor.

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Las reglas (sin nada del Worker, se prueban solas) | `src/worker/talles.ts` |
| Talle y grupo guardados en cada artículo de Producción y cada renglón del pedido; el recálculo | `src/worker/tallesdb.ts`, migración `0105_talles.sql` (`talle`, `grupo_talle`, `talles_v`) |
| Cuándo se calcula | Al guardar lo que trae ClickUp (`guardarTareas`, `podarArticulos`), al leer los renglones de Finnegans (`orderProducts`), al atar un renglón a su artículo (`reatarRenglones`) y, lo que falta, en el cron (`completarTalles`, cada corrida de ClickUp y Finnegans, de a 150 PDV y 150 pedidos). Producción calcula antes de mostrar los PDV que todavía no lo tienen. |
| Vista y edición de Producción | `src/worker/produccion.ts` (`grupos`, `contarProductos`, `editarProduccionGrupo`), `web/src/pages/Produccion.tsx` |
| Productos del pedido | `src/worker/productos.ts` (`grupos`, renglones en orden de talle), `web/src/pages/RecordPage.tsx` (`ProductoConTalles`) |
| Lista de Pedidos | `src/worker/pedidosprod.ts` (`juntarTalles`), `web/src/pages/PedidosProductos.tsx` |
| Logo del producto en todos sus talles | `src/worker/logos.ts` (`logosDeArticulos`) |
| Cuentas en SQL | `PRODUCTO_SQL` (`produccion.ts`), `RENGLON_SQL` (`productos.ts`) |
| Cronograma, ruta, remito de traslado y app del chofer | `src/worker/cronograma.ts` (`talle`, `grupo`, `producto` en cada movimiento; `juntarTalles` para el texto), `src/worker/recorridos.ts` (`remitoEgreso`), `web/src/talles.ts` (`juntarTalles`, `lineasMovs` en las pantallas) |
| Entrega, Direcciones, Conversación, ficha del proveedor | `src/worker/remitos.ts`, `src/worker/direcciones.ts`, `src/worker/conversacion.ts`, `produccionDeEmpresa` en `produccion.ts` |
| Celular | `web/src/movil/ProduccionMovil.tsx`, `web/src/movil/LogisticaMovil.tsx` |
| Pruebas | `test/talles.test.mjs` (las reglas, con SKU y nombres reales; no necesita el Hub corriendo) y `test/produccion.test.mjs` (de punta a punta: Producción, productos del pedido, Pedidos, notas por raíz, Cronograma y Conversación) |

**Si cambia una regla** (un proveedor nuevo, una prenda que falta): se cambia en `talles.ts`, se suma el caso a
`test/talles.test.mjs` y se sube `TALLES_VERSION`. El cron recalcula todo lo guardado con la regla nueva, de a tandas.

## Lo que sigue

- Si aparece un proveedor con otro formato de SKU, en general no hace falta nada (ver «Otro» arriba); si no se junta, se
  suma su formato en `talleDeSku` con su caso en `test/talles.test.mjs` y se sube `TALLES_VERSION`.
