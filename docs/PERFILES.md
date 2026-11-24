# Perfiles: qué ve cada uno

Cada usuario tiene uno o más **perfiles** (su área; el primero es el principal) y un **permiso** (qué puede hacer con lo que
ve). Se eligen en Configuración → Usuarios.

| Perfil | Qué ve |
|---|---|
| Admin | Todo, incluida Configuración. Va solo. |
| Comercial (Ventas) | Lo suyo; se puede ampliar a todo o a personas elegidas con [Qué ve](#qué-ve-back-office-y-varios-perfiles-pedidos-de-rodrigo-del-20112026) (solo para ver). |
| Back office | Lo mismo, y lo de las personas que atiende lo ve **y lo edita**: les asigna, carga a su nombre y pide encargos por ellas. |
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

## Qué ve, Back office y varios perfiles (pedidos de Rodrigo del 20/11/2026)

Primero: «que se pueda elegir qué ve cada usuario: solo lo suyo, lo de todos o elegir de qué usuarios; Carmen debería
poder ver lo suyo, lo de Mili y lo de Sonia». Después: «lo que quiero es que Carmen pueda ver y editar lo suyo, lo de Mili
y lo de Sonia, y asignarles ventas o pedir en nombre de ellas, ya que es su back office. Hacer un perfil de back office y
poder tener más de un perfil: Carmen tendría back office y ventas. Y elegir lo de quiénes puede ver además de lo suyo,
por usuario».

Cómo lo resuelven los CRM grandes, y qué tomamos:

- **HubSpot**: ver y editar por separado (todo, lo del equipo o lo suyo). Acá: «Qué ve» y «Qué edita» en la misma ventana.
- **Salesforce y Zoho**: la base es lo suyo y las **reglas para compartir** suman acceso, de solo lectura o editable («lo de
  tal persona lo ve también tal otra»). Acá, por usuario: sin Back office es de solo lectura; con Back office, editable.
- **Pipedrive / Salesforce**: un usuario con varios roles o grupos. Acá, varios perfiles.

### Varios perfiles

En la columna **Perfiles**, una lista como la de Equipos: el primero es el **principal** (con ese arranca el Hub y elige la
versión celular). Admin va solo (elegirlo saca los demás). Los perfiles son de dos lados: **comercial** (Comercial y Back
office) y **operaciones** (Producción y Logística). Comercial + Back office (Carmen) es lo de siempre de Ventas más lo de
las personas que atiende. Quien tiene perfiles de los dos lados (por ejemplo, Comercial y Producción) tiene las pantallas de
los dos y ve la suma: todos los pedidos (por Producción) y sus negocios (por Comercial); los negocios de otras, no.

Columna `users.perfiles` (JSON, el primero el principal). `profile` queda por compatibilidad y por su CHECK de la base, que
no conoce Back office: guarda el principal, con Back office como `comercial` (su mismo lado). En el código, `perfilesDe`,
`tienePerfil`, `ladoComercial` y `ladoOperaciones` (`alcance.ts`) y `conPerfilSql` para las consultas. Las reglas que
cierran pantallas (`esVentas`, `esOperaciones`) valen para quien tiene un solo lado.

### Qué ve (ventana «Qué ve y edita», perfiles Comercial y Back office)

| Opción | Qué ve |
|---|---|
| **Lo suyo** (lo de siempre) | Lo que tiene a su nombre, lo sin propietario y lo asociado a eso. |
| **Lo de todos** | Todos los contactos, empresas, negocios y pedidos, con sus tareas (lo de los demás, sin editarlo). |
| **Personas elegidas** (de a una) | Suma lo de esas personas: sus registros, lo asociado a ellos y sus tareas. |

Sin el perfil Back office, lo de las personas elegidas es **solo para ver**: la ficha dice «Solo para ver · es de Fulana» y
cambiarlo rebota. Ya no está la opción «Lo de su equipo» de la primera versión: se elige por usuario.

### Back office

Con el perfil **Back office**, las personas elegidas son las que atiende (en la ventana: «Back office de estas personas»).
Lo de ellas lo trata como suyo:

- **Ve y edita** sus contactos, empresas, negocios y pedidos (la ficha no dice «Solo para ver»).
- **Asigna**: como propietario puede ponerse a ella o a cualquiera de las personas que atiende (el desplegable de
  propietario solo ofrece esas); pasárselo a otra persona sigue siendo de un administrador.
- **Carga a su nombre**: crea empresas, contactos, negocios y pedidos con una de ellas de propietaria. Una vendedora sin
  back office crea solo a su nombre (antes la API no lo controlaba al crear).
- **Pide en su nombre** en Recorridos: «Lo pide» al cargar un encargo. Queda como si lo hubiera pedido ella (lo ve en sus
  encargos y le llega el aviso); el back office lo ve y lo cambia. Logística puede cargar a nombre de cualquiera.
- **Inicio**: elige «Mis números» o «Los de Mili», etc.
- **Claude**: lo mismo (`list_users` dice a quiénes atiende).

Carmen Donoso arranca con Comercial + Back office de Mili Formosa y Sonia Andersen (migración `0106_que_ve.sql`).

### Con el equipo

- **Gerencia** (en la misma ventana): la gerenta de un equipo ve y edita todo lo del equipo y lo asigna a cualquiera del
  equipo. Las personas del equipo que gerencia aparecen marcadas «Por la gerencia».
- **Pipelines que ve** siguen encima: un negocio de un pipeline que no ve no aparece aunque vea (o atienda) a su dueña. Si
  elegís a alguien que trabaja en un pipeline que ella no ve, la ventana avisa y ofrece **Sumar esos pipelines** al guardar.

Se controla en el servidor (`src/worker/alcance.ts`: `vistos` para ver, `propios` para editar y asignar, `atiende`,
`esSuyo`, `esDeSuEquipo`), así vale igual para la pantalla, la API y Claude. Columnas `users.ve` ('suyo' o 'todos'),
`users.ve_usuarios` (JSON con ids) y `users.perfiles`. Prueba: `test/que-ve.test.mjs`.

### Pendiente

- En la versión celular de Recorridos todavía no está «Lo pide» (sí en la de escritorio).

### La tabla de Usuarios (misma fecha: «quedó raro, desfasado»)

La tabla desbordaba la pantalla y se corría toda la página de costado (el título quedaba «…guración»), y la columna de
pipelines tenía dos renglones, así que los desplegables de una fila no quedaban a la misma altura. Ahora: el usuario lleva
nombre y mail juntos y queda fijo a la izquierda; las columnas tienen ancho fijo (los textos largos se cortan con «…» y se
leen enteros al pasar el mouse) y entran en una pantalla de notebook; si no entran, se desplaza solo la tabla. Los
desplegables de varias opciones (`MultiPick`) flotan como los del DS, así no los corta la tabla. «Según sus equipos» y
«volver a según sus equipos» de los pipelines están dentro de su desplegable («· a mano» cuando están elegidos a mano), y
para Producción y Logística dice «No ven negocios». La Gerencia pasó a la ventana «Qué ve y edita». La columna Perfiles admite
varios («Comercial + Back office»).

**Qué puede cambiar** (revisión de la versión celular, 18/11/2026; `soloLoSuyoVentas` en `api.ts`): solo lo suyo o lo que no
tiene propietario (para tomarlo), y como propietario se pone solo a sí misma (o lo deja sin); el back office, también lo de
las personas que atiende, y se lo puede asignar a ellas. Que vea una empresa ajena
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
