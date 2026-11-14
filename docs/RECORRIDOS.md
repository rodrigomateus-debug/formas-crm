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

«Nuevo encargo», en tres pasos:

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

## En el Cronograma y la app del chofer

- **Semana**: un carril «Encargos» (verde) en cada día, con quién lo pidió, qué se deja y qué se retira. Como las demás
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
se siguió usando unos días). Se abre listo para imprimir: **dos copias en una hoja A4**, una queda en el destino y la
firmada (firma, aclaración y DNI) vuelve a Formas. Si el encargo solo retira, sale como «Constancia de retiro».

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
