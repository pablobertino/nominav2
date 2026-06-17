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

function resolve() {
  const path = location.hash.replace(/^#/, '') || '/';
  const handler = routes.get(path) || notFound;
  if (handler) handler();
}

/** Arranca el router */
export function start(defaultPath = '/') {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) location.hash = defaultPath;
  else resolve();
}
