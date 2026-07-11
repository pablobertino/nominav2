/* =====================================================================
   main.js — Punto de entrada del portal. Arranca el router y registra
   las vistas. A medida que crezca el portal, aquí se registran nuevas
   rutas (panel, usuarios, alcance...) sin tocar el resto.
   ===================================================================== */
import { on, start } from './core/router.js';
import { renderLogin } from './views/login.js';
import { renderPanel } from './views/panel.js';
import { getSession, clearSession } from './core/session.js';

/* v5.08: nadie entra al panel con una clave temporal pendiente de cambio.
   El camino normal ya lo cubre login.js (intercepta el ingreso y pide la
   clave nueva ANTES de abrir sesion). Esto es el cinturon para el resto de
   los casos: una sesion que quedo abierta de antes de este cambio, o alguien
   que escribe #/panel a mano. Se descarta esa sesion y se lo manda al login,
   donde va a tener que pasar si o si por el cambio de clave. */
function guard(view) {
  return () => {
    const s = getSession();
    if (s && s.mustChangePassword) {
      clearSession();
      renderLogin();
      return;
    }
    view();
  };
}

// Rutas registradas
on('/', () => { getSession() ? guard(renderPanel)() : renderLogin(); });
on('/login', renderLogin);
on('/panel', guard(renderPanel));
on('*', renderLogin); // fallback

// Arranca: si ya hay sesión, al panel; si no, al login
start(getSession() ? '/panel' : '/login');
