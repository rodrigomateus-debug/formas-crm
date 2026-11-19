import { STAGE } from './clickup';
import { produccionDePedidos } from './pedidosprod';

// Los festejos de Chispín para la vendedora (pedido de Rodrigo del 19/11/2026): sus pedidos que pasaron a «Listo para
// entregar» (Chispín embala los productos en una caja) o a «Entregado» (sale el camioncito). Casi siempre los mueve
// ClickUp (Producción, Logística), así que Chispín los busca cada tanto
// y los festeja en la pantalla de la dueña del pedido y en la de quien lo movió en el Hub. Qué se festejó ya lo recuerda
// el navegador (Chispin.tsx).
export interface FestejoPedido {
  id: number; name: string; etapa: 'listo' | 'entregado'; at: string; monto: number | null; moneda: string | null;
  articulos: Array<{ nombre: string; cantidad: number | null }>;
  hizo: Array<{ nombre: string; user_id: number | null }>;   // quién lo produjo (asignados en ClickUp)
  duenio_id: number | null;   // la vendedora del pedido (si se lo festejan a quien lo movió, para nombrarla)
}

const DIAS = 3;   // lo de más atrás ya no se festeja

export async function festejosDePedidos(db: D1Database, userId: number, desde?: string): Promise<FestejoPedido[]> {
  const limite = new Date(Date.now() - DIAS * 86_400_000).toISOString();
  const d = desde && !Number.isNaN(Date.parse(desde)) && desde > limite ? new Date(desde).toISOString() : limite;
  // El último paso a listo o entregado de cada pedido suyo o que movió ella (desde cualquier pantalla del Hub, también
  // Producción: el historial guarda quién lo hizo), si sigue en esa etapa. Pedido de Rodrigo del 19/11/2026: que lo vea la
  // dueña y también quien lo mueve.
  const { results } = await db.prepare(`SELECT r.id, r.name, r.props, r.owner_id, c.new_value AS etapa, MAX(c.changed_at) AS at
      FROM changes c JOIN records r ON r.id = c.record_id
      WHERE c.prop = 'hs_pipeline_stage' AND c.new_value IN (?1, ?2) AND c.changed_at > ?3
        AND r.object_type = 'order' AND r.archived = 0 AND (r.owner_id = ?4 OR c.user_id = ?4) AND json_extract(r.props, '$.hs_pipeline_stage') = c.new_value
      GROUP BY r.id ORDER BY at DESC LIMIT 5`)
    .bind(STAGE.listo_entregar, STAGE.entregado, d, userId).all<{ id: number; name: string; props: string; owner_id: number | null; etapa: string; at: string }>();
  if (!results.length) return [];
  const prod = await produccionDePedidos(db, results.map((r) => r.id));
  return results.map((r) => {
    const props = JSON.parse(r.props) as Record<string, unknown>;
    const p = prod[r.id];
    const monto = Number(props.hs_total_price);
    return {
      id: r.id, name: r.name, etapa: r.etapa === STAGE.entregado ? 'entregado' : 'listo', at: r.at,
      monto: Number.isFinite(monto) && monto > 0 ? monto : null, moneda: (props.hs_currency_code as string) ?? null,
      articulos: (p?.articulos ?? []).slice(0, 12).map((a) => ({ nombre: a.nombre, cantidad: a.cantidad })),
      hizo: (p?.asignados ?? []).slice(0, 3).map((a) => ({ nombre: a.nombre, user_id: a.user_id })),
      duenio_id: r.owner_id ?? null,
    };
  });
}
