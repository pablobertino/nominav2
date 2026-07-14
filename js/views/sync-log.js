/* =====================================================================
   js/views/sync-log.js  →  vista "Registro de sincronizaciones" (v4.59)
   Solo superadmin. Se abre desde los botones "Registro" de las tres
   tarjetas de Configurar (no tiene item de menu propio).

   Un solo lugar para los TRES procesos programados (combo Proceso):
     - Catalogo de empresas   (sync_runs)
     - Estado de pago         (pay_sync_run)
     - Personal de tiendas    (roster_sync_log agrupado por corrida)

   Filtros: proceso, desde/hasta, estado. Paginado server-side. Detalle
   expandible por corrida (en Personal: fila por tienda con +/-/alerta).
   EXPORTAR xlsx/csv/txt con el patron de Empresas (REGLA GLOBAL de
   Pablo: "siempre el exportar debe hacerse asi en todos lados").

   Datos por /api/sync-log. Export: renderSyncLog(user, presetProcess?)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { attachRefresh } from '../core/refresh.js';

let USER = null;
let SL = { process: 'roster', page: 1, size: 25, status: '', from: '', to: '', total: 0, rows: [], note: '' };

/* ===== v5.58 — QUE CORRIDA SE ESTA MIRANDO =====
   La pagina de detalle (renderSyncRun) necesita saber CUAL. El portal no tiene
   router de verdad (navigate() enruta por data-view, sin parametros), asi que la
   corrida elegida viaja por el estado del modulo. Se guarda la fila ENTERA, no
   el id: ya la tenemos cargada, y pedirla de nuevo seria una llamada al pedo. */
let SL_OPEN = null;

/* v5.56: que pestaña esta abierta en cada corrida (idx -> 'mov'|'fill'|'dif'|
   'rej'|'alr'). Lo necesita EXPORTAR: baja LA PESTAÑA QUE ESTAS VIENDO, no todo
   mezclado. Antes el export tiraba las 5 categorias de TODAS las corridas de la
   pagina en un solo archivo con columnas vacias por todos lados: un Excel que
   habia que limpiar a mano antes de poder usarlo. */
let SL_TAB = {};

const PROC_LBL = {
  companies: 'Cat\u00e1logo de empresas',
  pay: 'Estado de pago',
  roster: 'Personal de tiendas',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/* Etiqueta legible del campo. El backend manda la clave interna (telefono /
   correo / cuenta), igual que en Diferencias. */
const CAMPO_LBL = {
  cuenta: 'Cuenta bancaria', telefono: 'Tel\u00e9fono', correo: 'Correo',
  account_number: 'Cuenta bancaria', phone: 'Tel\u00e9fono', email: 'Correo',
};

/* Mismo formateo que Diferencias: una cuenta de 20 digitos pegados es
   ilegible; en grupos de 4, la diferencia entre dos cuentas salta a la vista.
   El telefono se muestra en formato nacional (0424 8494408). */
function fmtVal(campo, v) {
  const s = String(v == null ? '' : v);
  if (!s) return '\u2014';
  const c = String(campo || '').toLowerCase();
  if (c.includes('cuenta') || c === 'account_number') {
    const d = s.replace(/\D/g, '');
    if (d.length === 20) return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  if (c.includes('tel') || c === 'phone') {
    let d = s.replace(/[^\d+]/g, '');
    if (d.startsWith('+58')) d = '0' + d.slice(3);
    else if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);
    if (/^\d{11}$/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4);
  }
  return s;
}

async function api(payload) {
  return fetch('/api/sync-log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminId: USER.id, user: { kind: USER.kind, id: USER.id || null, companyCode: USER.companyCode || null }, ...payload }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('slStyles')) return;
  const st = document.createElement('style');
  st.id = 'slStyles';
  st.textContent = `
  .sl-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .sl-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .sl-bar{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:16px 0 12px}
  .sl-bar .fg{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:600;color:var(--muted)}
  .sl-bar input,.sl-bar select{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink)}
  .sl-bar input:focus,.sl-bar select:focus{outline:none;border-color:var(--brand,#2563eb)}
  /* v5.58 — EL COMBO TIENE QUE PARECER UN COMBO (Pablo).
     Sin flechita no se lee como desplegable: parece una etiqueta. Y el navegador
     pinta el <select> en negrita heredada, asi que "Personal de tiendas" gritaba
     mas que el titulo de la pagina. Se apaga la apariencia nativa, se dibuja el
     chevron a mano (mismo trazo que el del menu) y se deja el peso normal. */
  .sl-bar select{
    -webkit-appearance:none; -moz-appearance:none; appearance:none;
    font-weight:400; padding-right:30px; cursor:pointer;
    background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat:no-repeat; background-position:right 9px center; background-size:13px;
  }
  .sl-bar select option{font-weight:400}
  .sl-bar select:hover{border-color:var(--muted)}
  .sl-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--ink);cursor:pointer}
  .sl-btn:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .sl-btn:disabled{opacity:.5;cursor:default}
  .sl-note{font-size:12px;color:var(--muted);margin:0 0 10px}
  .sl-tblwrap{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);overflow:auto}
  .sl-tbl{border-collapse:collapse;width:100%;font-size:13px}
  .sl-tbl th{background:var(--bg-soft,#f8fafc);text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
  .sl-tbl td{padding:9px 12px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:top;color:var(--ink)}
  .sl-tbl tr:hover td{background:var(--bg-soft,#f8fafc)}
  .sl-st{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap}
  .sl-st.ok{background:var(--success-bg,#f0fdf4);color:var(--success,#15803d);border:1px solid #bbf7d0}
  .sl-st.error{background:var(--danger-bg,#fef2f2);color:var(--danger,#b91c1c);border:1px solid #f3c2c2}
  .sl-st.alerta{background:var(--warn-bg,#fff7ed);color:#b45309;border:1px solid #fed7aa}
  .sl-more{background:none;border:0;color:var(--brand,#2563eb);cursor:pointer;padding:0;font:inherit;font-size:12.5px;text-decoration:underline}

  /* v5.60/61 — LOS BOTONES DE LA COLUMNA SON BOTONES, NO LINKS.
     "Ver detalle →" abre una PAGINA (renderSyncRun), igual que
     "← Volver a las sincronizaciones" vuelve de ella: dos acciones del mismo
     peso, se ven igual. El link azul subrayado las hacia parecer notas al pie.
     v5.61: "Detalle" (Empresas / Estado de pago) toma el MISMO estilo. Estan en
     la misma columna de la misma tabla: que uno fuera boton y el otro link se
     leia como un descuido. La diferencia real vive en la ETIQUETA, no en el
     estilo ("Ver detalle →" navega; "Detalle" despliega ahi mismo).
     Compacto: sl-btn esta dimensionado para la barra de filtros y dentro de una
     celda quedaria enorme. */
  .sl-verdet{padding:5px 11px;font-size:12.5px;white-space:nowrap}

  /* v5.62 — el detalle de Empresas, en la fila.
     Gris y chico: es apoyo del resumen, no compite con el. Los numeros en
     negrita para que se lean de un vistazo sin tener que leer las etiquetas. */
  .sl-dline{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
  .sl-dline b{color:var(--ink-soft,#475569);font-weight:600}
  .sl-derr{color:var(--danger,#b91c1c)}
  .sl-derr b{color:var(--danger,#b91c1c)}

  /* El boton de copiar: cuadrado, solo icono. Reemplaza al viejo "Detalle" +
     "Copiar detalle" (dos controles para una sola cosa). */
  .sl-ico{padding:0;width:30px;height:30px;display:inline-flex;align-items:center;
          justify-content:center;color:var(--muted)}
  .sl-ico:hover{color:var(--ink)}
  .sl-okcopy{display:inline-block;margin-left:5px;font-size:12px;font-weight:700;
             color:var(--success,#15803d);vertical-align:middle}
  .sl-det{background:var(--bg-soft,#f8fafc);border-radius:8px;padding:8px 11px;margin-top:7px;font-size:12px;color:var(--ink-soft,#475569);line-height:1.55;word-break:break-word}
  .sl-pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:12.5px;color:var(--muted)}
  .sl-empty{padding:40px 16px;text-align:center;color:var(--muted)}

  /* ===== EL AVISO (v5.56) =====
     v5.43 lo puso ABAJO, despues de las tablas, y con un boton naranja solido
     que gritaba mas que el propio aviso.

     Ahora va ARRIBA (es lo primero que hay que saber) y, sobre todo, HABLA EN
     PASADO: el numero de la corrida es historia y no cambia nunca; debajo se
     dice cuantas siguen vivas HOY. Antes decia "dejo 19 por resolver" aunque ya
     las hubieras resuelto todas, y el boton te mandaba a una pantalla vacia. */
  .sl-av{display:flex;align-items:center;gap:12px;border-radius:11px;padding:11px 14px;
         margin:0 0 14px;font-size:12.5px;line-height:1.55}
  .sl-av-ico{width:30px;height:30px;border-radius:9px;flex:none;display:flex;align-items:center;
             justify-content:center}
  .sl-av-ico svg{width:16px;height:16px}
  .sl-av .tx{flex:1;min-width:0}
  .sl-av .sub{font-size:11.5px;margin-top:2px;opacity:.9}

  /* Con cosas vivas: ambar. El boton ATENUADO, en la familia del de Publicar
     (borde ambar, fondo blanco, texto oscuro). El relleno naranja solido de
     v5.43 se veia mas fuerte que la pagina entera. Fondo blanco y no ambar
     claro: el aviso YA es ambar, un boton del mismo tono se le fundiria. */
  .sl-av.pend{background:#fffbeb;border:1px solid #fde68a;color:#78350f}
  .sl-av.pend .sl-av-ico{background:#fef3c7;color:#b45309}
  .sl-golink{font:inherit;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:8px;
             border:1px solid #fcd34d;background:#fff;color:#92400e;cursor:pointer;white-space:nowrap;
             display:inline-flex;align-items:center;gap:6px;flex:none}
  .sl-golink:hover{background:#fef3c7;border-color:#d97706}

  /* Ya no queda nada: verde y SIN boton (no tiene a donde llevarte). */
  .sl-av.done{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
  .sl-av.done .sl-av-ico{background:#dcfce7;color:#15803d}

  /* Estado de cada diferencia: si ya se decidio o si sigue esperando. Sin esto,
     el Registro te obliga a ir a Diferencias a ver que paso con cada una. */
  .sl-stt{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;
          font-size:10px;font-weight:800;white-space:nowrap}
  .sl-stt.open{background:#fffbeb;color:#b45309}
  .sl-stt.done{background:#f0fdf4;color:#15803d}

  .sl-vp{color:#15803d;font-weight:600}   /* valor del portal  */
  .sl-vs{color:#b45309;font-weight:600}   /* valor del sistema */
  .sl-vbad{color:#9a3412;font-weight:600} /* dato mal escrito  */

  /* v5.37: pestanas del detalle (Movimientos / Completadas / Alertas) */
  .sl-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin:2px 0 0;flex-wrap:wrap}
  .sl-tab{font:inherit;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;padding:7px 12px;
          background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
  .sl-tab:hover{color:var(--ink)}
  .sl-tab.on{color:var(--brand,#2563eb);border-bottom-color:var(--brand,#2563eb);font-weight:700}
  .sl-tn{display:inline-block;margin-left:4px;padding:1px 6px;border-radius:999px;background:#eef2f7;
         color:var(--muted);font-size:10.5px;font-weight:700}
  .sl-tab.on .sl-tn{background:#e6efff;color:var(--brand,#2563eb)}
  /* Punto en la pestaña que tiene cosas sin resolver. El mismo gesto que el
     badge del menu: te dice DONDE mirar sin que tengas que abrir cada una. */
  .sl-tdot{display:inline-block;width:6px;height:6px;border-radius:99px;background:#d97706;
           margin-left:5px;vertical-align:1px}
  .sl-pane{padding-top:11px}
  .sl-pn{font-size:12px;color:var(--ink-soft,#475569);margin:0 0 10px;padding:8px 11px;border-radius:8px;
         background:var(--bg-soft,#f8fafc);border:1px solid var(--border-soft,#eef1f5);line-height:1.6}
  .sl-pn b{color:var(--ink)}
  .sl-mini{width:100%;border-collapse:collapse;font-size:12px;background:var(--card,#fff);
           border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .sl-mini th{background:var(--bg-soft,#f8fafc);text-align:left;font-size:10px;text-transform:uppercase;
              letter-spacing:.04em;color:var(--muted);font-weight:700;padding:7px 9px;
              border-bottom:1px solid var(--border);white-space:nowrap}
  .sl-mini td{padding:7px 9px;border-bottom:1px solid var(--border-soft,#eef1f5);color:var(--ink);vertical-align:middle}
  .sl-mini tr:last-child td{border-bottom:0}
  .sl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;
           font-variant-numeric:tabular-nums}
  .sl-cc{color:var(--brand,#2563eb);font-weight:700;font-size:11.5px}
  .sl-pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:800;white-space:nowrap}
  .sl-pill.rev{background:#e6efff;color:#1e40af}
  .sl-pill.fix{background:#fdf3e7;color:#b45309}

  /* ===== v5.58 — LA PAGINA DE LA CORRIDA =====
     El detalle dejo de vivir dentro de la fila del Registro. Es una pagina, con
     su cabecera, su ficha y sus pestanas — tal cual el mockup aprobado. */
  .sr-back{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;
           padding:7px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);
           color:var(--ink);cursor:pointer;margin-bottom:14px}
  .sr-back:hover{background:var(--bg-soft,#f1f5f9)}

  /* La ficha de la corrida: los cuatro numeros. Es el mismo bloque que ya usa
     Diferencias, para que las dos pantallas se lean igual. */
  .sr-run{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);
          padding:14px 16px;margin:0 0 20px}
  .sr-run-t{font-size:13.5px;color:var(--ink);font-weight:600}
  .sr-run-sub{font-size:12px;color:var(--muted);margin:2px 0 12px}
  .sr-run-found{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint,#94a3b8);
                font-weight:700;margin-bottom:8px}
  .sr-res{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .sr-r{border-left:2px solid var(--border);padding-left:11px}
  .sr-r .v{font-size:24px;font-weight:700;line-height:1.15;color:var(--ink)}
  .sr-r .k{font-size:12px;color:var(--ink);font-weight:600;margin-top:1px}
  .sr-r .h{font-size:11px;color:var(--muted);margin-top:1px;line-height:1.4}
  .sr-r.act{border-left-color:#2563eb}
  .sr-r.act .v{color:var(--brand-ink,#1e40af)}
  .sr-r.zero .v{color:var(--faint,#94a3b8)}
  @media(max-width:900px){.sr-res{grid-template-columns:1fr 1fr}}

  /* La tarjeta que contiene las pestanas */
  .sr-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
  .sr-chead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
  .sr-chead h2{font-size:15.5px;font-weight:700;margin:0 0 3px;color:var(--ink)}
  .sr-chead .desc{margin:0;color:var(--muted);font-size:12.5px}

  .sr-tfoot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:12px;flex-wrap:wrap}
  .sr-muted{color:var(--faint,#94a3b8);font-size:12px}
  .sr-muted b{color:var(--muted)}`;
  document.head.appendChild(st);
}

/* ---------- EXPORTAR (patron Empresas: xlsx / csv / txt) ---------- */
function slExportRows() {
  /* v5.37: en Personal de tiendas, el export deja de ser "una fila por corrida"
     y pasa a ser UNA FILA POR CASO: cada ficha completada, cada diferencia,
     cada dato mal escrito. Eso es lo que sirve para trabajar: se abre en Excel,
     se filtra por estado, y se va a corregir al sistema.

     El resumen por corrida no se pierde: va en las columnas Fecha/Origen. */
  if (SL.process === 'roster') {
    const filas = [];
    for (const r of SL.rows) {
      const base = {
        'Fecha': fmtDT(r.run_at),
        'Origen': r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual',
      };
      for (const d of (r.fills || [])) filas.push({
        ...base, 'Tipo': 'Ficha completada', 'Estado': '',
        'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
        'Campo': d.campo || '', 'En el portal': '', 'En el sistema': d.valor || '',
      });
      for (const d of (r.diffs || [])) filas.push({
        ...base, 'Tipo': 'Diferencia',
        'Estado': d.estado === 'dato_roto' ? 'Corregir en el sistema' : 'Revisar',
        'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
        'Campo': d.campo || '', 'En el portal': d.portal || '', 'En el sistema': d.sistema || '',
      });
      for (const d of (r.rejects || [])) filas.push({
        ...base, 'Tipo': 'Dato mal escrito', 'Estado': 'Corregir en el sistema',
        'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
        'Campo': d.campo || '', 'En el portal': '', 'En el sistema': d.valor || '',
      });
      for (const s of (r.detail || [])) {
        if (s.added || s.removed) filas.push({
          ...base, 'Tipo': s.added ? 'Ingreso' : 'Egreso', 'Estado': '',
          'C\u00e9dula': '', 'Colaborador': '', 'Empresa': s.company_code || '',
          'Campo': '', 'En el portal': String(s.added || s.removed), 'En el sistema': '',
        });
        if (s.skipped || s.alert) filas.push({
          ...base, 'Tipo': 'Alerta', 'Estado': 'Tienda saltada',
          'C\u00e9dula': '', 'Colaborador': '', 'Empresa': s.company_code || '',
          'Campo': '', 'En el portal': '', 'En el sistema': s.alert || '',
        });
      }
    }
    // Corridas viejas (sin detalle fino): al menos se exporta el resumen.
    if (!filas.length) {
      return SL.rows.map(r => ({
        'Fecha': fmtDT(r.run_at),
        'Origen': r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual',
        'Tipo': 'Resumen', 'Estado': r.status === 'ok' ? 'OK' : 'Con alerta',
        'C\u00e9dula': '', 'Colaborador': '', 'Empresa': '',
        'Campo': '', 'En el portal': r.summary || '', 'En el sistema': '',
      }));
    }
    return filas;
  }

  return SL.rows.map(r => ({
    'Proceso': PROC_LBL[SL.process],
    'Fecha': fmtDT(r.run_at),
    'Origen': r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual',
    'Estado': r.status === 'ok' ? 'OK' : (r.status === 'alerta' ? 'Con alerta' : 'Error'),
    'Resumen': r.summary || '',
    'Error': r.error || '',
    'Duraci\u00f3n (s)': r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) : '',
    'Detalle': detailText(r),
  }));
}
function detailText(r) {
  if (!r.detail) return '';
  if (Array.isArray(r.detail)) {
    return r.detail.map(st => `${st.company_code}${st.added ? ' +' + st.added : ''}${st.removed ? ' -' + st.removed : ''}${st.skipped ? ' [ALERTA: ' + (st.alert || '') + ']' : ''}`).join(' | ');
  }
  try { return JSON.stringify(r.detail); } catch (_) { return ''; }
}
function slDownloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slTstamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
/* v5.56: la ESCRITURA del archivo, separada de QUE datos van adentro. Antes
   estaba pegada a slDoExport (que arma las filas del registro completo), asi que
   el export por pestaña habria tenido que duplicar los tres formatos. */
async function writeFile(data, fname, fmt) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);

  if (fmt === 'csv') {
    const escv = v => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escv(r[h])).join(';')));
    slDownloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const widths = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const fmtRow = cells => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
    const lines = [fmtRow(headers), widths.map(w => '-'.repeat(w)).join('  ')]
      .concat(data.map(r => fmtRow(headers.map(h => r[h]))));
    slDownloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar la librer\u00eda de Excel.'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Datos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (_) { /* sin conexion al CDN: reintentar luego */ }
  }
}

async function slDoExport(fmt) {
  const data = slExportRows();
  if (!data.length) return;
  await writeFile(data, `registro_sync_${SL.process}_${slTstamp()}`, fmt);
}
function slOpenExportMenu(btn) {
  const old = document.getElementById('slExpMenu');
  if (old) { old.remove(); return; }
  const r = btn.getBoundingClientRect();
  const m = document.createElement('div');
  m.id = 'slExpMenu';
  m.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${Math.max(8, r.right - 170)}px;z-index:1100;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:170px;display:flex;flex-direction:column;gap:2px`;
  const item = (lbl, fmt) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--ink);cursor:pointer';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { m.remove(); slDoExport(fmt); });
    return b;
  };
  m.appendChild(item('Excel (.xlsx)', 'xlsx'));
  m.appendChild(item('CSV (.csv)', 'csv'));
  m.appendChild(item('Texto (.txt)', 'txt'));
  document.body.appendChild(m);
  setTimeout(() => {
    const away = ev => { if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); } };
    document.addEventListener('click', away);
  }, 0);
}

/* ===== EXPORTAR LA PESTAÑA ABIERTA (v5.56) =====
   Cada corrida tiene su propio boton Exportar, y baja SOLO la pestaña que estas
   viendo. Antes solo existia el Exportar de arriba, que mezclaba las 5
   categorias de TODAS las corridas de la pagina en un unico archivo.

   Sobre CSV y TXT (la pregunta de Pablo): no hay problema. El lio de "varias
   hojas" solo existiria si se bajaran las 5 pestañas juntas — xlsx soporta
   hojas, csv y txt son texto plano y no. Pero una pestaña es UNA TABLA, asi que
   los tres formatos funcionan igual, con el mismo patron de siempre. */
const TAB_LBL = {
  mov: 'movimientos', fill: 'completadas', dif: 'diferencias',
  rej: 'mal_escritos', alr: 'alertas',
};

/* Las filas de UNA pestaña de UNA corrida, ya con las columnas de esa pestaña
   (cada una tiene las suyas: no se fuerza un formato comun con huecos). */
function tabRows(r, key) {
  const stores = Array.isArray(r.detail) ? r.detail : [];
  if (key === 'mov') {
    return stores.filter(s => s.added || s.removed).map(s => ({
      'Empresa': s.company_code || '',
      'Ingresos': s.added || 0,
      'Egresos': s.removed || 0,
    }));
  }
  if (key === 'alr') {
    return stores.filter(s => s.skipped || s.alert).map(s => ({
      'Empresa': s.company_code || '',
      'Motivo': s.alert || 'Sin detalle',
    }));
  }
  if (key === 'fill') {
    return (r.fills || []).map(d => ({
      'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
      'Campo': CAMPO_LBL[d.campo] || d.campo || '',
      'Dato que se tom\u00f3': fmtVal(d.campo, d.valor),
    }));
  }
  if (key === 'dif') {
    return (r.diffs || []).map(d => ({
      // El estado de HOY viaja al Excel: sin esto, el archivo miente igual que
      // mentia la pantalla antes de v5.56.
      'Estado': d.vivo ? 'Sin resolver' : 'Resuelta',
      'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
      'Campo': CAMPO_LBL[d.campo] || d.campo || '',
      'En el portal': fmtVal(d.campo, d.portal),
      'En el sistema': fmtVal(d.campo, d.sistema),
      'Mal escrito': d.estado === 'dato_roto' ? 'S\u00ed' : '',
    }));
  }
  if (key === 'rej') {
    return (r.rejects || []).map(d => ({
      'C\u00e9dula': d.ced || '', 'Colaborador': d.nom || '', 'Empresa': d.comp || '',
      'Campo': CAMPO_LBL[d.campo] || d.campo || '',
      'Vino as\u00ed': d.valor || '',
    }));
  }
  return [];
}

/* Nombre del archivo: la pestaña + la hora DE LA CORRIDA (no la de ahora). Asi
   dos exports de corridas distintas nunca se pisan. */
function tabFname(r, key) {
  const d = new Date(r.run_at);
  const p = n => String(n).padStart(2, '0');
  const ts = isNaN(d) ? slTstamp()
    : `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  return `${TAB_LBL[key] || 'detalle'}_${ts}`;
}

async function exportTab(idx, fmt) {
  const r = SL.rows[idx];
  if (!r) return;
  const key = SL_TAB[idx] || 'mov';
  const data = tabRows(r, key);
  if (!data.length) return;
  await writeFile(data, tabFname(r, key), fmt);
}
/* El menu de exportar de una pestaña. Dice QUE va a bajar y CUANTAS filas, para
   que no puedas equivocarte de pestaña sin darte cuenta. */
function openTabExport(btn, idx) {
  const old = document.getElementById('slTabExp');
  if (old) { old.remove(); return; }
  const r = SL.rows[idx];
  if (!r) return;
  const key = SL_TAB[idx] || 'mov';
  const n = tabRows(r, key).length;
  const rect = btn.getBoundingClientRect();

  const m = document.createElement('div');
  m.id = 'slTabExp';
  m.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${Math.max(8, rect.right - 190)}px;`
    + `z-index:1100;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;`
    + `box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:190px;display:flex;flex-direction:column;gap:2px`;

  const head = document.createElement('div');
  head.textContent = `${(TAB_LBL[key] || '').replace('_', ' ')} \u00b7 ${n} fila${n === 1 ? '' : 's'}`;
  head.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.05em;'
    + 'color:var(--faint,#94a3b8);font-weight:800;padding:6px 10px 3px';
  m.appendChild(head);

  [['Excel (.xlsx)', 'xlsx'], ['CSV (.csv)', 'csv'], ['Texto (.txt)', 'txt']].forEach(([lbl, f]) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;'
      + 'border-radius:8px;background:transparent;color:var(--ink);cursor:pointer';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { m.remove(); exportTab(idx, f); });
    m.appendChild(b);
  });

  document.body.appendChild(m);
  setTimeout(() => {
    const away = ev => {
      if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); }
    };
    document.addEventListener('click', away);
  }, 0);
}

/* ---------- carga y pintado ---------- */
async function slLoad() {
  const list = $('#slBody');
  if (list) list.innerHTML = '<tr><td colspan="6" class="sl-empty">Cargando\u2026</td></tr>';
  const r = await api({
    process: SL.process, page: SL.page, page_size: SL.size,
    status: SL.status, from: SL.from, to: SL.to,
  });
  if (!r || !r.ok) {
    if (list) list.innerHTML = `<tr><td colspan="6" class="sl-empty">No se pudo cargar${r && r.error ? ': ' + esc(r.error) : ''}.</td></tr>`;
    return;
  }
  SL.total = r.total || 0;
  SL.rows = r.rows || [];
  SL.note = r.note || '';
  // v5.56: los indices cambian con la pagina/filtros. Si no se limpia, SL_TAB[3]
  // seguiria apuntando a la pestaña de OTRA corrida.
  SL_TAB = {};
  slPaint();
}
/* Un panel de pestaña. Solo el primero arranca visible. */
function pane(idx, key, visible, inner) {
  return `<div class="sl-pane" id="slPane_${idx}_${key}"${visible ? '' : ' hidden'}>${inner}</div>`;
}

/* =====================================================================
   v5.58 — LA PAGINA DE LA CORRIDA (renderSyncRun)

   Pablo lo pidio SEIS O SIETE VECES: "dijimos muchisimas veces que el detalle
   salga en otra pagina". Y el mockup aprobado siempre fue eso. Yo lo segui
   metiendo dentro de la fila del Registro, empujando la tabla hacia abajo,
   con la mitad del ancho util y tablas de 33 filas apretadas en un acordeon.

   Ahora es una PAGINA:
     ← Volver
     Detalle de la corrida  (fecha · origen · tiendas)
     [ficha con los 4 numeros: ingresos / egresos / completadas / necesitan atencion]
     [el aviso, en pasado, con el estado de hoy]
     [tarjeta con las 5 pestanas + Exportar]

   El Registro vuelve a ser una LISTA: una fila por corrida, un boton que abre.
   ===================================================================== */

/* Los cuatro numeros de la ficha. `atencion` junta diferencias + mal escritos:
   es lo unico de la corrida que le pide algo a un humano. */
function runFicha(r) {
  const diffs   = Array.isArray(r.diffs)   ? r.diffs   : [];
  const rejects = Array.isArray(r.rejects) ? r.rejects : [];
  const stores  = Array.isArray(r.detail)  ? r.detail  : [];
  const ingresos = stores.reduce((a, s) => a + (s.added || 0), 0);
  const egresos  = stores.reduce((a, s) => a + (s.removed || 0), 0);
  const atencion = diffs.length + rejects.length;

  const cel = (v, k, h, cls) =>
    `<div class="sr-r ${v ? (cls || '') : 'zero'}">`
    + `<div class="v">${v}</div><div class="k">${k}</div><div class="h">${h}</div></div>`;

  const hint = [];
  if (diffs.length)   hint.push(`${diffs.length} para decidir`);
  if (rejects.length) hint.push(`${rejects.length} mal ${rejects.length === 1 ? 'escrito' : 'escritos'}`);

  /* Cuantas tiendas TOCO. Ojo: el log solo guarda las tiendas CON MOVIMIENTO
     (una corrida limpia no deja fila, por diseno), asi que este numero NO es
     "cuantas recorrio" — es "en cuantas paso algo". Decir "corrio sobre 36
     tiendas" seria mentira: recorrio 132 y encontro cosas en 36. */
  const conAlgo = stores.length;

  return `<div class="sr-run">
    <div class="sr-run-t">La sincronización corrió el <b>${fmtDT(r.run_at)}</b>`
    + (conAlgo ? ` y encontró movimiento en <b>${conAlgo}</b> ${conAlgo === 1 ? 'tienda' : 'tiendas'}.` : '.')
    + `</div>
    <div class="sr-run-sub">${r.source === 'cron' ? 'Automática' : 'Manual'} · `
    + `terminó ${r.status === 'ok' ? 'OK' : 'con alerta'} · `
    + `las tiendas sin novedad no dejan registro.</div>
    <div class="sr-run-found">Hizo</div>
    <div class="sr-res">
      ${cel(ingresos, 'ingresos', 'personas nuevas que trajo el sistema')}
      ${cel(egresos, 'egresos', 'solo con fin de contrato explícito')}
      ${cel(r.filled || 0, 'fichas completadas', 'campos que estaban en blanco')}
      ${cel(atencion, 'necesitan atención', hint.join(' · ') || 'nada pendiente', 'act')}
    </div>
  </div>`;
}

/* Las filas de una pestaña, ya pintadas. Devuelve {nota, thead, filas, pie}. */
function paneHtml(r, key) {
  const diffs   = Array.isArray(r.diffs)   ? r.diffs   : [];
  const fills   = Array.isArray(r.fills)   ? r.fills   : [];
  const rejects = Array.isArray(r.rejects) ? r.rejects : [];
  const stores  = Array.isArray(r.detail)  ? r.detail  : [];
  const movs    = stores.filter(s => s.added || s.removed);
  const alertas = stores.filter(s => s.skipped || s.alert);
  const TOPE = 300;   // mas que esto no se pinta: para eso esta Exportar

  if (key === 'mov') {
    return {
      nota: `Quién <b>entró</b> y quién <b>salió</b> del padrón, por empresa. `
        + `El egreso solo ocurre con <b>fin de contrato explícito</b>: nunca por ausencia en la respuesta.`,
      thead: `<tr><th style="width:90px">Empresa</th><th style="width:110px">Ingresos</th><th>Egresos</th></tr>`,
      filas: movs.map(s => `<tr>`
        + `<td class="sl-cc">${esc(s.company_code)}</td>`
        + `<td>${s.added ? `<b style="color:#15803d">+${s.added}</b>` : '<span style="color:#94a3b8">—</span>'}</td>`
        + `<td>${s.removed ? `<b style="color:#b91c1c">−${s.removed}</b>` : '<span style="color:#94a3b8">—</span>'}</td>`
        + `</tr>`).join(''),
      pie: `<b>${movs.length}</b> ${movs.length === 1 ? 'empresa' : 'empresas'} con movimiento`,
      n: movs.length,
    };
  }

  if (key === 'fill') {
    /* La cabecera dice "20 fichas completadas" y aca salen 33 filas. No es un
       error y hay que decirlo: `filled` cuenta PERSONAS, el detalle cuenta
       CAMPOS (a una persona se le puede completar el telefono Y el correo). */
    const aclara = (r.filled && fills.length !== r.filled)
      ? `<br>Son <b>${fills.length} campos</b> sobre <b>${r.filled} personas</b>: `
        + `a una misma persona se le puede haber completado más de un dato.`
      : '';
    return {
      nota: `Campos que estaban <b>en blanco</b> en el portal y el sistema sí tenía. `
        + `Se completaron solos. <b>Ningún dato ya cargado se tocó.</b>${aclara}`,
      thead: `<tr><th style="width:110px">Cédula</th><th>Colaborador</th>`
        + `<th style="width:70px">Empresa</th><th style="width:100px">Campo</th>`
        + `<th>Dato que se tomó del sistema</th></tr>`,
      filas: fills.slice(0, TOPE).map(d => `<tr>`
        + `<td class="sl-mono">${esc(cedFmt(d))}</td>`
        + `<td style="font-weight:600">${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(CAMPO_LBL[d.campo] || d.campo || '')}</td>`
        + `<td class="sl-mono sl-vp">${esc(fmtVal(d.campo, d.valor))}</td>`
        + `</tr>`).join(''),
      pie: fills.length > TOPE
        ? `Mostrando <b>${TOPE}</b> de <b>${fills.length}</b> · usá Exportar para la lista completa`
        : `<b>${fills.length}</b> ${fills.length === 1 ? 'campo completado' : 'campos completados'}`,
      n: fills.length,
    };
  }

  if (key === 'dif') {
    const vivas = diffs.filter(d => d.vivo).length;
    const resueltas = diffs.length - vivas;
    return {
      nota: `Los dos lados tenían un dato y <b>no coincidían</b>. El portal <b>no tocó nada</b>: `
        + `solo los señaló. Se deciden en <b>Diferencias</b>; acá se ve cómo quedaron.`,
      thead: `<tr><th style="width:112px">Estado</th><th style="width:110px">Cédula</th><th>Colaborador</th>`
        + `<th style="width:70px">Empresa</th><th style="width:90px">Campo</th>`
        + `<th>En el portal</th><th>En el sistema</th></tr>`,
      filas: diffs.slice(0, TOPE).map(d => {
        const roto = d.estado === 'dato_roto';
        return `<tr>`
          + `<td>${d.vivo
              ? '<span class="sl-stt open">● sin resolver</span>'
              : '<span class="sl-stt done">✓ resuelta</span>'}</td>`
          + `<td class="sl-mono">${esc(cedFmt(d))}</td>`
          + `<td style="font-weight:600">${esc(d.nom || '')}</td>`
          + `<td class="sl-cc">${esc(d.comp || '')}</td>`
          + `<td>${esc(CAMPO_LBL[d.campo] || d.campo || '')}</td>`
          + `<td class="sl-mono sl-vp">${esc(fmtVal(d.campo, d.portal))}</td>`
          + `<td class="sl-mono ${roto ? 'sl-vbad' : 'sl-vs'}">${esc(fmtVal(d.campo, d.sistema))}`
          + (roto ? '<div style="font-size:10px;font-weight:600">⚠ mal escrito</div>' : '')
          + `</td></tr>`;
      }).join(''),
      pie: `<b>${diffs.length}</b> ${diffs.length === 1 ? 'diferencia' : 'diferencias'}`
        + (resueltas ? ` · <b>${resueltas}</b> ya ${resueltas === 1 ? 'resuelta' : 'resueltas'}` : '')
        + (vivas ? ` · <b>${vivas}</b> ${vivas === 1 ? 'sigue viva' : 'siguen vivas'}` : ''),
      n: diffs.length,
    };
  }

  if (key === 'rej') {
    return {
      nota: `El sistema mandó estos datos mal escritos, así que <b>no se guardaron</b>. `
        + `El portal no arregla datos del sistema: <b>hay que corregirlos allá</b>. `
        + `Cuando se corrijan, dejan de aparecer solos.`,
      thead: `<tr><th style="width:110px">Cédula</th><th>Colaborador</th>`
        + `<th style="width:70px">Empresa</th><th style="width:90px">Campo</th><th>Vino así</th></tr>`,
      filas: rejects.slice(0, TOPE).map(d => `<tr>`
        + `<td class="sl-mono">${esc(cedFmt(d))}</td>`
        + `<td style="font-weight:600">${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(CAMPO_LBL[d.campo] || d.campo || '')}</td>`
        + `<td class="sl-mono sl-vbad">${esc(d.valor || '')}</td>`
        + `</tr>`).join(''),
      pie: rejects.length > TOPE
        ? `Mostrando <b>${TOPE}</b> de <b>${rejects.length}</b> · usá Exportar para la lista completa`
        : `<b>${rejects.length}</b> a corregir en el sistema`,
      n: rejects.length,
    };
  }

  // alr
  return {
    nota: `Estas tiendas <b>se saltaron</b>: el sistema devolvió una lista sospechosamente corta `
      + `y el portal prefirió no tocar nada antes que dar de baja a gente que sigue trabajando.`,
    thead: `<tr><th style="width:90px">Empresa</th><th>Motivo</th></tr>`,
    filas: alertas.map(s => `<tr>`
      + `<td class="sl-cc">${esc(s.company_code)}</td>`
      + `<td style="color:#b45309">${esc(s.alert || 'Sin detalle')}</td>`
      + `</tr>`).join(''),
    pie: `<b>${alertas.length}</b> ${alertas.length === 1 ? 'tienda saltada' : 'tiendas saltadas'}`,
    n: alertas.length,
  };
}

/* La cedula con su letra. El detalle guarda solo el numero, asi que se deduce
   igual que en el resto del portal (extranjeros desde 80.000.000). */
function cedFmt(d) {
  const s = String(d.ced || '');
  if (!s) return '';
  if (d.ced_kind) return `${d.ced_kind}-${s}`;
  const n = parseInt(s.replace(/\D/g, ''), 10);
  if (!n) return s;
  return `${n >= 80000000 ? 'E' : 'V'}-${s}`;
}

/* Estado del modulo de la pagina: que pestaña se esta viendo. */
let SR_TAB = 'mov';

export async function renderSyncRun(user) {
  USER = user;
  ensureStyles();

  const r = SL_OPEN;
  if (!r) {
    // Entraron por la ruta sin haber elegido corrida (recarga, link directo).
    // No se inventa nada: se los manda a la lista.
    renderSyncLog(user);
    return;
  }

  const diffs   = Array.isArray(r.diffs)   ? r.diffs   : [];
  const rejects = Array.isArray(r.rejects) ? r.rejects : [];
  const stores  = Array.isArray(r.detail)  ? r.detail  : [];
  const movs    = stores.filter(s => s.added || s.removed);
  const fills   = Array.isArray(r.fills)   ? r.fills   : [];
  const alertas = stores.filter(s => s.skipped || s.alert);

  const nOpen = r.diff_open != null ? r.diff_open : diffs.filter(d => d.vivo).length;
  const nTotal = diffs.length + rejects.length;

  /* Las pestanas: TODAS se muestran, incluso vacias (a diferencia del inline,
     donde se escondian). En una pagina, una pestana en 0 es informacion: te dice
     que esa corrida no tuvo alertas, y eso es bueno saberlo. */
  const TABS = [
    ['mov',  'Movimientos',  movs.length,    false],
    ['fill', 'Completadas',  fills.length,   false],
    ['dif',  'Diferencias',  diffs.length,   nOpen > 0],
    ['rej',  'Mal escritos', rejects.length, false],
    ['alr',  'Alertas',      alertas.length, false],
  ];
  // Se abre en la primera pestana que tenga algo: si la corrida solo encontro
  // diferencias, no tiene sentido abrirla en Movimientos vacio.
  if (!TABS.some(([k, , n]) => k === SR_TAB && n)) {
    const primera = TABS.find(([, , n]) => n);
    SR_TAB = primera ? primera[0] : 'mov';
  }

  const ICO_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';
  const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  /* EL AVISO. El numero de la corrida es HISTORIA y no cambia nunca; debajo va
     el estado de HOY. Sin nada vivo: verde y SIN boton (no tiene a donde llevar). */
  let aviso = '';
  if (nTotal) {
    const vivo = nOpen > 0;
    const resueltas = diffs.length - nOpen;
    const sub = [];
    if (vivo) sub.push(`Hoy ${nOpen === 1 ? 'queda' : 'quedan'} <b>${nOpen} sin resolver</b>.`);
    else if (diffs.length) sub.push('Ya no queda ninguna pendiente.');
    if (rejects.length) {
      sub.push(`${vivo && diffs.length ? 'Los otros' : 'Los'} ${rejects.length} mal `
        + `${rejects.length === 1 ? 'escrito' : 'escritos'} se corrigen en el sistema, no acá.`);
    } else if (resueltas > 0 && vivo) {
      sub.push(`${resueltas === 1 ? 'Una ya se resolvió' : resueltas + ' ya se resolvieron'}.`);
    }
    aviso = `<div class="sl-av ${vivo ? 'pend' : 'done'}">`
      + `<div class="sl-av-ico">${vivo ? ICO_WARN : ICO_OK}</div>`
      + `<div class="tx">Esta corrida encontró <b>${nTotal}</b> `
      + `${nTotal === 1 ? 'cosa que necesitaba' : 'cosas que necesitaban'} una decisión.`
      + (sub.length ? `<div class="sub">${sub.join(' ')}</div>` : '')
      + `</div>`
      + (vivo ? `<button class="sl-golink" id="srGo">Ir a Diferencias →</button>` : '')
      + `</div>`;
  }

  const IC_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

  $('#pnlMain').innerHTML = `
    <button class="sr-back" id="srBack">← Volver a las sincronizaciones</button>

    <div class="sl-head" style="margin-bottom:16px">
      <h1>Detalle de la corrida</h1>
      <p>Qué hizo la sincronización, y qué dejó pendiente.</p>
    </div>

    ${runFicha(r)}
    ${aviso}

    <div class="sr-card">
      <div class="sr-chead">
        <div>
          <h2>Lo que encontró</h2>
          <p class="desc">${fmtDT(r.run_at)} · ${r.source === 'cron' ? 'Automática' : 'Manual'}</p>
        </div>
        <button class="sl-btn" id="srExp" title="Exportar la pestaña que estás viendo">${IC_DOWN} Exportar</button>
      </div>

      <div class="sl-tabs" id="srTabs">
        ${TABS.map(([k, lbl, n, hot]) =>
          `<button class="sl-tab${k === SR_TAB ? ' on' : ''}" data-k="${k}">`
          + `${esc(lbl)} <span class="sl-tn">${n}</span>`
          + (hot ? '<span class="sl-tdot" title="Tiene cosas sin resolver"></span>' : '')
          + `</button>`).join('')}
      </div>

      <div id="srPane"></div>
    </div>`;

  const pintarPane = () => {
    const p = paneHtml(r, SR_TAB);
    const cuerpo = p.n
      ? `<table class="sl-mini" style="margin-top:0"><thead>${p.thead}</thead><tbody>${p.filas}</tbody></table>`
        + `<div class="sr-tfoot"><span class="sr-muted">${p.pie}</span></div>`
      : `<div class="sl-empty" style="padding:28px 16px">Esta corrida no tuvo nada de esto.</div>`;
    $('#srPane').innerHTML = `<div class="sl-pane"><p class="sl-pn">${p.nota}</p>${cuerpo}</div>`;
  };
  pintarPane();

  $('#srBack').addEventListener('click', () => renderSyncLog(USER));

  document.querySelectorAll('#srTabs [data-k]').forEach(b =>
    b.addEventListener('click', () => {
      SR_TAB = b.dataset.k;
      document.querySelectorAll('#srTabs [data-k]').forEach(t => t.classList.remove('on'));
      b.classList.add('on');
      pintarPane();
    }));

  const go = $('#srGo');
  if (go) go.addEventListener('click', () => {
    const nav = document.querySelector('.pnl-side [data-view="syncpend"]');
    if (nav) nav.click();
  });

  // Exportar: baja LA PESTAÑA que se esta viendo, en los 3 formatos de siempre.
  $('#srExp').addEventListener('click', (e) => {
    e.stopPropagation();
    openRunExport($('#srExp'), r);
  });
}

/* El menu de Exportar de la pagina. Dice QUE baja y CUANTAS filas. */
function openRunExport(btn, r) {
  const old = document.getElementById('srExpMenu');
  if (old) { old.remove(); return; }
  const data = tabRows(r, SR_TAB);
  const rect = btn.getBoundingClientRect();

  const m = document.createElement('div');
  m.id = 'srExpMenu';
  m.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${Math.max(8, rect.right - 200)}px;`
    + `z-index:1100;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;`
    + `box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:200px;display:flex;flex-direction:column;gap:2px`;

  const head = document.createElement('div');
  head.textContent = `${(TAB_LBL[SR_TAB] || '').replace('_', ' ')} · ${data.length} fila${data.length === 1 ? '' : 's'}`;
  head.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.05em;'
    + 'color:var(--faint,#94a3b8);font-weight:800;padding:6px 10px 3px';
  m.appendChild(head);

  [['Excel (.xlsx)', 'xlsx'], ['CSV (.csv)', 'csv'], ['Texto (.txt)', 'txt']].forEach(([lbl, f]) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.disabled = !data.length;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;'
      + `border-radius:8px;background:transparent;color:var(--ink);cursor:${data.length ? 'pointer' : 'default'};`
      + (data.length ? '' : 'opacity:.45');
    if (data.length) {
      b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      b.addEventListener('click', () => { m.remove(); writeFile(data, tabFname(r, SR_TAB), f); });
    }
    m.appendChild(b);
  });

  document.body.appendChild(m);
  setTimeout(() => {
    const away = ev => {
      if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); }
    };
    document.addEventListener('click', away);
  }, 0);
}

function detHtml(r, idx) {
  if (!r.detail && !r.error) return '';
  const copyBtn = `<div style="margin-top:7px"><button class="sl-more" data-copy="${idx}">Copiar detalle</button> <span id="slCopied_${idx}" style="display:none;font-size:11px;color:var(--success,#15803d)">✓ copiado</span></div>`;

  /* ===================================================================
     v5.56 — EL DETALLE VUELVE A CONTAR LA CORRIDA ENTERA.

     v5.43 saco de aca las pestañas Diferencias y Mal escritos, con este
     argumento: viven en la pagina Diferencias, alli tienen botones, y el numero
     del log esta congelado mientras el de Diferencias es el de hoy — dos
     numeros distintos para la misma pregunta.

     El diagnostico era correcto; la solucion, demasiado. Sacarlas dejo el
     Registro sin poder contestar la pregunta que se le hace: "que encontro esta
     corrida?". Quedaba un cartel con un numero y ningun modo de ver QUE era.

     Ahora vuelven, pero resolviendo el problema de fondo: cada diferencia trae
     su ESTADO DE HOY (`vivo`, del backend, leido de workers_master). Entonces:

       - El Registro sigue siendo HISTORIA: la lista es la de esa corrida, y su
         numero (19) no cambia nunca.
       - Pero cada fila dice si esa diferencia YA SE RESOLVIO o sigue esperando.
       - Y el aviso de arriba habla en pasado ("esta corrida encontro 19") y
         debajo dice la verdad de hoy ("quedan 3 sin resolver" / "ya no queda
         ninguna").

     Asi no hay dos numeros peleando: hay UN numero historico y UN estado actual,
     y se ve cual es cual. Actuar se sigue haciendo en Diferencias (aca no hay
     botones de decision): esa parte de v5.43 se mantiene.

     Las cinco pestañas:
       Movimientos   — ingresos y egresos de ese dia
       Completadas   — campos en blanco que se llenaron con el sistema
       Diferencias   — lo que no coincidia, con su ✓/● de hoy
       Mal escritos  — datos que el sistema mando rotos
       Alertas       — tiendas que se saltaron esa vez
     =================================================================== */
  if (Array.isArray(r.detail)) {
    const diffs   = Array.isArray(r.diffs)   ? r.diffs   : [];
    const fills   = Array.isArray(r.fills)   ? r.fills   : [];
    const rejects = Array.isArray(r.rejects) ? r.rejects : [];
    const movs    = r.detail.filter(s => s.added || s.removed);
    const alertas = r.detail.filter(s => s.skipped || s.alert);

    // Cuantas diferencias de ESTA corrida siguen vivas hoy (lo calcula el
    // backend contra workers_master; si es una corrida vieja, no viene).
    const nOpen = r.diff_open != null ? r.diff_open : diffs.filter(d => d.vivo).length;

    const tabs = [];
    if (movs.length)    tabs.push(['mov',  'Movimientos', movs.length, false]);
    if (fills.length)   tabs.push(['fill', 'Completadas', fills.length, false]);
    if (diffs.length)   tabs.push(['dif',  'Diferencias', diffs.length, nOpen > 0]);
    if (rejects.length) tabs.push(['rej',  'Mal escritos', rejects.length, false]);
    if (alertas.length) tabs.push(['alr',  'Alertas', alertas.length, false]);

    // Corrida vieja (sin las columnas nuevas): se cae al detalle de antes.
    if (!tabs.length) {
      return r.detail.map(st => esc(st.company_code)).join(' · ') + copyBtn;
    }

    const tabsHtml = tabs.map(([k, lbl, n, hot], i) =>
      `<button class="sl-tab${i === 0 ? ' on' : ''}" data-tab="${idx}" data-key="${k}">`
      + `${esc(lbl)} <span class="sl-tn">${n}</span>`
      + (hot ? '<span class="sl-tdot" title="Tiene cosas sin resolver"></span>' : '')
      + `</button>`).join('');

    /* La primera pestaña es la que se ve al abrir. Se registra ya, porque si el
       usuario exporta SIN haber tocado ninguna pestaña, Exportar tiene que bajar
       la que esta viendo — no una por defecto que no eligio. */
    if (SL_TAB[idx] == null) SL_TAB[idx] = tabs[0][0];

    const panes = [];
    const first = (k) => tabs[0][0] === k;

    if (movs.length) panes.push(pane(idx, 'mov', first('mov'),
      `<table class="sl-mini"><thead><tr><th>Empresa</th><th>Ingresos</th><th>Egresos</th></tr></thead><tbody>`
      + movs.map(s => `<tr><td class="sl-cc">${esc(s.company_code)}</td>`
        + `<td>${s.added ? '<b style="color:#15803d">+' + s.added + '</b>' : '—'}</td>`
        + `<td>${s.removed ? '<b style="color:#b91c1c">−' + s.removed + '</b>' : '—'}</td></tr>`).join('')
      + `</tbody></table>`));

    if (fills.length) panes.push(pane(idx, 'fill', first('fill'),
      `<p class="sl-pn">Campos que estaban <b>en blanco</b> en el portal y que el sistema sí tenía. `
      + `Se completaron solos. <b>Ningún dato ya cargado fue modificado.</b>`
      /* v5.56: la cabecera dice "20 fichas completadas" y aca salen 33 filas.
         No es un error y hay que decirlo, o parece uno: `filled` cuenta
         PERSONAS, `fill_detail` cuenta CAMPOS (a una misma persona se le puede
         haber completado el telefono Y el correo). */
      + (r.filled && fills.length !== r.filled
        ? `<br>Son <b>${fills.length} campos</b> sobre <b>${r.filled} personas</b>: `
          + `a una misma persona se le puede haber completado más de un dato.`
        : '')
      + `</p>`
      + `<table class="sl-mini"><thead><tr><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Campo</th><th>Dato que se tomó</th></tr></thead><tbody>`
      + fills.slice(0, 300).map(d => `<tr>`
        + `<td class="sl-mono">${esc(d.ced || '')}</td>`
        + `<td>${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(CAMPO_LBL[d.campo] || d.campo || '')}</td>`
        + `<td class="sl-mono sl-vp">${esc(fmtVal(d.campo, d.valor))}</td></tr>`).join('')
      + `</tbody></table>`
      + (fills.length > 300 ? `<p class="sl-pn">Mostrando 300 de ${fills.length}. Usá Exportar para la lista completa.</p>` : '')));

    /* ===== DIFERENCIAS (vuelve en v5.56) =====
       Cada fila lleva su estado de HOY. La lista es la de la corrida (historia)
       pero el ✓/● sale de workers_master (presente). Sin esto, ver el Registro
       te obligaba a ir a Diferencias a chequear una por una que habia pasado. */
    if (diffs.length) panes.push(pane(idx, 'dif', first('dif'),
      `<p class="sl-pn">Los dos lados tenían un dato y <b>no coincidían</b>. El portal <b>no tocó nada</b>: `
      + `solo los señaló. Se deciden en <b>Diferencias</b>; acá se ve cómo quedaron.</p>`
      + `<table class="sl-mini"><thead><tr><th>Estado</th><th>Cédula</th><th>Colaborador</th><th>Empresa</th>`
      + `<th>Campo</th><th>En el portal</th><th>En el sistema</th></tr></thead><tbody>`
      + diffs.slice(0, 300).map(d => {
        const roto = d.estado === 'dato_roto';
        return `<tr>`
        + `<td>${d.vivo
            ? '<span class="sl-stt open">● sin resolver</span>'
            : '<span class="sl-stt done">✓ resuelta</span>'}</td>`
        + `<td class="sl-mono">${esc(d.ced || '')}</td>`
        + `<td>${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(CAMPO_LBL[d.campo] || d.campo || '')}</td>`
        + `<td class="sl-mono sl-vp">${esc(fmtVal(d.campo, d.portal))}</td>`
        + `<td class="sl-mono ${roto ? 'sl-vbad' : 'sl-vs'}">${esc(fmtVal(d.campo, d.sistema))}`
        + (roto ? '<div style="font-size:10px;font-weight:600">⚠ mal escrito</div>' : '')
        + `</td></tr>`;
      }).join('')
      + `</tbody></table>`
      + (diffs.length > 300 ? `<p class="sl-pn">Mostrando 300 de ${diffs.length}. Usá Exportar para la lista completa.</p>` : '')));

    /* ===== MAL ESCRITOS (vuelve en v5.56) =====
       No llevan estado: no se resuelven en el portal. Se arreglan en el sistema
       y desaparecen solos en la proxima corrida. */
    if (rejects.length) panes.push(pane(idx, 'rej', first('rej'),
      `<p class="sl-pn">El sistema mandó estos datos mal escritos, así que <b>no se guardaron</b>. `
      + `El portal no arregla datos del sistema: <b>hay que corregirlos allá</b>. `
      + `Cuando se corrijan, dejan de aparecer solos.</p>`
      + `<table class="sl-mini"><thead><tr><th>Cédula</th><th>Colaborador</th><th>Empresa</th><th>Campo</th><th>Vino así</th></tr></thead><tbody>`
      + rejects.slice(0, 300).map(d => `<tr>`
        + `<td class="sl-mono">${esc(d.ced || '')}</td>`
        + `<td>${esc(d.nom || '')}</td>`
        + `<td class="sl-cc">${esc(d.comp || '')}</td>`
        + `<td>${esc(CAMPO_LBL[d.campo] || d.campo || '')}</td>`
        + `<td class="sl-mono sl-vbad">${esc(d.valor || '')}</td></tr>`).join('')
      + `</tbody></table>`
      + (rejects.length > 300 ? `<p class="sl-pn">Mostrando 300 de ${rejects.length}. Usá Exportar para la lista completa.</p>` : '')));

    if (alertas.length) panes.push(pane(idx, 'alr', first('alr'),
      `<p class="sl-pn">Estas tiendas <b>se saltaron</b>: el sistema devolvió una lista sospechosamente corta `
      + `y el portal prefirió no tocar nada antes que dar de baja a gente que sigue trabajando.</p>`
      + `<table class="sl-mini"><thead><tr><th>Empresa</th><th>Motivo</th></tr></thead><tbody>`
      + alertas.map(s => `<tr><td class="sl-cc">${esc(s.company_code)}</td>`
        + `<td style="color:#b45309">${esc(s.alert || 'Sin detalle')}</td></tr>`).join('')
      + `</tbody></table>`));

    /* ===== EL AVISO (v5.56) =====
       Va ARRIBA de las pestañas: es lo primero que hay que saber al abrir una
       corrida.

       Y habla EN PASADO. El log esta congelado — dice "19" para siempre — asi
       que decir "esta corrida DEJA 19 por resolver" era mentira apenas resolvias
       la primera. Ahora: el numero de la corrida es historia (no cambia), y
       debajo va el estado de HOY, que sale de workers_master.

       Cuando no queda nada vivo, el aviso se pone verde y PIERDE EL BOTON: no
       tiene a donde llevarte. Mandarte a una pantalla vacia es peor que no
       ofrecer el camino.

       Los mal escritos NO cuentan como "sin resolver": no se resuelven aca, se
       corrigen en el sistema. Por eso solo miran a las diferencias vivas. */
    const nTotal = diffs.length + rejects.length;
    const ICO_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';
    const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    let aviso = '';
    if (nTotal) {
      const vivo = nOpen > 0;
      // Que paso con las que ya no estan vivas.
      const resueltas = diffs.length - nOpen;
      const detalle = [];
      if (vivo) {
        detalle.push(`Hoy ${nOpen === 1 ? 'queda' : 'quedan'} <b>${nOpen} sin resolver</b>.`);
      } else if (diffs.length) {
        detalle.push('Ya no queda ninguna pendiente.');
      }
      if (rejects.length) {
        detalle.push(`${vivo && diffs.length ? 'Los otros' : 'Los'} ${rejects.length} mal `
          + `${rejects.length === 1 ? 'escrito' : 'escritos'} se corrigen en el sistema, no acá.`);
      } else if (resueltas > 0 && vivo) {
        detalle.push(`${resueltas === 1 ? 'Una ya se resolvió' : resueltas + ' ya se resolvieron'}.`);
      }

      aviso = `<div class="sl-av ${vivo ? 'pend' : 'done'}">`
        + `<div class="sl-av-ico">${vivo ? ICO_WARN : ICO_OK}</div>`
        + `<div class="tx">Esta corrida encontró <b>${nTotal}</b> `
        + `${nTotal === 1 ? 'cosa que necesitaba' : 'cosas que necesitaban'} una decisión.`
        + (detalle.length ? `<div class="sub">${detalle.join(' ')}</div>` : '')
        + `</div>`
        // Sin nada vivo, no hay boton: no tendria a donde llevar.
        + (vivo ? `<button class="sl-golink" data-gopend="1">Ir a Diferencias →</button>` : '')
        + `</div>`;
    }

    /* v5.56: barra de la corrida — el boton Exportar de ESTA corrida, que baja
       la pestaña abierta. El Exportar de arriba sigue existiendo y baja el
       registro completo (todas las corridas): son dos cosas distintas y ahora
       se puede elegir cual. */
    const IC_DOWN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
    const barra = `<div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:6px">`
      + `<button class="sl-btn" style="padding:6px 11px;font-size:12px" data-texp="${idx}" `
      + `title="Exportar la pestaña que estás viendo">${IC_DOWN} Exportar</button></div>`;

    return `${aviso}${barra}<div class="sl-tabs">${tabsHtml}</div>${panes.join('')}${copyBtn}`;
  }

  // v4.63: detalle LEGIBLE para no-programadores (nunca JSON crudo en
  // pantalla); el boton Copiar entrega el detalle tecnico completo.
  const LBL = {
    companies: 'Empresas', zones: 'Zonas', subzones: 'Subzonas', concepts: 'Conceptos',
    updated: 'Actualizados', inserted: 'Nuevos', rows: 'Registros', count: 'Registros',
    changes: 'Cambios', changes_count: 'Cambios', mode: 'Modo', stores: 'Tiendas revisadas',
    added: 'Ingresos', removed: 'Egresos', alerts: 'Alertas', errors: 'Errores',
    skipped: 'Saltadas', total: 'Total', duration_ms: 'Duracion (ms)', incomplete: 'Corrida parcial',
    run_id: 'Corrida', total_stores: 'Tiendas totales',
  };
  const parts = [];
  if (r.error) parts.push(`<div style="color:var(--danger,#b91c1c);margin-bottom:4px">⚠ ${esc(r.error)}</div>`);
  const d = r.detail;
  if (d && typeof d === 'object') {
    const items = [];
    for (const [k, v] of Object.entries(d)) {
      if (v == null) continue;
      if (typeof v === 'object') {
        if (Array.isArray(v)) items.push(`<b>${esc(LBL[k] || k)}:</b> ${v.length}`);
        continue;
      }
      if (typeof v === 'boolean') { if (v) items.push(`<b>${esc(LBL[k] || k)}:</b> sí`); continue; }
      items.push(`<b>${esc(LBL[k] || k)}:</b> ${esc(String(v))}`);
    }
    if (items.length) parts.push(items.join(' · '));
  }
  return parts.join('') + copyBtn;
}
/* ===== v5.62 — EL DETALLE DE EMPRESAS VIVE EN LA FILA =====
   Catalogo de empresas y Estado de pago no tienen pagina de detalle: su detalle
   es UNA LINEA de conteos. Hacerte apretar un boton para desplegar un renglon —
   y despues otro para cerrarlo — eran dos clics por nada.

   Ahora ese renglon se pinta SIEMPRE, gris y chico, debajo del resumen. El boton
   "Detalle" desaparece; en su lugar queda solo el icono de copiar.

   SOLO Catalogo de empresas lleva la segunda linea. Estado de pago NO: su
   `result` es {mode:'daily', rows:157, companies:157} y su resumen ya dice
   "daily · 157 registro(s)". Repetirlo abajo seria decir lo mismo dos veces.
   (Verificado contra la BD.) Se queda con su resumen y su icono.

   Personal de tiendas no se toca: tiene pagina propia ("Ver detalle →"). */
const DLINE_LBL = {
  zones: 'Zonas', subzones: 'Subzonas', concepts: 'Conceptos', companies: 'Empresas',
  updated: 'Actualizados', inserted: 'Nuevos', changes: 'Cambios',
};
function detailLine(r) {
  const d = r.detail;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return '';
  const partes = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null || typeof v === 'object' || typeof v === 'boolean') continue;
    if (!DLINE_LBL[k]) continue;   // solo conteos conocidos: nunca claves crudas en pantalla
    partes.push(`${esc(DLINE_LBL[k])} <b>${esc(String(v))}</b>`);
  }
  return partes.length ? `<div class="sl-dline">${partes.join(' \u00b7 ')}</div>` : '';
}

const IC_COPY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function slPaint() {
  const note = $('#slNote');
  if (note) note.textContent = SL.note || '';
  const body = $('#slBody');
  if (!body) return;
  if (!SL.rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="sl-empty">Sin corridas con estos filtros.</td></tr>';
  } else {
    body.innerHTML = SL.rows.map((r, i) => {
      const st = esc(r.status || 'ok');
      const stLbl = r.status === 'ok' ? 'OK' : (r.status === 'alerta' ? 'Con alerta' : 'Error');
      /* v5.58: el detalle YA NO SE DESPLIEGA ACA. Se abre en su propia pagina
         (mockup aprobado). Solo las corridas de Personal tienen pagina de
         detalle; las de Empresas/Pago siguen mostrando su resumen tecnico
         inline, que es una linea y no da para pagina. */
      const esRoster = SL.process === 'roster';
      const hasDet = !!(r.detail || r.error);
      /* v5.62: Personal de tiendas abre PAGINA ("Ver detalle →"). Empresas y Pago
         ya no despliegan nada: su detalle se pinta en la fila (detailLine) y en
         la columna solo queda el icono de copiar, que entrega el detalle tecnico
         completo (JSON) al portapapeles. */
      const verBtn = esRoster
        ? (hasDet ? `<button class="sl-btn sl-verdet" data-open="${i}">Ver detalle →</button>` : '')
        : (hasDet ? `<button class="sl-btn sl-ico" data-copy="${i}" title="Copiar detalle" aria-label="Copiar detalle">${IC_COPY}</button>`
            + `<span id="slCopied_${i}" class="sl-okcopy" hidden>\u2713</span>` : '');
      /* El error, si lo hubo, sigue viendose: es lo unico que no puede quedar
         escondido detras de un icono. */
      const errLine = (!esRoster && r.error)
        ? `<div class="sl-dline sl-derr">\u26a0 ${esc(r.error)}</div>` : '';
      return `<tr>
        <td>${fmtDT(r.run_at)}</td>
        <td>${r.source === 'cron' ? 'Autom\u00e1tica' : 'Manual'}</td>
        <td><span class="sl-st ${st}">${stLbl}</span></td>
        <td>${esc(r.summary || '')}${!esRoster ? detailLine(r) + errLine : ''}</td>
        <td style="text-align:right;white-space:nowrap">${r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + ' s' : '\u2014'}</td>
        <td style="white-space:nowrap">${verBtn}</td>
      </tr>`;
    }).join('');

    /* v5.58: abrir la pagina de la corrida. Se guarda la fila entera en SL_OPEN
       y se navega; renderSyncRun la lee de ahi. */
    body.querySelectorAll('[data-open]').forEach(b =>
      b.addEventListener('click', () => {
        SL_OPEN = SL.rows[+b.dataset.open] || null;
        if (!SL_OPEN) return;
        renderSyncRun(USER);
      }));

    body.querySelectorAll('[data-det]').forEach(b =>
      b.addEventListener('click', () => {
        const el = $('#slDet_' + b.dataset.det);
        if (el) el.hidden = !el.hidden;
      }));
    /* v5.37: cambiar de pestaña dentro del detalle. Se apaga el panel visible
       y se prende el elegido; los paneles viven en el mismo detalle, asi que
       el filtro por data-tab evita pisar los de OTRA corrida abierta. */
    body.querySelectorAll('[data-tab]').forEach(b =>
      b.addEventListener('click', () => {
        const idx = b.dataset.tab;
        const key = b.dataset.key;
        body.querySelectorAll(`[data-tab="${idx}"]`).forEach(t => t.classList.remove('on'));
        b.classList.add('on');
        body.querySelectorAll(`[id^="slPane_${idx}_"]`).forEach(p => { p.hidden = true; });
        const pane = $(`#slPane_${idx}_${key}`);
        if (pane) pane.hidden = false;
        // v5.56: se recuerda cual quedo abierta — es lo que va a bajar Exportar.
        SL_TAB[idx] = key;
      }));

    /* v5.56: Exportar de la corrida. Baja LA PESTAÑA ABIERTA, con sus propias
       columnas y en los tres formatos de siempre (xlsx/csv/txt). */
    body.querySelectorAll('[data-texp]').forEach(b =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openTabExport(b, +b.dataset.texp);
      }));

    /* El aviso lleva a Diferencias (la pagina ya no se llama "Pendientes").
       El boton solo existe cuando queda algo vivo: si no, no tendria a donde
       llevar. */
    body.querySelectorAll('[data-gopend]').forEach(b =>
      b.addEventListener('click', () => {
        const nav = document.querySelector('.pnl-side [data-view="syncpend"]');
        if (nav) nav.click();
      }));
    // v4.63: Copiar el detalle tecnico completo (JSON) al portapapeles.
    body.querySelectorAll('[data-copy]').forEach(b =>
      b.addEventListener('click', async () => {
        const r = SL.rows[+b.dataset.copy];
        if (!r) return;
        const payload = { fecha: r.run_at, origen: r.source, estado: r.status, resumen: r.summary, error: r.error || undefined, detalle: r.detail };
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          const ok = $('#slCopied_' + b.dataset.copy);
          if (ok) { ok.style.display = 'inline'; setTimeout(() => { ok.style.display = 'none'; }, 1800); }
        } catch (_) { /* portapapeles no disponible */ }
      }));
  }
  const from = SL.total ? (SL.page - 1) * SL.size + 1 : 0;
  const to = Math.min(SL.page * SL.size, SL.total);
  $('#slRange').textContent = SL.total ? `${from}\u2013${to} de ${SL.total}` : '0 corridas';
  $('#slPrev').disabled = SL.page <= 1;
  $('#slNext').disabled = to >= SL.total;
  $('#slExport').disabled = !SL.rows.length;
}

export async function renderSyncLog(user, presetProcess, backView) {
  USER = user;
  ensureStyles();
  // v4.66: sin preset (entrada por el menu) arranca en Personal de tiendas,
  // el proceso que mas se consulta. Los botones de tarjetas/vistas siguen
  // pasando su propio preset.
  SL = { process: PROC_LBL[presetProcess] ? presetProcess : 'roster', page: 1, size: 25, status: '', from: '', to: '', total: 0, rows: [], note: '' };
  // v4.63: backView = data-view del menu desde donde se abrio (sync,
  // syncreview, axcompare, axhistory): el boton Volver re-navega alli.
  const backBtn = backView
    ? `<button class="sl-btn" id="slBack" style="margin-bottom:10px">← Volver</button>`
    : '';
  $('#pnlMain').innerHTML = `
    ${backBtn}
    <div class="sl-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div>
      <h1>Registro de sincronizaciones</h1>
      <p>Historial de corridas de los procesos programados: qu\u00e9 corri\u00f3, cu\u00e1ndo, c\u00f3mo termin\u00f3 y su detalle.</p>
    </div><span id="slRefresh"></span></div>
    <div class="sl-bar">
      <span class="fg">Proceso<select id="slProc">
        <option value="companies">Cat\u00e1logo de empresas</option>
        <option value="pay">Estado de pago</option>
        <option value="roster">Personal de tiendas</option>
      </select></span>
      <span class="fg">Desde<input type="date" id="slFrom"></span>
      <span class="fg">Hasta<input type="date" id="slTo"></span>
      <span class="fg">Estado<select id="slSt"><option value="">Todos</option><option value="ok">OK</option><option value="error">Error / alerta</option></select></span>
      <span class="fg">Por p\u00e1gina<select id="slSize"><option selected>25</option><option>50</option><option>100</option></select></span>
      <button class="sl-btn" id="slGo">Aplicar</button>
      <span style="flex:1"></span>
      <button class="sl-btn" id="slExport" title="Exportar lo que se ve"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg> Exportar</button>
    </div>
    <p class="sl-note" id="slNote"></p>
    <div class="sl-tblwrap"><table class="sl-tbl">
      <thead><tr><th>Fecha</th><th>Origen</th><th>Estado</th><th>Resumen</th><th style="text-align:right">Duraci\u00f3n</th><th></th></tr></thead>
      <tbody id="slBody"></tbody>
    </table></div>
    <div class="sl-pager">
      <span id="slRange"></span>
      <button class="sl-btn" id="slPrev">\u2190 Anterior</button>
      <button class="sl-btn" id="slNext">Siguiente \u2192</button>
    </div>`;

  $('#slProc').value = SL.process;
  if (backView) {
    const bk = $('#slBack');
    if (bk) bk.addEventListener('click', () => {
      const navBtn = document.querySelector(`.pnl-side [data-view="${backView}"]`) || document.querySelector(`[data-view="${backView}"]`);
      if (navBtn) navBtn.click();
    });
  }
  const apply = () => {
    SL.process = $('#slProc').value;
    SL.from = $('#slFrom').value;
    SL.to = $('#slTo').value;
    SL.status = $('#slSt').value;
    SL.size = +$('#slSize').value;
    SL.page = 1;
    slLoad();
  };
  $('#slGo').addEventListener('click', apply);
  ['#slProc', '#slSt', '#slSize'].forEach(sel => $(sel).addEventListener('change', apply));
  $('#slPrev').addEventListener('click', () => { if (SL.page > 1) { SL.page--; slLoad(); } });
  $('#slNext').addEventListener('click', () => { if (SL.page * SL.size < SL.total) { SL.page++; slLoad(); } });
  $('#slExport').addEventListener('click', () => slOpenExportMenu($('#slExport')));

  await slLoad();
  // v4.66: chip "hace X min" + boton Recargar, como en Historial.
  attachRefresh('#slRefresh', () => slLoad(), 'synclog');
}
