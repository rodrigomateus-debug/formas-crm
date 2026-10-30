# Pasar los tableros de HubSpot al CRM

El CRM responde las mismas rutas de la API de HubSpot que usan los tableros (`/crm/v3/…`, `/crm/v4/…`,
`/oauth/v2/…`), con los mismos ids de registros, pipelines, etapas y propietarios. El cambio es el host y el token.
Conviene hacerlo con una variable, así se vuelve atrás sin tocar código.

Token: Configuración → Integraciones → crear un token tipo «API / tableros» y guardarlo como secreto `CRM_TOKEN`
en cada repo (GitHub Actions) y en Pages (para `worker.js`).

## formas-tablero

`claude/hs_api.py:92` tiene `BASE = "https://api.hubapi.com"`. Cambiarlo por:

```python
BASE = os.environ.get("HUBSPOT_BASE", "https://api.hubapi.com")
```

y en `.github/workflows/tablero.yml` y `rapido.yml` pasar `HUBSPOT_BASE=https://<crm>` y `HUBSPOT_TOKEN=${{ secrets.CRM_TOKEN }}`.

**Importante:** `_req` (línea ~149) arma el pedido con `urllib.request` sin `User-Agent`. Cloudflare rechaza el
agente por defecto de urllib («Python-urllib») con un 403 «error code: 1010» antes de que llegue al CRM (probado el
30/10/2026). Agregar el header en ese mismo `Request`:

```python
headers={"Authorization": "Bearer " + _token.tok, "Content-Type": "application/json", "User-Agent": "formas-tablero/1.0"}
```

`shop.py` usa `http.client`, que no manda agente, y pasa sin cambios (probado).

## formas-shop-tablero

- `shop.py` abre `http.client.HTTPSConnection("api.hubapi.com")` en 8 lugares (líneas 408, 1526, 1700, 1765, 1799,
  1841, 1872 y 6689). Reemplazar el literal por una constante `HS_HOST = os.environ.get("HUBSPOT_HOST", "api.hubapi.com")`.
- `worker.js:92` (referidos) y `nc_api.js:221` hacen `fetch("https://api.hubapi.com" + …)`: usar `env.HUBSPOT_BASE`
  con el mismo valor por defecto.
- Los links a fichas (`app.hubspot.com/contacts/47666798/record/0-1|0-2|0-3/<id>`, 17 lugares) siguen valiendo con
  solo cambiar el host: el CRM redirige esa ruta a la ficha.
- Las pruebas (`test_worker.mjs`, `test_nc_api.mjs`) comparan contra `https://api.hubapi.com`; con el valor por
  defecto siguen pasando.

## Qué responde el CRM (y diferencias)

| Lo que piden los tableros | En el CRM |
|---|---|
| `POST /crm/v3/objects/{deals,contacts,companies,orders,tasks,emails}/search` con `filterGroups`, `sorts`, `after` | ✅ Operadores EQ, NEQ, LT/LTE/GT/GTE, BETWEEN, IN/NOT_IN, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN. Fechas en milisegundos o ISO. |
| `hs_is_closed`, `hs_is_closed_won`, `hs_is_closed_lost`, `amount_in_home_currency`, `days_to_close` | ✅ Calculadas igual. |
| `hs_v2_date_entered_<etapa>` | ✅ Desde la historia de etapas (migrada de HubSpot y registrada desde entonces). |
| `notes_last_contacted`, `notes_last_updated`, `notes_next_activity_date`, `hs_last_logged_*`, `num_associated_*`, `hs_num_open_deals` | ✅ |
| `POST /crm/v3/objects/{contacts,companies}/batch/read` con `propertiesWithHistory` | ✅ El historial existe para lo que cambió en el CRM y para etapas/propietario migrados. |
| `POST /crm/v4/associations/{a}/{b}/batch/read` | ✅ Con la empresa principal marcada (typeId 5 en negocios, 1 en contactos). |
| `GET /crm/v3/pipelines/deals`, `GET /crm/v3/owners` (también archivados) | ✅ Owners con el id de HubSpot. |
| `POST /oauth/v2/private-apps/get/access-token-info` | ✅ Devuelve los alcances que chequea `shop.py`. |
| `POST /crm/v3/objects/contacts` y `deals` con `associations` (referidos) | ✅ |
| Búsqueda con más de 10.000 resultados | El CRM no corta en 10.000 (HubSpot sí). |
| `query_crm_data` del conector de Claude (prospeccion.js) | Usar las herramientas `search_records` y `report` del MCP del CRM. |
