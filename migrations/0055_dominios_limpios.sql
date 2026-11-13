-- El dominio de una empresa se guarda sin «https://», sin «www.» y sin lo que sigue a la barra (pedido de Rodrigo del
-- 13/11/2026: «https://go.illumin.com/» → «go.illumin.com»). Desde ahora lo limpia el CRM al guardar (records.ts); esto
-- limpia los que ya estaban cargados así. De a un paso por consulta.
UPDATE records SET props = json_set(props, '$.domain', lower(trim(json_extract(props, '$.domain'))))
  WHERE object_type = 'company' AND json_type(props, '$.domain') = 'text'
    AND (json_extract(props, '$.domain') LIKE 'http%' OR json_extract(props, '$.domain') LIKE 'www.%' OR json_extract(props, '$.domain') LIKE '%/%' OR json_extract(props, '$.domain') LIKE ' %');
UPDATE records SET props = json_set(props, '$.domain', substr(json_extract(props, '$.domain'), 9))
  WHERE object_type = 'company' AND json_extract(props, '$.domain') LIKE 'https://%';
UPDATE records SET props = json_set(props, '$.domain', substr(json_extract(props, '$.domain'), 8))
  WHERE object_type = 'company' AND json_extract(props, '$.domain') LIKE 'http://%';
UPDATE records SET props = json_set(props, '$.domain', substr(json_extract(props, '$.domain'), 5))
  WHERE object_type = 'company' AND json_extract(props, '$.domain') LIKE 'www.%';
UPDATE records SET props = json_set(props, '$.domain', substr(json_extract(props, '$.domain'), 1, instr(json_extract(props, '$.domain'), '/') - 1))
  WHERE object_type = 'company' AND instr(json_extract(props, '$.domain'), '/') > 1;
UPDATE records SET props = json_set(props, '$.domain', substr(json_extract(props, '$.domain'), 1, instr(json_extract(props, '$.domain'), '?') - 1))
  WHERE object_type = 'company' AND instr(json_extract(props, '$.domain'), '?') > 1;
