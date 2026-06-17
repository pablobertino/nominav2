/* =====================================================================
   core/session.js — Manejo simple de sesión en memoria + sessionStorage
   Guarda el usuario logueado para que el router sepa qué vista mostrar.
   (sessionStorage se limpia al cerrar la pestaña; suficiente para esta fase.)
   ===================================================================== */
const KEY = 'nmv2_session';

export function setSession(user) {
  sessionStorage.setItem(KEY, JSON.stringify(user));
}

export function getSession() {
  try { return JSON.parse(sessionStorage.getItem(KEY)); }
  catch { return null; }
}

export function clearSession() {
  sessionStorage.removeItem(KEY);
}
