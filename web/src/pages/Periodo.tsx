import { useMemo, useState } from 'react';
import { Icon } from '../lib';
import { Select } from '../Select';
import { SelectorFecha } from '../Fecha';

// Selector de período de los Inicios (Dirección y Producción): mes en curso, último mes, últimos 90 días, YTD, un año
// completo, un mes puntual o un rango a mano con el calendario.

const ZONA = 'America/Argentina/Buenos_Aires';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const D = (s: string) => new Date(`${s}T12:00:00`);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sumar = (s: string, n: number) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
const finDeMes = (y: number, m: number) => iso(new Date(y, m + 1, 0, 12));
export const corto = (s: string) => { const d = D(s); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
export const pct = (x: number | null) => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)} %`);
export const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

type Modo = 'mes' | 'mes-ant' | '90' | 'ytd' | 'anio' | 'mes-elegido' | 'rango';
const MODOS: Array<[Modo, string]> = [['mes', 'Mes en curso'], ['mes-ant', 'Último mes'], ['90', 'Últimos 90 días'], ['ytd', 'Año a la fecha (YTD)'],
  ['anio', 'Año completo'], ['mes-elegido', 'Elegir un mes'], ['rango', 'Rango a mano (calendario)']];

function periodo(modo: Modo, hoy: string, mes: string, anio: number, rango: { desde: string; hasta: string }) {
  const d = D(hoy), y = d.getFullYear(), m = d.getMonth();
  switch (modo) {
    case 'mes': return { desde: iso(new Date(y, m, 1, 12)), hasta: hoy, nombre: `${MESES[m]} ${y}` };
    case 'mes-ant': { const a = new Date(y, m - 1, 1, 12); return { desde: iso(a), hasta: finDeMes(a.getFullYear(), a.getMonth()), nombre: `${MESES[a.getMonth()]} ${a.getFullYear()}` }; }
    case '90': return { desde: sumar(hoy, -89), hasta: hoy, nombre: 'los últimos 90 días' };
    case 'ytd': return { desde: `${y}-01-01`, hasta: hoy, nombre: `${y} a la fecha` };
    case 'anio': return { desde: `${anio}-01-01`, hasta: anio === y ? hoy : `${anio}-12-31`, nombre: String(anio) };
    case 'mes-elegido': { const [yy, mm] = mes.split('-').map(Number); const fin = finDeMes(yy, mm - 1); return { desde: `${mes}-01`, hasta: fin > hoy ? hoy : fin, nombre: `${MESES[mm - 1]} ${yy}` }; }
    case 'rango': return { ...rango, nombre: `${corto(rango.desde)} al ${corto(rango.hasta)}` };
  }
}

// El período elegido ({desde, hasta, nombre}) y los controles para elegirlo.
export function usePeriodo() {
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: ZONA });
  const [modo, setModo] = useState<Modo>('mes');
  const [mes, setMes] = useState(hoy.slice(0, 7));
  const [anio, setAnio] = useState(D(hoy).getFullYear());
  const [rango, setRango] = useState({ desde: sumar(hoy, -29), hasta: hoy });
  const meses = useMemo(() => Array.from({ length: 24 }, (_, i) => { const x = D(hoy); const a = new Date(x.getFullYear(), x.getMonth() - i, 1, 12); return { v: iso(a).slice(0, 7), l: `${MESES[a.getMonth()]} ${a.getFullYear()}` }; }), [hoy]);
  const anios = useMemo(() => Array.from({ length: 5 }, (_, i) => D(hoy).getFullYear() - i), [hoy]);
  const p = periodo(modo, hoy, mes, anio, rango);
  const controles = <>
    <Select className="input" style={{ width: 210 }} value={modo} onChange={(e) => setModo(e.target.value as Modo)} aria-label="Período">
      {MODOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </Select>
    {modo === 'mes-elegido' && <Select className="input" style={{ width: 170 }} value={mes} onChange={(e) => setMes(e.target.value)} aria-label="Mes">
      {meses.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}</Select>}
    {modo === 'anio' && <Select className="input" style={{ width: 110 }} value={anio} onChange={(e) => setAnio(Number(e.target.value))} aria-label="Año">
      {anios.map((x) => <option key={x} value={x}>{x}</option>)}</Select>}
    {modo === 'rango' && <>
      <SelectorFecha className="input" label="Desde" valor={rango.desde} onElegir={(v) => v && setRango((r) => ({ desde: v, hasta: v > r.hasta ? v : r.hasta }))}>
        <Icon name="calendar" size={14} /> Desde {corto(rango.desde)}</SelectorFecha>
      <SelectorFecha className="input" label="Hasta" valor={rango.hasta} onElegir={(v) => v && setRango((r) => ({ desde: v < r.desde ? v : r.desde, hasta: v }))}>
        <Icon name="calendar" size={14} /> Hasta {corto(rango.hasta)}</SelectorFecha>
    </>}
  </>;
  return { p, hoy, controles };
}
