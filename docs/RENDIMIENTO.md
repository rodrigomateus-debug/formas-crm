# Rendimiento de los choferes

Pedido de Rodrigo del 17/11/2026: medir qué recorrido hace cada chofer cada día, en km y en tiempo, para después sacar
promedios por chofer y costo por km. Está en **Analíticas → Recorridos** (`/analiticas`, para Logística, Producción y
los administradores).

**Analíticas** (pedido de Rodrigo del 18/11/2026) es una sola entrada del menú, aparte de CRM y Operaciones, para los
números de cada área: así los módulos de trabajo no se llenan de pantallas de reportes. Adentro hay una pestaña por tema
y cada perfil ve las suyas (`ANALITICAS` en `web/src/pages/Analiticas.tsx`); a quien no le toca ninguna, la entrada no le
aparece (hoy, el perfil Ventas). Lo que venga (costos, puntualidad, ventas) se suma ahí como pestaña nueva.

## Qué se mide

Por cada recorrido de cada día (los de la Ruta del día del [Cronograma](CRONOGRAMA.md) que tienen chofer; los expresos no
cuentan, su costo es por envío):

- **El plan**: una foto de cómo estaba el recorrido cuando el chofer salió (o marcó la primera parada). Logística lo
  puede cambiar durante el día, y así queda con qué comparar. Si nadie avisó nada, la foto se saca al cerrar el día. Del
  plan salen los km y el tiempo que daba la ruta del día (la misma cuenta: tránsito según la hora, tiempo en cada parada
  y esperas por horario).
- **Lo que hizo**: las paradas que marcó en la app, **en el orden en que las marcó**. Las que alguien marcó hechas desde
  el Hub entran donde estaban en el plan. Cada parada queda como hecha, no se pudo o sin hacer.
- **Los km**: por calles (servicio de rutas OSRM), saliendo del punto de salida, pasando por las paradas que hizo y
  terminando donde termina el recorrido. No se ve el desvío entre parada y parada. Si el servicio no contesta, se calcula
  en línea recta por 1,35 y el día queda marcado **«Km estimados»**; también si alguna parada no está ubicada en el mapa.
  Lo que ya se pidió queda guardado (`caminos`): volver a medir no vuelve a consultar.
- **La salida y la llegada**, en este orden de confianza:
  1. **Corregida a mano** por Logística.
  2. **Por GPS**: con la app abierta y permiso de ubicación, la app ve que el chofer se alejó del punto de salida (después
     de haber estado ahí) o que está donde termina con todas las paradas resueltas.
  3. **La avisó el chofer**: los botones «Salgo» y «Terminé el recorrido».
  4. **Al marcar la última parada**, si el recorrido termina ahí (sin volver a ningún lado).
  5. **Estimada** (≈): la salida es la primera marca menos el tiempo en esa parada y el viaje hasta ahí; la llegada, la
     última marca más la vuelta.
- **Dónde estaba al marcar cada parada** (si dio permiso): si la marcó a más de 500 m del lugar, el detalle lo dice.

## El límite del GPS

La app del chofer es una página web: el celular solo le da la ubicación mientras está abierta y en pantalla. Con el
celular bloqueado, o con Waze o Google Maps al frente, no llega nada. Por eso **no se sigue el viaje entero**: se guarda el
punto cuando el chofer usa la app (sale, marca una parada, termina) y los km se calculan por calles entre esos puntos.
Los choferes están avisados. Si hiciera falta el recorrido exacto, la opción es un rastreador en los vehículos de Formas.

## En la app del chofer

- En cada recorrido: **«Salgo»** y, después, **«Terminé el recorrido»** (si quedan paradas sin hacer, pregunta). Lo ya
  avisado se ve con su hora («Saliste a las 8:42») y **«Deshacer»**.
- Si el chofer no toca nada y la app está abierta con permiso de ubicación, lo detecta sola.
- Sin señal, el aviso queda en el celular y sale cuando vuelve, con la hora en que pasó.
- De la salida vale la primera que llega; de la llegada, la última.
- Si Logística le pasa el recorrido a otro chofer durante el día, lo anotado del primero no le queda al segundo.

## La pestaña Recorridos

- **Período**: esta semana, la pasada, este mes, el pasado o los últimos 90 días. Y todos, solo los **vehículos de
  Formas** o solo los **externos**.
- **Totales**: km, horas en la calle, paradas hechas, km y tiempo por parada, y cuánto más (o menos) se hizo que lo que
  daba el plan.
- **Por chofer**: días, km, km por día, horas por día, paradas, km y tiempo por parada, y contra el plan. La etiqueta
  «De Formas» / «Externo» se cambia con un clic.
- **Día por día**: a qué hora salió y volvió (≈ si es estimada), tiempo en la calle, km y km del plan, paradas, y las
  notas (no se pudo, km estimados, corregido, en curso). Un clic abre el día: las paradas en el orden en que las hizo,
  con su hora y los km de cada tramo, el orden del plan y **corregir la hora** de salida o de llegada (queda quién la
  cambió; vaciarla la devuelve a lo que diga la app o a la estimación).
- **Medir hoy**: vuelve a medir los recorridos de hoy con lo marcado hasta ahora. **Exportar**: el día por día, en CSV.
- **Días sin medir**: si en el período hay días con recorridos que todavía no se midieron (los de antes de este cambio),
  avisa y los mide con un botón, de a uno.

## Cuándo se mide

- **Solo, de noche**: el cron de los :45 cierra el último día con recorridos que quedó sin cerrar (uno por corrida, de
  los últimos 10 días). Comparte el tope de consultas de esa corrida; si no alcanza, sigue en la próxima.
- **A mano**: «Medir hoy» y «Medirlos ahora». Medir un día no pisa un aviso del chofer que llegue mientras se hace la
  cuenta.

## Cómo está hecho

| Qué | Dónde |
|---|---|
| Tablas `recorridos_medidos`, `rendimiento_dias`, `caminos`; el punto de cada marca en `cronograma_visitas`; `propio` en `transportistas` | `migrations/0077_rendimiento.sql` |
| La medición, los avisos de la app, el cierre nocturno, la corrección y la consulta | `src/worker/rendimiento.ts` |
| Avisos de la app (`POST /hooks/chofer/api/ruta/evento`), el punto con la marca y lo ya avisado en `/ruta` | `src/worker/hooks.ts` |
| API `/api/rendimiento…` | `src/worker/api.ts` |
| Pantalla | `web/src/pages/Analiticas.tsx` (la entrada y las pestañas) y `web/src/pages/Rendimiento.tsx` (la pestaña Recorridos) |
| App del chofer: botones, detección por GPS y cola sin señal | `web/chofer/src/jornada.ts`, `web/chofer/src/Ruta.tsx` |
| Prueba de punta a punta (servicio de rutas simulado) | `test/rendimiento.test.mjs` |

| Ruta | Qué |
|---|---|
| `GET /api/rendimiento?desde&hasta` | Los recorridos medidos del período, los choferes (propio o externo) y los días que faltan medir |
| `POST /api/rendimiento/medir` `{ fecha }` | Medir (o volver a medir) un día |
| `PATCH /api/rendimiento/:fecha/:n` `{ salida, llegada }` | Corregir la hora («08:40»; vacío la saca) |
| `PUT /api/rendimiento/chofer` `{ nombre, propio }` | El vehículo es de Formas o externo |
| `POST /hooks/chofer/api/ruta/evento` `{ n, tipo, origen, at, lat, lng, quitar }` | La app avisa la salida o la llegada |

`OSRM_URL` cambia el servicio de rutas (por defecto, el público de OSRM; en las pruebas, simulado).

## Para revisar con datos reales

- **Los km contra la realidad**: una semana comparando con el odómetro de uno de los vehículos de Formas dice cuánto se
  apartan los km por calles de los reales.
- **El servicio público de OSRM** no tiene garantía: si falla seguido, los días quedan «estimados». Se puede cambiar por
  otro con `OSRM_URL`.
- **Los días anteriores** se pueden medir, pero el plan es el recorrido como quedó (no hay foto de la salida) y las horas
  salen solo de las marcas.
- **Quién es propio y quién externo** hay que marcarlo una vez (son dos vehículos de Formas).

## Lo que sigue

- **Costos**: costo por km y por parada (combustible, sueldo, seguro, mantenimiento para los propios; lo que cobran por
  viaje los externos).
- Costo de entrega por pedido.
- Puntualidad contra los horarios de recepción y las horas fijadas.
