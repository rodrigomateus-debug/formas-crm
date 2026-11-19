# Perfiles: qué ve cada uno

Cada usuario tiene un **perfil** (su área) y un **permiso** (qué puede hacer con lo que ve). Se eligen en
Configuración → Usuarios.

| Perfil | Qué ve |
|---|---|
| Admin | Todo, incluida Configuración. |
| Comercial (Ventas) | Lo suyo (ver abajo). |
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
- **Importar** ni **exportar** listas, no (auditoría del 19/11/2026: importar creaba negocios y completaba contactos sin pasar
  por el alcance del perfil). Vale igual para Logística.

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

Con permiso **Solo mira**, Logística ve la lista de Choferes pero no crea ni da de baja links, no ve los links ni los
códigos (sirven para mandar remitos), no cambia el tipo de un remito ni finaliza entregas (`puedeFinalizar` en
`src/worker/remitos.ts`).

Se controla en el mismo lugar (`src/worker/alcance.ts`, `esOperaciones`: Producción o Logística), también con Claude.
Prueba: `test/ventas.test.mjs`.

## Auditoría del 19/11/2026: lo que se cerró

Cuatro agentes (dos de Fable y dos de Opus) auditaron los perfiles y reprodujeron estos casos; ahora los cubre
`test/auditoria.test.mjs`:

- **El id de un registro tiene que ser un número tal cual.** `/records/deal/123.0`, `+123`, `%20123` o `0x7b` llegaban a la
  ficha (Number() los acepta) sin pasar por la revisión del alcance, que buscaba solo dígitos: Ventas, Producción y
  Logística abrían, copiaban o archivaban cualquier registro. Ahora contestan 400 (`RUTA_REGISTRO` en `api.ts`).
- **Ventas borra, restaura, combina y clona solo lo suyo** (o lo sin propietario), como ya pasaba al editar: ver una
  empresa ajena porque está asociada a lo suyo no la habilita a borrarla ni a combinarla con la suya (`soloLoSuyoVentas`).
  Tampoco crea registros a nombre de otra vendedora. Un registro combinado no se restaura (quedaba duplicado).
- **«Ver como» no escribe por ninguna entrada**: la API compatible con HubSpot y «Conectar con Claude» también
  (antes solo `/api`). Se rechaza en `verComo` (`src/worker/auth.ts`).
- **Con Claude, `resumen_reunion` solo en reuniones propias** (como `update_activity`): con el id de cualquier reunión se
  pisaba su resumen y se leían el asunto y la fecha.
- **Login**: «volver» solo a una página del Hub (`/\otro.com` el navegador lo toma como otro sitio).
- **Formulario público** (`/hooks/form/<nombre>`): el visitante carga solo datos de contacto (no el propietario, el tipo de
  relación ni el estado del lead) y la vuelta es solo a sitios de Formas o a los del formulario (README).

Segunda tanda:

- **El token de «Conectar con Claude» sirve solo en `/mcp`** (`entradaDelToken` en `src/worker/auth.ts`): lo saca
  cualquier usuario para sí mismo, y antes abría también `/api` y `/hooks` (con `/hooks/bundle` una vendedora se hacía
  visibles clientes ajenos). El del webhook de Darwin (de un administrador, viaja en la dirección) sirve solo en
  `/hooks/darwin`. Los que crea un administrador en Configuración → Integraciones siguen sirviendo donde se usan. El token
  en la dirección (`?token=`) se acepta solo en `/hooks`.
- **Ventas cambia y borra solo sus notas, mails y tareas** (las que tiene asignadas, cargó o colabora; la gerenta, las de su
  equipo), aunque vea las de otra en un registro que ve (`actividadSuyaVentas`).
- **Filtros por datos de un asociado** («negocio.monto > X» en empresas): solo entre los asociados que ve quien busca.
- **El administrador principal** (ADMIN_EMAIL) no se desactiva ni deja de ser administrador. Un cambio de usuario que
  rebota no deja nada guardado a medias.
- **CSV exportado** sin fórmulas (un texto que empieza con `=`, `+`, `-` o `@` va con apóstrofo).
- **Cabeceras de seguridad** en la pantalla (`web/public/_headers`): `nosniff`, `X-Frame-Options`, `Referrer-Policy`.
- **Choferes**: pasado el tope general de intentos con códigos errados, siguen pudiendo entrar las conexiones con menos de
  3 errores (antes unos pocos probando al azar dejaban afuera a todos).

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
