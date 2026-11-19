# Recorridos

Pedido de Rodrigo del 13/11/2026. Reemplaza la planilla «Recorridos 2026» de Logística (una pestaña por mes), donde
vendedoras, backoffice, producción, compras y administración cargan lo que el chofer tiene que hacer al día siguiente:
llevar o retirar muestras, un sobre, mercadería, un trámite. En el Hub eso es un **encargo**, y se carga en la pestaña
**Recorridos** (`/recorridos`, en el menú para todos los perfiles, también Ventas).

## Lo que mostró la planilla (mayo a noviembre de 2026)

- 2.896 paradas en 6 meses (sacando ~550 filas copiadas entre pestañas), unas 22 por día hábil.
- El 75 % lo cargaba Logística y es lo de ClickUp (retiros, egresos y entregas con número de PDV), que el
  [Cronograma](CRONOGRAMA.md) ya arma solo. El resto son los pedidos de los demás: vendedoras (casi todo muestras),
  producción (telas, talleres), compras (muestras de proveedores) y administración (RAMI, sobres).
- El 99 % de los destinos se elegía de la pestaña DESTINOS (la libreta), que es la misma que ya copiaba el Cronograma.
- Hay lugares muy regulares: RAMI casi todos los días; MAD/Dimilito y Solsport 3 veces por semana; Publios, Lavita,
  Novatampo, Imprefas y Zecat depósito 2 o 3 (Zecat, sobre todo los lunes; MAD, los jueves).
- Las columnas COSTO y ORDEN casi no se usaban; PRIORIDAD (ALTA) y HORARIO, en las filas de las vendedoras.

## Una sola base de destinos

La libreta de direcciones pasa a ser del Hub (antes se borraba y se volvía a copiar entera de la planilla cada día, así
que nada podía apuntar a un lugar):

- **Cada destino tiene su id para siempre.** La planilla DESTINOS se sigue copiando una vez por día (o con «Traer la
  planilla ahora»), pero ahora **suma y actualiza**: reconoce cada lugar por nombre y dirección, los nuevos se agregan, los
  que la planilla sacó dejan de ofrecerse (los encargos viejos los siguen nombrando).
- **Lo que se corrige en el Hub queda**: la copia de la planilla ya no lo pisa (en la lista dice «Corregido»), y lo que
  Logística sacó de la libreta no vuelve. Los destinos los corrige Logística (y quien edita el cronograma); cada uno
  corrige los que cargó.
- **Destinos nuevos desde el Hub**: «Nuevo destino» en la pestaña Destinos, o al cargar un encargo a una dirección que no
  está («Guardarlo en Destinos»). Una empresa del CRM elegida como destino también se suma, atada a su empresa.
- **Al buscar un destino** aparecen juntos: los lugares de la libreta, las empresas del CRM (las que la persona ve, más
  los proveedores e impresores), los expresos y los depósitos de Formas. Si una empresa ya es un lugar de la libreta,
  sale una vez.
- La misma base la usan el Cronograma (direcciones de las paradas, «Corregir dirección») y la app del chofer (horario,
  contacto y observaciones de cada lugar).

La planilla DESTINOS puede seguir usándose mientras tanto; cuando todos carguen en el Hub, alcanza con dejar de usarla.

## Cargar un encargo

«Nuevo encargo» en Recorridos o, desde cualquier pantalla, **Crear → Encargo** arriba a la derecha (pedido de Rodrigo del
19/11/2026; también para Producción y Logística, que en «Crear» solo tienen Pedido), en tres pasos:

1. **¿A dónde?** Se busca en toda la base, o se elige de las sugerencias de cada persona:
   - **A donde más mandás**: sus destinos de los últimos 6 meses (también los de la planilla vieja, si se trajo el
     historial).
   - **De tus pedidos y negocios**: el cliente de sus pedidos abiertos, el proveedor y el impresor de cada artículo que
     falta («Impresor de tu PDV 31406»), y la empresa de sus negocios abiertos de los últimos 2 meses (para las muestras).
   - Cada sugerencia dice **«Ya van mañana»** (o el día) si ya hay viaje previsto ahí, o qué días se suele ir.
   - O **otro lugar**: un nombre y una dirección (un domicilio, un envío suelto), con la opción de guardarlo en Destinos.
2. **¿Qué día?** Los próximos días hábiles, y en cada uno:
   - **Ya van**: ese día ya se va a ese lugar (un retiro, egreso o entrega de ClickUp, u otro encargo). El encargo va en
     la misma parada. Al pasar el mouse dice qué.
   - **Suele ir**: es uno de los días que se va habitualmente (de las últimas 8 semanas: la planilla vieja, los encargos y
     los retiros y egresos de ClickUp; cuenta días, no filas).
   - Si el día elegido no tiene viaje y hay uno cerca: «Si puede esperar, el jueves ya van» (o «Antes, …»), con un botón
     para sumarlo ahí.
   - Si es para hoy, el aviso de que el recorrido puede haber salido (Logística se entera en la campanita).
   - Lo que dice la libreta de ese lugar (horario, contacto, observaciones) y lo último que se mandó ahí.
3. **¿Qué hay que hacer?** Renglones de **Llevar** y de **Retirar** (cantidad, qué y PDV si es de un pedido); dónde está
   lo que se lleva y a dónde va lo que se retira (Depósito Gral. Roca u Oficina Matienzo); horario; a quién preguntar;
   notas; «Tiene que ir sí o sí ese día» (la PRIORIDAD ALTA de la planilla).

Validaciones: hace falta algo para llevar o retirar (o qué hacer, en las notas); no se carga para un día que ya pasó
(Logística sí puede).

## Quién hace qué

| | Quien lo pidió | Logística, Producción y administradores | El chofer (app) |
|---|---|---|---|
| Cargar | Sí | Sí | — |
| Cambiarlo o pasarlo a otro día | Mientras esté pendiente o no se haya podido | Siempre | — |
| Cancelarlo | El suyo, si no está hecho (y volverlo a pendiente si lo canceló) | Cualquiera | — |
| Marcarlo hecho | — | Sí (en la tarjeta, la ruta o el encargo) | Sí (en su parada) |
| No se pudo | — | Sí | Sí, con el motivo |

Con permiso «Solo mira» no se carga nada. Cuando lo cambia otro (lo pasa a otro día, lo cancela, lo marca hecho o el
chofer marca que no se pudo), **a quien lo pidió le llega un aviso** en la campanita (no por mail). Cuando alguien carga o
cambia un encargo para hoy o para un día que ya tiene el recorrido armado, se les avisa a los de Logística.

## Las pestañas

- **Próximos días**: los próximos 8 días hábiles (y el sábado o domingo si tienen algo) con los lugares a los que va el
  recorrido, juntos por lugar como en la ruta del día: entregas, retiros, egresos y encargos, el chofer si ya está armado,
  y los encargos propios. «Sumar algo acá» abre un encargo para ese lugar y ese día. **Perfil Ventas**: lo de clientes que
  no son suyos dice solo «Un cliente» y la localidad (sirve para ver que «el jueves van a Vicente López», sin ver de quién
  es); si su encargo cae en esa parada, se ve con el nombre que le puso ella. Los proveedores e impresores, con su
  nombre. Como destino puede elegir sus empresas y los proveedores e impresores, no las de otras vendedoras.
- **Encargos**: los propios (Logística ve también «De todos»), por estado, con el remito de traslado. «Últimos 6 meses»
  muestra el historial.
- **Destinos**: la base de destinos, con cuántos viajes hubo a cada uno; se agregan y se corrigen. Para los
  administradores, abajo: el número del remito de traslado y traer el historial de la planilla.

## Quién lo pidió, con su foto

Pedido de Rodrigo del 17/11/2026: en cada encargo se ve **la foto y el nombre de quien lo pidió** (la foto de su cuenta
de Google; sin foto, sus iniciales). Antes era solo el nombre de pila, en texto.

- **Próximos días**: debajo de lo que lleva o retira, en cada encargo de la parada.
- **Encargos**: «Pidió …» con el nombre completo, también en «Los míos» (antes solo en «De todos»).
- **El encargo abierto**: «Lo pidió … hace 2 horas».
- **Cronograma, semana**: debajo del destino, en la tarjeta del carril «Encargos».
- **Cronograma, ruta del día**: «Encargo de …» en la parada.
- **App del chofer**: «Lo pidió …» en la parada, con la foto y el nombre de pila.

En el Hub es el componente `QuienPidio` (`web/src/components.tsx`): toma el usuario de `meta.users`; los encargos de la
planilla vieja que no tienen usuario muestran el nombre que traían, con sus iniciales. La app del chofer no tiene la
lista de usuarios: el servidor le manda la foto en cada encargo (`quien_foto`, de `SELECT_ENC` en `cronograma.ts`). Si
la foto no carga (sin señal), quedan las iniciales.

## En el Cronograma y la app del chofer

- **Semana**: un carril «Encargos» (verde) en cada día, con quién lo pidió (foto y nombre), qué se deja y qué se retira. Como las demás
  tarjetas: se arrastra a otro día (o el ícono de calendario), se le elige el **chofer** (pasa toda la parada de ese lugar
  al recorrido de ese chofer) y se marca hecho; un clic lo abre. Cuenta en los pendientes del día y en la barra de semanas.
- **Ruta del día**: el encargo va **en la parada del mismo lugar** si ese día ya se va ahí (el mismo destino de la
  libreta, la misma calle y altura, o la misma empresa o el mismo nombre si alguno no tiene altura: «IMPREFAS» de la
  libreta es el impresor IMPREFAS de ClickUp); si no, es una parada propia. Se ordena, se pasa de recorrido y se marca como
  cualquier parada; «Marcar hecho» marca también sus encargos. Dos sucursales de la misma empresa (o la misma calle y
  altura en dos localidades) son dos paradas.
- **App del chofer**: en la parada, «Dejar …» y «Retirar …» de cada encargo, dónde buscar lo que lleva si no está en el
  depósito, a quién preguntar, el horario y si es urgente. «Listo» lo deja hecho y «No se pudo» lo deja así con el motivo
  (se le avisa a quien lo pidió); «Deshacer» o «Para después» lo vuelven a como estaba, salvo que Logística lo haya
  cambiado después.

## Remito de traslado

El remito informal de la planilla («REMITO DE TRASLADO DE MERCADERÍA – No válido como factura»), con la marca de Formas:
en el encargo o en la lista, «Remito de traslado». La primera vez se le da el número siguiente (sigue el de la planilla:
el último usado fue el 0001-000098575; un administrador lo cambia en Destinos → Configuración, por ejemplo si la planilla
se siguió usando unos días). Se abre listo para imprimir: **una hoja A4 por remito** (pedido de Rodrigo del 16/11/2026); se
imprime dos veces, una copia queda en el destino y la firmada (firma, aclaración y DNI) vuelve a Formas. Los egresos del
Cronograma tienen el mismo remito (ver [CRONOGRAMA.md](CRONOGRAMA.md)). Si el encargo solo retira, sale como «Constancia de retiro».

## El historial de la planilla

Para que las sugerencias anden desde el primer día, un administrador trae el historial (Recorridos → Destinos →
Configuración → «Traer el historial»):

- Lee las pestañas de los últimos meses (6 por defecto) con la Sheets API, **como el usuario que lo pide** (la cuenta de
  servicio de `GOOGLE_SA_JSON` con el permiso de Drive de la delegación, el mismo de los bocetos): tiene que poder abrir
  la planilla. El id de la planilla está en `settings` → `recorridos.planilla_id`.
- Solo los días que ya pasaron. Quedan como historial (origen «planilla»): **no aparecen en el Cronograma** (de esos días
  ya está ClickUp) pero cuentan para «A donde más mandás» y para los días habituales de cada lugar.
- Las pestañas tienen filas copiadas de otros meses: no se duplican, y se puede volver a traer cuantas veces haga falta.
- Columnas por nombre (JULIO tiene otras); fechas como vengan («2/11/2026», «04-05-2026», «17/11», «21/072026»);
  ENTREGADO/RETIRADO → hecho, NO ENTREGADO → no se pudo, NO HABIA QUE IR → cancelado; PRIORIDAD ALTA → urgente;
  DESDE OFICINA → está en la oficina; el destino se ata a su lugar de la libreta por nombre (y dirección, si hay varios).
- **Quién lo pidió** (RESPONSABLE): se reconoce por el nombre de pila o el sobrenombre (Gonza, Agus, Mili, Ale…) y el
  apellido si hay más de uno. El resultado lista cada nombre con su usuario; si alguno quedó sin usuario, se elige y se
  vuelve a traer (queda guardado como alias).

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Tablas `encargos` y columnas nuevas de `lugares` (origen, editado, activo, empresa, clave de la planilla), avisos de encargos, configuración del remito | `migrations/0064_recorridos.sql` |
| Encargos, destinos, sugerencias, días del destino, agenda, remito e historial | `src/worker/recorridos.ts` |
| La copia de la libreta (merge), los encargos en la semana, en la ruta del día (`anfitrion`, `mismoSitio`) y en la app del chofer | `src/worker/cronograma.ts` |
| API `/api/recorridos/…` | `src/worker/api.ts` |
| Pantalla | `web/src/pages/Recorridos.tsx`; carril y tarjetas en `Cronograma.tsx`; paradas en `CronogramaRuta.tsx`; app del chofer en `web/chofer/src/Ruta.tsx` |
| Prueba de punta a punta (planilla, buscador de direcciones y Sheets API simulados) | `test/recorridos.test.mjs` |

API (todo con la sesión del Hub):

| Ruta | Qué |
|---|---|
| `GET /api/recorridos/agenda?desde&dias` | Los próximos días con sus lugares |
| `GET /api/recorridos/sugerencias` | Frecuentes y de tus pedidos, con próximos viajes y días habituales |
| `GET /api/recorridos/destinos?q` | Buscar en toda la base de destinos |
| `GET /api/recorridos/destino?lugar_id&company_id&nombre&direccion` | Los próximos días para ese destino |
| `GET/POST /api/recorridos/libreta`, `PATCH /api/recorridos/libreta/:id` | La base de destinos |
| `GET/POST /api/recorridos/encargos`, `GET/PATCH /api/recorridos/encargos/:id` | Los encargos (`estado`, `fecha`, renglones, etc.) |
| `POST /api/recorridos/encargos/:id/remito`, `GET …/remito` | Numerar e imprimir el remito de traslado |
| `GET/PUT /api/recorridos/config`, `POST /api/recorridos/historial` | Número del remito e historial (administradores) |
| `PUT /api/cronograma/chofer` con `ids: ["enc:<id>"]` | El chofer de un encargo (toda su parada) |

## Para revisar con datos reales

- **Los nombres de RESPONSABLE**: al traer el historial, revisar la lista de quién es quién (ALE NOMS, ALE. SALAS, ALE M,
  GONZA…).
- **El remito**: los datos de la empresa (CUIT no figura en la planilla; IIBB e inicio de actividades sí) y el número.
- **Calles numeradas** (La Plata, San Andrés: «Calle 23 y Diagonal 78»): para reconocer el lugar se toma la calle y la
  primera altura, así que dos lugares de la misma calle numerada sin altura pueden juntarse en una parada.

## Lo que sigue

- Encargos encadenados: retirar en un lugar y llevarlo directo a otro (pasó 14 veces en 6 meses; hoy va en las notas).
- Avisar al cliente por WhatsApp cuando sale el encargo.
- Sugerir la parada siguiente de un circuito («si va a Lavita, también pasa por Novatampo»: juntos 49 veces).
- Que Claude pueda cargar encargos desde el conector.

## Completar las direcciones con IA

Pedido de Rodrigo del 18/11/2026: muchos destinos de la libreta no tenían la localidad o la provincia, o no aparecían en
el mapa. En la pestaña **Destinos**, Logística (y quien edita el cronograma) tiene **«Completar direcciones con IA»**:

- Claude revisa los destinos a los que les falta la localidad, la provincia o el punto en el mapa (de a 15, hasta
  terminar; se puede frenar) y propone la dirección prolija (calle y altura), la localidad y la provincia, con cuán seguro
  está. **Nunca inventa** una calle ni una altura que no estén en los datos.
- **Solo se corrige lo que está al menos 90 % seguro.** Con Google Maps conectado, además Google tiene que ubicarlo en la
  misma altura, localidad y provincia; entonces su punto va al mapa de la ruta. Sin Google Maps, el punto se busca solo al
  abrir la ruta, como siempre.
- Lo demás queda **«Para revisar»** (con la sugerencia, el porcentaje y el motivo): en el destino, «Usar la sugerencia»
  la carga en el formulario para confirmarla o corregirla. Hay un filtro «Solo los N para revisar».
- Lo corregido dice **«Completado con IA»**, queda como corregido en el Hub (la copia de la planilla ya no lo pisa) y
  guarda cómo estaba: en el destino, «Volver a como estaba».
- Cada destino se revisa una vez; si alguien lo cambia, se vuelve a mirar la próxima vez.
- Los destinos ahora tienen **provincia** (se ve en la tabla y se carga en el formulario); la dirección completa que va
  al mapa y al chofer la incluye.

Código: `src/worker/destinosia.ts` (`POST /api/recorridos/libreta/ia`), migración `0078_destinos_ia.sql`, prueba
`test/destinos-ia.test.mjs`.

## La pestaña Destinos, rediseñada

Pedido de Rodrigo del 18/11/2026: que la pestaña esté enfocada en que los destinos estén bien.

**Cómo está armada la base** (`src/worker/destinos.ts`, migración `0079_destinos_rediseno.sql`), siguiendo lo que se usa
para este tipo de libretas de direcciones, para que esté completa pero se pueda mantener cuando crezca:

- **Empresa y sucursales por separado.** Cada destino es *una dirección*; los de una misma empresa (casa central,
  depósito, planta, otra sucursal) se juntan en un **grupo** (`destino_grupos`). Así no se duplica la empresa, y cada
  sucursal tiene su dirección, su horario y su contacto.
- **La dirección en partes**: calle y altura, localidad, provincia y código postal (no un solo texto), más el lugar de
  Google Maps (`place_id`) y el punto en el mapa (el mismo de la ruta del cronograma, `geocodigos`).
- **Un tipo por destino** (cliente, proveedor, impresor, taller, expreso, otro) y **de dónde salió** (`tipo_origen`): a
  mano, por la empresa del CRM y su «Tipo de relación», porque es un expreso del cronograma, por el nombre («imprenta»,
  «serigrafía», «transporte», «taller»…) o por la IA (≥ 90 %). Lo que se pone a mano no lo pisa nada.
- **Contacto por destino**: nombre, teléfono, WhatsApp (si es otro número que el teléfono) y mail.
- **Qué le falta a cada uno** (dirección, localidad, provincia, mapa, teléfono o WhatsApp, tipo) y el % de completos.
- Los ids no cambian nunca, los que se sacan quedan inactivos (los encargos viejos los siguen nombrando) y la copia de la
  planilla no pisa lo corregido en el Hub.

**La pantalla** (`web/src/pages/RecorridosDestinos.tsx`):

- Arriba, el estado de la base: cuántos destinos, % en el mapa, % completos, empresas con sucursales y cuántos quedaron
  «para revisar» de la IA (se tocan para filtrarlos).
- Filtros por tipo (con su color, el mismo de los puntos del mapa), «Solo incompletos» y buscador (nombre, calle,
  localidad, contacto, empresa).
- La tabla: destino (con su tipo y lo que le falta), **dirección, localidad y provincia en columnas separadas**, contacto
  con el botón **WhatsApp** (abre el chat con esa persona, con un saludo de Formas), teléfono y mail, y **viajes**: en los
  últimos 6 meses / en total, el último y si ya hay uno previsto («va el 21/11»). Los grupos se ven como una empresa con
  sus direcciones abajo (se pliegan).
- **Cada destino con su empresa del CRM** (pedido de Rodrigo del 18/11/2026): el Hub relaciona solo cada destino (y cada
  grupo) con la empresa del CRM que se llama igual, sin mirar lo que va entre paréntesis, la forma societaria ni palabras
  como «Depósito» o «Planta» («GADOR (DEPÓSITO)» y «Depósito Gador» son «Gador S.A.»). Si hay varias con ese nombre, gana
  la que es cliente; después, la que tiene dominio. Las direcciones de un grupo relacionado toman la empresa del grupo.
  En la lista se ve **el logo de la empresa** (el del dominio, como en el resto del Hub; sin dominio, las iniciales) y un
  link que la abre en el CRM; el destino sin empresa lleva un pin gris. Con la empresa relacionada, el tipo (cliente o
  proveedor) sale del CRM. Logística la elige, la cambia o la quita en «Editar» (del destino o de la empresa): lo hecho a
  mano no se vuelve a deducir (`empresa_origen`: `nombre`, `grupo` o `manual`; migración `0081_destinos_empresa.sql`,
  `vincularEmpresas` en `src/worker/destinos.ts`). La relación se busca cada vez que se abre la pestaña, así que una
  empresa nueva del CRM aparece sola.
- **De entrada, los 100 más visitados** (pedido de Rodrigo del 18/11/2026: con los 2.472 a la vez la pantalla se
  trababa). La tabla y el mapa muestran los 100 destinos (o empresas con sus sucursales) con más viajes; el buscador y
  los filtros buscan en toda la base, y «Ver todos» los trae completos (`TOPE` en `RecorridosDestinos.tsx`).
- **Empresa y destino suelto, al mismo nivel**: los dos arrancan en la misma línea y con el mismo peso. Las direcciones
  de una empresa cuelgan debajo con una línea que las une y un fondo apenas distinto, como los productos de un pedido.
  Las filas tienen más aire.
- **El mapa**: todos los destinos con un punto del color de su tipo. Al tocar una dirección, el mapa va a ese lugar y
  muestra la ficha con **«Ver en Google Maps»** (cada dirección tiene además su link «Maps» en la tabla), WhatsApp y
  Editar. Si no está ubicada, Logística la ubica a mano arrastrando el pin («Ubicar a mano» / «Corregir el punto»), y
  queda también para la ruta del cronograma. Las direcciones que nunca se buscaron se buscan solas, de fondo. En
  pantallas anchas el mapa queda al costado; en las demás, arriba.
- **Agrupar sucursales**: se eligen destinos en la tabla y «Agrupar como una empresa» (una nueva o sumar a una que ya
  está, con el tipo para todas). El Hub **sugiere** qué juntar (la misma empresa del CRM, o el mismo nombre como «ZECAT
  OFICINA» y «ZECAT (DEPÓSITO)»): «Agrupar» o «No son la misma». Al tocar el nombre del grupo se le cambia el nombre o el
  tipo, se saca una dirección o se deshace.
- **Editar un destino**: qué es (nombre, sucursal o sector, tipo, empresa), dirección (se puede elegir de **Google Maps**
  y el Hub completa localidad, provincia, CP y el punto), contacto y lo que necesita saber el chofer.

Quién puede: Logística, Producción y los administradores corrigen todo, agrupan y ubican en el mapa; los demás, los
destinos que cargaron ellos. Prueba: `test/destinos.test.mjs`.

## La primera corrida (18/11/2026)

Sobre los 2.471 destinos de la planilla DESTINOS, Claude revisó uno por uno y se cargó solo lo que pasó los controles
(migración `0080_destinos_primera_corrida.sql`, que se aplica sola al publicar; reconoce cada destino por su clave de la
planilla y no toca lo que ya se corrigió en el Hub):

- **Se carga** si Claude está al menos 90 % seguro y el mapa (OpenStreetMap, el mismo buscador del Hub) lo ubica en esa
  calle, localidad y provincia; o si está 80-89 % y el mapa lo encuentra en esa misma altura exacta (dos fuentes que
  coinciden); o con 95 % o más aunque el mapa no lo encuentre. Además: no puede aparecer una altura que no estaba en la
  planilla, la provincia tiene que coincidir con la zona y la calle tiene que ser la misma.
- Resultado: **1.160 destinos completados** (dirección prolija, localidad, provincia, CP si estaba y el punto en el mapa),
  **1.311 «Para revisar»** con la sugerencia y el motivo (sin altura, sin localidad, o que el mapa no confirmó), **627
  con tipo** (473 clientes, 68 expresos, 36 impresores, 24 proveedores, 17 talleres, 9 otros) y **259 empresas con sus
  sucursales agrupadas** (994 direcciones: YPF, Nestlé, Adare, Opessa, Puma, L'Oréal, Quilmes, Telefónica…).

## La segunda corrida (18/11/2026)

Sobre los 1.311 que quedaron «Para revisar» (migración `0083_destinos_segunda_corrida.sql`, que solo toca los que
siguen para revisar y nadie corrigió a mano):

- Se arreglaron dos defectos de los controles de la primera: «0988» y «988» son la misma altura, y un error de tipeo en
  la calle («Hulmbolt» → «Humboldt») no es otra calle.
- Se buscó cada uno de nuevo en el mapa con dos buscadores (Photon y Nominatim por partes): **335 confirmados**.
- Claude buscó en internet (sitio de la empresa, Google Maps, directorios) los que no tenían altura o localidad; se cargan
  solo con 90 % o más, con fuente, coherentes con la planilla y confirmados en el mapa: **16**. A otros **47** se les
  suma lo encontrado como sugerencia. La búsqueda en internet tuvo un tope y unos 290 no se llegaron a buscar.
- Resultado: **351 más cargados**; quedan **960 para revisar**.
- **Tercera pasada** (`0090_destinos_tercera_corrida.sql`): Claude buscó en internet los 289 que la segunda no llegó a
  buscar (de a 50 búsquedas por tanda). **10 más cargados** (Roche, Raffo, Puratos, Northlands, Provincia ART, Trafigura…),
  27 suman sugerencia y quedan **950 para revisar**. Unos 80 tampoco se llegaron a buscar esta vez (sobre todo estaciones
  YPF); la mayoría de lo que sí se buscó son comercios chicos, personas o domicilios que no aparecen en internet.

## Provincia y localidad, de un listado (18/11/2026)

Pedido de Rodrigo: que la provincia se elija de una lista y la localidad de la lista de esa provincia, y que las que ya
existen se adapten.

- **El listado** (`web/src/localidades.json`) sale de **Georef**, el servicio de normalización geográfica del Estado
  (apis.datos.gob.ar/georef): las 24 provincias, las localidades del BAHRA y, en Buenos Aires, también los partidos, más
  los nombres de uso que faltan en el AMBA (Don Torcuato, Nordelta, Boulogne…). En CABA la localidad es el **barrio** (los
  48) o «CABA» si no se sabe.
- **En el formulario**: la provincia es un desplegable y la localidad (o el barrio) se escribe y se elige de la lista de
  esa provincia; si no está en la lista se avisa, pero se puede guardar igual.
- **Normalización** (`normalizarUbicacion`, en `web/src/localidades.ts`, la usan la web y el servidor): sin tildes ni
  mayúsculas, con alias («Once» → Balvanera, «Pompeya» → Nueva Pompeya, «Pq Patricios», «Gral Pacheco»), errores de
  tipeo («Parlermo») y la provincia que sale de la localidad o de la zona de la planilla. Una zona escrita como localidad
  («NORTE») se saca. Lo que no se reconoce queda como estaba, prolijo.
- **Se aplica** a lo que entra (la copia diaria de la planilla, lo que se guarda a mano o de Google, lo de la IA) y, una
  sola vez, a toda la libreta (`normalizarLibreta`, en `destinos.ts`, al abrir Destinos; queda marcado en `settings`
  como `localidades_normalizadas`). Como el punto del mapa se guarda por la dirección completa, se copia a la dirección
  nueva; y lo que la IA ya revisó no vuelve a revisarse. Sobre la planilla real: de 2.061 filas con localidad, quedan
  fuera del listado unas 10 (siglas o lugares raros).
