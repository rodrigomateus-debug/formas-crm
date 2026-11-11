# Tipo de relación: clientes, proveedores, equipo de Formas y otros

Pedido de Rodrigo del 11/11/2026: que los proveedores, la gente que trabaja en Formas y otros contactos (bancos,
transporte, estudios…) no se mezclen con los clientes y prospectos.

## El dato

Contactos y empresas tienen **«Tipo de relación»** (`tipo_de_relacion`): Cliente / prospecto, Proveedor, Equipo Formas u
Otro. Vacío cuenta como cliente. Se cambia en la ficha, en la tabla o en masa (Acciones masivas → editar).

## Qué se ve

- En **Contactos** y **Empresas**, «Todos», «Míos» y las vistas guardadas muestran por defecto solo **clientes y
  prospectos**: el primer filtro rápido («Clientes y prospectos») deja sumar los otros tipos o elegir «Todos», y se guarda
  con la vista. Vale para la tabla, el tablero, la exportación y las acciones masivas.
- Las pestañas compartidas **«Proveedores»** y **«Equipo y otros»** (migración 0037) muestran los demás.
- El buscador de arriba encuentra todo; los que no son clientes llevan su marca (Proveedor, Equipo Formas, Otro).
- Claude (`search_records`) sabe que para clientes y prospectos tiene que filtrar con `__relacion` = `cliente`.
- Los negocios y los pedidos no cambian.

## Solo (`src/worker/relacion.ts`)

- **Equipo Formas:** el contacto con mail de un dominio de Formas (los «internos» de la configuración de Gmail:
  formaspublicitarias.com, formas.ar, soutex.com.ar) o de un usuario del CRM, y la empresa con dominio de Formas, al
  crearse o cambiar el mail o el dominio (si no se eligió otro tipo).
- **Herencia:** el contacto hereda el tipo de su empresa principal al asociarse (si no tiene uno propio). Cuando a la
  empresa se le cambia el tipo, sus contactos que no tenían tipo (o tenían el de antes de la empresa) pasan al nuevo; el
  que tiene uno propio distinto lo conserva. Así, marcar una empresa como proveedor marca a su gente, y los mails nuevos
  de ese dominio (Gmail asocia el contacto a la empresa por el dominio) entran como proveedores.
- La migración 0037 marcó lo seguro: las empresas que en HubSpot eran «Proveedor», las de dominio de Formas, los
  contactos con mail de Formas o de un usuario del CRM, y los contactos de esas empresas.

## Pendiente

Marcar solas las empresas que son proveedores en Finnegans (por CUIT), si la API deja leer el listado de proveedores.
