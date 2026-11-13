// Íconos propios, de trazo, para no cargar ninguna librería.
import type { ReactNode } from 'react';

const TRAZOS: Record<string, ReactNode> = {
  camara: (<>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2a1 1 0 0 0 .8-.4l.9-1.2a1 1 0 0 1 .8-.4h3.6a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4h1.2A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.5" r="3.4" />
  </>),
  bien: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  // Cómo llegar: el rombo con la flecha de giro, como el de los mapas.
  navegar: (<>
    <path d="M12 2.8 21.2 12 12 21.2 2.8 12z" />
    <path d="M9 15v-2.6a1.6 1.6 0 0 1 1.6-1.6H15.5M13.3 8.6l2.2 2.2-2.2 2.2" />
  </>),
  aviso: (<>
    <path d="M12 4.5 3.5 19h17z" />
    <path d="M12 10v4.2M12 16.6v.2" />
  </>),
  repetir: (<>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5" />
    <path d="M4.5 4.5v4h4" />
  </>),
  reloj: (<>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </>),
  copia: (<>
    <rect x="8" y="8" width="11" height="11" rx="2" />
    <path d="M5 15.5V7a2 2 0 0 1 2-2h8.5" />
  </>),
  cruz: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  subir: (<>
    <path d="M12 16V5.5M7.5 10 12 5.5l4.5 4.5" />
    <path d="M5 19h14" />
  </>),
  sinSenal: (<>
    <path d="M3 9.5a13 13 0 0 1 5-3M21 9.5a13 13 0 0 0-8-3.4M6.5 13.2a8 8 0 0 1 3.2-1.9M17.5 13.2a8 8 0 0 0-2.6-1.7" />
    <path d="M12 17.5v.2M4.5 4.5l15 15" />
  </>),
  link: (<>
    <path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.5 6.8" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.1-1.1" />
    <path d="M4 4l16 16" />
  </>),
  compartir: (<>
    <path d="M12 14.5V3.5M8 7l4-3.5L16 7" />
    <path d="M8.5 10.5H7A1.5 1.5 0 0 0 5.5 12v7A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5" />
  </>),
  galeria: (<>
    <rect x="4" y="5" width="16" height="14" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m5 17 4.5-4 3 2.5 3-3L20 16" />
  </>),
  // Consejos para la foto
  entero: (<>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <rect x="8.5" y="7.5" width="7" height="9" rx="1" />
  </>),
  frente: (<>
    <rect x="6" y="4" width="12" height="16" rx="1.5" />
    <path d="M9 9h6M9 12h6M9 15h3.5" />
  </>),
  sol: (<>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
  </>),
  uno: (<>
    <rect x="6" y="4" width="12" height="16" rx="1.5" />
    <path d="M10.8 10.2 12.5 9v6" />
  </>),
};

export type NombreIcono = keyof typeof TRAZOS;

/** La marca de la app (la hoja de remito con el tilde verde del ícono), para la barra de arriba. */
export function Marca({ tamano = 30 }: { tamano?: number }) {
  return (
    <svg width={tamano} height={tamano} viewBox="100 66 380 400" aria-hidden="true" focusable="false">
      <g transform="rotate(-6 256 256)">
        <rect x="132" y="84" width="232" height="318" rx="26" fill="#fff" />
        <path d="M170 150h110M170 206h156M170 262h156M170 318h74" stroke="#000085" strokeWidth="24" strokeLinecap="round" opacity=".85" />
      </g>
      <circle cx="352" cy="352" r="100" fill="var(--cabecera, #000085)" />
      <circle cx="352" cy="352" r="80" fill="#8cc63f" />
      <path d="M314 354l28 28 50-56" fill="none" stroke="#000085" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Icono({ nombre, tamano = 24 }: { nombre: string; tamano?: number }) {
  return (
    <svg className="icono" width={tamano} height={tamano} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {TRAZOS[nombre]}
    </svg>
  );
}
