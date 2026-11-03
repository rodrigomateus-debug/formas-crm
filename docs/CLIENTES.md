# Compras de cada cliente (Finnegans → empresas)

Pedido de Rodrigo del 3/11/2026: que la lista de empresas muestre sola el estado del cliente según la lógica del tablero,
la última compra, la compra histórica en dólares MEP y el ticket promedio.

## Qué se ve

En las empresas, en el grupo **Compras** (de solo lectura): estado del cliente, última y primera compra, cantidad de
compras, compra de los últimos 12 meses, compra histórica y ticket promedio (en US$ MEP), cada cuántos días compra, saldo
pendiente y vencido (en pesos, con IVA), la vendedora y la unidad de negocio de sus compras. En la lista de empresas, el
estado sale como etiqueta de color y por defecto están las columnas de estado, última compra, compra de 12 meses y
vencido. En la ficha y en la vista previa, la tarjeta «Compras».

## De dónde sale

`scripts/clientes.mjs`, todos los días a las 6:41 (GitHub Actions, `.github/workflows/clientes.yml`). Solo lee Finnegans.

- **Compras:** pedidos de venta de Finnegans (`AnalisisdePedidosdeVentaPorProducto`, Formas y FP DEMO) desde 2023, neto sin
  IVA. Como en el tablero, no cuentan los objetivos de venta, los pedidos anulados, los beneficios al personal, Trafigura
  en Formas Shop, las ventas a Formas (salvo antiestrés) ni Mercado Libre y MarketShell (no tienen cliente).
- **Antes de 2023:** las facturas de 2020 a 2022 del libro de IVA (la planilla `facturacion_historica.csv` del tablero de
  márgenes), guardadas en la tabla `compras_historicas` del CRM. Las notas de crédito restan plata pero no son compras. Se
  cargan una vez con `PUT /hooks/clientes/historico`.
- **Dólar:** cada compra al dólar MEP (venta) de su día, de argentinadatos.com. El tablero usa el promedio del mes del dólar
  oficial; acá se pidió MEP.
- **Saldo:** la composición de saldos de clientes de hoy (`COMPOSICIONSALDOSCLIENTES`), cuenta «Deudores en Cta. Cte.»;
  vencido es lo que pasó su fecha de vencimiento. Los recibos sin aplicar no se descuentan (igual que en el tablero).
- **Cliente:** se agrupa por CUIT (el de los pedidos); sin CUIT, por nombre.

## Estado del cliente

Con los umbrales del tablero de márgenes, pero contados hacia atrás desde hoy (el tablero cuenta el año calendario, que el
1 de enero dejaría a casi todos como perdidos):

| Estado | Regla |
|---|---|
| Dormido | más de 2 años sin comprar |
| Perdido | más de 12 meses sin comprar |
| En riesgo | compró en los últimos 12 meses, tiene 3 compras o más desde 2024 y lleva más de 90 días y más de 2,5 veces su ritmo (mediana de días entre compras) sin comprar |
| Nuevo | su primera compra fue en los últimos 12 meses |
| Recuperado | en los últimos 12 meses volvió a comprar después de más de 12 meses sin comprar |
| Activo | el resto de los que compraron en los últimos 12 meses |

Diferencias con el tablero: no usa los grupos económicos ni las marcas manuales de `clientes_meta.csv` (cerrados,
reasignados), y la historia arranca en 2020 (un cliente de antes que volvió figura como nuevo).

## Cruce con las empresas del CRM

En este orden: código de Finnegans de la empresa (con el CUIT del saldo o de la ficha del cliente en Finnegans), CUIT, y
nombre o razón social (sin la forma societaria) solo si corresponde a un único cliente. Si la empresa no tiene CUIT,
código o razón social, se completan (nunca se pisan). Las empresas que tenían compras y ya no cruzan se limpian.

## Hooks (token de administrador)

- `GET /hooks/clientes/empresas`: las empresas para cruzar.
- `GET` y `PUT /hooks/clientes/historico`: el histórico de facturas (`{"rows": [{fecha, cuit, cliente, tipo, neto}]}`).
- `POST /hooks/clientes/aplicar`: `{updates: [{id, props, completar}], limpiar: [ids], resumen}`.
- `GET /hooks/clientes/estado`: el resumen de la última corrida (solo cantidades).

`DRY_RUN=1 node scripts/clientes.mjs` calcula y muestra el resumen sin aplicar nada.
