/* =====================================================================
   js/core/back-nav.js
   Bus DESACOPLADO del guardian del boton "Atras" del navegador.

   Problema que resuelve: el portal es una SPA. panel.js instala el guardian
   real (History API: pushState + popstate + pila de vistas) y expone una
   forma de registrar "interceptores" del Atras (funciones que, mientras una
   sub-vista/wizard este activo, consumen el Atras para retroceder DENTRO de
   esa sub-vista en vez de salir de ella).

   Pero componentes como el wizard (js/reports/wizard-core.js) viven en otro
   modulo y NO pueden importar de panel.js sin crear una dependencia circular
   (panel.js importa el wizard). Este modulo es el intermediario:

     - panel.js         ->  registerBackHandler(impl)   // conecta su impl real
     - wizard-core.js   ->  pushBackInterceptor(fn)      // registra su interceptor

   Contrato de un interceptor `fn`:
     - Se invoca cuando el usuario pulsa Atras y este interceptor esta en el
       tope de la pila.
     - Devuelve `true` si CONSUMIO el Atras (retrocedio dentro de la sub-vista).
     - Devuelve `false` (o nada) si no habia a donde retroceder -> el guardian
       hace la navegacion normal (sacar de la sub-vista a la vista anterior).

   `pushBackInterceptor(fn)` devuelve SIEMPRE una funcion de limpieza (para
   desregistrar el interceptor), sea cual sea el orden de carga:

     const remove = pushBackInterceptor(miFn);
     // ...mas tarde:
     remove();

   Robustez ante el orden de carga: si un componente registra un interceptor
   ANTES de que panel.js haya conectado su impl real, el `fn` se guarda en una
   cola pendiente y se vuelca a la impl en cuanto se conecta. La funcion de
   limpieza devuelta funciona en ambos casos (antes y despues de conectar).
   ===================================================================== */

// Impl real del registro de interceptores (la aporta panel.js). Firma:
//   IMPL(fn) -> removeFn
let IMPL = null;

// Interceptores registrados ANTES de que panel conecte su impl. Cada entrada
// es un "handle" mutable para poder redirigir su limpieza cuando se conecte.
const PENDING = [];

/* panel.js llama esto en installBackGuard, pasando su pushBackInterceptor real.
   Al conectar, se vuelca la cola pendiente a la impl y cada handle pendiente
   pasa a apuntar al remove real que devuelve la impl. */
export function registerBackHandler(impl) {
  IMPL = typeof impl === 'function' ? impl : null;
  if (!IMPL) return;
  // Volcar los interceptores que se registraron antes de tiempo, en orden.
  while (PENDING.length) {
    const handle = PENDING.shift();
    if (handle.removed) continue;            // ya lo quitaron antes de conectar
    handle.realRemove = IMPL(handle.fn) || null;
  }
}

/* Registra un interceptor del Atras. Devuelve una funcion de limpieza segura
   sin importar si la impl real ya esta conectada o no. */
export function pushBackInterceptor(fn) {
  if (typeof fn !== 'function') return () => {};

  // Caso normal: la impl real ya esta conectada -> delegar directamente.
  if (IMPL) {
    const realRemove = IMPL(fn) || null;
    return () => { if (realRemove) realRemove(); };
  }

  // Caso temprano: aun no hay impl. Encolar y devolver una limpieza que
  // funcione tanto si se quita ANTES como DESPUES de conectar la impl.
  const handle = { fn, removed: false, realRemove: null };
  PENDING.push(handle);
  return () => {
    if (handle.removed) return;
    handle.removed = true;
    if (handle.realRemove) {
      // Ya se volco a la impl real: usar su remove.
      handle.realRemove();
      handle.realRemove = null;
    } else {
      // Aun en la cola pendiente: sacarlo de ahi.
      const i = PENDING.indexOf(handle);
      if (i !== -1) PENDING.splice(i, 1);
    }
  };
}
