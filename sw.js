/* GeoFacing · service worker (modo sin conexión)
 *
 * IMPORTANTE: cada vez que subas cambios a la página, cambia VERSION (por ejemplo la fecha).
 * Así los teléfonos que ya tienen la app guardada detectan la actualización y ofrecen "Actualizar".
 *
 * Estrategias:
 *  - Archivos de la app (html, css, js, iconos): se guardan juntos en cada versión y se sirven desde el teléfono
 *    (la app abre al instante y sin conexión). Cambian solo cuando cambia VERSION.
 *  - Datos (mapa, horarios, lugares): primero la red, para que los horarios estén al día; si no hay conexión o tarda
 *    más de TIEMPO_RED_MS, se usa la última copia guardada. Esa copia sobrevive a las actualizaciones de la app.
 */
const VERSION = '2026-11-09-1';

const CACHE_APP = 'geofacing-app-' + VERSION;
const CACHE_DATOS = 'geofacing-datos';
const TIEMPO_RED_MS = 3000;

const ARCHIVOS_APP = [
  'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'logo_geofacing.png', 'favicon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
];
const ARCHIVOS_DATOS = ['mapageofacing.svg', 'horarios.json', 'estructuras.json'];

// Copia de una respuesta con la fecha en que se guardó (la app la muestra si usa datos sin conexión)
async function sellar(respuesta) {
  const cabeceras = new Headers(respuesta.headers);
  cabeceras.set('x-guardado', String(Date.now()));
  return new Response(await respuesta.blob(), { status: respuesta.status, statusText: respuesta.statusText, headers: cabeceras });
}

function marcarDesdeCache(respuesta) {
  const cabeceras = new Headers(respuesta.headers);
  cabeceras.set('x-desde-cache', '1');
  return new Response(respuesta.body, { status: respuesta.status, statusText: respuesta.statusText, headers: cabeceras });
}

async function guardarDato(url) {
  const respuesta = await fetch(new Request(url, { cache: 'reload' }));
  if (respuesta.ok) await (await caches.open(CACHE_DATOS)).put(url, await sellar(respuesta.clone()));
}

self.addEventListener('install', evento => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);
    await cache.addAll(ARCHIVOS_APP.map(u => new Request(u, { cache: 'reload' }))); // si falta un archivo, no se instala
    await Promise.all(ARCHIVOS_DATOS.map(u => guardarDato(u).catch(() => {})));       // los datos son "mejor esfuerzo"
    if (!self.registration.active) self.skipWaiting(); // primera instalación: se activa de inmediato
  })());
});

self.addEventListener('activate', evento => {
  evento.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(nombres.filter(n => n.startsWith('geofacing-app-') && n !== CACHE_APP).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// La página pide activar la versión nueva cuando el usuario pulsa "Actualizar"
self.addEventListener('message', evento => {
  if (evento.data === 'saltar-espera') self.skipWaiting();
});

async function desdeLaApp(peticion) {
  const guardada = await (await caches.open(CACHE_APP)).match(peticion, { ignoreSearch: true });
  return guardada || fetch(peticion);
}

async function redPrimero(evento, peticion, ruta) {
  const cache = await caches.open(CACHE_DATOS);
  // la descarga sigue aunque se agote el tiempo, y deja la copia nueva guardada para la próxima vez
  const descarga = fetch(peticion.url, { cache: 'no-cache' }).then(async respuesta => { // 'no-cache': revalida siempre con el servidor (si no cambió, responde 304 sin descargar)
    if (respuesta.ok) await cache.put(ruta, await sellar(respuesta.clone()));
    return respuesta;
  });
  evento.waitUntil(descarga.catch(() => {}));

  const limite = new Promise(resolver => setTimeout(() => resolver(null), TIEMPO_RED_MS));
  try {
    const rapida = await Promise.race([descarga, limite]);
    if (rapida) return rapida;
  } catch (e) { /* sin conexión: se intenta con la copia guardada */ }

  const guardada = await cache.match(ruta);
  if (guardada) return marcarDesdeCache(guardada);
  return descarga; // sin copia guardada: se espera a la red
}

self.addEventListener('fetch', evento => {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;
  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;

  const base = new URL(self.registration.scope).pathname;
  let ruta = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  if (ruta === '') ruta = 'index.html';

  if (peticion.mode === 'navigate') {
    evento.respondWith(desdeLaApp(new Request('index.html')));
  } else if (ARCHIVOS_DATOS.includes(ruta)) {
    evento.respondWith(redPrimero(evento, peticion, ruta));
  } else if (ARCHIVOS_APP.includes(ruta)) {
    evento.respondWith(desdeLaApp(peticion));
  }
});