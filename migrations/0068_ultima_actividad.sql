-- «Última actividad» nunca vacía (pedido de Rodrigo del 16/11/2026): cargar el registro ya es actividad, y también cuentan
-- las tareas completadas, los mensajes de la conversación, los cambios de etapa y los bocetos y logos que se suben (antes
-- solo notas, mails, llamadas, reuniones y WhatsApp, y casi todas las tarjetas decían «Sin actividad»). Se recalcula
-- para todos con la misma cuenta que ultimaActividadSql en src/worker/records.ts; de acá en más la mantiene el servidor.
UPDATE records SET last_activity_at = MAX(records.created_at, COALESCE(records.stage_entered_at, ''),
  COALESCE((SELECT MAX(CASE WHEN a.type = 'task' THEN a.completed_at ELSE a.occurred_at END) FROM activities a JOIN activity_links l ON l.activity_id = a.id
    WHERE l.record_id = records.id AND a.archived = 0 AND (a.type != 'task' OR a.status = 'COMPLETED')
      AND a.occurred_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ''),
  COALESCE((SELECT MAX(m.created_at) FROM mensajes m WHERE m.record_id = records.id AND m.borrado_at IS NULL), ''),
  COALESCE((SELECT MAX(c.changed_at) FROM changes c WHERE c.record_id = records.id AND c.prop IN ('dealstage', 'hs_pipeline_stage')), ''),
  COALESCE((SELECT MAX(b.created_at) FROM bocetos b WHERE b.record_id = records.id), ''),
  COALESCE((SELECT MAX(g.created_at) FROM logos g WHERE g.company_id = records.id), ''),
  COALESCE((SELECT MAX(g.created_at) FROM logos g WHERE g.record_id = records.id), ''));
