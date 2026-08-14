/* =====================================================================
   js/reports/shared/wizard-close.js — cerrar un modal de wizard  (v6.223)

   Una X arriba, Escape, y la pregunta antes de descartar lo cargado. Los
   cinco wizards (marcaje, ausencia, egreso, ingreso, modificacion) lo usan
   desde aca en vez de tener cada uno su version: cinco copias de una regla
   de interaccion no se rompen, se DESINCRONIZAN, y el usuario termina
   aprendiendo que "depende del formulario" — que es justo lo contrario de
   lo que un detalle de diseño tiene que lograr.

   POR QUE LA PREGUNTA NO ES OPCIONAL. La X vive arriba a la derecha, que es
   donde se aprieta sin querer. Un formulario de veinte campos que se
   evapora por un clic al pasar es peor que el scroll que la X viene a
   evitar. Pero preguntar SIEMPRE tambien molesta: cerrar un formulario que
   nunca se toco no merece un cartel. Por eso se pregunta solo si hay algo
   escrito, y quien llama decide que significa "algo escrito" en su caso.

   Y CANCELAR HACE LO MISMO QUE LA X. Hasta la v6.222, Cancelar cerraba de
   una y perdia lo cargado igual; nadie se quejaba porque estaba al final de
   la pagina y no se apretaba de casualidad. La distancia escondia el
   riesgo, no lo eliminaba.
   ===================================================================== */

import { confirmModal } from './ticket-actions.js';

/* La X. Se inyecta por JS y no en el HTML de cada wizard para que los cinco
   tengan el MISMO boton: si estuviera en cinco plantillas, en algun momento
   uno tendria otro tamaño u otro titulo. */
function botonX() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'wz-x';
  b.setAttribute('aria-label', 'Cerrar');
  b.title = 'Cerrar (Esc)';
  b.textContent = '✕';
  return b;
}

/**
 * Engancha el cierre de un modal de wizard.
 *
 * @param {object} o
 *   ov        el overlay (.modal-ov) que hay que sacar del DOM
 *   caja      donde se cuelga la X. Por defecto, el .modal de adentro.
 *   hayDatos  () => boolean. Si devuelve true se pregunta antes de cerrar.
 *             Si no se pasa, nunca pregunta (modales de solo confirmacion).
 *   titulo    texto del cartel de confirmacion.
 *   mensaje   idem.
 *   cancelar  selector del boton Cancelar existente, para que haga lo mismo.
 *   alCerrar  callback opcional despues de cerrar (limpiar timers, etc).
 * @returns {function} la propia funcion de cierre, por si hace falta llamarla.
 */
export function wireWizardClose(o = {}) {
  const ov = o.ov;
  if (!ov) return () => {};
  const caja = o.caja || ov.querySelector('.modal') || ov.firstElementChild;
  const hayDatos = typeof o.hayDatos === 'function' ? o.hayDatos : () => false;

  if (caja && !caja.querySelector(':scope > .wz-x')) {
    // El absolute de la X necesita un ancestro posicionado. Se pone aca y no
    // en el CSS de cada modal para no depender de que los cinco lo tengan.
    if (getComputedStyle(caja).position === 'static') caja.style.position = 'relative';
    caja.appendChild(botonX());
  }

  let cerrado = false;
  const cerrar = async () => {
    if (cerrado) return;
    if (hayDatos()) {
      const ok = await confirmModal({
        title: o.titulo || 'Descartar los cambios',
        message: o.mensaje || 'Ya cargaste datos en este formulario. Si cerrás ahora se pierden.',
        confirmText: 'Descartar', cancelText: 'Seguir cargando', danger: true,
      });
      if (!ok) return;
    }
    cerrado = true;
    document.removeEventListener('keydown', onEsc);
    ov.remove();
    if (typeof o.alCerrar === 'function') o.alCerrar();
  };

  /* Escape solo actua si ESTE overlay sigue en pantalla. Con dos modales
     encimados -el wizard y el de confirmacion- el de arriba maneja su
     propio Escape y este no tiene que robarselo. */
  const onEsc = (e) => {
    if (e.key !== 'Escape' || !document.body.contains(ov)) return;
    if (document.querySelectorAll('.modal-ov').length > 1) return;
    cerrar();
  };
  document.addEventListener('keydown', onEsc);

  const x = caja && caja.querySelector(':scope > .wz-x');
  if (x) x.addEventListener('click', cerrar);

  if (o.cancelar) {
    const c = ov.querySelector(o.cancelar);
    if (c) c.addEventListener('click', cerrar);
  }

  return cerrar;
}

/* Atajo para el caso mas comun: "hay datos si alguno de estos campos tiene
   algo". Evita que cada wizard escriba el mismo some() a mano. */
export function algunoConValor(ov, selectores) {
  return () => (selectores || []).some(sel => {
    const el = ov.querySelector(sel);
    if (!el) return false;
    if (el.type === 'checkbox' || el.type === 'radio') return !!el.checked;
    return !!String(el.value || '').trim();
  });
}
