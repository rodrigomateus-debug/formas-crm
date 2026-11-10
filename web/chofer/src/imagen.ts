// Achica la foto en el celular antes de mandarla: lado mayor ~2000 px, JPEG, derecha (orientación EXIF) y ≤ 1,8 MB.

export const PESO_MAXIMO = 1_800_000;

type Fuente = { dibujo: CanvasImageSource; ancho: number; alto: number; soltar: () => void };

async function abrirImagen(archivo: Blob): Promise<Fuente> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
      return { dibujo: b, ancho: b.width, alto: b.height, soltar: () => b.close() };
    } catch { /* formato que createImageBitmap no abre: se prueba con <img> */ }
  }
  // <img> ya respeta la orientación EXIF en los navegadores actuales.
  const url = URL.createObjectURL(archivo);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((ok, mal) => {
      img.onload = () => ok();
      img.onerror = () => mal(new Error('no se pudo abrir la imagen'));
      img.src = url;
    });
    return { dibujo: img, ancho: img.naturalWidth, alto: img.naturalHeight, soltar: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function aJpeg(f: Fuente, ladoMayor: number, calidad: number): Promise<Blob> {
  const escala = Math.min(1, ladoMayor / Math.max(f.ancho, f.alto));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.max(1, Math.round(f.ancho * escala));
  lienzo.height = Math.max(1, Math.round(f.alto * escala));
  const ctx = lienzo.getContext('2d');
  if (!ctx) return Promise.reject(new Error('sin canvas'));
  ctx.fillStyle = '#fff'; // por si la imagen trae transparencia
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f.dibujo, 0, 0, lienzo.width, lienzo.height);
  return new Promise((ok, mal) => {
    lienzo.toBlob((b) => {
      lienzo.width = 0; lienzo.height = 0; // devuelve la memoria ya (Safari tiene un tope de canvas)
      if (b) ok(b); else mal(new Error('no se pudo guardar la imagen'));
    }, 'image/jpeg', calidad);
  });
}

// De mejor a peor: primero se baja la calidad y recién después el tamaño (el texto chico del remito necesita píxeles).
const ESCALERA: Array<[lado: number, calidad: number]> = [
  [2000, 0.85], [2000, 0.75], [2000, 0.65], [1700, 0.7], [1400, 0.7], [1200, 0.65], [1000, 0.6],
];

/** `desde` saltea los primeros escalones: sirve para achicar más una foto que el servidor rechazó por pesada. */
export async function achicarFoto(archivo: Blob, desde = 0): Promise<Blob> {
  const fuente = await abrirImagen(archivo);
  try {
    if (!fuente.ancho || !fuente.alto) throw new Error('imagen vacía');
    let salida: Blob | null = null;
    for (const [lado, calidad] of ESCALERA.slice(desde)) {
      salida = await aJpeg(fuente, lado, calidad);
      if (salida.size <= PESO_MAXIMO) return salida;
    }
    if (!salida) throw new Error('sin salida');
    return salida;
  } finally {
    fuente.soltar();
  }
}
