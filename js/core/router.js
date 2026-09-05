/* =====================================================================
   core/router.js — Router mínimo basado en hash (#/ruta)
   Permite navegar entre vistas sin recargar y deja espacio para crecer
   (login, panel, usuarios, alcance...) sin tocar el shell.
   ===================================================================== */
const routes = new Map();
let notFound = null;

/** Registra una ruta: on('/login', fn) */
export function on(path, handler) {
  if (path === '*') notFound = handler;
  else routes.set(path, handler);
}

/** Navega a una ruta */
export function go(path) {
  if (location.hash !== '#' + path) location.hash = path;
  else resolve();
}

/* v6.268 — RUTAS CON SEGUNDO SEGMENTO (#/panel/historial).
   Antes solo habia coincidencia EXACTA contra el Map: '#/panel/historial' no
   estaba registrado, caia en notFound y te mandaba al LOGIN. Por eso la URL
   nunca podia llevar la vista y refrescar te devolvia al Inicio.

   Se prueba primero la ruta exacta y, solo si no existe, la raiz. Ninguna URL
   que hoy funciona cambia de comportamiento: '#/panel', '#/login' y '#/'
   siguen encontrandose por coincidencia exacta igual que antes. Lo unico que
   cambia es lo que ANTES iba a parar al login. */
function resolve() {
  const path = location.hash.replace(/^#/, '') || '/';
  let handler = routes.get(path);
  if (!handler) {
    const raiz = '/' + (path.split('/').filter(Boolean)[0] || '');
    if (raiz !== '/') handler = routes.get(raiz);
  }
  handler = handler || notFound;
  if (handler) handler();
}

/* La vista pedida en la URL, si la hay: '#/panel/historial' -> 'historial'.
   Vive aca porque es el router quien sabe como esta armado el hash. */
export function subRuta() {
  const partes = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  return partes.length > 1 ? partes[1] : null;
}

/** Arranca el router */
export function start(defaultPath = '/') {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) location.hash = defaultPath;
  else resolve();
}
