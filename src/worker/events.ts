// Avisos a otros sistemas (webhooks de salida). Hoy: cuando un negocio cambia de etapa o se gana, para que Darwin
// marque la venta y registre el ingreso (reemplaza a los workflows de Darwin que leían HubSpot).
// Configuración en settings, clave `webhooks`: [{ event: 'deal.won' | 'deal.stage_changed', url, secret? }].

export type CrmEvent = 'deal.won' | 'deal.stage_changed';
interface Hook { event: CrmEvent; url: string; secret?: string; name?: string }

// Teléfono como lo usa Darwin para el hilo de WhatsApp: 549 + característica + número.
export function whatsappThread(v: unknown) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return `549${d.slice(2)}`;
  return `549${d.slice(-10)}`;
}

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function emitDealEvent(db: D1Database, events: CrmEvent[], dealId: number) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'webhooks'").first<{ value: string }>();
  const hooks = (row ? (JSON.parse(row.value) as Hook[]) : []).filter((h) => events.includes(h.event));
  if (!hooks.length) return;
  const deal = await db.prepare('SELECT r.*, s.label AS stage_label, s.is_won, s.is_closed FROM records r LEFT JOIN stages s ON s.id = r.stage_id WHERE r.id = ?')
    .bind(dealId).first<{ id: number; name: string; props: string; amount: number | null; close_date: string | null; pipeline_id: string; stage_id: string; stage_label: string; is_won: number; is_closed: number; owner_id: number | null }>();
  if (!deal) return;
  const { results: related } = await db.prepare(
    `SELECT r.id, r.object_type, r.name, r.props FROM associations a JOIN records r ON r.id = a.to_id AND r.archived = 0
     WHERE a.from_id = ? AND a.to_type IN ('contact', 'company') ORDER BY a.is_primary DESC`,
  ).bind(dealId).all<{ id: number; object_type: string; name: string; props: string }>();
  const props = JSON.parse(deal.props) as Record<string, unknown>;
  const owner = deal.owner_id ? await db.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(deal.owner_id).first() : null;
  const contacts = related.filter((r) => r.object_type === 'contact').map((r) => {
    const p = JSON.parse(r.props) as Record<string, unknown>;
    return { id: r.id, name: r.name, email: p.email ?? null, phone: p.mobilephone ?? p.phone ?? null, whatsapp_thread: whatsappThread(p.mobilephone ?? p.phone) };
  });
  const darwinConv = String(props.link_a_darwin ?? '').split('/').pop() || null;
  for (const h of hooks) {
    const body = JSON.stringify({
      event: h.event,
      at: new Date().toISOString(),
      deal: {
        id: deal.id, name: deal.name, amount: deal.amount, currency: props.deal_currency_code ?? 'ARS', closedate: deal.close_date,
        pipeline: deal.pipeline_id, stage: deal.stage_id, stage_label: deal.stage_label, won: !!deal.is_won, closed: !!deal.is_closed,
        producto: props.producto ?? null, link_a_darwin: props.link_a_darwin ?? null, darwin_conversation_id: darwinConv,
        whatsapp_thread: whatsappThread(darwinConv?.split('-').pop()) ?? contacts.find((c) => c.whatsapp_thread)?.whatsapp_thread ?? null,
      },
      owner,
      contacts,
      company: related.filter((r) => r.object_type === 'company').map((r) => ({ id: r.id, name: r.name }))[0] ?? null,
    });
    let ok = false;
    let result = '';
    try {
      const res = await fetch(h.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(h.secret ? { 'x-formas-crm-signature': await sign(h.secret, body) } : {}) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      ok = res.ok;
      result = `${res.status}`;
    } catch (e) {
      result = (e as Error).message;
    }
    await db.prepare('INSERT INTO inbound_log (source, payload, result, ok) VALUES (?, ?, ?, ?)')
      .bind(`salida:${h.event}${h.name ? `:${h.name}` : ''}`, body.slice(0, 20000), result, ok ? 1 : 0).run();
  }
}
