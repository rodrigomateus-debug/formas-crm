# Arquitectura: por qué Cloudflare Workers + D1, y hasta dónde llega

Evaluado el 30/10/2026 antes de publicar, con una prueba de carga sobre el volumen proyectado a 5 años.

## Volumen

| | Hoy en HubSpot | Ritmo actual | Proyección a 5 años (prueba) |
|---|---|---|---|
| Contactos | 10.450 | ~300 leads de LinkedIn + ~200 otros por mes | 60.000 |
| Empresas | 2.011 | ~100 por mes | 10.000 |
| Negocios | 9.686 | ~500 por mes | 40.000 |
| Actividades (mails, tareas, notas…) | ~53.000 | 4.000 a 6.000 por mes | 400.000 |

Es un volumen chico para una base SQLite: la prueba ocupó **385 MB** contra un límite de 10 GB por base de D1. Con
mails más largos que los de la prueba, del orden de 1 GB en 5 años.

## Tiempos medidos con el volumen de 5 años (servidor local, mediana de 5 pedidos)

| Pantalla o pedido | Tiempo |
|---|---|
| Ficha de empresa, línea de tiempo, listas sin filtro, negocios de una vendedora | 13 a 30 ms |
| Tablero de negocios (pipeline completo) | 128 ms (era 1.078 ms; se juntó en 2 consultas) |
| Tareas vencidas del equipo, API para los tableros | 140 ms |
| Búsqueda global | 260 ms (era 528 ms) |
| Filtros por propiedad y búsqueda de texto en 60.000 contactos | ~280 ms |
| Inicio con los números de todo el equipo | 286 ms |

## Decisión: quedarse en Cloudflare

- **Es el stack que ya usan.** Tablero de Formas Shop, Formas Studio y formas-tablero están en Cloudflare con el mismo
  Access: mismo ingreso, mismas credenciales, mismo despliegue por GitHub Actions.
- **Costo y mantenimiento.** Entra en el plan Workers Paid (US$5 por mes, que ya se usa). Sin servidores que actualizar.
- **Escala de sobra para el uso real** (ver arriba), con margen para multiplicar por 10.
- **No queda atado.** D1 es SQLite: `wrangler d1 export` da un SQL estándar todos los días (workflow «Respaldo de la
  base»). Si algún día hiciera falta Postgres, el cambio se concentra en la capa de datos (`records.ts`,
  `activities.ts`, `associations.ts`, `compat.ts`); la interfaz, el MCP y las integraciones no cambian.

### Lo que se hizo por la latencia desde Argentina

D1 no tiene región en Sudamérica (la más cercana es la costa este de EE. UU.). Si el Worker corriera en Buenos
Aires, cada consulta cruzaría el continente. Por eso:
- **Smart Placement** (`placement` en `wrangler.jsonc`): el Worker corre al lado de la base; cada pantalla hace un
  solo viaje largo (navegador → Worker, ~130 ms) y las consultas son locales.
- **Pocas consultas por pantalla:** el tablero usa 2; las listas, 2 en un solo viaje (`db.batch`).

### Alternativas evaluadas

| Opción | A favor | En contra | Cuándo convendría |
|---|---|---|---|
| **Postgres administrado** (Supabase o Neon en São Paulo) + Workers | Base en la región, índices sobre JSON (GIN), búsqueda de texto completa, mejor para reportes pesados | Otro proveedor y otra cuenta, ~US$25/mes, conexión por Hyperdrive, migrar las consultas | Si el CRM pasa de ~1 millón de actividades o se necesitan reportes analíticos pesados dentro del CRM (hoy los hacen los tableros) |
| **CRM de código abierto** (Twenty, EspoCRM, Odoo CRM) en un servidor | Trae de fábrica sincronización de mails y calendario, workflows, permisos | Hay que mantener un servidor (Docker, actualizaciones, backups), personalizarlo para Darwin, los tableros y el MCP de Claude cuesta más que hacerlo propio, el diseño no es el de Formas | Si el objetivo fuera tener funciones genéricas de CRM sin desarrollar, no un CRM a medida integrado con Darwin y Claude |
| **Seguir en HubSpot** | Cero desarrollo | Costo por usuario, datos e integraciones atados a su API y sus límites | — |

## Cuándo revisar esta decisión (señales concretas)

1. La base pasa de 5 GB (hoy D1 permite 10 GB): primero archivar mails viejos fuera de la base; si no alcanza, Postgres.
2. Los filtros por propiedad o la búsqueda pasan de 1 segundo: agregar índices sobre las propiedades más filtradas
   (SQLite permite índices sobre `json_extract`) y búsqueda FTS5 (D1 la soporta). Es un cambio chico, sin migrar.
3. Hace falta que muchas personas escriban a la vez de forma intensiva (cientos por segundo): D1 escribe en serie.
   Con ~20 usuarios y las integraciones actuales, hay margen de sobra.
