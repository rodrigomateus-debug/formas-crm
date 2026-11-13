import { useCallback, useEffect, useState } from 'react';
import { marcarParada, pedirRuta, SinSenal, type ParadaChofer, type RecorridoChofer } from './api';
import { hhmm, simular } from '../../src/ruta';

// El recorrido de hoy (pedido de Rodrigo del 12/11/2026): las paradas en el orden que armó Logística en el Cronograma
// del CRM, con la hora aproximada de llegada, qué hay que retirar o entregar y un botón para abrir el mapa del celular.
// En cada parada el chofer marca cómo le fue: la hizo, no se pudo (con el motivo, como en las apps de reparto) o la deja
// para después. Si era una entrega, al marcarla se abre la cámara para la foto del remito firmado.
// Si no tiene recorrido asignado (o no hay señal), no se muestra nada: la app sigue siendo la de los remitos.

const TIPO: Record<string, string> = { entrega: 'Entregar', retiro_proveedor: 'Retirar', retiro_impresor: 'Retirar', egreso: 'Dejar' };
const MOTIVOS: Array<[string, string]> = [['nadie', 'No había nadie'], ['cerrado', 'Estaba cerrado'], ['direccion', 'No encontré la dirección'], ['rechazo', 'No lo quisieron recibir'], ['no_listo', 'No estaba listo'], ['otro', 'Otro motivo']];
const num = new Intl.NumberFormat('es-AR');
const CLAVE = 'chofer-ruta';
const hoy = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
function guardado(): RecorridoChofer[] {
  try { const g = JSON.parse(localStorage.getItem(CLAVE) ?? 'null') as { dia: string; r: RecorridoChofer[] } | null; return g && g.dia === hoy() && Array.isArray(g.r) ? g.r : []; } catch { return []; }
}

export function RutaHoy({ enLinea, alEntregar }: { enLinea: boolean; alEntregar: () => void }) {
  // Lo último que se trajo queda en el celular: sin señal (o si el celular recarga la app al volver de la cámara) el
  // recorrido de hoy se sigue viendo.
  const [recorridos, setRecorridos] = useState<RecorridoChofer[]>(guardado);
  const [abierta, setAbierta] = useState<string | null>(null);
  const traer = useCallback(() => pedirRuta().then((r) => { setRecorridos(r); try { localStorage.setItem(CLAVE, JSON.stringify({ dia: hoy(), r })); } catch { /* sin almacenamiento */ } }, () => undefined), []);
  useEffect(() => {
    if (!enLinea) return;
    void traer();
    const t = window.setInterval(traer, 5 * 60_000);   // Logística puede cambiar el orden durante el día
    return () => window.clearInterval(t);
  }, [enLinea, traer]);
  const conParadas = recorridos.filter((r) => r.paradas.length);
  if (!conParadas.length) return null;
  return (
    <>
      {conParadas.map((r) => {
        const base = r.base.lat != null && r.base.lng != null ? { lat: r.base.lat, lng: r.base.lng } : null;
        const sim = simular(base, r.paradas, r.salida);
        const hechas = r.paradas.filter((p) => p.visita?.resultado === 'hecho' || p.movimientos.every((m) => m.hecho)).length;
        return (
          <section key={r.n} className="ruta" aria-labelledby={`titulo-ruta-${r.n}`}>
            <h2 id={`titulo-ruta-${r.n}`}>Tu recorrido de hoy <span className="cuenta">{hechas}/{r.paradas.length}</span></h2>
            <p className="ruta-sale">Salís de {r.base.nombre} a las {hhmm(r.salida)} · volvés cerca de las {hhmm(sim.fin)}</p>
            <ol className="lista ruta-lista">
              {r.paradas.map((p, i) => {
                const s = sim.paradas[i], hecha = p.visita?.resultado === 'hecho' || p.movimientos.every((m) => m.hecho);
                const estado = hecha ? 'hecha' : p.visita?.resultado === 'no_se_pudo' ? 'fallo' : p.visita?.resultado === 'salteada' ? 'salteada' : '';
                const ver = abierta === p.clave;
                return (
                  <li key={p.clave} className={estado}>
                    <button type="button" className="ruta-parada" aria-expanded={ver} onClick={() => setAbierta(ver ? null : p.clave)}>
                      <span className="ruta-n">{hecha ? '✓' : estado === 'fallo' ? '!' : i + 1}</span>
                      <span className="ruta-quien"><strong>{p.nombre}</strong>{p.expreso && <span>Expreso: dejar para {p.expreso.cliente}{p.expreso.guia ? ` · guía ${p.expreso.guia}` : ''}</span>}<span>{p.direccion ?? 'Sin dirección: preguntale a Logística'}</span>
                        {estado === 'fallo' && <em>{MOTIVOS.find((m) => m[0] === p.visita!.motivo)?.[1] ?? 'No se pudo'}{p.visita!.nota ? `: ${p.visita!.nota}` : ''}</em>}
                        {estado === 'salteada' && <em>La dejaste para después</em>}</span>
                      <span className="ruta-hora">{s.tramo.sinUbicar ? '—' : hhmm(s.llega)}</span>
                    </button>
                    {ver && <Detalle p={p} tarde={s.tarde > 0} hecha={hecha} enLinea={enLinea} alCambiar={traer} alEntregar={alEntregar} />}
                  </li>
                );
              })}
            </ol>
            <p className="ruta-nota">Los horarios son aproximados.</p>
          </section>
        );
      })}
    </>
  );
}

function Detalle({ p, tarde, hecha, enLinea, alCambiar, alEntregar }: { p: ParadaChofer; tarde: boolean; hecha: boolean; enLinea: boolean; alCambiar: () => Promise<unknown>; alEntregar: () => void }) {
  const [paso, setPaso] = useState<'botones' | 'motivo'>('botones');
  const [motivo, setMotivo] = useState('');
  const [nota, setNota] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const esEntrega = p.movimientos.some((m) => m.tipo === 'entrega');
  const soloRetiros = p.movimientos.every((m) => m.tipo.startsWith('retiro'));
  async function marcar(resultado: 'hecho' | 'no_se_pudo' | 'salteada' | null, m?: string, n?: string) {
    setOcupado(true); setError('');
    // Una entrega hecha: directo a la foto del remito firmado. La cámara se abre ya, en el mismo toque: si se espera a que
    // conteste el servidor, el iPhone no la deja abrir.
    if (resultado === 'hecho' && esEntrega) alEntregar();
    try {
      await marcarParada(p.clave, resultado, m, n);
      await alCambiar();
      setPaso('botones');
    } catch (e) { setError(e instanceof SinSenal ? 'Sin señal: probá de nuevo cuando vuelva.' : 'No se pudo guardar. Actualizá la pantalla y probá de nuevo.'); }
    setOcupado(false);
  }
  return (
    <div className="ruta-detalle">
      <ul>
        {p.movimientos.map((m) => <li key={m.id} className={m.hecho ? 'hecho' : ''}><strong>{TIPO[m.tipo] ?? m.tipo}</strong> PDV {m.npdv ?? '—'}{m.cliente ? ` ${m.cliente}` : ''}
          {m.articulo ? ` · ${m.cantidad != null ? `${num.format(m.cantidad)} ` : ''}${m.articulo}` : ''}</li>)}
      </ul>
      {p.horario ? <p className={tarde ? 'ruta-tarde' : ''}>Reciben de {hhmm(p.horario[0])} a {hhmm(p.horario[1])}{tarde ? ': vas justo' : ''}</p> : p.lugar?.horario ? <p>Horario: {p.lugar.horario}</p> : null}
      {(p.lugar?.contacto || p.lugar?.telefono) && <p>Preguntá por {[p.lugar.contacto, p.lugar.telefono].filter(Boolean).join(' · ')}</p>}
      {p.lugar?.observaciones && <p>{p.lugar.observaciones}</p>}
      {(p.lat != null || p.direccion) && (
        <a className="boton chico" target="_blank" rel="noreferrer"
          href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat != null ? `${p.lat},${p.lng}` : encodeURIComponent(p.direccion!)}`}>Cómo llegar</a>
      )}
      {!enLinea && <p className="ruta-tarde">Sin señal no se puede marcar la parada.</p>}
      {paso === 'botones' && (hecha || p.visita ? (
        <div className="ruta-acciones">
          {hecha && esEntrega && <button type="button" className="boton principal" onClick={alEntregar}>Sacar la foto del remito</button>}
          {!hecha && <button type="button" className="boton principal" disabled={ocupado || !enLinea} onClick={() => marcar('hecho')}>{esEntrega ? 'Ahora sí: entregué' : 'Ahora sí: listo'}</button>}
          <button type="button" className="enlace" disabled={ocupado || !enLinea} onClick={() => marcar(null)}>Deshacer</button>
        </div>
      ) : (
        <div className="ruta-acciones">
          <button type="button" className="boton principal" disabled={ocupado || !enLinea} onClick={() => marcar('hecho')}>{p.expreso ? 'Dejé en el expreso: foto de la guía' : esEntrega ? 'Entregué: sacar foto del remito' : soloRetiros ? 'Retiré todo' : 'Listo'}</button>
          <button type="button" className="boton" disabled={ocupado || !enLinea} onClick={() => setPaso('motivo')}>No se pudo</button>
          <button type="button" className="enlace" disabled={ocupado || !enLinea} onClick={() => marcar('salteada')}>Dejar para después</button>
        </div>
      ))}
      {paso === 'motivo' && (
        <form className="ruta-motivo" onSubmit={(e) => { e.preventDefault(); if (motivo) void marcar('no_se_pudo', motivo, nota); }}>
          <fieldset><legend>¿Qué pasó?</legend>
            {MOTIVOS.filter(([k]) => (k === 'no_listo' ? !esEntrega : k === 'rechazo' ? esEntrega : true)).map(([k, t]) => (
              <label key={k} className={motivo === k ? 'elegido' : ''}><input type="radio" name={`motivo-${p.clave}`} checked={motivo === k} onChange={() => setMotivo(k)} />{t}</label>))}
          </fieldset>
          <input className="campo" value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Algo más para Logística (opcional)" aria-label="Nota para Logística" maxLength={300} />
          <div className="ruta-acciones"><button type="submit" className="boton principal" disabled={!motivo || ocupado}>Avisar a Logística</button><button type="button" className="enlace" onClick={() => setPaso('botones')}>Volver</button></div>
        </form>
      )}
      {error && <p className="ruta-tarde" role="alert">{error}</p>}
    </div>
  );
}
