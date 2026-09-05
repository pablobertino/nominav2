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

/* Los segmentos del hash, sin los vacios: '#/panel/fotos/AA01' -> ['panel',
   'fotos','AA01']. Vive aca porque es el router quien sabe como esta armado
   el hash; el resto del portal pide por posicion y no parsea nada. */
export function rutaPartes() {
  return location.hash.replace(/^#/, '').split('/').filter(Boolean);
}

/* La vista pedida en la URL, si la hay: '#/panel/historial' -> 'historial'. */
export function subRuta() {
  const p = rutaPartes();
  return p.length > 1 ? p[1] : null;
}

/* v6.269 — Lo que viene DESPUES de la vista: en '#/panel/fotos/AA01' el
   'AA01'. Es el argumento con el que una vista reconstruye donde estaba. */
export function subRutaArg(i = 0) {
  const p = rutaPartes();
  return p.length > 2 + i ? decodeURIComponent(p[2 + i]) : null;
}

/* =====================================================================
   fijarRuta(vista, ...args) — deja la URL diciendo donde estas.  (v6.271)

     fijarRuta('historial', 1888)      -> #/panel/historial/1888
     fijarRuta('fotos', 'AA01', ced)   -> #/panel/fotos/AA01/28189230
     fijarRuta('historial')            -> #/panel/historial   (vuelve a la lista)

   UNA SOLA REGLA, y es la que evita todos los accidentes: solo escribe si la
   vista que se pide COINCIDE con la vista que ya esta en la URL. De ahi salen
   gratis los dos casos que antes habia que cuidar a mano:

     · Estando en #/panel/buscar, una ficha NO reescribe la URL a /fotos/...
       El boton Volver de esa ficha apunta a la busqueda, y una URL que
       contradiga al boton Volver es peor que no tener URL.
     · Una pantalla que termina de cargar tarde no puede pisar la URL de otra
       a la que el usuario ya se movio.

   replaceState y NO pushState: no agrega entradas al historial, asi que el
   guardian del boton Atras -que cuenta entradas y lleva su propio stack- no
   se entera de nada. Y tampoco dispara hashchange, asi que no re-renderiza.

   Nunca lanza: si el navegador se queja, la navegacion sigue igual y lo unico
   que se pierde es que la URL quede linda. */
export function fijarRuta(vista, ...args) {
  try {
    const p = rutaPartes();
    if (p[0] !== 'panel' || p[1] !== vista) return;
    const cola = args.filter(a => a != null && a !== '').map(a => encodeURIComponent(a));
    const destino = `#/panel/${vista}${cola.length ? '/' + cola.join('/') : ''}`;
    if (location.hash !== destino) history.replaceState(history.state, '', destino);
  } catch (_) { /* la navegacion sigue igual */ }
}

/** Arranca el router */
export function start(defaultPath = '/') {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) location.hash = defaultPath;
  else resolve();
}
