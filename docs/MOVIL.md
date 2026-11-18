# Versión celular

Pedido de Rodrigo del 18/11/2026. En el celular, el perfil **Ventas** no ve el CRM de escritorio achicado sino una app
simple, con lo esencial para cargar desde la calle. Misma dirección, mismo login y la misma API: no hay nada nuevo del
lado del servidor.

## Cuándo aparece

- Pantalla angosta (hasta 760 px) **y** perfil Ventas (`esVentas`). Los demás perfiles siguen con la versión de siempre,
  que se adapta sola a la pantalla chica.
- Desde el avatar → **Ver versión completa** se pasa a la de siempre; queda recordado en ese navegador
  (`crm-version-completa`). Para volver, el botón **Versión celular** arriba.
- Se puede instalar en la pantalla de inicio («Agregar a inicio»): `web/public/hub.webmanifest` y los íconos `hub-*.png`.

## Pantallas

Barra abajo: **Hoy · Clientes · ＋ · Ventas · Chat**. Arriba, el avatar (menú), el buscador y la campanita.

- **Hoy** (arranque): tareas de hoy y vencidas (se tildan o se pasan +1 día ahí mismo), los encargos al recorrido de los
  próximos 14 días y los negocios sin movimiento hace más de 14 días.
- **＋**: Encargo al recorrido, Tarea (qué y cuándo, en dos toques), Negocio, Empresa y Contacto.
- **Recorridos**: «Nuevo encargo» y la lista de los suyos. El encargo es un asistente a pantalla completa, un paso por
  pantalla (¿A dónde? → ¿Qué día? → ¿Qué hay que hacer?), con las mismas piezas que el de escritorio: las sugerencias,
  el «Ya van» y los días habituales son los mismos. Horario, a quién preguntar y de dónde sale van en «Más datos».
- **Clientes**: Empresas | Contactos, con buscador y «Míos / Todos los que veo» (solo clientes y prospectos, ordenados
  por última actividad). Cada tarjeta trae los botones de WhatsApp y Llamar.
- **Ficha de empresa o contacto**: arriba **Llamar · WhatsApp · Mail · Cómo llegar** (si al contacto le falta el teléfono
  o la dirección, se usan los de su empresa); después **Registrar** (nota, llamada con cómo salió, WhatsApp, reunión o
  mail), **Tarea** (queda atada al cliente) y **Encargo** (el asistente arranca con la empresa como destino, en el día).
  Los datos principales (los mismos que eligió el administrador para la ficha) se tocan para editarlos; «Ver todos los
  datos cargados» muestra el resto. Abajo: contactos de la empresa (con «Agregar»), negocios, pedidos y la actividad.
- **Alta corta** (desde ＋, la lista o la ficha): empresa con nombre, sitio, teléfono, dirección y ciudad; contacto con
  nombre, apellido, celular, mail, cargo y empresa. Siempre se piden también los campos obligatorios que tenga
  configurados el CRM (hoy, el «Canal de contacto» de los contactos). Queda a nombre de quien lo carga.
- **Ventas → Negocios**: los suyos del pipeline (si ve varios, se elige arriba), por etapa en una fila de botones
  (Abiertos, cada etapa, Cerrados), con cuántos son y cuánto suman. La ficha muestra el monto y la etapa con su barra de
  avance; tocando la etapa se elige otra de la lista, y si la etapa pide algo (el monto para «Envío de cotización», el
  motivo para «Cierre perdido», lo que configure el pipeline) se pide ahí mismo. Pestañas Resumen (Registrar, Tarea, el
  cliente con WhatsApp y Llamar, los datos principales del pipeline, editables, los pedidos y la actividad) y
  Conversación (la del equipo, con menciones y archivos).
- **Alta de negocio** (＋, la lista o la ficha de una empresa o contacto): nombre, empresa, monto, cantidad, producto y
  etapa (las que el pipeline deja usar para crear), más lo que pida esa etapa. Si el pipeline exige empresa, no deja
  crearlo sin una.
- **Ventas → Pedidos**: solo para consultar (no se crean desde el celular). Lista con buscador, «Míos / Todos los que
  veo», el estado de cada uno y los mensajes sin leer. La ficha abre en **Conversación** (comentar, avisar con @, subir
  archivos y fotos desde el teléfono) y **Detalle**: «Encargo para este pedido» (con la empresa como destino), artículos con
  su estado de producción, la entrega, los **logos de la empresa** (se suben desde ahí), factura y remitos, contactos y
  negocio.
- **Tareas** (menú del avatar o «Todas las tareas» en Hoy): Hoy (las vencidas aparte, arriba) · Próximas (por día) ·
  Hechas. Se tildan (con «Deshacer») y se pasan un día con un toque; al tocar una se abre el panel de siempre (estado,
  responsable, colaboradores, vencimiento, relacionada con, descripción, pasos y comentarios), a pantalla completa. Las
  tareas de Hoy también se abren así.
- **Chat**: la bandeja de las conversaciones que sigue, Sin leer (si hay) · Todas, con el último mensaje, quién lo
  escribió, las menciones y cuántos sin leer. Cada conversación se abre a pantalla completa (sin las barras), queda leída
  al abrirla, el nombre arriba lleva a la ficha y el ojito la deja «no leída» para retomarla. En el celular, la ayuda del
  cuadro de escribir no nombra el Ctrl+V.
- En las hojas, los campos de lista corta (canal de contacto, motivo de pérdida…) se eligen con botones.
- Menú del avatar: Tareas, Recorridos, Contactos, Pedidos, Notas de productos, tema, versión completa y cerrar sesión.

## Fases

1. **Hecha**: el esqueleto, Hoy y Recorridos.
2. **Hecha**: Clientes (lista, ficha y alta corta).
3. **Hecha**: Ventas (negocios por etapa, alta y cambio de etapa; pedidos para consultar y conversar).
4. **Hecha**: Tareas y Chat.

Lo que no está en el celular (tableros, vistas, edición masiva, analíticas, configuración, la ficha completa) se abre con
«Ver versión completa».

## Código

`web/src/movil/`: `Movil.tsx` (esqueleto, `useModoMovil`, hojas, ＋, tarea rápida), `Hoy.tsx`, `RecorridosMovil.tsx`,
`ClientesMovil.tsx`, `VentasMovil.tsx`, `TareasChatMovil.tsx` y `movil.css`. `App.tsx` elige cuál dibujar. Los modales del escritorio ocupan toda la pantalla con `body.movil`.

## Revisión del 18/11/2026

Tres revisores (uso en la calle, robustez en el teléfono y reglas/permisos/accesibilidad) criticaron las cuatro fases.
Lo que se cambió:

- **Permisos (servidor, también en el escritorio)**: Ventas cambia solo lo suyo o lo sin dueño y no se lo pasa a otra
  persona; un contacto nuevo no se asocia a la empresa de otra vendedora ([PERFILES.md](PERFILES.md)).
- **Carga**: `Raiz.tsx` baja solo la versión que corresponde (el celular no carga el escritorio) y `movil.css` queda
  después de `styles.css`, así sus reglas ganan. Girar el teléfono no pasa a la de escritorio (`modo.ts`).
- **Errores**: sin señal o con la sesión vencida se dice («Sin conexión…», «Reintentar»), nunca «no hay nada»
  (`useCarga` y `Fallo` en `base.tsx`; `http()` en `lib.tsx`). Al volver a la app después de 5 minutos o de otro día, lo
  que está a la vista se recarga. Las respuestas viejas se descartan.
- **Navegación**: las fichas tienen flecha para volver; «Volver» y «Salir» sin historial (un link de un mail, la app
  recién abierta) van a la lista en vez de dejar la pantalla en blanco; las hojas y el panel de una tarea se cierran con el
  botón Atrás del teléfono; la búsqueda y los filtros de las listas quedan en la dirección. `/tasks?tarea=…` abre la
  tarea y `…?conversacion=1&mensaje=…` abre la conversación en el mensaje. Lo que no tiene pantalla en el celular dice
  «Esto se ve en la versión completa».
- **Teclado**: la app y las hojas miden lo que se ve (`visualViewport`), la barra de abajo se esconde mientras se
  escribe, y la conversación de un pedido o negocio se abre a pantalla completa (en la ficha, con el teclado, no se veía).
- **Reglas en pantalla**: pipelines que puede ver (no solo donde ya tenía negocios); el encargo desde un pedido queda
  atado al pedido; «Solo mira» y «Ver como» no ven botones para cargar, y «Ver como» tiene cartel y vuelta; los
  resultados de una llamada son los del sistema y no viene ninguno elegido; los obligatorios (y lo que exige la etapa) no
  se pueden vaciar; el propietario no se edita (lo sin dueño se toma con «Tomarlo»); el alta avisa si ya existe (también
  si es de otra vendedora); un negocio desde un contacto queda asociado al contacto; el cambio a una etapa perdida pide
  también el detalle; el monto acepta puntos de miles; Negocios tiene «Sin dueño».
- **Uso**: al volver de llamar o escribir por WhatsApp desde el CRM, pregunta «¿Cómo salió?»; «Visita» como tipo; Hoy en
  orden de urgencia (Tareas, Te escribieron, Entregas de la semana, Encargos, Negocios sin movimiento); las tareas dicen
  «10:00 · Cliente» o «Vencida ayer»; el círculo para tildar se toca en 44×44; las fichas muestran primero contactos,
  pedidos y negocios y pliegan los datos vacíos; un solo buscador por pantalla; factura y remito se abren dentro de la
  app (con «Compartir»); el encargo no abre el teclado sobre las sugerencias ni repite destinos.
- **Accesibilidad**: las hojas son diálogos modales (foco adentro, Tab no se escapa, vuelve al cerrar); lo elegido se
  ve lleno con el color de acento (también en oscuro); las acciones sin dato dicen por qué («Sin teléfono»).
- **Ícono**: «Hub» con el moño de Formas arriba y la barra verde de la marca (`web/public/hub-*.png`); el manifiesto ya no
  fija la orientación.

Pendiente: el código compartido con el escritorio todavía pesa (~890 KB en total para el celular, antes 1,1 MB); la
fecha de cierre y el origen del negocio no están en el alta corta.

