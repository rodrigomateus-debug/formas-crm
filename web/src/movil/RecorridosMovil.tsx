import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { http, useToast, Icon } from '../lib';
import { lindo } from '../pages/Cronograma';
import {
  ListaEncargos, EncargoModal, ElegirDestino, ElegirDia, DestinoElegido, Items, cuando, proximoHabil, vacio,
  type DestinoOpcion, type Encargo, type ItemForm, type Sugerencias,
} from '../pages/Recorridos';

// Recorridos en el celular (versión celular, perfil Ventas): «Nuevo encargo» bien a mano y la lista de los suyos. El
// encargo se carga en un asistente a pantalla completa, un paso por pantalla: ¿A dónde? → ¿Qué día? → ¿Qué hay que hacer?
// Usa las mismas piezas que el de escritorio (Recorridos.tsx), así las sugerencias y el «Ya van» son los mismos.

export function RecorridosMovil() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const abierto = Number(sp.get('encargo')) || null;
  const [version, setVersion] = useState(0);
  const cerrar = useCallback(() => setSp((p) => { const n = new URLSearchParams(p); n.delete('encargo'); return n; }, { replace: true }), [setSp]);
  return (
    <div className="m-pag">
      <div className="m-pag-cab"><h1>Recorridos</h1></div>
      <button type="button" className="btn primary m-grande" onClick={() => navigate('/recorridos/nuevo')}><Icon name="plus" size={18} />Nuevo encargo</button>
      <div className="m-rc-lista">
        <ListaEncargos version={version} onAbrir={(id) => setSp((p) => { const n = new URLSearchParams(p); n.set('encargo', String(id)); return n; }, { replace: true })} />
      </div>
      {abierto && <EncargoModal id={abierto} onClose={cerrar} onListo={() => { cerrar(); setVersion((v) => v + 1); }} />}
    </div>
  );
}

const PASOS = ['¿A dónde?', '¿Qué día?', '¿Qué hay que hacer?'];

export function EncargoAsistente() {
  const navigate = useNavigate();
  const toast = useToast();
  // Desde la ficha de un cliente («Encargo»): el destino ya elegido, se arranca en el día.
  const desde = (useLocation().state as { destino?: DestinoOpcion } | null)?.destino ?? null;
  const [paso, setPaso] = useState(desde ? 1 : 0);
  const [sug, setSug] = useState<Sugerencias | null>(null);
  const [destino, setDestino] = useState<DestinoOpcion | null>(desde);
  const [fecha, setFecha] = useState(proximoHabil());
  const [llevar, setLlevar] = useState<ItemForm[]>([vacio()]);
  const [retirar, setRetirar] = useState<ItemForm[]>([vacio()]);
  const [extra, setExtra] = useState({ desde: '', hacia: '', horario: '', contacto: '', notas: '', urgente: false, record_id: null as number | null });
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { http<Sugerencias>('GET', '/recorridos/sugerencias').then(setSug, () => setSug({ frecuentes: [], de_pedidos: [], bases: [], organiza: false })); }, []);
  // Cada paso arranca arriba de todo.
  const cuerpo = useRef<HTMLDivElement>(null);
  useEffect(() => { cuerpo.current?.scrollTo(0, 0); }, [paso]);

  const elegir = (d: DestinoOpcion) => {
    setDestino(d);
    setExtra((x) => ({ ...x, record_id: x.record_id ?? d.record_id ?? null, contacto: x.contacto || (d.contacto && /[a-z]/i.test(d.contacto) ? d.contacto : '') }));
    setPaso(1);
  };
  const atras = () => (paso === 0 || (desde && paso === 1) ? navigate(-1) : setPaso(paso - 1));
  const hayAlgo = [...llevar, ...retirar].some((i) => i.que.trim() || i.pdv) || !!extra.notas.trim();

  async function guardar() {
    if (!destino) { setPaso(0); return; }
    if (!hayAlgo) { setError('Contá qué hay que llevar o retirar (o dejá una nota).'); return; }
    setOcupado(true); setError('');
    try {
      const r = await http<Encargo>('POST', '/recorridos/encargos', {
        fecha, llevar: llevar.filter((i) => i.que.trim() || i.pdv), retirar: retirar.filter((i) => i.que.trim() || i.pdv), ...extra,
        desde: extra.desde || null, hacia: extra.hacia || null,
        destino: { lugar_id: destino.lugar_id, company_id: destino.company_id, nombre: destino.nombre, direccion: destino.direccion, guardar: destino.tipo === 'suelto' && !!(destino as DestinoOpcion & { guardar?: boolean }).guardar },
      });
      toast(`Listo: ${lindo(r.destino)}, ${cuando(r.fecha).toLowerCase()}. Logística lo ve en el cronograma.`);
      if (desde) navigate(-1); else navigate('/recorridos', { replace: true });
    } catch (e) { setError((e as Error).message); setOcupado(false); }
  }

  const bases = sug?.bases ?? [];
  return (
    <div className="m-asis">
      <header className="m-asis-cab">
        <button type="button" className="btn ghost icon" onClick={atras} aria-label={paso === 0 || (desde && paso === 1) ? 'Salir' : 'Paso anterior'}><Icon name={paso === 0 || (desde && paso === 1) ? 'x' : 'chevron'} size={22} /></button>
        <div className="m-asis-tit"><b>Nuevo encargo</b><small>Paso {paso + 1} de 3 · {PASOS[paso]}</small></div>
        <span style={{ width: 36 }} />
        <div className="m-asis-barra" aria-hidden="true"><i style={{ width: `${((paso + 1) / 3) * 100}%` }} /></div>
      </header>

      <div className="m-asis-cuerpo rc-modal" ref={cuerpo}>
        {paso === 0 && (
          <section className="rc-paso">
            <h3>¿A dónde tiene que ir el chofer?</h3>
            <ElegirDestino sug={sug} onElegir={elegir} />
          </section>
        )}
        {paso === 1 && destino && (
          <section className="rc-paso">
            <DestinoElegido d={destino} editable onCambiar={() => setPaso(0)} />
            <h3>¿Qué día?</h3>
            <ElegirDia destino={destino} fecha={fecha} editable onFecha={setFecha} />
          </section>
        )}
        {paso === 2 && destino && (
          <section className="rc-paso">
            <div className="m-asis-resumen"><b>{lindo(destino.nombre)}</b><span>{cuando(fecha)}</span>
              <button type="button" className="m-link" onClick={() => setPaso(1)}>Cambiar</button></div>
            <Items titulo="Llevar" ayuda="Lo que el chofer deja ahí" items={llevar} onChange={setLlevar} editable />
            <Items titulo="Retirar" ayuda="Lo que el chofer trae" items={retirar} onChange={setRetirar} editable />
            <label className="field">Nota para Logística y el chofer<textarea className="input" rows={2} value={extra.notas} onChange={(e) => setExtra({ ...extra, notas: e.target.value })} placeholder="Para Delfina, dejar en recepción…" maxLength={1000} /></label>
            <label className="m-switch"><input type="checkbox" checked={extra.urgente} onChange={(e) => setExtra({ ...extra, urgente: e.target.checked })} /><span>Tiene que ir sí o sí ese día</span></label>
            <details className="m-mas-datos">
              <summary>Más datos (horario, a quién preguntar, de dónde sale)</summary>
              <label className="field">Horario<input className="input" value={extra.horario} onChange={(e) => setExtra({ ...extra, horario: e.target.value })} placeholder="10 a 16, después del mediodía…" maxLength={120} /></label>
              <label className="field">Preguntar por<input className="input" value={extra.contacto} onChange={(e) => setExtra({ ...extra, contacto: e.target.value })} placeholder="Nombre y teléfono" maxLength={200} /></label>
              {bases.length > 0 && llevar.some((i) => i.que.trim()) && (
                <div className="rc-base"><span className="small muted">Lo que hay que llevar está en</span>
                  {bases.map((b) => <button key={b.id} type="button" className={`chip${(extra.desde || bases[0].id) === b.id ? ' on' : ''}`} onClick={() => setExtra({ ...extra, desde: b.id })}>{b.nombre}</button>)}</div>
              )}
              {bases.length > 0 && retirar.some((i) => i.que.trim()) && (
                <div className="rc-base"><span className="small muted">Lo que se retira va a</span>
                  {bases.map((b) => <button key={b.id} type="button" className={`chip${(extra.hacia || bases[0].id) === b.id ? ' on' : ''}`} onClick={() => setExtra({ ...extra, hacia: b.id })}>{b.nombre}</button>)}</div>
              )}
            </details>
            {error && <div className="aviso warn small">{error}</div>}
          </section>
        )}
      </div>

      {paso > 0 && (
        <footer className="m-asis-pie">
          {paso === 1 && <button type="button" className="btn primary m-grande" onClick={() => setPaso(2)}>Siguiente: qué hay que hacer</button>}
          {paso === 2 && <button type="button" className="btn primary m-grande" disabled={ocupado || !hayAlgo} onClick={guardar}>{ocupado ? 'Cargando…' : 'Cargar encargo'}</button>}
        </footer>
      )}
    </div>
  );
}
