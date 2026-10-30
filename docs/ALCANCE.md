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
| Vistas guardadas propias y compartidas, «Todos» / «Míos», en la tabla y en el tablero (con sus filtros) | ✅ | Pestañas de cada lista |
| Elegir y ordenar columnas, ordenar por columna, paginado | ✅ | «Columnas» |
| Editar un campo desde la lista (propietario, mail, desplegables, fechas…), sin entrar a la ficha | ✅ | Lápiz al pasar el mouse por la celda (o doble clic); solo lectura no edita |
| Vista previa al costado: clic en una tarjeta del tablero o «Vista previa» en la tabla, con acciones rápidas, «Acerca de» editable, asociaciones y última actividad | ✅ | Botón «Ver registro» para la ficha completa |
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
| Logo de la empresa (ícono de su dominio) y foto del contacto (Gravatar de su mail) en la lista, la ficha y las asociaciones | ✅ | Se trae una vez y queda guardado una semana; si no hay, las iniciales |
| Links viejos de HubSpot (`/contacts/47666798/record/0-3/…`) | ✅ | Redirigen a la ficha |

### Negocios y pipelines
| Función | Estado | Dónde |
|---|---|---|
| 8 pipelines con las mismas etapas, ids y probabilidades | ✅ | `src/worker/seed.ts` |
| Tablero con arrastrar y soltar (en cualquier parte de la columna), totales por etapa, filtro por propietario | ✅ | Negocios → «Tablero» |
| Selector de pipeline grande arriba de Negocios (tabla y tablero), «Todos los pipelines» en la tabla, recordado y en el link | ✅ | Negocios |
| Tablero de empresas y contactos por etapa del ciclo de vida (o por cualquier desplegable o propietario), arrastrando para cambiar | ✅ | Empresas / Contactos → «Tablero» |
| Motivo de cierre perdido obligatorio al perder | ✅ | Tablero y barra de etapas |
| Fecha de cierre automática al cerrar | ✅ | |
| Fecha de entrada a cada etapa (`hs_v2_date_entered_*`) | ✅ | Historial y API compatible |
| Crear pipelines (en blanco o copiando otro con sus etapas y reglas), borrar pipelines sin negocios | ✅ | Configuración → Pipelines |
| Etapas: agregar, ordenar, renombrar, probabilidad, tipo (abierta, ganada, perdida); borrar moviendo sus negocios | ✅ | Configuración → Pipelines |
| Propiedades obligatorias por etapa (como las «propiedades condicionales» de HubSpot): se piden al mover en el tablero o la ficha | ✅ | Por defecto: el motivo al perder en los pipelines de venta |
| Tarea automática al entrar a una etapa, para el propietario del negocio | ✅ | Configuración → Pipelines → Etapas |
| Reglas por pipeline: no saltear etapas, no volver atrás, empresa obligatoria, etapas donde se crean negocios | ✅ | Corporate pide empresa (pendiente del runbook de márgenes) |
| Cada equipo arranca en su pipeline (tablero y alta) | ✅ | Equipo del pipeline |
| Datos de las tarjetas del tablero y de «Acerca de este negocio» por pipeline | ✅ | Configuración → Pipelines → General |

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
| Darwin crea contacto + negocio desde WhatsApp | 🔧 | `/hooks/darwin` recibe el evento nativo de Darwin: sin Pipedream, sin mail inventado, sin negocios repetidos. Falta reemplazar los 3 pasos de HubSpot del workflow por un `http-request` ([DARWIN.md](DARWIN.md)) |
| Venta ganada → Darwin (estado de la venta e ingreso para marketing) | 🔧 | Aviso «Negocio ganado» del CRM; falta el workflow de Darwin con disparador webhook. Hoy esos workflows leen HubSpot y fallan en ~60 % de las corridas |
| Leads de prospección por LinkedIn (hoy por Zapier: 4.712 en total, ~300 por mes) | 🔧 | `/hooks/linkedin` directo, sin Zapier; deduplica por perfil y separa bien nombre y apellido. Falta apuntar la herramienta de LinkedIn y dar de baja el Zap |
| Formularios web (ruleta de eventos, descarga de catálogos) | 🔧 | `/hooks/form/<nombre>`; falta cambiar el formulario de la web |
| Registro automático de mails de la bandeja | 🔧 | Gmail cada 10 min; falta la delegación de la cuenta de servicio |
| Tableros que leen HubSpot (formas-tablero, formas-shop-tablero) | 🔧 | API compatible en la misma ruta; ver `docs/CAMBIO-TABLEROS.md` |
| Referidos del tablero que crean contacto y negocio | 🔧 | La misma API compatible (`POST /crm/v3/objects/contacts` y `deals`) |
| Migración de todo lo histórico | 🔧 | `scripts/migrate-hubspot.mjs` probado contra un HubSpot simulado; falta correrlo con el token real |

### Usuarios y permisos
| Función | Estado | Dónde |
|---|---|---|
| Ingreso con el mail de Formas (Cloudflare Access); quién entra lo decide Configuración → Usuarios | 🔧 | La aplicación de Access ya está; falta la política «Mails de Formas (CRM)» (a mano o con el workflow «Login de Cloudflare», que necesita el permiso de Access en el token) |
| Usuarios, equipos, roles (admin, gerente, miembro, solo lectura) | ✅ | Configuración → Usuarios |
| Qué pipelines ve cada uno: por pipeline, «Todos» o «Solo estos equipos»; equipos extra por usuario; los administradores ven todo | ✅ | Configuración → Pipelines (Quién lo ve) y Usuarios (Otros equipos, Pipelines que ve). En HubSpot esto es del plan Enterprise |
| Que cada vendedora vea solo sus registros (contactos, empresas, negocios propios) | ⏳ | Hoy ven todo lo de los pipelines que tienen habilitados |

### Lo que falta para pasar el 90 %
| Función | Estado | Por qué importa |
|---|---|---|
| Links de agenda de reuniones (meetings link) | ⏳ | 337 reuniones; se puede reemplazar con las «páginas de reserva» de Google Calendar y registrar el evento por Gmail/Calendar |
| Seguimiento de aperturas de mails | ⏳ | Lo da la extensión de HubSpot; hoy no lo usan los tableros (solo cuentan aperturas en formas-tablero) |
| Workflows de HubSpot | ⏳ | No se pueden leer por el conector: hay que listar cuáles están activos (Automatización → Workflows). Hay al menos uno: completa el origen de los negocios de Darwin (eso ya lo hace el CRM) |
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
