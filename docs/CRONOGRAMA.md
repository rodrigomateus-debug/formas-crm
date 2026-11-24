# Cronograma

Pedido de Rodrigo del 12/11/2026. Reemplaza la planilla «Cronograma Semanal» de Logística: una pestaña por semana con
las entregas, ingresos, retiros y egresos de cada día, que se pasaban a mano desde ClickUp (y se desfasaban: la
planilla tenía su propia hoja de avisos con las fechas distintas). La pestaña **Cronograma** del CRM (`/cronograma`,
abajo de Entregas) arma lo mismo sola y se edita ahí.

## De dónde sale cada cosa

Nada se carga: los movimientos salen de las fechas de cada artículo en ClickUp, que ya están en la tabla `produccion`
(ver [PRODUCCION.md](PRODUCCION.md)).

| En el cronograma | Campo de ClickUp | Lugar |
|---|---|---|
| Entregas | ENTREGAS (FECHA REAL), del artículo o, si no tiene, la del PDV | El cliente |
| Ingresos | INGRESO (PROVEEDOR) e INGRESO (IMPRESOR) | Lo trae el proveedor o el impresor al depósito (no es un viaje). El del impresor pasa poco: es en vez de ir a retirarlo, y si un artículo tiene los dos, el cronograma avisa |
| Retiros | RETIROS (PROVEEDOR) y RETIRO (IMPRESOR) | El proveedor o el impresor |
| Egresos | EGRESO (IMPRESOR) | El impresor |
| Listos para entregar, sin fecha | Estado «listo para entregar» sin fecha de entrega | — |

Lo único propio del CRM: las notas sueltas de un día, los feriados, lo que se marcó como hecho, los recorridos y lo que
marca el chofer (migración `0045_cronograma.sql`). Además, los **encargos** que carga cualquiera en
[Recorridos](RECORRIDOS.md) (llevar o retirar muestras, sobres, mercadería): van en su propio carril de la semana y en la
parada del mismo lugar en la ruta del día.

## Semana

- **Barra de semanas**, arriba: trece semanas agrupadas por mes (el mes, corto, a la izquierda de sus semanas). Se
  arrastra para los costados, las flechas la corren un mes y un clic elige la semana. Cada semana muestra cuánto tiene
  cada día y cuánto falta; en rojo, lo que ya pasó y no se hizo. La actual tiene el fondo verde y un puntito; «Esta
  semana» vuelve a ella. Para que la cabecera ocupe poco (pedido de Rodrigo del 20/11/2026), la barra es de un solo
  renglón de tarjetas y la leyenda de colores va en la fila del título (en el celular no va: los colores están en el
  filtro «Tipo de movimiento»).
- **Cada día** con sus cuatro carriles. Una tarjeta junta los artículos de un PDV con el mismo movimiento, el mismo día
  y en el mismo lugar. Un clic abre la vista previa del pedido. En la computadora la semana ocupa el alto de la ventana:
  cada día (y Colgados) se desplaza adentro con su encabezado fijo, y la barra para los costados queda al pie. Abajo a la
  izquierda, como en Pedidos y Producción, cuántos movimientos, hechos y encargos hay (con lo que se ve filtrado).
- **El día expandido** (botón «Día», o el nombre del día en la semana; pedido de Rodrigo del 20/11/2026): un solo día con
  lugar. Arriba, los días de esa semana como pestañas, con cuánto falta en cada uno; abajo, cada tipo de movimiento en su
  franja (entregas, ingresos, retiros, egresos y encargos) con las tarjetas en grilla, y las notas del día. Las tarjetas
  son las mismas de la semana (marcar, chofer, mover, colgar, anotaciones…) y los filtros de arriba también valen. Para
  pasar una tarjeta a otro día de la semana se suelta en su pestaña. Link: `/cronograma?vista=dia&dia=AAAA-MM-DD`.
  En el día, cada producto con **su foto** (la misma del pedido y de Producción, por el SKU: `fotosDeArticulos`) y todos
  a la vista (en la semana siguen los tres primeros), y arriba el total de bultos del día.
- **Mover**: arrastrar la tarjeta a otro día (o el ícono de calendario, para el celular) escribe la fecha en ClickUp en
  el momento. Si ClickUp no lo acepta, no cambia nada. En las entregas la fecha queda en cada artículo que se movió; la
  del PDV se mueve solo si se movieron todos sus artículos abiertos (pasar uno a otro día no arrastra a los demás). Lo que
  estaba marcado hecho y se pasa a otro día vuelve a pendiente.
- **Chofer** (pedido de Rodrigo del 13/11/2026): abajo de cada tarjeta de entrega, retiro o egreso, el desplegable con
  los choferes y los expresos (el mismo de la Ruta del día, con «+ Agregar chofer o expreso…»). Elegir uno pasa la parada
  al recorrido de ese chofer ese día; si no tiene, se arma uno nuevo que sale del mismo lugar y a la misma hora que el
  primero. Pasa **la parada entera**: en un impresor van todos sus retiros y egresos del día (el aviso lo dice), y un pedido
  que va a varias direcciones pasa con todas. «Sin chofer» la pasa a un recorrido sin chofer; uno sin chofer que queda
  vacío se saca. Se ve en la Ruta del día y en la app del chofer. Los ingresos no llevan chofer (no son un viaje) y lo que
  retira el cliente en Formas dice «Retira en …». En las tarjetas hechas y para quien solo mira, el chofer aparece sin
  desplegable. Un día sin recorridos guardados está todo «Sin chofer».
- **Dirección en la tarjeta** (pedido de Rodrigo del 18/11/2026): en cada tarjeta que es parada de la ruta (entregas,
  retiros, egresos y encargos), la dirección en una línea, la misma que usa la Ruta del día. Con el **tilde verde** si está
  ubicada en el mapa; en **naranja** si falta, no se encontró o todavía no se ubicó. Un clic la corrige ahí mismo (en el
  pedido o en la ficha de la empresa, igual que «Corregir dirección» de la ruta): se escribe y **se elige de las
  sugerencias de Google Maps**, como en Uber (queda validada, con el punto exacto en el mapa), o de la libreta.
  Abajo, **piso, depto, puerta o unidad** y **observaciones de entrega** («tocar timbre de recepción»), que se ven en una
  segunda línea de la tarjeta, en la parada de la Ruta del día y en la app del chofer. En el pedido van en su dirección
  (`entrega_direcciones.detalle` y `observaciones`, migración `0091_direccion_observaciones.sql`); en un proveedor o
  impresor, en la ficha (`direccion_detalle` y `observaciones_entrega`). Cambiar solo la dirección no las borra. La de un
  expreso o la de un encargo sin parada de ClickUp se cambia desde su lugar. Un pedido que va a varias direcciones muestra
  la primera y «+N». Llega aparte de la semana para no demorarla (`GET /api/cronograma/direcciones?desde&hasta`,
  `direccionesSemana`); para quien edita, el servidor busca en el mapa unas pocas que faltan y la pantalla vuelve a pedir
  mientras tanto (la ruedita).
- **Hecho**: el círculo. Queda quién y cuándo, y **el artículo cambia de estado en ClickUp**:

  | Se marca | El artículo pasa a |
  |---|---|
  | Ingreso, o retiro del proveedor | en control de depósito |
  | Egreso | en el impresor |
  | Retiro del impresor | en revision |
  | Entrega | entregados |

  El estado solo avanza: si el artículo ya está más adelante en la lista de ClickUp (por ejemplo «en el impresor» cuando
  se marca un ingreso viejo), no se toca. Desmarcar lo vuelve al
  estado que tenía. Los estados se pueden cambiar con `PUT /api/cronograma/config` (`estados`). Un artículo entregado
  cuenta como hecho aunque nadie lo haya marcado (las semanas viejas no aparecen todas pendientes).
- **Avisos** en la tarjeta: cae en feriado o fin de semana, se retira y se entrega el mismo día, la entrega es anterior
  al último retiro, el retiro del impresor es anterior al egreso. «Evento» si el pedido es para un evento; «Atrasado» si
  ya pasó y no se hizo.
- **Encargos** (pedido de Rodrigo del 13/11/2026): lo que alguien pidió en [Recorridos](RECORRIDOS.md), en un carril verde
  de cada día. Se arrastran a otro día, se les elige el chofer (pasa toda la parada de ese lugar) y se marcan hechos como
  las demás tarjetas; un clic abre el encargo. A quien lo pidió le llega un aviso si se lo cambian.
- **Remito de traslado de un egreso** (pedido de Rodrigo del 16/11/2026): en la tarjeta de un egreso, el ícono de la
  impresora (y «Remito» en su parada de la Ruta del día, que después muestra su número) arma el remito con todo lo que va a ese impresor ese
  día, de todos sus PDV, como el de los encargos de [Recorridos](RECORRIDOS.md): una hoja A4 por remito, con el número que
  sigue el de la planilla. Se numera la primera vez y, si cambian los egresos, se vuelve a armar con el mismo número
  (`POST /api/cronograma/remito-traslado` con `{ fecha, clave }`, tabla `remitos_traslado`).
- **La foto del remito** es obligatoria en todas las paradas: la Ruta del día dice cuáles ya la tienen y cuáles no (ver
  [REMITOS.md](REMITOS.md#remitos-internos-y-foto-obligatoria-en-todas-las-paradas-pedido-de-rodrigo-del-16112026)).
- **Colgados** (pedido de Rodrigo del 19/11/2026): una columna al final de la semana, punteada y rayada en ámbar, que
  es **la misma en todas las semanas**. Ahí va lo que no se pudo hacer y queda pendiente (el cliente no abonó el total,
  fueron y nadie recibió, falta un documento). Se arrastra la tarjeta a la columna (o el ícono de aviso de la tarjeta, para
  el celular) y se elige o se escribe **el motivo**, que es obligatorio. El movimiento sale de su día y de la ruta de ese
  día, y queda en Colgados con el motivo, el día que tenía y quién lo dejó; la fecha de ClickUp no se toca. **Al
  responsable del pedido** (su propietario) le llega el aviso en la campanita y por mail, con qué era y por qué. Para
  resolverlo se arrastra a un día (o el calendario de la tarjeta), que escribe la fecha en ClickUp, o se marca hecho. Lo
  que se entrega, se anula o se queda sin fecha en ClickUp sale solo. Los encargos no se cuelgan (se pasan de día o se
  cancelan). Tabla `cronograma_colgados` (migración `0095`), `colgados` y `colgarMovimiento` en `cronograma.ts`,
  `POST /api/cronograma/colgar` con `{ ids, tipo, motivo }`.
- **Horario desde la tarjeta, también como rango** (pedido de Producción, Rodrigo del 19/11/2026): el reloj de cada
  tarjeta que es parada abre «Horario»: **Entre las… y las…**, A las, Antes de las o Desde las. Es la misma hora fijada de
  la Ruta del día (`cronograma_horas`, con `hasta` para el rango; migración `0097`): vale para toda la parada de ese día,
  el recorrido se ordena solo para cumplirla y el chofer la ve en su app.
- **Anotaciones de logística, con quién las escribió** (`logistica.ts`, `web/src/NotasLogistica.tsx`, tabla
  `logistica_notas`): el ícono de la nota en la tarjeta. Dos alcances: **Solo esta vez** (de este pedido y este movimiento:
  esta entrega, este retiro, este egreso) y **Siempre**, que queda en **el destino** y aparece cada vez que se va a ese
  lugar, sea por una entrega, un retiro, un egreso o un encargo de Recorridos. El destino se reconoce por la empresa del
  Hub, por el lugar de la libreta de Recorridos o por el nombre (en las entregas, el cliente del PDV, que está aunque el
  pedido no tenga la empresa asociada; se compara sin mayúsculas, acentos ni «S.A.»). Se ven en la tarjeta (en ámbar las
  de esta vez, en azul las de siempre, con el nombre y el día), en la parada de la Ruta del día, en la app del chofer y en
  la ficha del pedido. Las escriben Logística y Producción desde la tarjeta y **la vendedora desde su pedido** (ficha o
  vista previa, panel Entrega → «Anotaciones de logística»: Ventas no ve el cronograma), que elige si es solo para esta
  entrega o para todas las entregas a ese cliente. Ahí también ve **el horario fijado** para su entrega en el cronograma.
  **Desde la tarjeta de un encargo** de Recorridos también se anota (el ícono de la nota): ahí no hay pedido, así que es
  siempre del destino (lo de esa vez va en las notas del encargo); es la forma de dejar algo para un lugar al que solo se
  va por encargos.
  La borra quien la escribió, Logística, Producción o un administrador. **Reemplazan las observaciones de entrega** de la
  dirección del pedido y de la ficha de la empresa: las que ya estaban cargadas pasaron a ser anotaciones (migración
  `0097`; las del pedido, de esa entrega; las de una empresa, de siempre) y el campo ya no está en «Corregir dirección»,
  donde queda el piso, depto, puerta o unidad.
- **Un pedido que se reparte entre varios lugares** (Rodrigo, 19/11/2026: 1.000 kits, 250 a la central, 500 a una
  sucursal y 250 a un depósito). Lo carga la vendedora en el pedido, panel Entrega → **Varias direcciones** (el botón está
  desde que el pedido no tiene dirección): cada lugar con su **nombre** («Central», «Sucursal Santa Fe»), su dirección,
  cuánto de cada producto va ahí (nunca más que el total del pedido) y su **anotación propia**, que queda con quién la
  escribió (`entrega_direcciones.nombre`, `observaciones`, `obs_user_id`; migración `0098`). Las generales del cliente
  van en las anotaciones de logística. En la Ruta del día y en la app del chofer hay **una parada por lugar**, con el nombre
  del lugar, **la cantidad que va ahí** (el reparto llega por el artículo de ClickUp atado al renglón del pedido,
  `clavesDeTareas`; un artículo que no va a un lugar no es parada ahí; sin reparto, o si el artículo no se pudo atar, va
  la cantidad entera) y la anotación de ese lugar. La tarjeta de la semana muestra cada lugar con lo que va («Central: 250»).
  **La logística se bifurca; la producción no** (etapa 2, migración `0099`). En Producción sigue siendo un artículo con un
  estado. En el cronograma, la entrega de cada artículo se abre en **una por lugar** (`repartirEntregas`, movimiento
  `tarea:entrega@dirección`), cada una con su día (`entrega_direcciones.fecha`; sin día propio, el del artículo), su
  «hecho» (`hecho_at`) y sus Colgados (`cronograma_colgados.dir`). Las que caen el mismo día se ven en una tarjeta, con el
  lugar al lado de cada cantidad; arrastrar la tarjeta mueve solo los lugares que tiene, y la primera vez que se separa
  uno los demás quedan fijos en el día que tenían. Los ids de las direcciones se conservan al guardar el reparto, así no
  se pierde lo que hizo Logística con cada lugar.
  **En ClickUp**, que tiene una fecha y un estado por artículo: la fecha es la de la última entrega que falta
  (`fechaEnClickup`) y el estado, «parcial entregado» mientras falte algún lugar y «entregados» cuando se hicieron todos
  (`hechoPorLugar`). Si ClickUp no acepta la fecha, el lugar vuelve a donde estaba. En la ficha del pedido, cada lugar
  dice qué día va o si ya se entregó. Mover la entrega entera (por ejemplo desde «listos sin fecha») pasa a ese día todos
  los lugares que faltan. Lo que cambien a mano en ClickUp no mueve los lugares que ya tienen día propio.
- **Cantidad enviada (demasía)**: en ingresos, retiros y egresos (no en las entregas al cliente), la cantidad de cada
  producto se toca para anotar la que realmente va o llega («110», con «+10 de más» al lado) y por qué. La cantidad del PDV
  no cambia. El remito de traslado del egreso y la app del chofer salen con esa cantidad. Tabla `cronograma_enviados`,
  `POST /api/cronograma/enviado` con `{ id, tipo, cantidad, motivo }`; la misma cantidad del pedido (o vacío) lo saca.
- **Bultos** (pedido de Rodrigo del 20/11/2026): por ahora los anota Logística a mano, en cualquier tarjeta (entregas,
  ingresos, retiros, egresos y encargos), por medida: **cajas de 40×30, de 60×40** (las que más se usan) **y otros**. Al
  pie de la tarjeta, al lado del chofer: «+ Bultos» (punteado) o «5 bultos», con el desglose al pasar el mouse y, en el día
  expandido, a la vista. Un clic los cambia; todo en 0 los saca. Se guardan en el primer movimiento de la tarjeta y la
  tarjeta suma los suyos: si se pasa a otro día van con ella y, si dos tarjetas se juntan, se suman. Tabla
  `cronograma_bultos` (clave `task_id:tipo`, `task_id:tipo@dir` o `enc:id`), `POST /api/cronograma/bultos` con
  `{ claves, c40, c60, otros }`. La Ruta del día los usa para avisar si la carga no entra en la camioneta.
- **Notas** del día (lo que no es de un artículo: un sobre, una muestra, un trámite) y **feriados** (se marcan en la
  cabecera del día; vienen cargados los de fin de 2026 y los de fecha fija de 2027).
- **Quién edita**: Logística, Producción y los administradores, en todas las unidades (también Corporate, aunque
  producción lo siga trabajando en ClickUp). El perfil Ventas no lo ve (igual que Producción y Entregas); el resto mira.

## Estados de despacho

Pedido de Logística (Rodrigo, 19/11/2026). Reemplaza los colores que Logística pintaba a mano en la planilla. El estado
**no se pinta: sale de los datos**, y cada tarjeta pendiente dice qué falta y a quién le toca. Tres etapas: el estado,
los puntitos, el reloj y el filtro «Le toca a»; la semana llena y la sección «Despacho» en la vista previa del pedido; y
los colgados que no se olvidan y la corrección a mano (la maqueta con las ideas está en el artifact «Estados de despacho»).

| Estado | Color | Cuándo | Le toca a |
|---|---|---|---|
| Entregado / Llegó / Retirado / Llevado | verde | hecho (como siempre) | — |
| No pagó nada / Pagó una parte | amarillo flúor | el pedido está en «$ Pendiente de Anticipo» **o** tiene saldo en Finnegans (lo que falta cobrar más lo que falta facturar). Como en Pedidos (`cobroPedido`): si lo pagado pasa el 1 % del total, «pagó una parte» | la vendedora (propietaria del pedido) |
| Falta información | rojo | la dirección de la parada falta o no se encontró en el mapa | la vendedora (en un retiro o un egreso, Logística: es la dirección del proveedor o el impresor) |
| No llegó | gris | lo que tenía que llegar antes (ingreso o retiro del proveedor, vuelta del impresor) tiene fecha pasada, no se marcó y el artículo sigue antes de ese paso; o un ingreso con fecha pasada | el proveedor o el impresor (Compras) |
| En cola de producción | violeta | algún artículo todavía no está «listo para entregar»; en un egreso, la mercadería todavía no llegó al depósito | Producción |
| Remitido | naranja | el remito ya está en Finnegans; en un egreso, el remito de traslado ya está armado | Logística |
| Listo para despachar | azul | todo lo demás bien | Logística |
| Programado | sin color | un ingreso que todavía no tenía que llegar | el proveedor |

- **Si aplican varios, gana el que traba**: no pagó > falta información > no llegó > en cola > remitido > listo.
- **Los puntitos** (checklist de salida): en las entregas, producción completa · mercadería en el depósito · pago ·
  dirección · remito; en los egresos, mercadería en el depósito · dirección · remito de traslado; en los retiros, la
  dirección. Los ingresos no tienen (llegan o no). Verde sí, rojo no, violeta en parte (2 de 3 productos listos), gris
  pendiente. El de pago: rojo no pagó nada, naranja pagó una parte, verde pagó. Al lado, lo que falta en pocas palabras; con el mouse encima, el detalle («Saldo de $ 1.240.000 en Finnegans»).
  Cada uno con su dibujito, para saber de un pantallazo cuál falta (pedido de Rodrigo del 20/11/2026): impresora la
  producción (como en el menú), caja la mercadería en el depósito, $ el pago, pin la dirección, hoja el remito y lápiz una
  anotación que traba. El estado va en el color y en la marquita de la esquina (✓, ✗ o –), para no depender solo del
  color (`ICONO_CONTROL` y `PuntoControl` en `Cronograma.tsx`).
- **Si llega a tiempo** (el reloj): solo cuando algo traba (no pagó, falta información, no llegó, en cola). Cuenta días
  hábiles hasta el día del movimiento (sin fines de semana ni feriados): «Atrasado · es mañana» (o hoy, o ya pasó) en rojo,
  «Justo · en 2 días hábiles» en ámbar. Lo listo, remitido o programado no lo lleva.
- **La semana llena**: lo hecho ocupa una línea punteada (✓, el lugar y el PDV; la flecha abre la tarjeta entera) y cada
  día tiene arriba una barrita con cuánto hay de cada estado.
- **En la vista previa del pedido**: al tocar la tarjeta se abre la vista previa de siempre con la sección «Despacho»
  arriba (el estado, el reloj, a quién le toca, el motivo si está colgado y el checklist entero con el detalle de cada
  control). `RecordPreview` recibe `arriba` (lo que quiera mostrar primero la pantalla que la abre).
- **Corregir la dirección desde la tarjeta** se ve enseguida en la tarjeta y en su despacho (la de la semana se vuelve a
  pedir de fondo, que tarda porque arma la ruta de cada día).
- **Corrección a mano**: una anotación de logística «solo esta vez» puede **trabar la entrega** (al escribirla:
  «¿Traba la entrega?» No · Falta información · No pagó · No llegó). Mientras esté, la tarjeta queda en ese estado (si es
  más grave que el automático), con el puntito «Anotación» en rojo y el texto como detalle; se ve en la tarjeta con la
  etiqueta «Traba: …». Borrarla la devuelve a lo automático. Las de siempre no traban. Columna `traba` de
  `logistica_notas` (migración `0100_colgados_avisos.sql`).
- **Colgados que no se olvidan** (etapa 3): cada colgado dice hace cuántos días está colgado (en rojo desde la semana);
  arriba van los que ya se pueden reprogramar y después, del más viejo al más nuevo. Si se destraba lo que lo colgó (todo
  queda listo o remitido: entró el pago, llegó la mercadería), la etiqueta pasa a **«Listo para reprogramar»** y a
  Logística le llega el aviso (campanita y mail) una vez; si se vuelve a trabar y se destraba, de nuevo. Si pasa una
  semana colgado, al responsable del pedido le llega otra vez el aviso, una vez. Lo revisa `revisarColgados`
  (`cronograma.ts`) a los :25 de cada hora; `POST /api/cronograma/colgados/revisar` lo fuerza (administradores). Columnas
  `listo_avisado_at` y `reavisado_at` de `cronograma_colgados`; avisos `colgado_listo` y `colgado_reaviso`.
- **Le toca a**: en la barra, Producción · Ventas · Proveedor · Logística con cuántas tarjetas tiene cada uno (también las
  colgadas); un clic deja solo esas.
- **Cómo está hecho**: el servidor arma el despacho de cada movimiento (`despachoDe` en `cronograma.ts`, campo `despacho`
  de cada movimiento) y la pantalla junta los de una tarjeta y suma la dirección de la parada, que llega aparte
  (`web/src/despacho.ts`). El orden de los estados de ClickUp dice si un artículo ya pasó por el depósito («en control de
  depósito») o volvió del impresor («articulo con logo»); con un estado desconocido no se marca «No llegó».
- **El remito en Finnegans** (`revisarRemitos` en `finnegans.ts`): puede salir del pedido (lo habitual en Corporate:
  pedido → remito → factura) o de la factura (lo habitual en Formas Shop: pedido → factura → remito). Se pregunta solo por
  los pedidos con algún producto listo y entrega entre hace 15 días y dentro de 7, que todavía no tienen remito: a los
  :30, de lunes a viernes de 9 a 20, hasta 15 pedidos por vez y cada pedido como mucho cada 2 horas (Finnegans cobra por
  consulta; una por pedido y, si no aparece, una por factura). «Sincronizar» en Configuración → Integraciones vuelve a
  preguntar sin esperar. Queda en el pedido: `remito_finnegans` y `remito_finnegans_fecha` (migración
  `0099_remito_finnegans.sql`). **A verificar con datos reales**: que el informe de documentos destino de una factura de
  Formas Shop traiga su remito.

## Ruta del día

Las paradas del día en el mapa: **una por proveedor o impresor** (tres retiros en el mismo impresor son una parada) y
**una por PDV** en las entregas. La parada no depende de su dirección: corregirla no la saca del recorrido ni pierde lo
que marcó el chofer. Lo que se pasa a un día después de armar sus recorridos va al final del primero.

- **Varios recorridos por día, uno por chofer** (pestañas). Cada uno con su chofer (los que tienen link en Entregas →
  Choferes), de dónde sale (Depósito Gral. Roca 4250 u Oficina Matienzo 1308, Florida Oeste) y a qué hora. Las paradas
  se pasan de un recorrido a otro.
- **Orden**: un recorrido que nadie ordenó a mano (el del día recién abierto, o los que se arman eligiendo el chofer desde
  las tarjetas) **se ordena solo** por el recorrido más corto, también en la app del chofer, y se vuelve a ordenar cuando
  se le suma una parada o se ubica una dirección (la barra dice «Se ordena solo por el recorrido más corto»). Arrastrar
  una parada o moverla con las flechas lo deja ordenado a mano: desde ahí queda en el orden que se le dio, lo que se le
  suma desde una tarjeta entra donde menos lo alarga, y aparece «Ordenar por el recorrido más corto» (tiene en cuenta el
  horario de recepción de cada lugar) y lo deja otra vez automático. La primera vez que se mueve una parada, un aviso
  dice que el recorrido quedó ordenado a mano.
- **Hora de llegada a cada parada, por ahora sin el tránsito del momento**: el tiempo de cada tramo con la calle libre
  por un factor según la hora, como un día de tránsito moderado (`web/src/ruta.ts`: 1,6 de 7 a 10, 1,35 de 10 a 12,
  1,4 de 12 a 14, 1,3 de 14 a 16:30, 1,65 de 16:30 a 19:30). Un tramo que cruza de una franja a otra va con el factor de
  cada parte (`minutosDeViaje`). Más el tiempo en cada parada (8 minutos y 4 por movimiento). El tramo dice «tránsito
  habitual fluido / moderado / pesado» en grises: el rojo queda para llegar tarde.
- **Direcciones sin ubicar**: el tramo que llega a esa parada (o la vuelta, si no se ubicó dónde termina) dice «Sin
  calcular: falta ubicar *tal lugar*», en ámbar, con el botón para arreglarlo («Ubicarla en el mapa», «Cargar la
  dirección» o «Cambiar el lugar»). Las horas que vienen después llevan «≈»: no cuentan ese viaje. El resto del recorrido
  igual se pide por calles con las paradas que sí están ubicadas. Mientras el servidor sigue buscando, la parada dice
  «Buscando en el mapa…»; si tarda demasiado, «Volver a fijarse».
- **Horario de recepción** («9 a 13», propiedad nueva de la empresa): si el orden deja una parada fuera de horario,
  queda en rojo. El horario escrito en un encargo o en la libreta también cuenta, aunque esté escrito como «antes de las
  14 hs», «después de las 15», «luego del mediodía» o «a las 12».
- **Hora fijada a mano** (pedido de Rodrigo del 16/11/2026): «Fijar hora» en cada parada, con **A las** (llega entre 15
  minutos antes y 15 después), **Antes de las** o **Desde las**. El recorrido que la tiene **se vuelve a ordenar solo**
  para cumplirla junto con las demás horas fijadas y los horarios de recepción (aunque estuviera ordenado a mano): llegar
  tarde a una hora fijada pesa mucho más que llegar tarde a un horario de recepción, así que el orden más corto la cumple
  aunque el recorrido quede más largo. Si además el lugar tiene horario de recepción, vale lo que cumpla los dos. La parada
  dice «A las 12:00» (en rojo si igual llega tarde); si llega antes, espera hasta las 12:00 (no hasta las 11:45, aunque
  llegar a esa hora no sea tarde) y la hora de la parada es la de cuando se la atiende, con «llega 11:36 y espera» abajo.
  Si el recorrido estaba ordenado a mano, el panel avisa que al guardar se pierde ese orden. Se ve también en la tarjeta de la semana y en la app del chofer. «Sacar la hora» la quita. Es de
  esa parada ese día: tabla `cronograma_horas` (migración `0065_horas_pactadas.sql`), `PUT /api/cronograma/hora`
  (`{ fecha, clave, modo: 'a_las' | 'antes' | 'desde', hora: '12:00' }`, sin `modo` la saca). Prueba: `test/horas.test.mjs`.
- **Mapa**: OpenStreetMap. El dibujo y la distancia por calles salen del servicio público de OSRM; si no contesta, el
  recorrido se ve en línea recta y los tiempos son estimados (dice cuál de los dos es). Los números del mapa no se arrastran. Para corregir un punto mal
  ubicado: «Corregir el punto en el mapa» en el menú ⋯ de su parada, se arrastra solo ese número y se guarda con «Guardar
  ubicación» (vale para esa dirección en todas las rutas). Una que no se encontró se ubica igual: su número aparece en
  el centro del mapa para llevarlo a su lugar. «Volver a buscar en el mapa» saca la corrección. Un clic en un número del
  mapa lleva a su parada en la lista.
- **La tarjeta de cada parada**: el número (y su manija) se arrastra para cambiar el orden; la dirección, lo que se
  lleva o se trae (primero qué y cuánto, abajo el PDV) y la hora. Debajo, una fila con los estados (hora fijada, sin
  ubicar, foto del remito) y otra con las acciones: **Marcar hecha** (cambia ClickUp; el aviso trae «Deshacer»),
  **Remito** en los egresos, **Fijar hora**, el menú **⋯** (corregir la dirección, diciendo si se cambia en el pedido o
  en la ficha de la empresa; corregir el punto en el mapa; mandar por expreso; cómo llegar; pasar a otro recorrido; juntar
  una parada de encargos con otra o separar un encargo, ver [Juntar paradas](RECORRIDOS.md#juntar-paradas)) y
  las flechas. Se abre un panel por vez. «Pasar a otro recorrido» entra donde menos lo alarga si ese recorrido está
  ordenado a mano (la misma cuenta que el servidor, `dondeEntra` en `ruta.ts`) y el aviso trae «Deshacer».

### Choferes, expresos y de dónde sale

- **La camioneta de cada chofer** (pedido de Rodrigo del 20/11/2026), en la pantalla Choferes (Logística y los
  administradores): modelo, tamaño, una foto (se achica en el navegador) y **cuántas cajas entran de 40×30 y de 60×40**
  si va cargada solo con esa medida. Va por el nombre del chofer, igual que los recorridos (sirve aunque se le cree otro
  código). Al lado del desplegable «Chofer» de la ruta se ve su camioneta. Tabla `cronograma_vehiculos`
  (`src/worker/vehiculos.ts`); `GET /api/choferes/vehiculos`, `PUT /api/choferes/vehiculo`, `POST|DELETE|GET
  /api/choferes/vehiculo/foto`.
- **Si la carga entra** (cajas combinadas): con los bultos de las tarjetas, cada recorrido sale con todo lo que va a dejar
  (entregas, egresos y encargos que llevan algo) y en cada parada baja lo que deja y sube lo que retira; se compara el
  momento más cargado con la camioneta de su chofer. Cada caja ocupa la parte que le toca de su medida (con 80 de 40×30 o
  40 de 60×40, 20 de 40×30 y 10 de 60×40 son la mitad); si se sabe una sola capacidad, la otra medida se pasa por
  superficie (una de 60×40 son dos de 40×30). Los de otra medida no cuentan. Se ve en «Carga» (el % de la camioneta), en
  la pestaña del recorrido (en rojo si no entra) y en un aviso: **no entra** (más del 100 %) o **casi llena** (más del
  90 %), con cuándo va más cargada. Con bultos y sin la capacidad de la camioneta, pide cargarla en Choferes. Cada parada
  dice cuántos bultos deja y cuántos sube. La cuenta está en `web/src/bultos.ts` (`cargaRecorrido`, `ocupacion`).

- **El link del chofer** (pedido de Rodrigo del 18/11/2026): abajo de la barra del recorrido, cuando tiene un chofer (no
  un expreso), su link y su código, con «Copiar link» y «Mandar por WhatsApp» (el mensaje ya dice de qué día es el
  recorrido). Si ese chofer todavía no tiene link, «Crear su link» lo crea ahí mismo con su nombre (el mismo que en
  Choferes). `GET /api/choferes/por-nombre?nombre=` (solo Logística y administradores).
- **Lista de choferes y expresos.** El desplegable «Chofer» de cada recorrido (y el de cada tarjeta de la semana) tiene
  los choferes, los expresos (transportes de terceros) y «+ Agregar chofer o expreso…». Todos los desplegables del
  cronograma (Chofer, Sale de, Expreso) son el del Hub (`web/src/Select.tsx`), no la lista del navegador. Del expreso se guarda además su dirección, que es a donde se le lleva la
  mercadería (se puede buscar en la libreta). El link de la app del chofer sigue siendo aparte (Choferes en la barra lateral de
  Logística, o Entregas → Choferes, con el mismo nombre): un chofer puede estar en la lista sin link.
- **Una entrega por expreso.** En la parada de una entrega, «Mandar por expreso»: se elige el expreso y, cuando se
  despacha, se carga el **número de guía** para seguir el envío. La parada pasa a ser el expreso (con su dirección) y dice
  para qué cliente es; en la semana la tarjeta lleva «Expreso … · guía …». Es del PDV: vale para todas sus entregas. «Va
  directo al cliente» lo deshace. El chofer ve «Dejé en el expreso: foto de la guía».
- **Termina en** (pedido de Rodrigo del 13/11/2026): un recorrido no siempre vuelve a donde salió. Al lado de «Sale de»:
  **Donde sale** (como hasta ahora), uno de los depósitos de Formas, **La última parada** (no vuelve a ningún lado) u
  **Otro lugar**, que se busca en la libreta o se escribe la dirección, como en «Sale de». El último tramo, la hora a la
  que termina («Termina» en vez de «Vuelve» cuando no es el mismo lugar), los kilómetros, el orden más corto y el mapa
  (con una bandera donde termina) lo tienen en cuenta. El chofer lo ve en su app: «terminás en … cerca de las …».
  Columnas `fin`, `fin_nombre` y `fin_direccion` de `cronograma_rutas` (migración `0060_recorrido_termina.sql`).
- **La guía, sola desde la foto** (pedido de Rodrigo del 13/11/2026): cuando el chofer deja la mercadería en el expreso
  saca la foto de la guía (muchas veces apoyada encima del remito). Al leerla, Claude saca la empresa y el número de guía.
  De qué entrega es: la parada desde la que abrió la cámara («Dejé en el expreso: foto de la guía», «Entregué»: la app
  manda la parada con la foto); si la sacó con el botón general, la del pedido del remito, o la del pedido de ese PDV si
  va por expreso; y si no se sabe, **la app le pregunta al chofer**: «¿De qué entrega es la guía?», con las entregas de
  su recorrido de hoy para tocar (o el PDV para escribir). Si esa entrega no estaba marcada por expreso, queda marcada
  con el expreso de la guía. Una guía ya cargada no se pisa (si es otra, queda avisado en el remito). Al chofer no se le
  pide otra foto por eso. Lo mismo vale para un remito de Formas que no dice el PDV: toma el de la parada desde la que se
  sacó, o la app le muestra las paradas para elegir.
- **Seguimiento**: con Vía Cargo, la guía es un link a su seguimiento (`viacargo.com.ar/seguimiento-de-envio/<guía>`,
  el mismo que abre su buscador) en la tarjeta de la semana, en la parada y en el remito; de los demás expresos queda el
  número para copiar (`web/src/expresos.ts`, donde se suma otro expreso con link).
- **Sale de → Otro lugar.** Además de los dos depósitos de Formas, un recorrido puede salir de otro lugar: se busca en la
  libreta por nombre o por dirección, o se escribe la dirección. Queda con su punto en el mapa.

### Direcciones

- **Proveedores e impresores**: la dirección de la ficha de su empresa; si no tiene, la de la libreta de direcciones
  cuando hay un lugar que se llama igual (ver abajo).
- **Entregas**, en este orden: las direcciones de la tarjeta «Entrega» del pedido (validadas con Google Maps; con
  varias, **una parada por dirección**, ver [REMITOS.md](REMITOS.md#dirección-de-entrega-pedido-de-rodrigo-del-12112026));
  la del pedido de venta de Finnegans; la de la última entrega a ese cliente; la de la ficha de la empresa. Las validadas
  van al mapa con el punto de Google. Corregirla desde la parada (o aceptar la sugerencia) cambia la de la tarjeta; si el
  pedido va a varias direcciones, se cambian en la tarjeta.
- **Retira en Formas** (tarjeta «Entrega»): no es una parada ni va en la app del chofer. Se lista aparte, abajo del mapa,
  en «Retiran en Formas», con en cuál de las dos lo retira el cliente; si además una parte se envía, esa sí es parada y
  el retiro dice «una parte; el resto se envía».
- **Si las últimas entregas fueron a otro lado**: se compara la dirección de Finnegans con la de los últimos remitos
  leídos de ese cliente. Si a simple vista no son iguales, Claude decide si es el mismo lugar escrito distinto o es
  otro. Solo si es otro aparece la sugerencia en la parada, para usarla o descartarla. Se consulta una vez por pedido.
- Cada dirección se busca en el mapa una sola vez (Nominatim de OpenStreetMap, de a pocas por vez).
- Buscar afuera (Finnegans, el mapa, Claude) lo dispara solo quien edita el cronograma al abrir la ruta. Quien solo
  mira, «Ver como» y la app del chofer usan lo que ya está guardado.

### La libreta de direcciones

Los lugares a los que se va siempre (proveedores, impresores, depósitos y oficinas de clientes: unos 2.500), con su
dirección, horario, teléfono, contacto y observaciones. Desde [Recorridos](RECORRIDOS.md#una-sola-base-de-destinos) es
la **base de destinos del Hub**: cada lugar tiene su id, se agregan y se corrigen en Recorridos → Destinos, y la planilla de
Logística publicada como CSV (columnas PROVEEDOR, DIRECCION, H. ATENCION, TELEFONO, LOCALIDAD, ZONA, CONTACTO 1 y 2,
OBSERVACIONES y los datos de coordinación) se sigue copiando sin pisar lo que se corrigió en el Hub.

- **Se copia sola una vez por día**, cuando alguien que edita abre la ruta, y con «Actualizar» al pie del mapa. Suma los
  lugares nuevos y actualiza los que estaban (por nombre y dirección); los que la planilla sacó dejan de ofrecerse. Si la
  planilla no se puede leer, queda la copia anterior. De qué planilla se copia lo cambia un administrador
  (`PUT /api/cronograma/lugares/planilla`).
- **Una parada sin dirección** usa la de la libreta si hay un lugar que se llama igual («SOLSPORT»; «MAD / DIMILITO» es
  Dimilito; «ZECAT (DEPOSITO)» es Zecat) y es uno solo, todos son la misma dirección o uno solo es el depósito. Con el
  nombre parecido pero no igual («NESTLE ARGENTINA S.A.» tiene más de veinte lugares) no se usa ninguno solo: se elige.
- **«Corregir dirección»** en la parada tiene el buscador de la libreta: muestra primero los lugares de ese cliente o
  proveedor y busca por nombre, calle o localidad. Elegir uno lo guarda en el pedido (entregas) o en la ficha de la
  empresa (proveedores e impresores).
- **Lo que dice la libreta del lugar** aparece en la parada cuando reconoce la calle y la altura, aunque estén escritas
  distinto: horario (cuenta para avisar si se llega tarde), contacto, teléfono y observaciones. También en la app del
  chofer. Cómo se coordina la entrega (turnos, seguros) lo ve solo quien edita.

## La app del chofer

En la misma app de los remitos (`/hooks/chofer/`, ver [REMITOS.md](REMITOS.md)), arriba: **«Tu recorrido de hoy»**, el
que Logística armó con su nombre. Cada parada con la hora aproximada, qué hay que retirar, dejar o entregar y «Cómo
llegar» (abre el mapa del celular). Es solo el de hoy: el link del chofer no ve ni marca otros días. No puede haber dos links activos con el mismo nombre.
Entra con su **código de 8 números**, que escribe una sola vez y queda guardado en el celular, o con su link (los dos se
crean en Choferes, en la barra lateral de Logística, o en Entregas → Choferes, con el mismo nombre que tiene en el desplegable «Chofer»; ver [REMITOS.md](REMITOS.md)).
**Cómo llegar** (pedido de Rodrigo del 13/11/2026): cada parada tiene a la derecha el botón de navegación, que abre la
dirección sin abrir la parada. La primera vez pregunta con qué app va (Google Maps, Waze y, en el iPhone, Apple Maps) y
después abre directo con esa; se cambia en «Cómo llegar con» de la parada abierta. Arriba de las paradas, **«Todo el
recorrido en Google Maps»** abre la navegación desde donde está el chofer con las paradas que le faltan, en orden, y
dónde termina el recorrido. Google Maps acepta hasta 9 paradas en el medio más el destino: si faltan más, abre las
próximas 10 y, al hacerlas, el botón abre las que siguen. Waze no deja cargar varias paradas por link: con Waze se va
parada por parada (la app lo avisa).

**La parada abierta** (pedido de Rodrigo del 16/11/2026): tocar una parada abre su propia pantalla, que entra desde la
derecha, como si entrara a la parada: «← Recorrido» y «Parada 3 de 16» arriba; el lugar, en qué estado está y la
dirección grandes, la hora estimada (y la fijada o el horario de recepción), «Cómo llegar»; qué hay que hacer; en el lugar
a quién preguntar, las observaciones y, si hay teléfono, «Llamar»; y abajo, fijos, los botones. Se vuelve con la flecha o
con el «atrás» del celular. Hecha, queda abierta (para la foto del remito) y ofrece «Siguiente» con la próxima que falta.

En cada parada marca cómo le fue (se ve en el momento; si no se pudo guardar, vuelve a como estaba y lo avisa arriba):

- **Entregué / Retiré todo / Listo**: los artículos quedan hechos (y cambian de estado en ClickUp, igual que cuando lo
  marca Logística, pero a nombre del chofer en la conversación del pedido y en el historial, con el origen «app del
  chofer»: se lee «Gabriel Cimino (app del chofer) pasó…», para que no parezca un usuario del CRM). Si era una entrega,
  se abre la cámara para la foto del remito firmado. «Deshacer» vuelve atrás solo lo que marcó él, no lo que había marcado Logística.
- **No se pudo**, con el motivo: no había nadie, estaba cerrado, no encontré la dirección, no lo quisieron recibir, no
  estaba listo (en los retiros) u otro, y una nota. Logística lo ve en la parada, en el momento.
- **Dejar para después**.

Sin señal no se puede marcar, pero el recorrido se sigue viendo (queda guardado en el celular); las fotos de los remitos siguen saliendo solas cuando
vuelve, como siempre.

## Aviso a las vendedoras de lo que se entrega mañana

Pedido de Rodrigo del 24/11/2026. A las 16 de cada día hábil, a cada vendedora le llega a la campanita y al mail (si
tiene «Avisos por mail» prendido) qué pedidos suyos se entregan el próximo día hábil: el viernes, lo del lunes, y se
saltean los feriados cargados en el cronograma. Un aviso por pedido, con el cliente, el PDV y los artículos («martes 24/11 · Nestlé
S.A. · PDV 12345 · 40 Caja»).

- Solo **entregas al cliente** (tipo `entrega`): nunca los retiros, ingresos ni egresos de producción. Tampoco lo ya
  entregado ni lo colgado.
- A la **responsable del pedido** y a quien la atiende como **Back office** ([PERFILES.md](PERFILES.md#back-office)), con
  «· de Fulana» al final.
- Sale una vez por día (`settings.avisos_entregas_manana`), en la corrida de los :05 de las 16 (`index.ts`), y el mail en
  esa misma corrida (`avisos.ts`). Un administrador lo puede forzar con `POST /api/cronograma/entregas-manana/avisar`
  (`?hoy=AAAA-MM-DD` para hacer de cuenta que es otro día). Código: `avisarEntregasManana` en `cronograma.ts`.

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Correcciones de la revisión: qué marcó el chofer en cada parada, a nombre de quién, feriados que faltaban | `migrations/0046_cronograma_chofer.sql` |
| La libreta de direcciones: tablas `lugares` y `lugares_claves`, y de qué planilla se copia (settings `lugares`) | `migrations/0047_lugares.sql` |
| Choferes y expresos (`transportistas`), entregas por expreso con su guía (`entrega_expresos`) y el otro lugar de salida de un recorrido | `migrations/0054_transportistas.sql` |
| Recorridos que se ordenan solos o que alguien ordenó a mano (`cronograma_rutas.a_mano`) | `migrations/0057_recorridos_solos.sql` |
| El chofer desde la tarjeta: `PUT /api/cronograma/chofer` (`{ fecha, ids, chofer }`, con los `id` de los movimientos de la tarjeta) | `asignarChofer` en `src/worker/cronograma.ts` |
| Tablas `cronograma_hechos`, `cronograma_notas`, `feriados`, `geocodigos`, `cronograma_rutas`, `cronograma_visitas`, `direcciones_finnegans`, `direcciones_revisadas`; propiedades `direccion_entrega` (pedido) y `horario_recepcion` (empresa) | `migrations/0045_cronograma.sql` |
| Movimientos, mover, marcar, notas, feriados, direcciones, ruta, chofer | `src/worker/cronograma.ts` |
| API `/api/cronograma…` | `src/worker/api.ts` |
| API del chofer: `GET /hooks/chofer/api/ruta`, `POST /hooks/chofer/api/ruta/parada` | `src/worker/hooks.ts` |
| Pantalla: semana y barra de semanas / ruta y mapa | `web/src/pages/Cronograma.tsx`, `web/src/pages/CronogramaRuta.tsx` |
| Cálculo del recorrido (lo usan el CRM y la app del chofer) | `web/src/ruta.ts` |
| El recorrido en la app del chofer | `web/chofer/src/Ruta.tsx` |
| Bultos por medida (`cronograma_bultos`) y la camioneta de cada chofer (`cronograma_vehiculos`) | `migrations/0102_bultos.sql`, `migrations/0103_vehiculos.sql`, `src/worker/vehiculos.ts` |
| Cajas combinadas y la carga de un recorrido | `web/src/bultos.ts` |
| Prueba de punta a punta (ClickUp, Finnegans, Claude y el buscador de direcciones simulados) | `test/cronograma.test.mjs` |

## Para revisar con datos reales

- **El campo de la dirección en Finnegans.** No está documentado cómo se llama en el pedido de venta: se toma el primer
  campo que habla de la dirección o el domicilio de entrega (`direccionDeFinnegans`). Hay que mirar un pedido real; si
  no aparece, la entrega usa la de la última entrega o la de la empresa.
- **Direcciones que no se encuentran.** El buscador es gratuito y no siempre encuentra una dirección argentina mal
  escrita: la parada queda «No se encontró en el mapa» y se corrige la dirección o se arrastra el punto.
- **Servicios de afuera.** Al buscador de direcciones (Nominatim) le llega la dirección y al de rutas (OSRM), las
  coordenadas; ninguno recibe nombres de clientes. Los dos son servicios públicos sin garantía: si se usa todos los días
  conviene pasar a uno pago (el mismo que traiga el tránsito).

## Lo que sigue

- Tránsito del momento (Google Maps u otro servicio pago) en lugar del factor por hora.
- Aviso al cliente por WhatsApp con la hora estimada.
- Puntualidad de proveedores e impresores (fecha prometida contra la real).
