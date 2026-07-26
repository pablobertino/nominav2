/* =====================================================================
   core/export-menu.js — "Exportar ▾" UNIFICADO del portal (v6.132)

   El estándar del sitio: un único botón "Exportar ▾" (blanco/negro, como
   el de Empresas) que al hacer clic despliega un menú GRÁFICO con las tres
   opciones — Excel / CSV / Texto — cada una con su ícono de color y un
   subtítulo. Nace del que tenía Cuentas Bancarias; Pablo pidió volverlo el
   de todos lados, pero con el botón en blanco/negro (no azul).

   Uso en una vista:
     import { ensureExportMenuStyles, exportMenuHtml, wireExportMenu } from '../core/export-menu.js';
     ensureExportMenuStyles();
     // en el innerHTML del encabezado:
     ${exportMenuHtml('miExp')}
     // tras pintar:
     wireExportMenu('miExp', fmt => runExport(fmt));   // fmt: 'xlsx' | 'csv' | 'txt'

   Cada vista mantiene su PROPIA lógica de exportación (columnas, filas
   visibles, etc.); este módulo solo aporta el botón + menú + su apertura.
   ===================================================================== */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

let STYLED = false;
export function ensureExportMenuStyles() {
  if (STYLED || document.getElementById('expdd-styles')) { STYLED = true; return; }
  STYLED = true;
  const css = document.createElement('style');
  css.id = 'expdd-styles';
  css.textContent = `
  .expdd-wrap{position:relative;display:inline-block}
  .expdd-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;
     padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);
     color:var(--ink);cursor:pointer;white-space:nowrap}
  .expdd-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .expdd-btn:disabled{opacity:.55;cursor:default}
  .expdd-menu{position:absolute;right:0;top:calc(100% + 6px);background:var(--card,#fff);
     border:1px solid var(--border);border-radius:11px;box-shadow:0 10px 34px rgba(15,23,42,.14);
     min-width:232px;padding:6px;z-index:70;display:none}
  .expdd-menu.open{display:block}
  .expdd-menu button{display:flex;gap:10px;align-items:center;width:100%;border:0;background:transparent;
     text-align:left;padding:9px 11px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;color:var(--ink)}
  .expdd-menu button:hover{background:var(--bg-soft,#f1f5f9)}
  .expdd-menu span.tx{font-weight:600}
  .expdd-menu small{color:var(--muted);display:block;font-size:11px;font-weight:400}
  .expdd-ico{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;
     font-size:10px;font-weight:800;color:#fff;flex:none;letter-spacing:.02em}
  `;
  document.head.appendChild(css);
}

const DEFAULT_SUB = {
  xlsx: 'Todo lo filtrado',
  csv: 'Separador ; con BOM UTF-8',
  txt: 'Columnas de ancho fijo',
};

/* Devuelve el HTML del botón + menú. `id` es un prefijo único por vista
   (genera `${id}Btn` y `${id}Menu`). opts.subtitles permite ajustar los
   subtítulos; opts.label cambia el texto del botón ("Exportar" por defecto). */
export function exportMenuHtml(id, opts = {}) {
  const sub = { ...DEFAULT_SUB, ...(opts.subtitles || {}) };
  const label = opts.label || 'Exportar';
  return `<div class="expdd-wrap">
    <button class="expdd-btn" id="${esc(id)}Btn" aria-haspopup="true" aria-expanded="false">${esc(label)} ▾</button>
    <div class="expdd-menu" id="${esc(id)}Menu">
      <button data-exp="xlsx"><span class="expdd-ico" style="background:#16a34a">XLS</span><span class="tx">Excel (.xlsx)<small>${esc(sub.xlsx)}</small></span></button>
      <button data-exp="csv"><span class="expdd-ico" style="background:#2563eb">CSV</span><span class="tx">CSV (;)<small>${esc(sub.csv)}</small></span></button>
      <button data-exp="txt"><span class="expdd-ico" style="background:#64748b">TXT</span><span class="tx">Texto alineado<small>${esc(sub.txt)}</small></span></button>
    </div></div>`;
}

/* Conecta el botón y el menú. onPick(fmt) recibe 'xlsx' | 'csv' | 'txt'.
   Cierra al elegir, al hacer clic fuera y respeta varios menús en la misma
   página (cada uno con su propio id). */
export function wireExportMenu(id, onPick) {
  const btn = document.getElementById(id + 'Btn');
  const menu = document.getElementById(id + 'Menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-exp]');
    if (!b) return;
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    onPick(b.dataset.exp);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.expdd-wrap')) {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}
