# Perfiles: qué ve cada uno

Cada usuario tiene un **perfil** (su área) y un **permiso** (qué puede hacer con lo que ve). Se eligen en
Configuración → Usuarios.

| Perfil | Qué ve |
|---|---|
| Admin | Todo, incluida Configuración. |
| Comercial (Ventas) | Lo suyo; se puede ampliar a su equipo, a todo o a personas elegidas con [Qué ve](#qué-ve-pedido-de-rodrigo-del-20112026). |
| Producción | Lo suyo: pedidos, Producción, Entregas y Cronograma (ver abajo). Edita Producción. |
| Logística | Producción, Pedidos, Entregas, Recorridos y Cronograma (ver abajo). Revisa remitos y cierra entregas. |

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
- **Recorridos** ([RECORRIDOS.md](RECORRIDOS.md)): carga sus encargos y ve los suyos. En los próximos días ve a qué
  proveedores e impresores va el recorrido; lo de clientes que no son suyos dice solo «Un cliente» y la localidad.

No ve ni hace:

- La pantalla **Producción** ni la pantalla **Entregas** (la bandeja de Logística). De sus pedidos sí ve quién los tiene en
  Producción, el estado de cada producto y la fecha real, en la lista de Pedidos y en la ficha (pedido de Rodrigo del
  17/11/2026, [PEDIDOS.md](PEDIDOS.md#los-productos-de-cada-pedido-en-la-lista)).
- **Importar** ni **exportar** listas (cuida la base de clientes; si necesita una lista, se la baja un administrador).
- Abrir lo de otra vendedora: si lo busca, el buscador le muestra los **contactos y empresas** que ya existen con
  «Ya existe · es de Fulana» (solo el nombre y de quién es) para que no los cargue de nuevo; abrirlos le dice de quién es y
  que se lo pida a un administrador. Si intenta crear uno con el mismo mail o dominio, el aviso también dice de quién es.

Lo que crea queda a su nombre (también si lo crea con Claude).

## Qué ve (pedido de Rodrigo del 20/11/2026)

«Que se pueda elegir qué ve cada usuario: solo lo suyo, lo de todos o elegir de qué usuarios. Carmen debería poder ver lo
suyo, lo de Mili y lo de Sonia. Fijate cómo interactúa con el equipo.» Se elige en Configuración → Usuarios → **Qué ve**
(perfil Comercial; los administradores ven todo y Producción y Logística tienen su propia regla).

Está armado como lo resuelven los CRM grandes:

- **HubSpot**: cada usuario tiene un alcance para *ver* y otro para *editar* (todo, lo de su equipo o lo suyo, más la
  casilla de lo sin asignar). Si está en varios equipos, cuentan todos.
- **Salesforce y Zoho**: la base es privada (lo suyo); el jefe ve lo de su gente y las **reglas para compartir** suman
  acceso («lo de tal persona lo ve también tal otra», de solo lectura o editable). Solo suman, nunca restan.
- **Pipedrive**: grupos de visibilidad (lo del grupo lo ve el grupo; el grupo de arriba ve lo de abajo).

Acá, en la ventana «Qué ve» de cada vendedora:

| Opción | Qué ve |
|---|---|
| **Solo lo suyo** (lo de siempre) | Lo que tiene a su nombre, lo sin propietario y lo asociado a eso. |
| **Lo de su equipo** | Además, lo de quienes comparten alguno de sus equipos (columna Equipos, principal o extra). Si se suma alguien al equipo, lo ve solo. |
| **Lo de todos** | Todos los contactos, empresas, negocios y pedidos, con sus tareas. |
| **Y además, lo de estas personas** | Suma lo de las personas elegidas (las reglas para compartir de Salesforce). Con «Lo de todos» no hace falta. |

Carmen Donoso arranca con «Solo lo suyo» y, además, lo de Mili Formosa y Sonia Andersen (migración `0104_que_ve.sql`).

**Ver lo de otra persona** es ver sus registros como si fueran suyos: sus contactos, empresas, negocios y pedidos, lo
asociado a ellos y sus tareas (aunque no estén en ningún registro), en las listas, los tableros, el buscador, la bandeja de
conversaciones, Recorridos (sus entregas dicen el nombre del cliente) y Claude.

**Ver no es editar** (como las reglas de solo lectura de Salesforce): edita lo suyo y lo sin propietario, y la gerenta, lo de
su equipo. Lo de los demás lo mira: la ficha dice **«Solo para ver · es de Fulana»** y, si lo intenta cambiar, se le dice
que lo cambia la propietaria o un administrador. Anotar y crear tareas en lo que ve sí puede, como en lo asociado a lo suyo.

**Con el equipo:**

- **Gerencia** (el «jefe ve lo de su gente» de Salesforce): está en la misma ventana. La gerenta de un equipo ve y edita
  todo lo del equipo. Las personas del equipo que gerencia aparecen marcadas «Por la gerencia»; las de su equipo, si ve
  «Lo de su equipo», «Por su equipo».
- **Pipelines que ve** siguen encima, como los permisos por pipeline de HubSpot: un negocio de un pipeline que no ve no
  aparece aunque vea a su dueña. Si elegís a alguien que trabaja en un pipeline que ella no ve, la ventana lo avisa
  («de ahí verá sus contactos, empresas y pedidos, pero no sus negocios») y ofrece **Sumar esos pipelines** al guardar.
- **Inicio** sigue mostrando sus números (no los de las personas que ve); los del equipo son de Dirección.

Se controla en el servidor (`src/worker/alcance.ts`: `ve`, `ve_usuarios`, `vistos` y `duenosVistos`), así vale igual para la
pantalla, la API y Claude. Columnas `users.ve` ('suyo', 'equipo' o 'todos') y `users.ve_usuarios` (JSON con ids). Prueba:
`test/que-ve.test.mjs`.

### La tabla de Usuarios (misma fecha: «quedó raro, desfasado»)

La tabla desbordaba la pantalla y se corría toda la página de costado (el título quedaba «…guración»), y la columna de
pipelines tenía dos renglones, así que los desplegables de una fila no quedaban a la misma altura. Ahora: el usuario lleva
nombre y mail juntos y queda fijo a la izquierda; las columnas tienen ancho fijo (los textos largos se cortan con «…» y se
leen enteros al pasar el mouse) y entran en una pantalla de notebook; si no entran, se desplaza solo la tabla. Los
desplegables de varias opciones (`MultiPick`) flotan como los del DS, así no los corta la tabla. «Según sus equipos» y
«volver a según sus equipos» de los pipelines están dentro de su desplegable («· a mano» cuando están elegidos a mano), y
para Producción y Logística dice «No ven negocios». La Gerencia pasó a la ventana «Qué ve».

**Qué puede cambiar** (revisión de la versión celular, 18/11/2026; `soloLoSuyoVentas` en `api.ts`): solo lo suyo o lo que no
tiene propietario (para tomarlo), y como propietario se pone solo a sí misma (o lo deja sin). Que vea una empresa ajena
porque está asociada a lo suyo no la habilita a editarla ni a quedársela. Un contacto nuevo con el mail de una empresa de
otra vendedora queda sin empresa (antes se asociaba solo y la empresa le quedaba a la vista y a mano). Es la misma regla
que ya tenía Claude para todos. Prueba: `test/ventas-lo-suyo.test.mjs`.

## Perfil Producción (pedido de Rodrigo del 13/11/2026)

Producción trabaja con los pedidos, no con la parte comercial:

- **Pedidos**: todos. **Producción**, **Entregas** y **Cronograma**, como siempre.
- **Negocios**: ninguno (no los ve, no los busca, no los crea).
- **Contactos y empresas**: no tiene sus listas en el menú. Abre solo los que necesita para trabajar: los
  **proveedores e impresores** (tipo de relación «Proveedor») y los que están **en algún pedido** (el cliente y sus
  contactos). En la ficha del cliente no aparecen sus negocios.
- **Inicio**: sus tareas, sin los números de ventas. **Crear**: solo pedidos.
- **Tareas, actividad y conversaciones**: las suyas y las de lo que ve.

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

## Perfil Logística (pedido de Rodrigo del 16/11/2026)

Logística trabaja con lo de operaciones: **Producción**, **Pedidos**, **Entregas**, **Recorridos** y **Cronograma**. Para
el resto vale lo mismo que en el perfil Producción: pedidos, todos; negocios, ninguno; contactos y empresas, sin sus
listas en el menú, y solo los proveedores e impresores y los que están en algún pedido; Inicio con sus tareas, sin los
números de ventas; crear, solo pedidos. Lo que edita no cambia: revisa los remitos y cierra las entregas, arma el
cronograma y la ruta del día y organiza los encargos de Recorridos. La pantalla Producción la mira (la edita Producción).
En la barra lateral tiene además **Choferes** (el código de cada chofer para su app; pedido de Rodrigo del 16/11/2026),
que solo aparece en el perfil Logística: los administradores lo tienen en Entregas → Choferes.

Se controla en el mismo lugar (`src/worker/alcance.ts`, `esOperaciones`: Producción o Logística), también con Claude.
Prueba: `test/ventas.test.mjs`.

## Barra lateral y pantalla de inicio (pedido de Rodrigo del 16/11/2026)

La barra lateral va en grupos, cada uno con una línea sutil arriba (`App.tsx`):

- arriba, sin título: Inicio, Tareas y Conversaciones;
- **CRM**: Contactos, Empresas, Negocios y Pedidos (Producción y Logística ven solo Pedidos);
- **Operaciones**, en el orden del trabajo: Producción, Cronograma, Recorridos y Entregas, Choferes en el perfil
  Logística y, al final, Notas de productos. El perfil Ventas ve Recorridos y Notas de productos.

Al abrir el Hub, el perfil **Producción** arranca en **Producción** y el perfil **Logística** en el **Cronograma**
(`PANTALLA_INICIAL`); los demás, en Inicio. Es solo al abrirlo: «Inicio» sigue llevando a Inicio.

### Pendiente / a revisar

- Si alguien menciona a una vendedora en la conversación de un pedido que no es suyo, ella no lo ve (ni en la bandeja).
