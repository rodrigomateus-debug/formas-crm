# Darwin ↔ CRM sin Pipedream ni HubSpot

Relevado el 30/10/2026 en Darwin (workspace 1986 «Formas Shop», solo lectura). Hoy hay tres workflows de Darwin
encendidos que dependen de HubSpot. Los tres se reemplazan por llamadas directas al CRM.

## 1. Alta de contacto y negocio (Darwin → CRM)

**Hoy:** «Formas Publicitarias - Hubspot» (`auto-32592435…`, disparador `session.forwarded`). Pasos: filtro de canal
«Formas Publicitarias», 6 pasos de código (origen, campaña, propietario por nombre, nombre, canal, limpieza) y 3 pasos
de HubSpot (crear o actualizar contacto, crear negocio, asociar). Problemas que tiene:

- El contacto se crea con un mail inventado (`incompleto<teléfono>@gmail.com`).
- El propietario sale de una tabla fija por *nombre* de la vendedora; si el nombre no está, queda sin propietario.
- No deduplica negocios: si la misma conversación se califica y después se escala, crea dos.
- Los campos de origen del negocio (`origen_del_prospecto`, `origen_de_la_campana`, `origen_del_negocio`) no los manda
  Darwin: los completa algo dentro de HubSpot (probablemente un workflow de HubSpot que los copia del contacto).

**Con el CRM:** el CRM hace toda esa lógica en `/hooks/darwin` (`src/worker/hooks.ts`), así que el workflow queda en:

1. El filtro de canal `solo-canal-formas` (igual que hoy).
2. Un paso `http-request`:
   - método `POST`, URL `https://<crm>/hooks/darwin`
   - headers: `Authorization: Bearer <token>` (token tipo «Darwin» de Configuración → Integraciones)
   - body `json` con un solo campo: `data` = `{{data}}` (el evento completo; un campo que es un único placeholder conserva su tipo)
3. Se borran los 6 pasos de código y los 3 de HubSpot.

El CRM: busca el contacto por teléfono (sin mail inventado), elige el propietario por `forwardedToEmail` (y si no, por
nombre), arma el nombre igual que hoy (descarta «Maru» y los nombres del equipo), calcula origen y campaña con la misma
regla (anuncio prellenado sin utm → `META_ADS` / «Anuncio sin referral - …»; si no, `Orgánico` / `Directo`), crea el
negocio «Nombre - Producto - Cantidad - Darwin» en Formas Shop (Inbound) / Lead calificado con los campos de origen
completos, y si ya hay un negocio abierto de ese contacto lo reutiliza. El resumen de la conversación queda como nota.

Si el CRM no está en Cloudflare Access para `/hooks/*` (ver README), no hace falta permitir IPs; si se quiere,
Darwin sale desde 32.192.137.35, 32.192.62.181 y 18.235.132.229.

## 2. Venta ganada (CRM → Darwin)

**Hoy:** «Actualizar Estado de la Venta en Darwin» y «… Darwin Marketing» se disparan con «New Deal In Stage» de
HubSpot (Cierre ganado), buscan el contacto asociado y su teléfono, y en Darwin marcan el campo 13508 = `closedwon` y
registran el ingreso (fuente Marketing 16, ARS, monto y fecha de cierre, referencia = id del negocio). En octubre
fallaron 21 de 36 y 26 de 37 corridas.

**Con el CRM:** cuando un negocio pasa a una etapa ganada, el CRM avisa a la URL configurada en Configuración →
Integraciones → «Avisos a otros sistemas» (evento «Negocio ganado») con este cuerpo:

```json
{
  "event": "deal.won",
  "deal": { "id": 123, "name": "…", "amount": 900000, "currency": "ARS", "closedate": "2026-10-30",
            "whatsapp_thread": "5493511234567", "darwin_conversation_id": "15552-5493511234567", "link_a_darwin": "…" },
  "owner": { "id": 1, "name": "…", "email": "…" },
  "contacts": [{ "id": 456, "name": "…", "phone": "…", "whatsapp_thread": "549…" }],
  "company": { "id": 789, "name": "…" }
}
```

En Darwin: un workflow nuevo con disparador `inbound-webhook` (su URL va en el aviso del CRM) y los mismos dos pasos
de hoy: `set_session_field` (campo 13508 = `closedwon`, hilo = `{{trigger.body.deal.whatsapp_thread}}`) y
`record_revenue` (monto `deal.amount`, fecha `deal.closedate`, referencia `deal.id`). Después se apagan los dos
workflows que leen HubSpot. El teléfono ya viene resuelto, que es justo donde fallan hoy.

## 3. Borradores apagados que leen pedidos de HubSpot

«Outbound Pedidos» y «Outbound - Saldo Pendiente» están apagados (nunca se activaron: a la cuenta de HubSpot le
faltaban permisos). Si se retoman, se hacen con un aviso del CRM sobre pedidos en vez de leer HubSpot.
