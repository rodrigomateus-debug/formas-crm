# Alcance: qué usamos de HubSpot y qué cubre el CRM

Objetivo del proyecto: el CRM propio reemplaza al menos el 90 % de lo que hoy usamos de HubSpot. Este documento es
la lista de control: cada fila es algo que hoy se usa, con el dato que lo respalda y su estado.

## De dónde sale la lista (relevamiento del 30/10/2026, portal 47666798)

| Objeto | Registros | Uso actual |
|---|---|---|
| Contactos | 10.450 | Alta por integraciones (Zapier 948 —leads de LinkedIn— y Pipedream/Darwin 185 desde julio), extensión de Gmail (601), a mano (335), formularios (174), conector de Claude (51). |
| Empresas | 2.011 | Conector de Claude (532 desde julio), asociación automática por dominio (212), a mano. |
| Negocios | 9.686 | ~500 por mes. 8 pipelines. De los últimos 200: Pipedream/Darwin 109, Claude 34, a mano 55. |
| Mails registrados | 40.641 | 3.000 a 5.000 por mes, casi todos por la conexión de bandeja (`EMAIL`). |
| Tareas | 10.554 | 100 a 470 por mes; desde septiembre, la prospección diaria de Cowork («Prospectar …»). |
| Notas | 1.225 | ~35 por mes. |
| Reuniones | 337 | Links de agenda de cada vendedora. |
| Llamadas | 15 | Casi sin uso. |
| Tickets, cotizaciones, productos, líneas | 5 / 10 / 0 / 1 | Sin uso real. |
| Pedidos (Order) | — | Los lee el tablero de Formas Shop (`pdv_finnegans`). |

Propiedades custom con datos: 37 en negocios, 31 en contactos, 13 en empresas (todas en `src/worker/seed.ts`; la
migración crea cualquier otra que aparezca). Equipos: Corporate (Grandes Cuentas), Formas Shop, NOESTRES. 22 propietarios.

## Lista de control

Estado: ✅ hecho y probado · 🔧 hecho, falta configurar o conectar · ⏳ pendiente · ➖ fuera de alcance (sin uso real).

### Registros y listas
| Función de HubSpot | Estado | Dónde |
|---|---|---|
| Listas de contactos, empresas, negocios, pedidos | ✅ | `/contacts`, `/companies`, `/deals`, `/orders` |
| Búsqueda por nombre, mail, dominio, teléfono, id | ✅ | Lupa de arriba (Ctrl+K) y cada lista |
| Filtros avanzados (Y / O), por propietario, fechas relativas | ✅ | «Filtros» |
| Vistas guardadas propias y compartidas, «Todos» / «Míos» | ✅ | Pestañas de cada lista |
| Elegir y ordenar columnas, ordenar por columna, paginado | ✅ | «Columnas» |
| Edición masiva, borrar y restaurar | ✅ | Selección en la lista |
| Importar CSV con mapeo y dedupe (mail/teléfono, dominio/nombre) | ✅ | «Importar» |
| Exportar CSV con los filtros aplicados | ✅ | «Exportar» |
| Combinar duplicados (asociaciones, actividad y datos pasan al principal) | ✅ | Ficha → «Combinar» |
| Crear y asociar empresa por dominio del mail | ✅ | Automático en toda alta |
| Dedupe de contactos por mail y de empresas por dominio | ✅ | Alta, importación, integraciones |

### Ficha de cada registro
| Función | Estado | Dónde |
|---|---|---|
| Propiedades por grupo, edición en línea, búsqueda de propiedad | ✅ | Columna izquierda |
| Historial de cada propiedad (quién, cuándo, desde dónde) | ✅ | «Historial» en cada propiedad |
| Asociaciones con empresa principal, agregar existente o crear nueva | ✅ | Columna derecha |
| Línea de tiempo con filtros por tipo; en empresa y negocio suma la de sus contactos | ✅ | Centro |
| Registrar nota, mail, llamada (con resultado), reunión, WhatsApp | ✅ | Botones de la ficha |
| Crear tareas con vencimiento, tipo, prioridad y responsable | ✅ | Botón «Tarea» |
| Última actividad, último contacto, próxima actividad | ✅ | Se recalculan solos |
| Atajos a WhatsApp, Gmail y chat de Darwin | ✅ | Cabecera de la ficha |
| Links viejos de HubSpot (`/contacts/47666798/record/0-3/…`) | ✅ | Redirigen a la ficha |

### Negocios y pipelines
| Función | Estado | Dónde |
|---|---|---|
| 8 pipelines con las mismas etapas, ids y probabilidades | ✅ | `src/worker/seed.ts` |
| Tablero con arrastrar y soltar, totales por etapa, filtro por propietario | ✅ | Negocios → «Tablero» |
| Motivo de cierre perdido obligatorio al perder | ✅ | Tablero y barra de etapas |
| Fecha de cierre automática al cerrar | ✅ | |
| Fecha de entrada a cada etapa (`hs_v2_date_entered_*`) | ✅ | Historial y API compatible |
| Editar pipelines y etapas | ✅ | Configuración → Pipelines |

### Tareas
| Función | Estado | Dónde |
|---|---|---|
| Cola por vencidas, hoy, semana, próximas, completadas; de todo el equipo | ✅ | `/tasks` |
| Completar, reabrir, posponer (+1 día / +1 semana), editar | ✅ | |
| Aviso por mail de tareas que vencen y de registros asignados | ⏳ | Próximo paso (Gmail send, como los avisos de NC) |

### Integraciones
| Función | Estado | Dónde |
|---|---|---|
| Claude / Cowork leen y actualizan el CRM | 🔧 | MCP en `/mcp/<token>`; falta cargar el conector en claude.ai y repuntar la prospección diaria |
| Darwin crea contacto + negocio desde WhatsApp | 🔧 | `/hooks/darwin` (mismo formato de negocio que hoy); falta cambiar el paso de Pipedream |
| Leads de prospección por LinkedIn (hoy por Zapier: 4.712 en total, ~300 por mes) | 🔧 | `/hooks/linkedin` directo, sin Zapier; deduplica por perfil y separa bien nombre y apellido. Falta apuntar la herramienta de LinkedIn y dar de baja el Zap |
| Formularios web (ruleta de eventos, descarga de catálogos) | 🔧 | `/hooks/form/<nombre>`; falta cambiar el formulario de la web |
| Registro automático de mails de la bandeja | 🔧 | Gmail cada 10 min; falta la delegación de la cuenta de servicio |
| Tableros que leen HubSpot (formas-tablero, formas-shop-tablero) | 🔧 | API compatible en la misma ruta; ver `docs/CAMBIO-TABLEROS.md` |
| Referidos del tablero que crean contacto y negocio | 🔧 | La misma API compatible (`POST /crm/v3/objects/contacts` y `deals`) |
| Migración de todo lo histórico | 🔧 | `scripts/migrate-hubspot.mjs` probado contra un HubSpot simulado; falta correrlo con el token real |

### Usuarios y permisos
| Función | Estado | Dónde |
|---|---|---|
| Ingreso con el mail de Formas (Cloudflare Access) | 🔧 | Falta crear la aplicación de Access |
| Usuarios, equipos, roles (admin, gerente, miembro, solo lectura) | ✅ | Configuración → Usuarios |
| Que cada vendedora vea solo lo suyo | ⏳ | Hoy todos ven todo (como en HubSpot con permiso «Todo»); se puede restringir por equipo |

### Lo que falta para pasar el 90 %
| Función | Estado | Por qué importa |
|---|---|---|
| Links de agenda de reuniones (meetings link) | ⏳ | 337 reuniones; se puede reemplazar con las «páginas de reserva» de Google Calendar y registrar el evento por Gmail/Calendar |
| Seguimiento de aperturas de mails | ⏳ | Lo da la extensión de HubSpot; hoy no lo usan los tableros (solo cuentan aperturas en formas-tablero) |
| Workflows de HubSpot | ⏳ | No se pueden leer por el conector: hay que listar cuáles están activos (Automatización → Workflows) y rehacer los que sirvan |
| Avisos por mail (tareas, asignaciones) | ⏳ | Ver «Tareas» |

### Fuera de alcance (sin uso real)
Tickets (5), cotizaciones de HubSpot (10, se cotiza en formas.shop), productos y líneas de pedido, marketing
(mails masivos, landing pages, blog, campañas, AEO), secuencias, chat del sitio, app móvil (el CRM se usa desde el
celular en el navegador).

## Criterio de «terminado»

1. La migración completa corrió y los números de `stats` coinciden con HubSpot.
2. Darwin, Zapier, los formularios y Cowork escriben en el CRM (en `Configuración → Registro de entradas` se ve que llegan).
3. Gmail registra los mails del equipo.
4. Los dos tableros leen del CRM sin errores en su corrida nocturna.
5. Una semana con el equipo trabajando solo en el CRM sin volver a HubSpot para nada de la lista de arriba.
