/* =====================================================================
   js/core/refresh.js — boton "Recargar" unificado del portal.
   Componente aprobado en _PRUEBAS\refresh_mockup.html (v0-mock1).

   Uso (una linea por vista):
     import { attachRefresh } from '../core/refresh.js';
     // la vista pone un host vacio en su header: <span id="xxxRefresh"></span>
     attachRefresh('#xxxRefresh', miFuncionDeRecarga, 'clave-de-la-vista');

   Reglas del componente (las 5 de la maqueta):
     1. Icono de 32x32 con tooltip "Recargar", siempre el elemento mas a la
        izquierda del grupo de acciones del header.
     2. Al hacer clic gira y se deshabilita hasta que la recarga termine.
     3. La recarga la hace la VISTA (onReload): re-consulta sus datos
        conservando filtros, orden y busqueda. Este componente no sabe nada
        de los datos.
     4. Texto "hace X min" a la izquierda del icono; en movil (<560px) se
        oculta y queda solo el icono.
     5. Nada automatico: solo recarga cuando el usuario lo pide.

   La MARCA DE TIEMPO del ultimo refresco vive en un mapa a nivel de modulo
   (por `key`): si la vista repinta su header al recargar (paint() completo),
   el attach nuevo sigue mostrando la hora correcta.
   ===================================================================== */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

// key -> timestamp (ms) del ultimo refresco. Sobrevive repintados de la vista.
const LAST = {};

function ensureStyles() {
  if (document.getElementById('pnlRefreshStyles')) return;
  const st = document.createElement('style');
  st.id = 'pnlRefreshStyles';
  st.textContent = `
  .pnl-refresh-wrap{display:inline-flex;align-items:center;gap:8px}
  .pnl-refresh{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;
    border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--muted);
    cursor:pointer;flex:none;padding:0}
  .pnl-refresh:hover:not(:disabled){background:var(--bg-soft,#f1f5f9);color:var(--ink)}
  .pnl-refresh svg{width:15px;height:15px}
  .pnl-refresh.spin svg{animation:pnlRefSpin .8s linear infinite}
  .pnl-refresh:disabled{opacity:.55;cursor:default}
  @keyframes pnlRefSpin{to{transform:rotate(360deg)}}
  .pnl-refresh-ago{font-size:11.5px;color:var(--faint,#94a3b8);white-space:nowrap}
  @media (max-width:560px){ .pnl-refresh-ago{display:none} }
  `;
  document.head.appendChild(st);
}

/* Monta el boton dentro de `host` (selector o elemento). `onReload` es la
   funcion de recarga de la vista (puede ser async y puede repintar el header:
   el componente lo tolera). `key` identifica la vista para conservar la hora
   del ultimo refresco entre repintados. */
export function attachRefresh(host, onReload, key) {
  const el = typeof host === 'string' ? document.querySelector(host) : host;
  if (!el) return;
  ensureStyles();
  if (!LAST[key]) LAST[key] = Date.now();   // primer montado = recien cargado

  el.classList.add('pnl-refresh-wrap');
  el.innerHTML = `<span class="pnl-refresh-ago"></span>`
    + `<button type="button" class="pnl-refresh" title="Recargar" aria-label="Recargar">${ICON}</button>`;
  const ago = el.querySelector('.pnl-refresh-ago');
  const btn = el.querySelector('.pnl-refresh');

  const paintAgo = () => {
    const min = Math.floor((Date.now() - LAST[key]) / 60000);
    if (min <= 0) ago.textContent = 'justo ahora';
    else if (min < 60) ago.textContent = `hace ${min} min`;
    else {
      const h = Math.floor(min / 60), rm = min % 60;
      ago.textContent = rm ? `hace ${h} h ${rm} min` : `hace ${h} h`;
    }
  };
  paintAgo();

  // Envejecer el texto cada 30s; si el elemento salio del DOM (la vista se
  // repinto o se navego a otra), el intervalo se limpia solo.
  const timer = setInterval(() => {
    if (!document.body.contains(el)) { clearInterval(timer); return; }
    paintAgo();
  }, 30000);

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spin');
    ago.textContent = 'actualizando\u2026';
    // La marca se toma al iniciar: si onReload repinta el header, el attach
    // nuevo (dentro del paint de la vista) ya muestra "justo ahora".
    LAST[key] = Date.now();
    try { await onReload(); }
    catch (_) { /* la vista muestra su propio error; aqui solo restauramos */ }
    if (document.body.contains(el)) {
      btn.disabled = false;
      btn.classList.remove('spin');
      paintAgo();
    } else {
      clearInterval(timer);
    }
  });
}
