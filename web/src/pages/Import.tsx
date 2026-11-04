import { useMemo, useState } from 'react';
import { http, useMeta, useToast, propsOf, OBJECTS, type ObjectType } from '../lib';
import { Modal } from '../components';
import { Select } from '../Select';

// CSV con comillas, separador , o ; (lo detecta), BOM de Excel incluido.
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export default function ImportModal({ type, onClose }: { type: ObjectType; onClose: () => void }) {
  const { meta } = useMeta();
  const toast = useToast();
  const props = propsOf(meta, type).filter((p) => !p.read_only);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [map, setMap] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; created: number; updated: number; errors: Array<{ row: number; error: string }> } | null>(null);
  const targets = useMemo(() => [
    ...props.map((p) => ({ value: p.name, label: p.label })),
    ...(type !== 'company' ? [{ value: '__company', label: 'Empresa (nombre, para asociar)' }] : []),
  ], [props, type]);

  const load = async (file: File) => {
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) { toast('El archivo no tiene filas', true); return; }
    setRows(parsed);
    setMap(parsed[0].map((h) => {
      const n = norm(h);
      const alias: Record<string, string> = { nombre: type === 'company' ? 'name' : 'firstname', apellido: 'lastname', mail: 'email', correo: 'email', telefono: 'phone', celular: 'mobilephone', cargo: 'jobtitle', empresa: type === 'company' ? 'name' : '__company', propietario: 'owner_id', monto: 'amount', etapa: 'dealstage' };
      return targets.find((t) => norm(t.label) === n || norm(t.value) === n)?.value ?? alias[n] ?? '';
    }));
  };

  const run = async () => {
    if (!rows) return;
    const data = rows.slice(1).map((r) => {
      const o: Record<string, unknown> = {};
      map.forEach((target, i) => {
        if (!target || r[i] == null || r[i] === '') return;
        let v: unknown = r[i].trim();
        if (target === 'owner_id') v = meta.users.find((u) => norm(u.name) === norm(String(v)) || u.email === v)?.id ?? v;
        o[target] = v;
      });
      return o;
    });
    const res = { done: 0, created: 0, updated: 0, errors: [] as Array<{ row: number; error: string }> };
    setProgress({ ...res });
    for (let i = 0; i < data.length; i += 200) {
      try {
        const r = await http<{ created: number; updated: number; errors: Array<{ row: number; error: string }> }>('POST', `/import/${type}`, { rows: data.slice(i, i + 200) });
        res.created += r.created; res.updated += r.updated;
        res.errors.push(...r.errors.map((e) => ({ row: e.row + i + 1, error: e.error })));
      } catch (e) {
        res.errors.push({ row: i + 2, error: (e as Error).message });
      }
      res.done = Math.min(i + 200, data.length);
      setProgress({ ...res });
    }
    toast(`Importación terminada: ${res.created} nuevos, ${res.updated} actualizados`);
  };

  return (
    <Modal title={`Importar ${OBJECTS[type].plural.toLowerCase()}`} onClose={onClose} footer={rows && !progress ? <>
      <button className="btn" onClick={() => setRows(null)}>Otro archivo</button>
      <button className="btn primary" disabled={!map.some(Boolean)} onClick={run}>Importar {rows.length - 1} filas</button>
    </> : <button className="btn" onClick={onClose}>Cerrar</button>}>
      {!rows && <>
        <p style={{ margin: 0 }}>Subí un CSV (Excel → Guardar como CSV). La primera fila son los títulos de las columnas.</p>
        <p className="muted small" style={{ margin: 0 }}>
          {type === 'contact' ? 'Los contactos se buscan por email o teléfono: si ya existen, se completan los datos vacíos.' : type === 'company' ? 'Las empresas se buscan por dominio o nombre: si ya existen, se completan los datos vacíos.' : 'Cada fila crea un registro nuevo.'}
        </p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      </>}
      {rows && !progress && (
        <div className="stack">
          <b className="small">Relacioná cada columna con una propiedad</b>
          {rows[0].map((h, i) => (
            <div key={i} className="row">
              <span className="grow ellipsis" title={rows[1]?.[i]}>{h} <span className="muted small">· ej. {rows[1]?.[i] || '—'}</span></span>
              <Select className="input" style={{ width: 260 }} value={map[i] ?? ''} onChange={(e) => setMap(map.map((m, j) => (j === i ? e.target.value : m)))}>
                <option value="">No importar</option>
                {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </div>
          ))}
        </div>
      )}
      {progress && (
        <div className="stack">
          <div>{progress.done} de {rows!.length - 1} filas · <b>{progress.created}</b> nuevos · <b>{progress.updated}</b> actualizados</div>
          {progress.errors.length > 0 && <div className="panel panel-body small" style={{ maxHeight: 220, overflow: 'auto' }}>
            {progress.errors.map((e, i) => <div key={i}>Fila {e.row}: {e.error}</div>)}
          </div>}
        </div>
      )}
    </Modal>
  );
}
