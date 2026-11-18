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
- En las hojas, los campos de lista corta (canal de contacto, motivo de pérdida…) se eligen con botones.
- Menú del avatar: Tareas, Recorridos, Contactos, Pedidos, Notas de productos, tema, versión completa y cerrar sesión.

## Fases

1. **Hecha**: el esqueleto, Hoy y Recorridos.
2. **Hecha**: Clientes (lista, ficha y alta corta).
3. **Hecha**: Ventas (negocios por etapa, alta y cambio de etapa; pedidos para consultar y conversar).
4. Tareas y Chat a medida.

Mientras tanto, Tareas y Chat abren las pantallas de siempre dentro del esqueleto del celular.

## Código

`web/src/movil/`: `Movil.tsx` (esqueleto, `useModoMovil`, hojas, ＋, tarea rápida), `Hoy.tsx`, `RecorridosMovil.tsx`,
`ClientesMovil.tsx`, `VentasMovil.tsx` y `movil.css`. `App.tsx` elige cuál dibujar. Los modales del escritorio ocupan toda la pantalla con `body.movil`.
