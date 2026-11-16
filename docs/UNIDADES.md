# Unidad de negocio de empresas y contactos

Pedido de Rodrigo del 16/11/2026: la columna «Unidad de negocio» de las empresas salía del equipo del propietario, así que
todas las empresas de alguien con dos equipos mostraban las dos unidades (Formas Shop y NoEstres) y no se podía corregir.

## Empresas

Se usa la primera que haya, en este orden:

1. **A mano:** el campo «Unidades de negocio» (`unidades_de_negocio`, varias a la vez: Formas Shop, Corporate, NoEstres).
   Se edita en la ficha, en la celda de la columna (el lápiz) o en masa (Acciones masivas → editar). Vacío = automático.
2. **Por sus compras:** la unidad de sus compras en Finnegans (`unidad_finnegans`, «Unidad de negocio de sus compras», la
   carga cada mañana `scripts/clientes.mjs`, ver [CLIENTES.md](CLIENTES.md)). «Otros» o vacío no cuentan.
3. **Por el propietario:** la del equipo de su propietario (el principal y los extra), como antes.

Al pasar el mouse por la columna se ve de dónde salió.

## Contactos

Heredan la de su **empresa principal**. Sin empresa (o si la empresa no tiene ni unidad, ni compras, ni propietario), la
del equipo de su propietario. El servidor la manda en la lista (`unidad` de cada contacto).

## Dónde está

- Filtro (`__unidad`, el filtro rápido y los avanzados): `unidadSql` y `unidadEmpresaSql` en `src/worker/records.ts`.
- Columna de los contactos: `unidadesDeContactos` (records.ts), en `GET /api/records/contact`.
- Columna de las empresas: `unidadDeEmpresa` en `web/src/lib.tsx` (la misma cuenta).
- Negocios (por el equipo del pipeline), pedidos (por la unidad de ClickUp) y tareas (por el propietario) no cambian.
- Migración 0069.
