/* =====================================================================
   core/ver-como.js — abrir el panel con la sesión de otro usuario  (v6.256)

   PARA QUÉ. Soporte. Cuando una tienda dice "no me aparece el botón" o un
   gestor "no veo esa empresa", la única forma honesta de responder es mirar
   lo que él mira. Adivinar desde la matriz de permisos falla seguido.

   POR QUÉ FUNCIONA SIN TOCAR CASI NADA. renderPanel() reconstruye todo el
   panel desde el objeto de sesión, y el menú se poda solo con /api/my-perms
   del usuario de esa sesión. Cambiar la sesión y repintar alcanza. El propio
   panel.js ya lo anticipaba: "evita que datos de un usuario anterior se
   filtren si se cambia de sesión sin recargar".

   SOLO LECTURA, Y POR QUÉ IMPORTA. Si desde acá se pudiera enviar un
   reporte, el historial diría que lo mandó la tienda. El registro de quién
   hizo qué dejaría de ser confiable, que es justo lo que sostiene todo lo
   demás. Así que se bloquea toda escritura (ver ACCIONES_LECTURA).

   QUÉ ES Y QUÉ NO ES ESTE BLOQUEO. Es un guardarraíl contra un descuido de
   quien lo usa, NO una barrera de seguridad: el API acepta el objeto `user`
   sin token, así que quien conozca un id ya puede hacer lo mismo por su
   cuenta. Formalizarlo no agrega riesgo; lo deja auditado. Cuando el API
   tenga autenticación real, esto debería revisarse junto con ella.

   FALLA CERRADO. La lista de acciones permitidas es una LISTA BLANCA: una
   acción nueva queda bloqueada hasta que se agregue. En un modo de solo
   lectura es preferible molestar a alguien que dejar pasar una escritura.
   ===================================================================== */

import { getSession, setSession } from './session.js';

const KEY_ORIGEN = 'nmv2_vercomo_origen';

/* Acciones de LECTURA. Todo lo que no esté acá se bloquea.
   Los nombres siguen la convención del portal: list/get/detail/search para
   leer, y save/create/update/delete/submit/send/replace para escribir. */
const ACCIONES_LECTURA = new RegExp('^(?:'
  + 'list|get|detail|search|facets|stats|resumen|current|years|card|grid'
  + '|check|sign|download|versions|audit|activity|periods|count|evolucion'
  + '|moves|incomplete|directory|group_history|cat_list|worker_reports'
  + '|detalle_tienda|ticket_text|ticket_excel|resend_info|company_history'
  + '|window|rotation|ficha|verify'
  + '|[a-z_]+_catalogs|[a-z_]+_causas|[a-z_]+_reasons|[a-z_]+_types'
  + ')$');

/* Endpoints de LECTURA que no declaran `action`. Solo aplica cuando el
   pedido NO trae accion: si la trae, manda la lista blanca de arriba.

   La version anterior eximia el ENDPOINT COMPLETO, y eso dejaba pasar
   holidays(create/update/delete), periods(generate/override/reset) y
   announcements(save/delete): tres endpoints con acciones destructivas que
   quedaban fuera del bloqueo justamente porque tambien servian lecturas.
   Mirar primero la accion y despues el endpoint cierra eso. */
const ENDPOINTS_SIN_ACCION = new Set([
  'my-perms', 'version', 'dashboard', 'empresas', 'logistic-geo',
  'sync-log', 'ax-probe', 'osticket-test', 'bank-stats', 'bank-accounts',
  'ver-como',
]);

export function estoyViendoComo() {
  return !!sessionStorage.getItem(KEY_ORIGEN);
}

export function sesionOriginal() {
  try { return JSON.parse(sessionStorage.getItem(KEY_ORIGEN)); } catch { return null; }
}

/* Arranca el modo. `objetivo` es un objeto de sesión ya armado por quien
   llama (Usuarios / Equipo saben qué forma tiene cada tipo). */
export function entrarVerComo(objetivo, etiqueta) {
  const yo = getSession();
  if (!yo || estoyViendoComo()) return false;
  /* La bitácora se manda ANTES de prestar la sesión. Al revés se bloqueaba
     sola: el propio guardarraíl interceptaba el POST y el registro nunca
     llegaba, con lo cual la función quedaba sin rastro — exactamente lo que
     no puede pasar con algo que deja ver la pantalla de otro. */
  const registrar = () => {
  try {
    return fetch('/api/ver-como', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'log', user: yo,
        target_kind: objetivo.kind,
        target_id: String(objetivo.id || objetivo.companyCode || ''),
        target_label: etiqueta || '',
      }),
    }).catch(() => {});
    } catch (_) { /* noop */ }
  };
  registrar();

  sessionStorage.setItem(KEY_ORIGEN, JSON.stringify(yo));
  setSession({ ...objetivo, verComo: { de: yo.id || null, etiqueta: etiqueta || '' } });
  return true;
}

export function salirVerComo() {
  /* Se restaura PRIMERO y se borra la marca despues. Al reves, si la sesion
     guardada estaba corrupta quedaba la sesion prestada activa Y el
     guardarraíl apagado: escritura completa con la identidad de otro. */
  const yo = sesionOriginal();
  if (!yo) return false;
  setSession(yo);
  sessionStorage.removeItem(KEY_ORIGEN);
  return true;
}

/* Para cerrar sesion: deja todo limpio aunque la sesion prestada siguiera
   activa. Sin esto, la marca sobrevivia al logout y la proxima sesion
   -la tuya- arrancaba en modo solo lectura sin forma de salir. */
export function limpiarVerComo() {
  sessionStorage.removeItem(KEY_ORIGEN);
}

/* ---------- El bloqueo de escritura ----------
   Se envuelve fetch una sola vez. Es el único punto por el que pasan todas
   las llamadas del panel, así que no hay que tocar cada pantalla — y
   justamente por eso no se puede olvidar ninguna. */
let YA_ENVUELTO = false;

export function instalarBloqueoLectura(alBloquear) {
  if (YA_ENVUELTO) return;
  YA_ENVUELTO = true;
  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    if (!estoyViendoComo()) return original(input, init);

    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('/api/')) return original(input, init);

    const endpoint = url.split('/api/')[1].split('?')[0].replace(/\/$/, '');

    let accion = '';
    try {
      const b = init && init.body ? JSON.parse(init.body) : null;
      accion = (b && b.action) ? String(b.action) : '';
    } catch (_) { accion = ''; }

    /* La ACCION manda. Solo si no hay accion se mira el endpoint, y solo
       contra la lista de los que no la usan. Cualquier otra cosa se bloquea:
       un body que no se pudo leer (FormData, Blob) tambien cae aca, que es lo
       correcto en un modo de solo lectura. */
    if (accion) {
      if (ACCIONES_LECTURA.test(accion)) return original(input, init);
    } else if (ENDPOINTS_SIN_ACCION.has(endpoint)) {
      return original(input, init);
    }

    if (typeof alBloquear === 'function') alBloquear(endpoint, accion);
    return new Response(JSON.stringify({
      ok: false,
      error: 'Estás viendo como otro usuario. En este modo no se puede guardar ni enviar nada.',
      ver_como_bloqueado: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}
