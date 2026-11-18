# Tareas en equipo

Pedido de Rodrigo del 18/11/2026: rearmar la parte visual de tareas inspirada en ClickUp y Asana, con tablero, tareas
relacionadas con pedidos, contactos, empresas y negocios, varias personas en una tarea (con un responsable principal) y
una conversación en cada tarea, sin perder la relación con el resto del Hub.

## Para el equipo

- **Menú → Tareas** abre el **Tablero** (o la **Lista**, la de siempre, con Vencidas / Para hoy / Esta semana…; cada uno
  queda con la última que eligió).
- El tablero se **agrupa por** Estado (Por hacer, En curso, En espera, Hecha), Vencimiento (Vencidas, Hoy, Mañana, Esta
  semana, Más adelante, Hechas), Prioridad o Responsable. **Arrastrar** una tarjeta a otra columna le cambia eso (el estado,
  la fecha, la prioridad o el responsable). «Agregar tarea» arriba de cada columna la crea ahí mismo.
- **Mis tareas** son las que tengo de responsable y en las que colaboro. También: Todo el equipo, o una persona.
  «Relacionadas con»: pedidos, negocios, empresas, contactos o sin relacionar.
- La **tarjeta** muestra con qué está relacionada, el vencimiento (en rojo si venció), la prioridad, los pasos hechos, los
  comentarios (en rojo si hay sin leer) y el equipo (el responsable con aro, después los colaboradores).
- Un clic abre la **tarea** a la derecha: título, estado, responsable, **colaboradores** (+ Sumar), vence, prioridad, tipo,
  **relacionada con** (+ Relacionar: pedido, negocio, empresa o contacto), descripción, **pasos** (checklist) y la
  **conversación**: comentarios con `@` para mencionar, responder, editar y borrar los propios. El link `/tasks?tarea=<id>`
  abre la tarea directo (lo usan la campanita y los mails).
- **Nueva tarea** (arriba a la derecha) pide todo de una vez, incluidos colaboradores y relaciones.

## Lo que sigue igual (relación con el resto del Hub)

- Una tarea sigue siendo una actividad (`activities`, type `task`) con su responsable en `owner_id`: el resumen de la
  mañana, «te asignaron una tarea», el inicio, la API compatible con HubSpot y Claude la ven como siempre.
- Las relaciones son las de siempre (`activity_links`): la tarea aparece en la actividad de cada pedido, negocio, empresa y
  contacto relacionado (y en la conversación del pedido). En la ficha, la tarea muestra «+N» colaboradores y sus
  comentarios, y **Abrir** la abre con el mismo panel. Al crear una tarea desde una ficha se pueden sumar colaboradores.
- Perfil Ventas: además de lo de siempre, ve las tareas en las que colabora.

## Quién se entera

- Sumar a alguien como colaborador: «te sumó a una tarea» (campanita y mail, como una asignación).
- Mencionar con `@` en la conversación de la tarea: campanita y mail.
- Cualquier comentario: a la campanita del responsable y los colaboradores (no por mail).
- Abrir la tarea marca leídos sus comentarios y esos avisos.

## Claude (MCP)

- `create_task` y `update_activity` aceptan `colaboradores` (desde Claude, como con el responsable, cada uno se suma solo
  a sí mismo); `create_task` acepta `status`.
- `list_tasks` devuelve colaboradores y cantidad de comentarios; `get_task` da la tarea con su conversación y
  `comment_task` escribe en ella.

## Cómo está hecho

- `migrations/0082_tareas_equipo.sql`: `tarea_colaboradores`, `tarea_comentarios`, `tarea_lecturas` y `avisos.comentario_id`.
- `src/worker/tareas.ts`: colaboradores, comentarios, leído y avisos (`tarea`, `tarea_mencion`, `tarea_comentario`).
- `src/worker/activities.ts`: `colaboradores` al crear y editar; `listTasks` con `participa`, `objeto` y `status=board`
  (abiertas y completadas en los últimos 14 días); la lista y la actividad de cada registro traen colaboradores,
  comentarios y sin leer.
- Rutas: `GET /api/tasks/:id`, `PUT /api/tasks/:id/colaboradores`, `GET|POST /api/tasks/:id/comentarios`,
  `POST /api/tasks/:id/leido`, `PATCH|DELETE /api/tarea-comentarios/:id`.
- Pantalla: `web/src/pages/Tasks.tsx` (tablero y lista) y `web/src/TareaPanel.tsx` (panel, nueva tarea, conversación;
  reusa el cuadro con @menciones de la conversación de los pedidos).
- Prueba: `test/tareas.test.mjs`.

## Lo que falta (ideas)

- Adjuntar archivos en los comentarios de la tarea (hoy solo texto).
- Subtareas con responsable propio (hoy los pasos son un checklist).
- Reordenar a mano dentro de una columna (hoy van por vencimiento).
