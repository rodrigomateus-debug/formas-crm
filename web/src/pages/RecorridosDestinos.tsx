import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Link } from 'react-router-dom';
import { http, useMeta, useToast, Icon, fmtRelative, Cargando, whatsappUrl, recordUrl } from '../lib';
import { Avatar, InfoTip, Modal, RecordPicker } from '../components';
import { Select } from '../Select';
import { lindo } from './Cronograma';
import { BuscarDireccion, type Sugerencia } from './Direcciones';
import { CABA, PROVINCIAS, localidadesDe, normalizarUbicacion } from '../localidades';

// La pestaña Destinos de Recorridos (rediseñada el 18/11/2026, ver docs/RECORRIDOS.md): la base de destinos con la
// dirección en partes (calle y altura, localidad, provincia), el tipo (cliente, proveedor, impresor, taller, expreso), el
// contacto con su WhatsApp, los viajes, las empresas con varias sucursales juntas y el mapa: al tocar una dirección, el
// mapa va a ese lugar (y si no está ubicado, se lo puede ubicar a mano arrastrando el pin).

// Cuántos destinos (o empresas con sus sucursales) se ven de entrada: los más visitados.
const TOPE = 100;
export const TIPOS = [
  ['cliente', 'Cliente', '#2f6fdf'], ['proveedor', 'Proveedor', '#7b4fd6'], ['impresor', 'Impresor', '#d9731a'],
  ['taller', 'Taller', '#c2408a'], ['expreso', 'Expreso', '#14918a'], ['otro', 'Otro', '#6b7280'],
] as const;
type Tipo = (typeof TIPOS)[number][0];
const tipoDe = (t: string | null) => TIPOS.find((x) => x[0] === t);
const ORIGEN_TIPO: Record<string, string> = { manual: 'Puesto a mano', crm: 'Por la empresa del CRM', expreso: 'Es un expreso del cronograma', nombre: 'Por el nombre', ia: 'Lo dedujo la IA' };
const FALTA: Record<string, string> = { direccion: 'dirección', localidad: 'localidad', provincia: 'provincia', mapa: 'ubicación en el mapa', contacto: 'teléfono o WhatsApp', tipo: 'tipo' };

interface DirIA { direccion: string | null; localidad: string | null; provincia: string | null; confianza?: number }
export interface Destino {
  id: number; nombre: string; sucursal: string | null; tipo: Tipo | null; tipo_origen: string | null; grupo_id: number | null; company_id: number | null; empresa: string | null; dominio?: string | null; empresa_origen?: string | null;
  direccion: string | null; localidad: string | null; provincia: string | null; codigo_postal: string | null; zona: string | null; completa: string; place_id: string | null;
  lat: number | null; lng: number | null; mapa: 'ok' | 'sin_buscar' | 'no_encontrado' | 'sin_direccion'; punto_manual: boolean;
  horario: string | null; contacto: string | null; telefono: string | null; whatsapp: string | null; email: string | null; observaciones: string | null;
  viajes: { seis: number; total: number; ultimo: string | null; proximo: string | null };
  origen: string; editado: boolean; faltan: string[];
  ia_estado: 'corregido' | 'ok' | 'dudoso' | null; ia_nota: string | null; ia_antes: DirIA | null; ia_sugerida: DirIA | null; puede_editar: boolean; puede_borrar: boolean;
}
interface Grupo { id: number; nombre: string; tipo: Tipo | null; company_id: number | null; empresa?: string | null; dominio?: string | null; empresa_origen?: string | null; n: number }
// La empresa del CRM de un destino o de un grupo (su logo sale del dominio).
interface EmpresaCRM { id: number; nombre: string; dominio: string | null; origen?: string | null }
const empresaDe = (x: { company_id: number | null; empresa?: string | null; dominio?: string | null; empresa_origen?: string | null }): EmpresaCRM | null =>
  (x.company_id && x.empresa ? { id: x.company_id, nombre: x.empresa, dominio: x.dominio ?? null, origen: x.empresa_origen } : null);
const ORIGEN_EMPRESA: Record<string, string> = { nombre: 'Se relacionó sola porque se llama igual', grupo: 'Es la empresa de su grupo', manual: 'Elegida a mano' };
interface Datos {
  total: number; organiza: boolean; ia: boolean; maps: boolean; copia: { at: number; filas: number; error: string | null };
  resumen: { en_mapa: number; completos: number; sin_buscar: number; para_revisar: number };
  grupos: Grupo[]; sugeridos: Array<{ nombre: string; ids: number[]; grupo_id: number | null }>; destinos: Destino[];
}
interface ResultadoIA { revisados: number; corregidos: unknown[]; dudosos: unknown[]; pendientes: number; google: boolean }

const textoDir = (d: DirIA) => [d.direccion, d.localidad, d.provincia].filter(Boolean).join(', ');
export const linkGoogleMaps = (d: Pick<Destino, 'completa' | 'place_id' | 'lat' | 'lng'>) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.completa || (d.lat != null ? `${d.lat},${d.lng}` : ''))}${d.place_id ? `&query_place_id=${encodeURIComponent(d.place_id)}` : ''}`;
const linkWhatsapp = (d: Destino) => {
  const u = whatsappUrl(d.whatsapp || d.telefono);
  if (!u) return undefined;
  const nombre = d.contacto?.split(/[\s,(]/)[0];
  return `${u}?text=${encodeURIComponent(`Hola${nombre ? ` ${nombre}` : ''}! Te escribo de Formas Publicitarias.`)}`;
};
// En la tabla, la provincia corta («Ciudad Autónoma de Buenos Aires» es CABA); completa, en el destino.
const provCorta = (p: string) => (/ciudad aut[oó]noma|capital federal/i.test(p) ? 'CABA' : p.replace(/^provincia de /i, ''));
const fechaCorta = (f: string) => `${Number(f.slice(8))}/${Number(f.slice(5, 7))}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function TipoTag({ tipo, origen }: { tipo: Tipo | null; origen?: string | null }) {
  const t = tipoDe(tipo);
  if (!t) return <span className="ds-tipo vacio" title="Sin tipo">Sin tipo</span>;
  return <span className="ds-tipo" style={{ '--c': t[2] } as React.CSSProperties} title={origen ? ORIGEN_TIPO[origen] : undefined}>{t[1]}</span>;
}

type Filtro = 'top' | 'todos' | Tipo | 'sin_tipo';   // top: los más visitados (el filtro de entrada)
export function DestinosTab({ admin, slot }: { admin?: ReactNode; slot?: HTMLElement | null }) {
  const { meta } = useMeta();
  const toast = useToast();
  const [datos, setDatos] = useState<Datos | null>(null);
  const [v, setV] = useState(0);
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('top');
  const [incompletos, setIncompletos] = useState(false);
  const [revisar, setRevisar] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [foco, setFoco] = useState<number | null>(null);
  const [config, setConfig] = useState(false);
  // El mapa es opcional («Ver mapa»): se abre a la derecha de la tabla y queda recordado en este navegador.
  const [verMapa, setVerMapaYa] = useState(() => { try { return localStorage.getItem('crm.destinos.mapa') === '1'; } catch { return false; } });
  const setVerMapa = (x: boolean) => { setVerMapaYa(x); try { localStorage.setItem('crm.destinos.mapa', x ? '1' : '0'); } catch { /* ignorar */ } };
  const [ubicando, setUbicando] = useState<{ id: number; lat: number; lng: number } | null>(null);
  const [editando, setEditando] = useState<Destino | 'nuevo' | null>(null);
  const [borrando, setBorrando] = useState<Destino | null>(null);
  const [grupoAbierto, setGrupoAbierto] = useState<Grupo | null>(null);
  const [agrupando, setAgrupando] = useState<{ ids: number[]; nombre: string; grupo_id: number | null } | null>(null);
  const [verSugeridos, setVerSugeridos] = useState(false);
  const [descartados, setDescartados] = useState<Set<string>>(new Set());
  const [verTodos, setVerTodos] = useState(false);   // la lista y el mapa con todos, no solo los más visitados
  const [ia, setIa] = useState<{ corriendo: boolean; corregidos: number; dudosos: number; pendientes: number; google: boolean } | null>(null);
  const frenar = useRef(false);
  const buscandoMapa = useRef(false);

  useEffect(() => {
    let vivo = true;
    http<Datos>('GET', '/recorridos/libreta').then((d) => { if (vivo) setDatos(d); }, (e) => toast((e as Error).message, true));
    return () => { vivo = false; };
  }, [v, toast]);
  // Las direcciones que nunca se buscaron en el mapa se buscan de fondo, de a pocas (el buscador pide 1 por segundo).
  useEffect(() => {
    if (!datos?.resumen.sin_buscar || buscandoMapa.current) return;
    buscandoMapa.current = true;
    (async () => {
      try { for (let i = 0; i < 60; i++) { const r = await http<{ pendientes: number }>('POST', '/recorridos/libreta/mapa'); if (!r.pendientes) break; if (i % 3 === 2) setV((x) => x + 1); } }
      catch { /* se intenta la próxima vez */ }
      buscandoMapa.current = false;
      setV((x) => x + 1);
    })();
  }, [datos?.resumen.sin_buscar]);

  const organiza = !!datos?.organiza;
  const recargar = () => setV((x) => x + 1);
  const porId = useMemo(() => new Map((datos?.destinos ?? []).map((d) => [d.id, d])), [datos]);
  const visibles = useMemo(() => {
    if (!datos) return [];
    const t = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const gnombre = new Map(datos.grupos.map((g) => [g.id, `${g.nombre} ${g.empresa ?? ''}`]));
    return datos.destinos.filter((d) => {
      if (filtro === 'sin_tipo' ? d.tipo : filtro !== 'todos' && filtro !== 'top' && d.tipo !== filtro) return false;
      if (incompletos && !d.faltan.length) return false;
      if (revisar && d.ia_estado !== 'dudoso') return false;
      if (!t) return true;
      return [d.nombre, d.sucursal, d.direccion, d.localidad, d.provincia, d.contacto, d.empresa, d.grupo_id ? gnombre.get(d.grupo_id) : null]
        .some((x) => x && x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(t));
    });
  }, [datos, q, filtro, incompletos, revisar]);
  // Los bloques de la tabla: cada grupo (empresa) con sus destinos, y los sueltos; los más visitados primero.
  const bloques = useMemo(() => {
    if (!datos) return [];
    const porGrupo = new Map<number, Destino[]>();
    const sueltos: Destino[] = [];
    for (const d of visibles) { if (d.grupo_id) porGrupo.set(d.grupo_id, [...(porGrupo.get(d.grupo_id) ?? []), d]); else sueltos.push(d); }
    const orden = (d: Destino[]) => d.reduce((s, x) => s + x.viajes.total, 0);
    const lista: Array<{ grupo: Grupo | null; destinos: Destino[] }> = [
      ...[...porGrupo].map(([id, ds]) => ({ grupo: datos.grupos.find((g) => g.id === id) ?? null, destinos: ds.sort((a, b) => b.viajes.total - a.viajes.total) })),
      ...sueltos.map((d) => ({ grupo: null, destinos: [d] })),
    ];
    return lista.sort((a, b) => orden(b.destinos) - orden(a.destinos) || (a.grupo?.nombre ?? a.destinos[0].nombre).localeCompare(b.grupo?.nombre ?? b.destinos[0].nombre));
  }, [datos, visibles]);
  // «100 más visitados» (el filtro de entrada; pedido de Rodrigo del 18/11/2026): los bloques ya vienen con los más
  // visitados primero. Si se busca algo, se busca en todos.
  const mostrados = useMemo(() => (filtro === 'top' && !q.trim() ? bloques.slice(0, TOPE) : bloques), [bloques, filtro, q]);
  // Para el pie: cuántas direcciones (cada sucursal cuenta) y cuántos grupos (empresas con sucursales) se ven.
  const nDirecciones = mostrados.reduce((n, b) => n + b.destinos.length, 0), nGrupos = mostrados.filter((b) => b.grupo).length;
  // El mapa, con muchos puntos (los vuelve a dibujar en cada clic), se pone lento: si la lista tiene más de 100, el mapa
  // muestra los 100 primeros salvo que se pida ver todos. El elegido se ve siempre, aunque no esté entre ellos.
  const mapaTope = !verTodos && mostrados.length > TOPE;
  const enMapa = useMemo(() => {
    if (!mapaTope) return mostrados.flatMap((b) => b.destinos);
    const top = mostrados.slice(0, TOPE);
    const elegido = foco != null && !top.some((b) => b.destinos.some((d) => d.id === foco)) ? mostrados.find((b) => b.destinos.some((d) => d.id === foco)) : null;
    return (elegido ? [...top, elegido] : top).flatMap((b) => b.destinos);
  }, [mostrados, mapaTope, foco]);
  // De a 40 por página (un grupo cuenta como uno): dibujar miles de filas de una traba la página. La búsqueda y los
  // filtros buscan en todos.
  const POR_PAGINA = 40;
  const [pagina, setPagina] = useState(1);
  useEffect(() => setPagina(1), [q, filtro, incompletos, revisar, verTodos]);
  const paginas = Math.max(1, Math.ceil(mostrados.length / POR_PAGINA));
  const pag = Math.min(pagina, paginas);
  const enPagina = mostrados.slice((pag - 1) * POR_PAGINA, pag * POR_PAGINA);
  // Tocar un punto del mapa lleva a la página donde está ese destino.
  const irA = (id: number) => { const i = mostrados.findIndex((b) => b.destinos.some((d) => d.id === id)); if (i >= 0) setPagina(Math.floor(i / POR_PAGINA) + 1); };
  useEffect(() => { document.querySelector('.ds-tabla')?.scrollTo({ top: 0 }); }, [pag]);
  const sugeridos = (datos?.sugeridos ?? []).filter((s) => !descartados.has(s.ids.join(',')));
  const completarIA = async () => {
    frenar.current = false;
    const acum = { corriendo: true, corregidos: 0, dudosos: 0, pendientes: 0, google: false };
    setIa({ ...acum });
    try {
      for (let vuelta = 0; vuelta < 200 && !frenar.current; vuelta++) {
        const r = await http<ResultadoIA>('POST', '/recorridos/libreta/ia', {});
        acum.corregidos += r.corregidos.length; acum.dudosos += r.dudosos.length; acum.pendientes = r.pendientes; acum.google = r.google;
        setIa({ ...acum });
        if (vuelta % 2 === 1) recargar();
        if (!r.pendientes || !r.revisados) break;
      }
      toast(`Listo: ${acum.corregidos} destinos completados, ${acum.dudosos} para revisar.`);
    } catch (e) { toast((e as Error).message, true); }
    setIa({ ...acum, corriendo: false });
    recargar();
  };
  const traerPlanilla = async () => {
    try { const r = await http<{ filas: number; error: string | null }>('POST', '/cronograma/lugares/actualizar'); toast(r.error ? `No se pudo traer la planilla: ${r.error}` : `Listo: ${r.filas} destinos de la planilla.`, !!r.error); recargar(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const agruparYa = async (b: { ids: number[]; nombre?: string; grupo_id?: number | null; tipo?: string | null }) => {
    try { await http('POST', '/recorridos/grupos', b); toast('Destinos agrupados.'); setSel(new Set()); setAgrupando(null); recargar(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const guardarPunto = async () => {
    if (!ubicando) return;
    const d = porId.get(ubicando.id);
    if (!d) return;
    try { await http('PUT', '/cronograma/punto', { direccion: d.completa, lat: ubicando.lat, lng: ubicando.lng }); toast('Ubicación guardada: también la usa la ruta del cronograma.'); setUbicando(null); recargar(); }
    catch (e) { toast((e as Error).message, true); }
  };
  // Tocar una dirección abre el mapa (si estaba cerrado). En el celular el mapa queda arriba de la lista: se sube hasta él.
  const enfocar = (d: Destino, desdeMapa = false) => {
    setFoco(d.id); if (ubicando && ubicando.id !== d.id) setUbicando(null);
    if (desdeMapa) return;
    if (!verMapa) setVerMapa(true);
    if (window.matchMedia('(max-width: 860px)').matches) setTimeout(() => document.querySelector('.ds-mapa-col')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const marcar = (ids: number[], on: boolean) => setSel((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });

  if (!datos) return <Cargando />;
  const enfocado = foco != null ? porId.get(foco) ?? null : null;
  const pct = (n: number) => (datos.total ? Math.round((n / datos.total) * 100) : 0);
  const filtrando = !!q.trim() || (filtro !== 'todos' && filtro !== 'top') || incompletos || revisar;
  const conteo = (t: Filtro) => datos.destinos.filter((d) => (t === 'todos' || t === 'top' ? true : t === 'sin_tipo' ? !d.tipo : d.tipo === t)).length;

  return (
    <>
      <div className="toolbar ds-toolbar">
        <div className="search ds-buscar"><Icon name="search" />
          <input className="input" placeholder="Buscar nombre, calle, localidad, contacto…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar destinos" />
        </div>
        <div className="ds-chips" role="tablist" aria-label="Tipo de destino">
          {(['top', 'todos', ...TIPOS.map((t) => t[0]), 'sin_tipo'] as Filtro[]).map((t) => {
            if (t === 'top') return datos.destinos.length > TOPE || filtro === 'top' ? <button key={t} type="button" role="tab" aria-selected={filtro === t} className={`ds-chip${filtro === t ? ' on' : ''}`}
              onClick={() => setFiltro(t)} title="Los destinos (y empresas con sucursales) con más viajes. El buscador busca en todos.">{TOPE} más visitados</button> : null;
            const n = conteo(t);
            if (!n && t !== 'todos') return null;
            const info = tipoDe(t);
            return <button key={t} type="button" role="tab" aria-selected={filtro === t} className={`ds-chip${filtro === t ? ' on' : ''}`} style={info ? { '--c': info[2] } as React.CSSProperties : undefined}
              onClick={() => setFiltro(t)}>{info && <i />}{t === 'todos' ? 'Todos' : t === 'sin_tipo' ? 'Sin tipo' : info![1]}<span>{n}</span></button>;
          })}
        </div>
      </div>
      {(() => { const b = <>
        <button type="button" className={`btn sm qf-btn${verMapa ? ' on' : ''}`} aria-pressed={verMapa} onClick={() => setVerMapa(!verMapa)}
          title={verMapa ? 'Cerrar el mapa' : 'Ver los destinos en el mapa, a la derecha de la lista'}><Icon name="pin" size={14} />{verMapa ? 'Ocultar mapa' : 'Ver mapa'}</button>
        {organiza && datos.ia && (
          <button type="button" className="btn sm" disabled={ia?.corriendo} onClick={completarIA}
            title="Claude completa la localidad, la provincia, la dirección para el mapa y el tipo. Solo cambia lo que está al menos 90 % seguro; lo demás queda «Para revisar».">
            <Icon name="spark" size={14} />{ia?.corriendo ? 'Revisando…' : 'Completar con IA'}</button>
        )}
        {admin && <button type="button" className="btn sm ghost" onClick={() => setConfig(true)} title="Configuración (administradores)" aria-label="Configuración (administradores)"><Icon name="settings" size={14} /></button>}
        {meta.me.role !== 'viewer' && <button type="button" className="btn sm primary" onClick={() => setEditando('nuevo')}><Icon name="plus" size={14} />Nuevo destino</button>}
      </>; return slot ? createPortal(b, slot) : <div className="row ds-acciones-top">{b}</div>; })()}
      {/* El resumen, en un renglón: los números, «para revisar», «solo incompletos», las empresas por agrupar y el tope. */}
      <div className="ds-resumen small muted">
        <span><b>{datos.total}</b> destinos · <b>{pct(datos.resumen.en_mapa)} %</b> en el mapa · <b>{pct(datos.resumen.completos)} %</b> completos · <b>{datos.grupos.length}</b> con sucursales</span>
        <InfoTip label="Qué significan los números">
          <p><b>En el mapa:</b> con el punto ubicado. <b>Completos:</b> con dirección, localidad, provincia, mapa, teléfono y tipo. <b>Con sucursales:</b> empresas con varias direcciones agrupadas.</p>
          <p>Tocá una dirección para verla en el mapa.</p>
        </InfoTip>
        {datos.resumen.para_revisar > 0 && <button type="button" className={`ds-resumen-btn${revisar ? ' on' : ''}`} aria-pressed={revisar} onClick={() => setRevisar(!revisar)}><b>{datos.resumen.para_revisar}</b> para revisar</button>}
        <label className="row ds-check"><input type="checkbox" checked={incompletos} onChange={(e) => setIncompletos(e.target.checked)} />Solo incompletos</label>
        {organiza && sugeridos.length > 0 && (
          <button type="button" className="cr-link" onClick={() => setVerSugeridos(!verSugeridos)}>
            <Icon name="merge" size={13} /> {sugeridos.length} por agrupar{verSugeridos ? ' (ocultar)' : ''}</button>
        )}
      </div>
      {ia && (
        <p className="small muted ds-nota">{ia.corriendo ? 'La IA está revisando los destinos… ' : 'IA: '}{ia.corregidos} completados · {ia.dudosos} para revisar{ia.corriendo && ia.pendientes ? ` · faltan ${ia.pendientes}` : ''}
          {ia.corriendo && <> · <button type="button" className="cr-link" onClick={() => { frenar.current = true; }}>Frenar</button></>}</p>
      )}

      {organiza && verSugeridos && sugeridos.length > 0 && (
        <div className="ds-sugeridos">
            <ul>
              {sugeridos.map((s) => (
                <li key={s.ids.join(',')}>
                  <div className="grow"><b>{lindo(s.nombre)}</b>{s.grupo_id && <span className="muted small"> (ya es un grupo: sumar)</span>}
                    <div className="small muted">{s.ids.map((id) => porId.get(id)).filter(Boolean).map((d) => `${lindo(d!.nombre)}${d!.localidad ? ` (${d!.localidad})` : ''}`).join(' · ')}</div></div>
                  <button type="button" className="btn sm" onClick={() => setAgrupando({ ids: s.ids, nombre: s.nombre, grupo_id: s.grupo_id })}>Agrupar</button>
                  <button type="button" className="btn sm ghost" onClick={() => setDescartados((x) => new Set([...x, s.ids.join(',')]))}>No son la misma</button>
                </li>
              ))}
            </ul>
        </div>
      )}

      {sel.size > 0 && (
        <div className="ds-seleccion">
          <span><b>{sel.size}</b> {sel.size === 1 ? 'destino elegido' : 'destinos elegidos'}</span>
          {organiza && <button type="button" className="btn sm primary" onClick={() => setAgrupando({ ids: [...sel], nombre: lindo(porId.get([...sel][0])?.nombre ?? ''), grupo_id: null })}><Icon name="merge" size={14} />Agrupar como una empresa</button>}
          <button type="button" className="btn sm ghost" onClick={() => setSel(new Set())}>Deseleccionar</button>
        </div>
      )}

      <div className="ds-layout">
        <div className="ds-tabla table-wrap">
          <table className="grid">
            <thead><tr>
              {organiza && <th className="nosort ds-sel" aria-label="Elegir" />}
              <th className="nosort">Destino</th><th className="nosort">Dirección</th><th className="nosort ds-col-loc">Localidad</th><th className="nosort ds-col-loc">Provincia</th>
              <th className="nosort">Contacto</th><th className="nosort numcol" title="Viajes en los últimos 6 meses (y en total)">Viajes</th>
              <th className="nosort ds-acciones" aria-label="Acciones" />
            </tr></thead>
            <tbody>
              {enPagina.map((b) => b.grupo ? (
                <GrupoFilas key={`g${b.grupo.id}`} grupo={b.grupo} destinos={b.destinos} organiza={organiza} sel={sel} foco={foco} onMarcar={marcar} onFoco={enfocar}
                  onEditar={setEditando} onBorrar={setBorrando} onGrupo={() => setGrupoAbierto(b.grupo)} />
              ) : (
                <FilaDestino key={b.destinos[0].id} d={b.destinos[0]} organiza={organiza} sel={sel.has(b.destinos[0].id)} foco={foco === b.destinos[0].id}
                  onMarcar={(on) => marcar([b.destinos[0].id], on)} onFoco={() => enfocar(b.destinos[0])} onEditar={() => setEditando(b.destinos[0])} onBorrar={() => setBorrando(b.destinos[0])} />
              ))}
              {!bloques.length && <tr><td colSpan={organiza ? 8 : 7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No hay destinos con ese filtro.</td></tr>}
            </tbody>
          </table>
        </div>
        {verMapa && <aside className="ds-mapa-col">
          <MapaDestinos destinos={enMapa} foco={enfocado} ubicando={ubicando} onElegir={(id) => { const d = porId.get(id); if (d) { enfocar(d, true); irA(id); document.getElementById(`ds-fila-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }}
            onMover={(lat, lng) => setUbicando((u) => (u ? { ...u, lat, lng } : u))} />
          {enfocado ? (
            <FichaMapa d={enfocado} organiza={organiza} ubicando={ubicando?.id === enfocado.id} onUbicar={(lat, lng) => setUbicando({ id: enfocado.id, lat, lng })}
              onGuardar={guardarPunto} onCancelar={() => setUbicando(null)} onEditar={() => setEditando(enfocado)} />
          ) : datos.resumen.sin_buscar > 0 ? <p className="small muted ds-ficha">Buscando {datos.resumen.sin_buscar} direcciones en el mapa…</p> : null}
          {mostrados.length > TOPE && (
            <p className="small muted ds-mapa-tope">{mapaTope ? `En el mapa: los ${TOPE} más visitados.` : `En el mapa: los ${mostrados.length}.`}{' '}
              <button type="button" className="cr-link" onClick={() => setVerTodos(!verTodos)}>{mapaTope ? 'Ver todos' : 'Solo los más visitados'}</button>
              <InfoTip label="Por qué no se ven todos">Con miles de puntos el mapa se pone lento. La lista muestra todos.</InfoTip></p>
          )}
        </aside>}
      </div>
      <nav className="ds-paginas" aria-label="Páginas">
        <span className="small muted ds-pag-cuenta">{mostrados.length ? <>
          <b>{nDirecciones.toLocaleString('es-AR')}</b> {nDirecciones === 1 ? 'dirección' : 'direcciones'}{nGrupos > 0 && <> · <b>{nGrupos.toLocaleString('es-AR')}</b> {nGrupos === 1 ? 'grupo' : 'grupos'}</>}
          {paginas > 1 && ` · filas ${(pag - 1) * POR_PAGINA + 1}–${Math.min(pag * POR_PAGINA, mostrados.length)} de ${mostrados.length.toLocaleString('es-AR')}`}</> : 'Sin destinos'}</span>
        <InfoTip label="Planilla DESTINOS">
          <p>La libreta de Logística se copia de la planilla DESTINOS una vez por día, sin pisar lo que se corrige acá.</p>
          {datos.copia.at > 0 && <p>Última copia: {fmtRelative(new Date(datos.copia.at).toISOString())}.{datos.copia.error ? ` Error: ${datos.copia.error}` : ''}</p>}
        </InfoTip>
        {organiza && <button type="button" className="cr-link small" onClick={traerPlanilla}>Traer planilla</button>}
        <span className="grow" />
        {paginas > 1 && <Paginas pag={pag} paginas={paginas} onIr={setPagina} />}
      </nav>


      {editando && <EditarDestino d={editando === 'nuevo' ? null : editando} grupos={datos.grupos} organiza={organiza} maps={datos.maps}
        onClose={() => setEditando(null)} onListo={(id) => { setEditando(null); if (id) setFoco(id); recargar(); }} onBorrar={(d) => { setEditando(null); setBorrando(d); }} />}
      {borrando && <BorrarDestino d={borrando} onClose={() => setBorrando(null)} onListo={() => { if (foco === borrando.id) setFoco(null); setSel((s) => { const n = new Set(s); n.delete(borrando.id); return n; }); setBorrando(null); recargar(); }} />}
      {grupoAbierto && <EditarGrupo g={grupoAbierto} destinos={datos.destinos.filter((d) => d.grupo_id === grupoAbierto.id)} onClose={() => setGrupoAbierto(null)} onListo={() => { setGrupoAbierto(null); recargar(); }} />}
      {config && <Modal title="Configuración de Recorridos" onClose={() => setConfig(false)} wide>{admin}</Modal>}
      {agrupando && <Agrupar ini={agrupando} grupos={datos.grupos} destinos={agrupando.ids.map((id) => porId.get(id)).filter((d): d is Destino => !!d)} onClose={() => setAgrupando(null)} onAgrupar={agruparYa} />}
    </>
  );
}

// Paginado de un renglón: ‹ 1 … 4 5 6 … 20 ›
function Paginas({ pag, paginas, onIr }: { pag: number; paginas: number; onIr: (p: number) => void }) {
  const nums: Array<number | null> = [];
  for (let i = 1; i <= paginas; i++) {
    if (i === 1 || i === paginas || Math.abs(i - pag) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== null) nums.push(null);
  }
  return (
    <span className="ds-pags">
      <button type="button" className="btn sm ghost ds-pag" disabled={pag <= 1} onClick={() => onIr(pag - 1)} aria-label="Página anterior">‹</button>
      {nums.map((n, i) => (n == null ? <span key={`x${i}`} className="muted ds-pag-x">…</span>
        : <button key={n} type="button" className={`btn sm ghost ds-pag${n === pag ? ' on' : ''}`} aria-current={n === pag ? 'page' : undefined} onClick={() => onIr(n)}>{n}</button>))}
      <button type="button" className="btn sm ghost ds-pag" disabled={pag >= paginas} onClick={() => onIr(pag + 1)} aria-label="Página siguiente">›</button>
    </span>
  );
}

// ---------- La tabla ----------

function GrupoFilas({ grupo, destinos, organiza, sel, foco, onMarcar, onFoco, onEditar, onBorrar, onGrupo }: {
  grupo: Grupo; destinos: Destino[]; organiza: boolean; sel: Set<number>; foco: number | null; onMarcar: (ids: number[], on: boolean) => void; onFoco: (d: Destino) => void;
  onEditar: (d: Destino) => void; onBorrar: (d: Destino) => void; onGrupo: () => void;
}) {
  const [abierto, setAbierto] = useState(destinos.length <= 6);   // las empresas con muchas sucursales arrancan plegadas
  const seis = destinos.reduce((s, d) => s + d.viajes.seis, 0), total = destinos.reduce((s, d) => s + d.viajes.total, 0);
  const tipos = [...new Set(destinos.map((d) => d.tipo))];
  // La empresa del CRM: la del grupo o, si no tiene, la de sus direcciones cuando todas son de la misma.
  const deHijos = [...new Map(destinos.map(empresaDe).filter((e): e is EmpresaCRM => !!e).map((e) => [e.id, e])).values()];
  const empresa = empresaDe(grupo) ?? (deHijos.length === 1 ? deHijos[0] : null);
  return (
    <>
      <tr className={`ds-grupo${abierto ? ' ds-abierto' : ''}`}>
        {organiza && <td className="ds-sel"><input type="checkbox" aria-label={`Elegir los destinos de ${grupo.nombre}`} checked={destinos.every((d) => sel.has(d.id))} onChange={(e) => onMarcar(destinos.map((d) => d.id), e.target.checked)} /></td>}
        <td colSpan={5} className="ds-grupo-celda">
          <div className="ds-nivel">
            <button type="button" className="ds-plegar ds-margen" onClick={() => setAbierto(!abierto)} aria-expanded={abierto}
              aria-label={`${abierto ? 'Plegar' : 'Ver'} las direcciones de ${grupo.nombre}`} title={abierto ? 'Plegar sus direcciones' : 'Ver sus direcciones'}><Icon name="down" size={14} /></button>
            <LogoDestino nombre={grupo.nombre} empresa={empresa} />
            <button type="button" className="ds-grupo-nombre" onClick={organiza ? onGrupo : () => setAbierto(!abierto)}><b>{lindo(grupo.nombre)}</b></button>
            <button type="button" className="ds-cuantas" onClick={() => setAbierto(!abierto)}>{destinos.length} {destinos.length === 1 ? 'dirección' : 'direcciones'}</button>
          </div>
          <div className="ds-tags">{tipos.length === 1 ? <TipoTag tipo={tipos[0]} /> : <span className="muted small">Varios tipos</span>}{empresa && <LinkEmpresa empresa={empresa} />}</div>
        </td>
        <td className="numcell">{seis || ''}{total > seis && <span className="muted small"> / {total}</span>}</td>
        <td className="ds-acciones">{organiza && <button type="button" className="btn ghost sm icon" onClick={onGrupo} title="Editar la empresa" aria-label={`Editar la empresa ${grupo.nombre}`}><Icon name="edit" size={15} /></button>}</td>
      </tr>
      {abierto && destinos.map((d, i) => <FilaDestino key={d.id} d={d} enGrupo ultimo={i === destinos.length - 1} organiza={organiza} sel={sel.has(d.id)} foco={foco === d.id} onMarcar={(on) => onMarcar([d.id], on)} onFoco={() => onFoco(d)} onEditar={() => onEditar(d)} onBorrar={() => onBorrar(d)} />)}
    </>
  );
}

// El logo de la empresa del CRM (el favicon de su dominio, como en el resto del Hub; sin dominio, sus iniciales). El
// destino que no está relacionado con ninguna empresa lleva un pin gris, para que todos los nombres arranquen parejo.
function LogoDestino({ nombre, empresa }: { nombre: string; empresa: EmpresaCRM | null }) {
  if (!empresa) return <span className="ds-logo vacio" aria-hidden="true"><Icon name="pin" size={12} /></span>;
  return <span className="ds-logo" title={`Empresa del CRM: ${empresa.nombre}`}><Avatar name={empresa.nombre || nombre} type="company" size="sm" domain={empresa.dominio} /></span>;
}
// El link a la empresa en el CRM.
function LinkEmpresa({ empresa }: { empresa: EmpresaCRM }) {
  return <Link className="ds-crm" to={recordUrl('company', empresa.id)} title={`Abrir ${empresa.nombre} en el CRM${empresa.origen && ORIGEN_EMPRESA[empresa.origen] ? ` · ${ORIGEN_EMPRESA[empresa.origen]}` : ''}`}>
    <Icon name="company" size={11} /><span>{empresa.nombre}</span></Link>;
}

// Elegir (o quitar) la empresa del CRM de un destino o de un grupo. Es de Logística.
function CampoEmpresa({ valor, onChange }: { valor: EmpresaCRM | null; onChange: (e: EmpresaCRM | null) => void }) {
  const [buscando, setBuscando] = useState(false);
  return (
    <div className="field ds-campo-empresa">Empresa del CRM
      {valor ? (
        <div className="ds-empresa-elegida">
          <Avatar name={valor.nombre} type="company" size="sm" domain={valor.dominio} />
          <Link to={recordUrl('company', valor.id)} className="grow ellipsis" title="Abrir en el CRM">{valor.nombre}</Link>
          <button type="button" className="btn sm ghost" onClick={() => { onChange(null); setBuscando(true); }}>Cambiar</button>
          <button type="button" className="btn sm ghost" onClick={() => { onChange(null); setBuscando(false); }}>Quitar</button>
        </div>
      ) : buscando ? (
        <RecordPicker type="company" placeholder="Buscar la empresa en el CRM…" onPick={(r) => { onChange({ id: r.id, nombre: r.name, dominio: r.props.domain ? String(r.props.domain) : null, origen: 'manual' }); setBuscando(false); }} />
      ) : <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setBuscando(true)}><Icon name="company" size={13} />Relacionar con una empresa</button>}
      {valor?.origen && valor.origen !== 'manual' && ORIGEN_EMPRESA[valor.origen] && <span className="small muted">{ORIGEN_EMPRESA[valor.origen]}: si no es, quitala o cambiala y queda fijo.</span>}
      {!valor && !buscando && <span className="small muted">Con la empresa relacionada se ve su logo y se sabe si es cliente o proveedor.</span>}
    </div>
  );
}

// Un destino: suelto (al mismo nivel que una empresa con varias direcciones) o, `enGrupo`, una de las direcciones de una
// empresa: va corrida a la derecha, colgada de la línea que baja desde su empresa (`ultimo` la corta).
function FilaDestino({ d, enGrupo, ultimo, organiza, sel, foco, onMarcar, onFoco, onEditar, onBorrar }: {
  d: Destino; enGrupo?: boolean; ultimo?: boolean; organiza: boolean; sel: boolean; foco: boolean; onMarcar: (on: boolean) => void; onFoco: () => void; onEditar: () => void; onBorrar: () => void;
}) {
  const wa = linkWhatsapp(d);
  const faltan = d.faltan.filter((f) => f !== 'tipo' || !enGrupo);
  const empresa = empresaDe(d);
  return (
    <tr id={`ds-fila-${d.id}`} className={`${enGrupo ? `ds-hijo${ultimo ? ' ultimo' : ''}` : 'ds-suelto'}${foco ? ' ds-foco' : ''}`}>
      {organiza && <td className="ds-sel"><input type="checkbox" aria-label={`Elegir ${d.nombre}`} checked={sel} onChange={(e) => onMarcar(e.target.checked)} /></td>}
      <td className="ds-td-nombre">
        <div className="ds-nivel">
          {!enGrupo && <span className="ds-margen" aria-hidden="true" />}
          {!enGrupo && <LogoDestino nombre={d.nombre} empresa={empresa} />}
          <button type="button" className="ds-nombre" onClick={d.puede_editar ? onEditar : onFoco} title={d.puede_editar ? 'Editar el destino' : 'Los destinos de la libreta los corrige Logística'}>
            <b>{lindo(enGrupo && d.sucursal ? d.sucursal : d.nombre)}</b>
            {!enGrupo && d.sucursal && <span className="muted"> · {d.sucursal}</span>}
            {enGrupo && d.sucursal && <span className="muted small"> ({lindo(d.nombre)})</span>}
          </button>
        </div>
        <div className="ds-tags">
          {!enGrupo && <TipoTag tipo={d.tipo} origen={d.tipo_origen} />}
          {!enGrupo && empresa && <LinkEmpresa empresa={empresa} />}
          {d.ia_estado === 'corregido' && <span className="cr-tag" title={`${d.ia_nota ?? ''}${d.ia_antes ? `\nAntes: ${textoDir(d.ia_antes) || '(vacío)'}` : ''}`}>Completado con IA</span>}
          {d.ia_estado === 'dudoso' && <span className="cr-tag warn" title={`${d.ia_nota ?? ''}${d.ia_sugerida ? `\nSugerencia: ${textoDir(d.ia_sugerida)}` : ''}`}>Para revisar</span>}
          {faltan.length > 0 && <span className="ds-falta" title={`Falta: ${faltan.map((f) => FALTA[f]).join(', ')}`}>Falta {faltan.length === 1 ? FALTA[faltan[0]] : `${faltan.length} datos`}</span>}
        </div>
      </td>
      <td>
        {d.direccion ? (
          <button type="button" className="ds-dir" onClick={onFoco} title="Ver en el mapa">
            <Icon name="pin" size={13} /><span>{d.direccion}</span>{d.mapa !== 'ok' && <span className="ds-sinmapa" title="No está ubicada en el mapa">sin ubicar</span>}
          </button>
        ) : <span className="muted">—</span>}
        {(d.localidad || d.provincia) && <div className="ds-locmov small muted">{[d.localidad, d.provincia && provCorta(d.provincia)].filter(Boolean).join(', ')}</div>}
        {d.direccion && <a className="ds-gmaps" href={linkGoogleMaps(d)} target="_blank" rel="noreferrer" title="Abrir en Google Maps" aria-label={`Abrir ${d.nombre} en Google Maps`}><Icon name="external" size={12} />Maps</a>}
      </td>
      <td className="ds-col-loc">{d.localidad ?? <span className="muted">—</span>}{d.codigo_postal && <span className="muted small"> ({d.codigo_postal})</span>}</td>
      <td className="ds-col-loc" title={d.provincia ?? undefined}>{d.provincia ? provCorta(d.provincia) : <span className="muted">—</span>}</td>
      <td className="ds-contacto">
        {d.contacto && <div className="ellipsis">{d.contacto}</div>}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {wa && <a className="ds-wa" href={wa} target="_blank" rel="noreferrer" title={`Escribirle por WhatsApp${d.contacto ? ` a ${d.contacto}` : ''}`}><Icon name="whatsapp" size={13} />WhatsApp</a>}
          {d.telefono && <a className="small" href={`tel:${d.telefono.replace(/[^\d+]/g, '')}`}>{d.telefono}</a>}
          {d.email && <a className="small" href={`mailto:${d.email}`} title={d.email}><Icon name="email" size={13} /></a>}
          {!d.contacto && !d.telefono && !wa && !d.email && <span className="muted">—</span>}
        </div>
      </td>
      <td className="numcell" title={[d.viajes.ultimo && `Último: ${fechaCorta(d.viajes.ultimo)}`, d.viajes.proximo && `Próximo: ${fechaCorta(d.viajes.proximo)}`, `${d.viajes.total} en total`].filter(Boolean).join(' · ')}>
        {d.viajes.seis || (d.viajes.total ? '' : <span className="muted">0</span>)}{d.viajes.total > d.viajes.seis && <span className="muted small"> / {d.viajes.total}</span>}
        {d.viajes.ultimo && <div className="muted small">últ. {fechaCorta(d.viajes.ultimo)}</div>}
        {d.viajes.proximo && <div className="small ok-text">va el {fechaCorta(d.viajes.proximo)}</div>}
      </td>
      <td className="ds-acciones">
        {d.puede_editar && <button type="button" className="btn ghost sm icon" onClick={onEditar} title="Editar" aria-label={`Editar ${d.nombre}`}><Icon name="edit" size={15} /></button>}
        {d.puede_borrar && <button type="button" className="btn ghost sm icon ds-borrar" onClick={onBorrar} title="Borrar" aria-label={`Borrar ${d.nombre}`}><Icon name="trash" size={15} /></button>}
      </td>
    </tr>
  );
}

// ---------- El mapa ----------

function MapaDestinos({ destinos, foco, ubicando, onElegir, onMover }: {
  destinos: Destino[]; foco: Destino | null; ubicando: { id: number; lat: number; lng: number } | null; onElegir: (id: number) => void; onMover: (lat: number, lng: number) => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);
  const pines = useRef(new Map<number, L.CircleMarker>());
  const cb = useRef({ onElegir, onMover });
  cb.current = { onElegir, onMover };
  const encuadrado = useRef(false);

  useEffect(() => {
    // En canvas: miles de puntos sin trabar la página (con marcadores HTML, cada punto es un elemento más).
    const m = L.map(caja.current!, { zoomControl: true, attributionControl: true, scrollWheelZoom: true, preferCanvas: true }).setView([-34.6, -58.45], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>' }).addTo(m);
    capa.current = L.layerGroup().addTo(m);
    mapa.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(caja.current!);
    return () => { ro.disconnect(); m.remove(); mapa.current = null; };
  }, []);

  // Un punto por destino, del color de su tipo; el elegido, más grande.
  useEffect(() => {
    const m = mapa.current, g = capa.current;
    if (!m || !g) return;
    g.clearLayers();
    pines.current.clear();
    const todos: Array<[number, number]> = [];
    for (const d of destinos) {
      if (d.lat == null || d.lng == null || ubicando?.id === d.id) continue;
      todos.push([d.lat, d.lng]);
      const color = tipoDe(d.tipo)?.[2] ?? '#6b7280', on = foco?.id === d.id;
      if (on) continue;   // el elegido va al final, arriba de todos
      const mk = L.circleMarker([d.lat, d.lng], { radius: 5, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1 })
        .bindTooltip(() => esc(`${lindo(d.nombre)}${d.sucursal ? ` · ${d.sucursal}` : ''} — ${d.completa}`), { direction: 'top', offset: [0, -6] }).addTo(g);
      mk.on('click', () => cb.current.onElegir(d.id));
      pines.current.set(d.id, mk);
    }
    if (foco && foco.lat != null && foco.lng != null && ubicando?.id !== foco.id && destinos.some((d) => d.id === foco.id)) {
      const mk = L.circleMarker([foco.lat, foco.lng], { radius: 10, color: '#fff', weight: 3, fillColor: tipoDe(foco.tipo)?.[2] ?? '#6b7280', fillOpacity: 1 })
        .bindTooltip(esc(`${lindo(foco.nombre)}${foco.sucursal ? ` · ${foco.sucursal}` : ''} — ${foco.completa}`), { direction: 'top', offset: [0, -10] }).addTo(g);
      mk.on('click', () => cb.current.onElegir(foco.id));
      pines.current.set(foco.id, mk);
    }
    if (ubicando) {
      const mk = L.marker([ubicando.lat, ubicando.lng], { draggable: true, zIndexOffset: 5000, icon: L.divIcon({ className: 'ds-pin-wrap', html: '<span class="ds-pin on ubicando"></span>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(g);
      mk.on('dragend', () => { const ll = mk.getLatLng(); cb.current.onMover(ll.lat, ll.lng); });
    }
    // Arranca en el AMBA, donde está casi todo (los del interior se ven alejando el mapa).
    const amba = todos.filter(([la, ln]) => la < -34.1 && la > -35.2 && ln > -59.4 && ln < -57.7);
    if (!encuadrado.current && (amba.length || todos.length)) { m.fitBounds(L.latLngBounds(amba.length ? amba : todos).pad(0.05), { maxZoom: 12 }); encuadrado.current = true; }
  }, [destinos, foco?.id, ubicando]);

  // Al elegir un destino, el mapa va ahí.
  useEffect(() => {
    const m = mapa.current;
    if (!m || !foco || foco.lat == null || foco.lng == null) return;
    m.flyTo([foco.lat, foco.lng], Math.max(m.getZoom(), 15), { duration: 0.6 });
    pines.current.get(foco.id)?.openTooltip();
  }, [foco?.id, foco?.lat, foco?.lng]);

  return <div className="ds-mapa" ref={caja} />;
}

function FichaMapa({ d, organiza, ubicando, onUbicar, onGuardar, onCancelar, onEditar }: {
  d: Destino; organiza: boolean; ubicando: boolean; onUbicar: (lat: number, lng: number) => void; onGuardar: () => void; onCancelar: () => void; onEditar: () => void;
}) {
  const wa = linkWhatsapp(d);
  return (
    <div className="ds-ficha">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div><b>{lindo(d.nombre)}</b>{d.sucursal && <span className="muted"> · {d.sucursal}</span>}<div className="small">{d.completa || 'Sin dirección'}</div></div>
        <TipoTag tipo={d.tipo} origen={d.tipo_origen} />
      </div>
      {d.mapa !== 'ok' && !ubicando && <p className="small warn-text">{d.mapa === 'sin_direccion' ? 'Le falta la dirección.' : d.mapa === 'sin_buscar' ? 'Buscándola en el mapa…' : 'El mapa no la encontró.'}{organiza && d.mapa !== 'sin_direccion' && ' Ubicala a mano o elegila de Google en «Editar».'}</p>}
      {ubicando && <p className="small">Arrastrá el pin naranja hasta el lugar y tocá «Guardar ubicación».</p>}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {d.direccion && <a className="btn sm" href={linkGoogleMaps(d)} target="_blank" rel="noreferrer"><Icon name="external" size={13} />Ver en Google Maps</a>}
        {wa && <a className="btn sm" href={wa} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={13} />WhatsApp</a>}
        {organiza && !ubicando && d.direccion && <button type="button" className="btn sm ghost" onClick={() => onUbicar(d.lat ?? -34.6, d.lng ?? -58.45)}><Icon name="pin" size={13} />{d.mapa === 'ok' ? 'Corregir el punto' : 'Ubicar a mano'}</button>}
        {ubicando && <><button type="button" className="btn sm primary" onClick={onGuardar}>Guardar ubicación</button><button type="button" className="btn sm ghost" onClick={onCancelar}>Cancelar</button></>}
        {d.puede_editar && !ubicando && <button type="button" className="btn sm ghost" onClick={onEditar}><Icon name="edit" size={13} />Editar</button>}
      </div>
      {(d.horario || d.observaciones) && <p className="small muted" style={{ margin: 0 }}>{[d.horario && `Horario: ${d.horario}`, d.observaciones].filter(Boolean).join(' · ')}</p>}
    </div>
  );
}

// ---------- Editar un destino ----------

// La localidad y la provincia como en el listado (normalizarUbicacion): así el formulario muestra la provincia elegida en
// la lista y la localidad de esa provincia.
const ubic = (x: { localidad?: string | null; provincia?: string | null; zona?: string | null } | null) => {
  const n = normalizarUbicacion(x ?? {});
  return { localidad: n.localidad ?? '', provincia: n.provincia ?? '' };
};

function EditarDestino({ d, grupos, organiza, maps, onClose, onListo, onBorrar }: {
  d: Destino | null; grupos: Grupo[]; organiza: boolean; maps: boolean; onClose: () => void; onListo: (id: number | null) => void; onBorrar: (d: Destino) => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    nombre: d?.nombre ?? '', sucursal: d?.sucursal ?? '', tipo: (d?.tipo ?? '') as string, grupo_id: d?.grupo_id ? String(d.grupo_id) : '',
    direccion: d?.direccion ?? '', ...ubic(d), codigo_postal: d?.codigo_postal ?? '',
    contacto: d?.contacto ?? '', telefono: d?.telefono ?? '', whatsapp: d?.whatsapp ?? '', email: d?.email ?? '', horario: d?.horario ?? '', observaciones: d?.observaciones ?? '',
  });
  const [google, setGoogle] = useState<Sugerencia | null>(null);
  const [empresa, setEmpresa] = useState<EmpresaCRM | null>(d ? empresaDe(d) : null);
  const [sesion] = useState(() => crypto.randomUUID());
  const [ocupado, setOcupado] = useState(false);
  const guardar = async (extra: Record<string, unknown> = {}) => {
    setOcupado(true);
    try {
      const { grupo_id, ...resto } = f;
      const body: Record<string, unknown> = { ...resto, tipo: f.tipo || null, ...extra };
      if (organiza) body.grupo_id = grupo_id ? Number(grupo_id) : null;
      // La empresa del CRM solo viaja si se tocó: lo que el Hub relacionó solo sigue marcado como deducido.
      if (organiza && (empresa?.id ?? null) !== (d?.company_id ?? null)) body.company_id = empresa?.id ?? null;
      if (google) { body.place_id = google.place_id; body.sesion = sesion; }
      else if (d && f.direccion !== (d.direccion ?? '')) body.place_id = null;
      const r = await http<{ id: number }>(d ? 'PATCH' : 'POST', d ? `/recorridos/libreta/${d.id}` : '/recorridos/libreta', body);
      toast(extra.activo === false ? 'Destino sacado de la libreta.' : 'Destino guardado.'); onListo(r.id ?? d?.id ?? null);
    } catch (e) { toast((e as Error).message, true); setOcupado(false); }
  };
  const campo = (k: keyof typeof f, label: string, ph = '', props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label className="field">{label}<input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} {...props} /></label>;
  const wa = whatsappUrl(f.whatsapp || f.telefono);
  return (
    <Modal wide title={d ? lindo(d.nombre) : 'Nuevo destino'} onClose={onClose} footer={<>
      {d?.puede_borrar && <button type="button" className="btn ghost danger" disabled={ocupado} onClick={() => onBorrar(d)}><Icon name="trash" size={14} />Borrar destino</button>}
      <span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={ocupado || !f.nombre.trim() || !(f.direccion.trim() || google)} onClick={() => guardar()}>Guardar</button></>}>
      <div className="rc-form ds-form">
        <fieldset><legend>Qué es</legend>
          <div className="rc-2">{campo('nombre', 'Nombre', 'ZECAT, Imprefas, Nestlé…')}{campo('sucursal', 'Sucursal o sector', 'Depósito, Casa central, Planta Pilar…')}</div>
          <div className="rc-2">
            <label className="field">Tipo
              <Select className="input" value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })} aria-label="Tipo de destino">
                <option value="">Sin tipo</option>{TIPOS.map((t) => <option key={t[0]} value={t[0]}>{t[1]}</option>)}
              </Select>
              {d?.tipo && d.tipo_origen && d.tipo_origen !== 'manual' && <span className="small muted">{ORIGEN_TIPO[d.tipo_origen]}: si está mal, cambialo y queda fijo.</span>}
            </label>
            {organiza ? (
              <label className="field">Empresa (para juntar sucursales)
                <Select className="input" value={f.grupo_id} onChange={(e) => setF({ ...f, grupo_id: e.target.value })} aria-label="Grupo">
                  <option value="">Ninguna (destino suelto)</option>{grupos.map((g) => <option key={g.id} value={String(g.id)}>{lindo(g.nombre)} ({g.n})</option>)}
                </Select>
                <span className="small muted">Para una empresa nueva, elegí sus destinos en la lista y «Agrupar».</span>
              </label>
            ) : <span />}
          </div>
          {organiza ? <CampoEmpresa valor={empresa} onChange={setEmpresa} />
            : d?.empresa && <p className="small muted" style={{ margin: 0 }}>Es la empresa del CRM <b>{d.empresa}</b>.</p>}
        </fieldset>

        <fieldset><legend>Dirección</legend>
          <label className="field">Calle y altura
            <BuscarDireccion valor={f.direccion} validada={!!google || (!!d?.place_id && f.direccion === (d.direccion ?? ''))} sesion={sesion} maps={maps} sugerida={null} etiqueta="Calle y altura"
              onTexto={(t) => { setGoogle(null); setF({ ...f, direccion: t }); }}
              onElegir={(s) => { setGoogle(s); setF({ ...f, direccion: s.principal, localidad: '', provincia: '', codigo_postal: '' }); }} />
          </label>
          {google ? <p className="small ok-text" style={{ margin: 0 }}>Elegida de Google Maps: al guardar se completan la localidad, la provincia, el código postal y el punto en el mapa ({google.secundario}).</p> : (
            <div className="ds-3">
              <label className="field">Provincia
                <Select className="input" value={f.provincia} aria-label="Provincia"
                  onChange={(e) => { const p = e.target.value; setF({ ...f, provincia: p, localidad: localidadesDe(p).includes(f.localidad) ? f.localidad : '' }); }}>
                  <option value="">Elegí la provincia</option>
                  {f.provincia && !PROVINCIAS.includes(f.provincia) && <option value={f.provincia}>{f.provincia}</option>}
                  {PROVINCIAS.map((p) => <option key={p} value={p}>{p === CABA ? 'CABA (Ciudad Autónoma de Buenos Aires)' : p}</option>)}
                </Select>
              </label>
              <label className="field">{f.provincia === CABA ? 'Barrio' : 'Localidad'}
                <input className="input" list="ds-localidades" value={f.localidad} onChange={(e) => setF({ ...f, localidad: e.target.value })} disabled={!f.provincia}
                  placeholder={!f.provincia ? 'Primero la provincia' : f.provincia === CABA ? 'Palermo, Balvanera… o CABA' : 'Escribí y elegí de la lista'} autoComplete="off" />
                <datalist id="ds-localidades">{localidadesDe(f.provincia).map((l) => <option key={l} value={l} />)}</datalist>
                {f.localidad && f.provincia && !localidadesDe(f.provincia).includes(f.localidad) && <span className="small muted">No está en el listado de {f.provincia === CABA ? 'barrios' : 'localidades'}: revisá cómo se escribe.</span>}
              </label>
              {campo('codigo_postal', 'CP', 'B1872', { style: { maxWidth: 110 } })}
            </div>
          )}
          {d?.ia_estado === 'dudoso' && d.ia_sugerida && (
            <div className="rc-ia warn small"><b>La IA no está segura{d.ia_sugerida.confianza != null ? ` (${d.ia_sugerida.confianza} %)` : ''}:</b> {textoDir(d.ia_sugerida)}.
              {d.ia_nota && <span className="muted"> {d.ia_nota}</span>}{' '}
              <button type="button" className="cr-link" onClick={() => { setGoogle(null); setF({ ...f, direccion: d.ia_sugerida!.direccion ?? f.direccion, ...ubic({ ...d.ia_sugerida!, zona: d.zona }) }); }}>Usar la sugerencia</button></div>
          )}
          {d?.ia_estado === 'corregido' && d.ia_antes && (
            <div className="rc-ia small"><b>Completado con IA.</b>{d.ia_nota && <span className="muted"> {d.ia_nota}</span>} Antes: {textoDir(d.ia_antes) || '(vacío)'}.{' '}
              <button type="button" className="cr-link" onClick={() => { setGoogle(null); setF({ ...f, direccion: d.ia_antes!.direccion ?? '', ...ubic({ ...d.ia_antes!, zona: d.zona }) }); }}>Volver a como estaba</button></div>
          )}
        </fieldset>

        <fieldset><legend>Contacto</legend>
          <div className="rc-2">{campo('contacto', 'Nombre', 'Marcela (recepción)')}{campo('email', 'Mail', '', { type: 'email' })}</div>
          <div className="rc-2">{campo('telefono', 'Teléfono', '011 4567-8901')}
            <label className="field">WhatsApp<div className="row" style={{ gap: 6 }}>
              <input className="input" value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} placeholder="11 5555-1234 (si es otro que el teléfono)" />
              {wa && <a className="btn sm" href={wa} target="_blank" rel="noreferrer" title="Probar el link de WhatsApp"><Icon name="whatsapp" size={14} /></a>}</div></label>
          </div>
        </fieldset>

        <fieldset><legend>Para el chofer</legend>
          {campo('horario', 'Horario de atención', '9 a 13')}
          {campo('observaciones', 'Observaciones', 'Tocar timbre 2, entrar por el portón gris…')}
        </fieldset>
        {d && d.origen !== 'hub' && <p className="muted small">Viene de la planilla DESTINOS. Lo que cambies acá queda en el Hub y la copia de la planilla ya no lo pisa.</p>}
      </div>
    </Modal>
  );
}

// ---------- Borrar un destino (con confirmación) ----------

// Borrar es sacarlo de la libreta: deja de ofrecerse y de verse acá, pero los encargos que ya lo nombran (los viejos y los
// que están por hacerse) no cambian. Si viene de la planilla DESTINOS, la copia diaria no lo vuelve a traer.
function BorrarDestino({ d, onClose, onListo }: { d: Destino; onClose: () => void; onListo: () => void }) {
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const borrar = async () => {
    setOcupado(true);
    try { await http('PATCH', `/recorridos/libreta/${d.id}`, { activo: false }); toast(`«${lindo(d.nombre)}» se borró de los destinos.`); onListo(); }
    catch (e) { toast((e as Error).message, true); setOcupado(false); }
  };
  return (
    <Modal title="¿Borrar este destino?" onClose={onClose} footer={<><span className="grow" />
      <button type="button" className="btn" onClick={onClose} autoFocus>Cancelar</button>
      <button type="button" className="btn danger" disabled={ocupado} onClick={borrar}><Icon name="trash" size={14} />{ocupado ? 'Borrando…' : 'Sí, borrar'}</button></>}>
      <div className="rc-form">
        <div className="ds-ficha" style={{ margin: 0 }}>
          <div><b>{lindo(d.nombre)}</b>{d.sucursal && <span className="muted"> · {d.sucursal}</span>}</div>
          <div className="small">{d.completa || 'Sin dirección'}</div>
          {d.viajes.total > 0 && <div className="small muted">{d.viajes.total} {d.viajes.total === 1 ? 'viaje' : 'viajes'}{d.viajes.ultimo ? `, el último el ${fechaCorta(d.viajes.ultimo)}` : ''}.</div>}
        </div>
        {d.viajes.proximo && <div className="rc-ia warn small"><b>Tiene un encargo para el {fechaCorta(d.viajes.proximo)}.</b> Ese encargo no se borra y sigue yendo a esta dirección; si no tiene que ir, cancelalo en Encargos.</div>}
        <p className="small" style={{ margin: 0 }}>Deja de aparecer en Destinos y al cargar encargos. Los encargos que ya lo nombran no cambian.
          {d.origen !== 'hub' && ' Viene de la planilla DESTINOS: la copia diaria no lo vuelve a traer.'}</p>
      </div>
    </Modal>
  );
}

// ---------- Grupos ----------

function Agrupar({ ini, grupos, destinos, onClose, onAgrupar }: {
  ini: { ids: number[]; nombre: string; grupo_id: number | null }; grupos: Grupo[]; destinos: Destino[]; onClose: () => void;
  onAgrupar: (b: { ids: number[]; nombre?: string; grupo_id?: number | null; tipo?: string | null }) => void;
}) {
  const [grupo, setGrupo] = useState(ini.grupo_id ? String(ini.grupo_id) : '');
  const [nombre, setNombre] = useState(lindo(ini.nombre));
  const tipos = [...new Set(destinos.map((d) => d.tipo).filter(Boolean))];
  const [tipo, setTipo] = useState<string>(tipos.length === 1 ? tipos[0]! : '');
  return (
    <Modal title="Agrupar como una empresa" onClose={onClose} footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!grupo && !nombre.trim()} onClick={() => onAgrupar({ ids: ini.ids, ...(grupo ? { grupo_id: Number(grupo) } : { nombre: nombre.trim() }), tipo: tipo || null })}>Agrupar</button></>}>
      <div className="rc-form">
        <p className="small muted" style={{ margin: 0 }}>Son la misma empresa con distintas direcciones (sucursales, depósito, oficina). Cada una sigue siendo un destino con su dirección y su contacto.</p>
        <ul className="ds-lista">{destinos.map((d) => <li key={d.id}><b>{lindo(d.nombre)}</b>{d.sucursal && ` · ${d.sucursal}`} <span className="muted small">{d.completa}</span></li>)}</ul>
        {grupos.length > 0 && (
          <label className="field">Empresa
            <Select className="input" value={grupo} onChange={(e) => setGrupo(e.target.value)} aria-label="Empresa"><option value="">Una nueva</option>
              {grupos.map((g) => <option key={g.id} value={String(g.id)}>Sumar a {lindo(g.nombre)} ({g.n})</option>)}</Select>
          </label>
        )}
        {!grupo && <label className="field">Nombre de la empresa<input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="ZECAT" /></label>}
        <label className="field">Tipo (para todas sus direcciones)
          <Select className="input" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo"><option value="">Dejar como están</option>
            {TIPOS.map((t) => <option key={t[0]} value={t[0]}>{t[1]}</option>)}</Select>
        </label>
      </div>
    </Modal>
  );
}

function EditarGrupo({ g, destinos, onClose, onListo }: { g: Grupo; destinos: Destino[]; onClose: () => void; onListo: () => void }) {
  const toast = useToast();
  const [nombre, setNombre] = useState(lindo(g.nombre));
  const [tipo, setTipo] = useState<string>(g.tipo ?? '');
  const [empresa, setEmpresa] = useState<EmpresaCRM | null>(empresaDe(g));
  const hacer = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); onListo(); } catch (e) { toast((e as Error).message, true); } };
  return (
    <Modal title={lindo(g.nombre)} onClose={onClose} footer={<>
      <button type="button" className="btn ghost danger" onClick={() => hacer(() => http('POST', `/recorridos/grupos/${g.id}/sacar`, {}), 'Grupo deshecho: los destinos quedan sueltos.')}>Deshacer el grupo</button>
      <span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!nombre.trim()} onClick={() => hacer(() => http('PATCH', `/recorridos/grupos/${g.id}`, { nombre: nombre.trim(), ...(tipo !== (g.tipo ?? '') ? { tipo: tipo || null } : {}),
        ...((empresa?.id ?? null) !== (g.company_id ?? null) ? { company_id: empresa?.id ?? null } : {}) }), 'Grupo guardado.')}>Guardar</button></>}>
      <div className="rc-form">
        <div className="rc-2">
          <label className="field">Nombre de la empresa<input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} /></label>
          <label className="field">Tipo (para todas sus direcciones)
            <Select className="input" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo"><option value="">Dejar como están</option>
              {TIPOS.map((t) => <option key={t[0]} value={t[0]}>{t[1]}</option>)}</Select></label>
        </div>
        <CampoEmpresa valor={empresa} onChange={setEmpresa} />
        <ul className="ds-lista">
          {destinos.map((d) => (
            <li key={d.id}><span className="grow"><b>{lindo(d.nombre)}</b>{d.sucursal && ` · ${d.sucursal}`} <span className="muted small">{d.completa}</span></span>
              <button type="button" className="btn sm ghost" onClick={() => hacer(() => http('POST', `/recorridos/grupos/${g.id}/sacar`, { ids: [d.id] }), 'Sacado del grupo.')}>Sacar</button></li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

