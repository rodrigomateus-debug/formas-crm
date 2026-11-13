# Perfiles: qué ve cada uno

Cada usuario tiene un **perfil** (su área) y un **permiso** (qué puede hacer con lo que ve). Se eligen en
Configuración → Usuarios.

| Perfil | Qué ve |
|---|---|
| Admin | Todo, incluida Configuración. |
| Comercial (Ventas) | Lo suyo (ver abajo). |
| Producción | Lo suyo: pedidos, Producción, Entregas y Cronograma (ver abajo). Edita Producción. |
| Logística | Por ahora, todo. Revisa remitos y cierra entregas. |

Permisos (para los que no son Admin): **Edita** crea y edita; **Edita y borra** además borra y restaura; **Solo mira** no
cambia nada.

## Perfil Ventas (pedido de Rodrigo del 12/11/2026)

Una vendedora (perfil Comercial que no es administradora) ve:

- **Contactos, empresas, negocios y pedidos**:
  - lo suyo (es la propietaria);
  - lo que no tiene propietario, para poder tomarlo (leads de Darwin, LinkedIn, formularios); al ponerse como
    propietaria, queda suyo;
  - lo asociado a lo suyo: la empresa y los contactos de sus negocios, los contactos de sus empresas, los pedidos de sus
    negocios.
  - Un negocio de otra vendedora **no** se ve nunca, aunque sea de una empresa que ella ve: en la ficha de esa empresa
    aparecen solo sus negocios.
  - Encima de esto siguen valiendo los pipelines por equipo (Configuración → Pipelines → Quién lo ve).
- **Tareas, actividad y conversaciones**: las suyas y las de los registros que ve (aunque las haya cargado otra persona).
  En la ficha de una empresa no se suma la actividad de los negocios que no son suyos.
- **Saldo y deuda del cliente** (Finnegans), en la empresa y en el pedido.
- **Remitos de sus pedidos**: la tarjeta «Entrega» del pedido (qué se entregó y qué falta) y cada remito para ver o
  descargar, para mandárselo al cliente si tiene una duda. Cargarlos, revisarlos, asignarlos y cerrar la entrega es de
  Logística.
- **Inicio**: sus números; no el ranking «Ganado por vendedora» ni los números de otras.

No ve ni hace:

- **Producción** (tampoco quién tiene el pedido en producción) ni la pantalla **Entregas** (la bandeja de Logística).
- **Importar** ni **exportar** listas (cuida la base de clientes; si necesita una lista, se la baja un administrador).
- Abrir lo de otra vendedora: si lo busca, el buscador le muestra los **contactos y empresas** que ya existen con
  «Ya existe · es de Fulana» (solo el nombre y de quién es) para que no los cargue de nuevo; abrirlos le dice de quién es y
  que se lo pida a un administrador. Si intenta crear uno con el mismo mail o dominio, el aviso también dice de quién es.

Lo que crea queda a su nombre (también si lo crea con Claude).

## Perfil Producción (pedido de Rodrigo del 13/11/2026)

Producción trabaja con los pedidos, no con la parte comercial:

- **Pedidos**: todos. **Producción**, **Entregas** y **Cronograma**, como siempre.
- **Negocios**: ninguno (no los ve, no los busca, no los crea).
- **Contactos y empresas**: no tiene sus listas en el menú. Abre solo los que necesita para trabajar: los
  **proveedores e impresores** (tipo de relación «Proveedor») y los que están **en algún pedido** (el cliente y sus
  contactos). En la ficha del cliente no aparecen sus negocios.
- **Inicio**: sus tareas, sin los números de ventas. **Crear**: solo pedidos.
- **Tareas, actividad y conversaciones**: las suyas y las de lo que ve.
- **Bocetos, logos, direcciones y fechas de entrega**: los sube y los cambia en el pedido (productos, «Entrega», la ficha,
  la pantalla Producción y la parada del Cronograma). Lo que cambia le llega al vendedor (ver abajo, «Avisos de cambios»).

Se controla en el mismo lugar que Ventas (`src/worker/alcance.ts`, `esProduccion`), también con Claude.

### Dónde se controla

Todo en el servidor, en `src/worker/alcance.ts`, así vale igual para la pantalla, la API, **Claude por MCP** y lo que
venga después:

- las búsquedas, listas, tableros y «Seleccionar los N» (`buildWhere` en `records.ts`);
- cualquier ruta de un registro (`/api/records/<tipo>/<id>/…`: ficha, historial, actividad, conversación, archivos,
  bocetos, productos, datos para facturar, cambios, clonar, combinar, restaurar), las asociaciones, las acciones masivas y
  las actividades (`api.ts`);
- la bandeja de conversaciones, la cola de tareas y la línea de tiempo;
- con Claude: las herramientas reciben solo ids que la vendedora ve; el alta inteligente (`upsert_bundle`) no está, porque
  completa registros existentes de cualquiera (se busca con `search_records` y se crea con `create_record`);
- la API compatible con HubSpot (la de los tableros) no acepta tokens de una vendedora.

La pantalla solo esconde lo que no va a poder abrir (menú, botones, tarjetas). Para revisar cómo lo ve una vendedora, un
superadmin usa «Ver como» (Configuración → Usuarios, el ojito).

Pruebas: `test/ventas.test.mjs`.

## Pedidos compartidos y avisos de cambios (pedido de Rodrigo del 13/11/2026)

### Compartir un pedido

El propietario de un pedido es uno solo (la vendedora), pero se puede **compartir con más personas** para que lo vean y
lo trabajen, por ejemplo con su backoffice. Botón **«Compartir»** en la ficha del pedido (abajo del nombre) y en la vista
previa (renglón «Compartido»): se eligen las personas y se guarda. Con quien se comparte:

- lo ve aunque tenga el perfil Ventas, con el cliente y sus contactos, como si fuera suyo (no el negocio);
- le aparece en **«Míos»** de Pedidos (el filtro «Propietario: yo» de pedidos incluye los compartidos);
- sigue la conversación del pedido y le llegan los avisos de cambios, igual que al propietario;
- le llega un aviso «te compartió el pedido» (campanita y mail).

Lo comparte cualquiera que puede editar el pedido. Queda en la conversación y en el historial («compartió el pedido con…»,
«dejó de compartirlo con…»). Si una vendedora abre un pedido que no ve, el aviso le dice que se lo pida a la dueña.
Hecho en `src/worker/compartidos.ts` (tabla `compartidos`, migración 0052), `alcance.ts` (qué ve) y `web/src/Compartir.tsx`.
Por ahora solo pedidos; si hace falta, los negocios usarían lo mismo.

### Avisos de cambios al vendedor

Cuando **otra persona** cambia algo sensible de un pedido, al propietario y a quienes lo tienen compartido les llega a la
campanita y, si tienen «Avisos por mail» prendido, por mail («Ceci cambió PDV 31277: Subió el boceto «…» de Taza térmica ·
Cambió la dirección de entrega a «…»»). Lo que avisa (`src/worker/cambios.ts`):

| Qué | Dónde se cambia |
|---|---|
| Boceto subido, aprobado o vuelto a «para aprobar», pasado a otro producto, marcado técnico o referencia, quitado | Productos del pedido, visor del boceto |
| Logo subido o elegido para un producto, logo principal cambiado o quitado (en la empresa: a su propietaria) | Productos del pedido, Empresa → Logos |
| Dirección de entrega (y cuánto va a cada una, con varias) | Tarjeta «Entrega», parada del Cronograma |
| Fecha de entrega | Ficha del pedido; en Producción, «Entrega» del PDV o de un artículo |
| Etapa del pedido movida a mano | Ficha, tablero de pedidos |

No avisa a quien hizo el cambio, ni lo que trae la sincronización de ClickUp o Finnegans (solo personas: pantalla, Claude
o la API con el token de alguien). Los cambios seguidos de la misma persona en el mismo pedido (15 minutos, mientras no se
leyó ni salió el mail) van juntos en un solo aviso, para no llenar la campanita al subir varios bocetos. También en los
negocios (a su propietario), por ejemplo un boceto que sube otra persona.

Pruebas: `test/cambios.test.mjs` (y la fecha de Producción en `test/produccion.test.mjs`).

### Pendiente / a revisar

- Si alguien menciona a una vendedora en la conversación de un pedido que no es suyo, ella no lo ve (ni en la bandeja):
  hay que compartírselo («Compartir» en el pedido).
- Logística sigue viendo todo; cuando se defina, va en el mismo `alcance.ts`.
