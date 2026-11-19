# Buzón de ideas: Formi

Pedido de Rodrigo del 19/11/2026: un personaje divertido, siempre abajo a la derecha del Hub, donde cualquiera propone
mejoras, las demás personas proponen otras o votan las que les sirven, quedan rankeadas, y los administradores las van
haciendo y marcando como completadas.

## Para el equipo

**Formi** es una «forma» que cambia de forma (es de Formas): pasa de gota a casi cuadrado, a huevo y a círculo. Tiene una
lamparita arriba que se prende cuando hay ideas nuevas, con un número rojo de cuántas son.

- **Un clic en Formi** abre el buzón. Arriba se escribe la idea y **Proponer** (o Ctrl + Enter). Mientras se escribe, si
  ya hay una parecida, la muestra: «¿Es alguna de estas? Sumale tu voto en vez de repetirla». La misma idea dos veces no
  entra: el Hub lleva a la que ya está.
- **Ranking**: arriba lo que está **en marcha**; abajo, **para votar**, de más votos a menos (la primera con 👑, después
  #2 y #3). La flechita con el número es el voto: se toca para votar y otra vez para sacarlo. Quien propone ya la vota.
  Se ve quién la propuso, quiénes la votaron y si es nueva (menos de 3 días).
- **Hechas**: lo que ya se hizo, con la respuesta de quien la hizo («Listo: está en Pedidos → Filtros»), el **Salón de
  la fama** (cuántas ideas de cada uno se hicieron) y, al final, las que **no van** (por ahora).
- **Mías**: las que propuso cada uno. Mientras está pendiente se puede **corregir** o **borrar**.

Formi también tiene vida propia: sigue el mouse con los ojos, parpadea, saluda al pasar por encima, se duerme si nadie
mueve el mouse un buen rato y salta con papelitos cuando se hace una idea tuya (o una que votaste). Una vez por día dice
algo (la primera vez se presenta; después avisa si hay ideas nuevas o tira una frase). Con la ✕ que aparece al pasar
por encima se **esconde** y queda espiando desde el borde; un clic lo vuelve a traer. En Conversaciones (y con la
conversación abierta en una ficha) se corre solo al borde para no tapar el botón de mandar. Con «reducir movimiento» del
sistema queda quieto.

En la versión celular está arriba de la barra de abajo (no en los chats ni al cargar un encargo) y el buzón sube como
una hoja.

## Para los administradores

Al pasar el mouse por una idea aparecen **En marcha**, **Hecha**, **No va**, **A pendiente** y **Responder**: cada uno
pide una respuesta opcional para el equipo. La campanita avisa (sin mail):

| Qué pasa | A quién |
|---|---|
| Alguien propone una idea | A los administradores (`idea_nueva`) |
| Pasa a «en marcha» | A quien la propuso (`idea_en_curso`) |
| Se hizo | A quien la propuso (`idea_hecha`) y a todos los que la votaron (`idea_votada_hecha`) |
| No va | A quien la propuso (`idea_descartada`) |

Un clic en el aviso abre el buzón en esa idea, sin cambiar de pantalla. Un administrador también puede corregir o borrar
cualquier idea.

**Desde Claude** (conector del Hub): `ideas_del_hub` lista el buzón en el orden del ranking (filtra por `abiertas`,
`pendiente`, `en_curso`, `hecha` o `descartada`), y `marcar_idea` (solo administradores) la pasa de estado con la
respuesta. Así, al terminar una mejora en una sesión con Claude, se le puede pedir «marcá la idea 12 como hecha y
contales dónde está». El link de cada idea es `https://<hub>/?idea=<id>`: abre el buzón en esa idea.

## Cómo está hecho

- `migrations/0094_ideas.sql`: `ideas` (texto, quién, estado `pendiente` / `en_curso` / `hecha` / `descartada`,
  respuesta, cuándo y quién la marcó, borrado lógico) e `idea_votos` (un voto por persona e idea). `avisos.idea_id`.
- `src/worker/ideas.ts`: listar (todas, en el orden del ranking), crear (vota sola y avisa a los administradores; la
  misma idea abierta no se repite), corregir y borrar (autor mientras está pendiente, o administrador), votar (solo
  abiertas) y cambiar de estado (administradores, con los avisos). Rutas en `api.ts` (`/api/ideas…`); los de solo lectura
  también proponen y votan; mirando «Ver como», no.
- `web/src/Formi.tsx`: el personaje (HTML y CSS, sin imágenes), el globito, el buzón y los papelitos. Lo que recuerda
  cada navegador (lo último visto, si está escondido, el borrador, qué ya festejó) va en `localStorage` con prefijo
  `formi.`; sin eso, arranca de cero. Estilos al final de `web/src/styles.css` (claro, oscuro y alto contraste).
- Prueba: `test/ideas.test.mjs`.
