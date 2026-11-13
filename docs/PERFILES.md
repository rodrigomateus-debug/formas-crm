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

### Pendiente / a revisar

- Si alguien menciona a una vendedora en la conversación de un pedido que no es suyo, ella no lo ve (ni en la bandeja).
- Logística sigue viendo todo; cuando se defina, va en el mismo `alcance.ts`.
