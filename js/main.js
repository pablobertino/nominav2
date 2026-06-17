/* =====================================================================
   main.js — Punto de entrada del portal. Arranca el router y registra
   las vistas. A medida que crezca el portal, aquí se registran nuevas
   rutas (panel, usuarios, alcance...) sin tocar el resto.
   ===================================================================== */
import { on, start } from './core/router.js';
import { renderLogin } from './views/login.js';
import { renderPanel } from './views/panel.js';
import { getSession } from './core/session.js';

// Rutas registradas
on('/', () => { getSession() ? renderPanel() : renderLogin(); });
on('/login', renderLogin);
on('/panel', renderPanel);
on('*', renderLogin); // fallback

// Arranca: si ya hay sesión, al panel; si no, al login
start(getSession() ? '/panel' : '/login');
