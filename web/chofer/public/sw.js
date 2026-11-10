// Service worker de «Remitos Formas»: guarda la cáscara de la app (la página, el código, los estilos, la tipografía)
// para que abra sin señal. Nunca toca las llamadas a /api/: las fotos las maneja la app con su propia cola.
const CACHE = 'chofer-v2';
const BASE = new URL('./', self.location.href); // …/hooks/chofer/
// Sin mirar la cabecera Vary: lo guardado sirve igual aunque el pedido venga con otras cabeceras (Origin, Accept-Encoding).
const SIN_VARY = { ignoreVary: true };

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(BASE.href, { cache: 'reload' })).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n.startsWith('chofer-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// La página avisa qué archivos usó para abrir: se guardan esos y se borran los de versiones viejas.
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.tipo !== 'guardar' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    d.urls = d.urls.filter((u) => typeof u === 'string' && !esManifest(new URL(u, BASE).pathname));
    const quedan = new Set([BASE.href, ...d.urls]);
    const guardar = async (u) => {
      const ya = await c.match(u, SIN_VARY);
      if (ya) return ya;
      try {
        const r = await fetch(u);
        if (!r.ok) return null;
        await c.put(u, r.clone());
        return r;
      } catch {
        return null; // se guardará la próxima vez
      }
    };
    await Promise.all(d.urls.map(async (u) => {
      const r = await guardar(u);
      // La hoja de Google Fonts solo nombra los archivos de la tipografía: se guardan también los de letras latinas.
      if (r && u.startsWith('https://fonts.googleapis.com/')) {
        const css = await r.clone().text();
        const letras = [...css.matchAll(/\/\* latin \*\/[^}]*url\((https:[^)]+)\)/g)].map((m) => m[1]);
        await Promise.all(letras.map(guardar));
      }
    }));
    for (const pedido of await c.keys()) {
      if (pedido.url.startsWith(BASE.href) && !quedan.has(pedido.url)) await c.delete(pedido);
    }
  })());
});

const esManifest = (ruta) => ruta.endsWith('manifest.webmanifest');

function conTope(promesa, ms) {
  return new Promise((ok, mal) => {
    const reloj = setTimeout(() => mal(new Error('tardó')), ms);
    promesa.then((v) => { clearTimeout(reloj); ok(v); }, (err) => { clearTimeout(reloj); mal(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const pedido = e.request;
  if (pedido.method !== 'GET') return;
  const url = new URL(pedido.url);
  const propio = url.origin === self.location.origin && url.pathname.startsWith(BASE.pathname);
  const tipografia = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!propio && !tipografia) return;
  if (propio && url.pathname.startsWith(BASE.pathname + 'api/')) return;
  // El manifest lleva el link personal de cada chofer (?t=…): siempre a la red, nunca guardado.
  if (propio && esManifest(url.pathname)) return;

  // Abrir la app: primero la red (para tener la última versión); si no hay señal o tarda, la guardada.
  if (pedido.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const guardada = await c.match(BASE.href, SIN_VARY);
      const deLaRed = fetch(pedido).then((r) => {
        if (r.ok) c.put(BASE.href, r.clone());
        return r;
      });
      if (!guardada) return deLaRed;
      try {
        const r = await conTope(deLaRed, 3000);
        return r.ok ? r : guardada;
      } catch {
        return guardada;
      }
    })());
    return;
  }

  // El resto (código, estilos, íconos, tipografía): lo guardado primero; si no está, la red, y se guarda.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const guardado = await c.match(pedido, SIN_VARY);
    if (guardado) return guardado;
    const r = await fetch(pedido);
    if (r.ok) c.put(pedido, r.clone());
    return r;
  })());
});
