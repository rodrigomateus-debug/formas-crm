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
| Ingresos | INGRESO (PROVEEDOR) | Llega al depósito (no es un viaje) |
| Retiros | RETIROS (PROVEEDOR) y RETIRO (IMPRESOR) | El proveedor o el impresor |
| Egresos | EGRESO (IMPRESOR) | El impresor |
| Listos para entregar, sin fecha | Estado «listo para entregar» sin fecha de entrega | — |

Lo único propio del CRM: las notas sueltas de un día, los feriados, lo que se marcó como hecho, los recorridos y lo que
marca el chofer (migración `0045_cronograma.sql`).

## Semana

- **Barra de semanas**, arriba: trece semanas agrupadas por mes. Se arrastra para los costados, las flechas la corren
  un mes y un clic elige la semana. Cada semana muestra cuánto tiene cada día y cuánto falta; en rojo, lo que ya pasó y
  no se hizo. «Hoy» vuelve a la semana actual.
- **Cada día** con sus cuatro carriles. Una tarjeta junta los artículos de un PDV con el mismo movimiento, el mismo día
  y en el mismo lugar. Un clic abre la vista previa del pedido.
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
- **Notas** del día (lo que no es de un artículo: un sobre, una muestra, un trámite) y **feriados** (se marcan en la
  cabecera del día; vienen cargados los de fin de 2026 y los de fecha fija de 2027).
- **Quién edita**: Logística, Producción y los administradores, en todas las unidades (también Corporate, aunque
  producción lo siga trabajando en ClickUp). El perfil Ventas no lo ve (igual que Producción y Entregas); el resto mira.

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
  horario de recepción de cada lugar).
- **Hora de llegada a cada parada, por ahora sin el tránsito del momento**: el tiempo de cada tramo con la calle libre
  por un factor según la hora, como un día de tránsito moderado (`web/src/ruta.ts`: 1,6 de 7 a 10, 1,35 de 10 a 12,
  1,4 de 12 a 14, 1,3 de 14 a 16:30, 1,65 de 16:30 a 19:30). Más el tiempo en cada parada (8 minutos y 4 por movimiento).
- **Horario de recepción** («9 a 13», propiedad nueva de la empresa): si el orden deja una parada fuera de horario,
  queda en rojo.
- **Mapa**: OpenStreetMap. El dibujo y la distancia por calles salen del servicio público de OSRM; si no contesta, el
  recorrido se ve en línea recta y los tiempos son estimados (dice cuál de los dos es). Los números del mapa no se arrastran. Para corregir un punto mal
  ubicado: «Corregir ubicación» en su parada, se arrastra solo ese número y se guarda con «Guardar ubicación» (vale para
  esa dirección en todas las rutas). «Volver a buscar en el mapa» saca la corrección.

### Choferes, expresos y de dónde sale

- **Lista de choferes y expresos.** El desplegable «Chofer» de cada recorrido (y el de cada tarjeta de la semana) tiene
  los choferes, los expresos (transportes de terceros) y «+ Agregar chofer o expreso…». Todos los desplegables del
  cronograma (Chofer, Sale de, Pasar a…, Expreso) son el del Hub (`web/src/Select.tsx`), no la lista del navegador. Del expreso se guarda además su dirección, que es a donde se le lleva la
  mercadería (se puede buscar en la libreta). El link de la app del chofer sigue siendo aparte (Entregas → Choferes, con
  el mismo nombre): un chofer puede estar en la lista sin link.
- **Una entrega por expreso.** En la parada de una entrega, «Mandar por expreso»: se elige el expreso y, cuando se
  despacha, se carga el **número de guía** para seguir el envío. La parada pasa a ser el expreso (con su dirección) y dice
  para qué cliente es; en la semana la tarjeta lleva «Expreso … · guía …». Es del PDV: vale para todas sus entregas. «Va
  directo al cliente» lo deshace. El chofer ve «Dejé en el expreso: foto de la guía».
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
dirección, horario, teléfono, contacto y observaciones. Es una copia de la planilla de Logística publicada como CSV
(columnas PROVEEDOR, DIRECCION, H. ATENCION, TELEFONO, LOCALIDAD, ZONA, CONTACTO 1 y 2, OBSERVACIONES y los datos de
coordinación). La planilla sigue siendo donde se cargan y corrigen los lugares.

- **Se copia sola una vez por día**, cuando alguien que edita abre la ruta, y con «Actualizar» al pie del mapa. Si la
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
En cada parada marca cómo le fue:

- **Entregué / Retiré todo / Listo**: los artículos quedan hechos (y cambian de estado en ClickUp, igual que cuando lo
  marca Logística, pero a nombre del chofer en la conversación del pedido). Si era una entrega, se abre la cámara para
  la foto del remito firmado. «Deshacer» vuelve atrás solo lo que marcó él, no lo que había marcado Logística.
- **No se pudo**, con el motivo: no había nadie, estaba cerrado, no encontré la dirección, no lo quisieron recibir, no
  estaba listo (en los retiros) u otro, y una nota. Logística lo ve en la parada, en el momento.
- **Dejar para después**.

Sin señal no se puede marcar, pero el recorrido se sigue viendo (queda guardado en el celular); las fotos de los remitos siguen saliendo solas cuando
vuelve, como siempre.

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
