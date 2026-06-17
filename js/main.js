/* =====================================================================
   main.js — Punto de entrada del portal. Arranca el router y registra
   las vistas. A medida que crezca el portal, aquí se registran nuevas
   rutas (panel, usuarios, alcance...) sin tocar el resto.
   ===================================================================== */
import { on, start } from './core/router.js';
import { renderLogin } from './views/login.js';

// Rutas registradas
on('/', renderLogin);
on('/login', renderLogin);
on('*', renderLogin); // fallback: cualquier ruta desconocida → login

// Arranca en /login
start('/login');
