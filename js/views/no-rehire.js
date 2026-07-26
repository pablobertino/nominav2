/* =====================================================================
   views/no-rehire.js — No reempleables (v5.73)
   La lista de personas que el sistema marca como no aptas para
   recontratar, sincronizada a diario (v5.72). Gate: view.norehire.

   DOS CASOS QUE LA PANTALLA MANEJA SIN PARECER ROTA:
   - CON ficha (esta en workers_master) -> foto, cargo y datos. Va a pasar
     cuando marquen a alguien MIENTRAS esta empleado.
   - SIN ficha (solo existe en el sistema) -> solo lo que manda la API.
     Es el caso normal: los no-reempleables suelen ser gente que ya se fue
     y el maestro solo tiene vigentes.

   EL CASO A GRITAR: esta en la lista Y sigue activo en una tienda
   (`activo_en`). Se pinta en rojo arriba y en su fila.

   Motivo desconocido: si el sistema manda un motivo que no esta en el
   catalogo del portal, se muestra el crudo MARCADO en ambar (se arregla
   con un INSERT en no_rehire_reason, sin deploy).

   Las bajas no se borran (removed_at): por defecto se ocultan y un
   filtro las muestra. Solo lectura: la lista se corrige en el sistema.

   Superadmin ademas ve: Sincronizar ahora + la hora de la corrida diaria.
   ===================================================================== */
import { $ } from '../core/dom.js';
// v5.83: el boton Registro de la tarjeta de Configurar abre el Registro de
// sincronizaciones directo en el proceso No reempleables.
import { renderSyncLog } from './sync-log.js';
// v6.132: Exportar unificado (mismo botón/menú de todo el sitio).
import { ensureExportMenuStyles, exportMenuHtml, wireExportMenu } from '../core/export-menu.js';
// v6.132: visor de foto ampliada (lightbox) — el mismo de Buscar/Personal.
import { openWorkerLightbox } from './worker-photos.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmtDate = d => {
  if (!d) return '—';
  const [y, m, dd] = String(d).slice(0, 10).split('-');
  return (y && m && dd) ? `${dd}/${m}/${y}` : '—';
};

/* Fecha+hora en Caracas para "ultima sincronizacion". */
function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-VE', {
      timeZone: 'America/Caracas', day: '2-digit', month: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return fmtDate(iso); }
}

function daysSince(d) {
  if (!d) return null;
  const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/* Duración amable a partir de días (para "días trabajados"). v6.133. */
function fmtDur(days) {
  days = Math.max(0, Math.round(Number(days) || 0));
  if (days < 31) return `${days} día${days === 1 ? '' : 's'}`;
  const y = Math.floor(days / 365), rem = days % 365, mo = Math.floor(rem / 30);
  const parts = [];
  if (y) parts.push(`${y} año${y === 1 ? '' : 's'}`);
  if (mo) parts.push(`${mo} mes${mo === 1 ? '' : 'es'}`);
  if (!parts.length) parts.push(`${days} días`);
  return parts.join(' y ');
}

/* Iniciales para el avatar sin foto. */
function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/* Ícono de ficha del portal (mismo trazo que Buscar/Personal). v6.132. */
function icoFicha() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="2"/><path d="M13 9h5M13 13h5M6.5 15.5c.4-1.2 1.4-2 2.5-2s2.1.8 2.5 2"/></svg>';
}

/* Clase de color del chip segun el valor del motivo (m1..m8 del catalogo;
   m0 para valores fuera de rango o desconocidos). v5.76. */
function motClass(v) {
  const n = Number(v);
  return (Number.isFinite(n) && n >= 1 && n <= 8) ? ('m' + n) : 'm0';
}

async function api(user, payload) {
  const res = await fetch('/api/no-rehire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user }),
  });
  return res.json();
}

let STYLED = false;
function ensureStyles() {
  ensureExportMenuStyles();   // v6.132: estilos del "Exportar ▾" compartido
  if (STYLED) return;
  STYLED = true;
  const css = document.createElement('style');
  /* OJO: nunca escapes tipo \2713 dentro de este template literal (escape
     octal -> SyntaxError -> portal en blanco; leccion de v5.13). */
  css.textContent = `
  .nr-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
  .nr-head h2{margin:0;font-size:20px;font-weight:700}
  .nr-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .nr-why{display:flex;gap:11px;align-items:flex-start;background:var(--warn-bg,#fff7ed);
          border:1px solid #fed7aa;color:#92400e;border-radius:11px;
          padding:12px 15px;margin:16px 0 0;font-size:12.5px;line-height:1.6}
  .nr-why .ic{flex:none;font-size:15px}
  .nr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:11px;margin:14px 0 0}
  .nr-kpi{background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:13px 15px}
  .nr-kpi small{display:block;font-size:11.5px;color:var(--muted);font-weight:700}
  .nr-kpi b{font-size:24px;font-weight:700;line-height:1.25;display:block;margin-top:3px}
  .nr-kpi .sub{font-size:11px;color:var(--faint,#94a3b8);font-weight:600;margin-top:2px}
  .nr-kpi.bad{border-color:#fecaca;background:#fef2f2}
  .nr-kpi.bad b{color:#dc2626}
  .nr-filters{display:flex;gap:8px 10px;align-items:center;flex-wrap:wrap;margin:15px 0 0}
  .nr-filters input[type=text],.nr-filters select{font:inherit;font-size:13px;padding:7px 10px;
       border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .nr-filters label.chk{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted);cursor:pointer;user-select:none}
  .nr-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;margin-top:13px;overflow:hidden}
  .nr-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .nr-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
     color:var(--muted);font-weight:800;padding:10px 14px;background:#fbfcfe;
     border-bottom:1px solid var(--border);white-space:nowrap}
  .nr-tbl td{padding:11px 14px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:middle}
  .nr-tbl tbody tr:last-child td{border-bottom:none}
  .nr-tbl tbody tr{cursor:pointer}
  .nr-tbl tbody tr:hover{background:var(--bg-soft,#f8fafc)}
  .nr-tbl tbody tr.baja td{opacity:.55}
  .nr-who{display:flex;align-items:center;gap:10px;min-width:0}
  .nr-ava{width:38px;height:38px;border-radius:50%;flex:none;object-fit:cover;border:1px solid var(--border)}
  .nr-ava.zoom{cursor:zoom-in}
  /* v6.132: acción de ficha por fila (mismo botón iconizado del resto del sitio) */
  .nr-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;
     border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--muted);cursor:pointer}
  .nr-iconbtn:hover{background:var(--bg-soft,#f8fafc);color:var(--ink);border-color:#cbd5e1}
  .nr-act{width:1%;white-space:nowrap;text-align:right}
  .nr-fic-zoom{cursor:zoom-in}
  .nr-ava-ini{width:38px;height:38px;border-radius:50%;flex:none;display:inline-flex;align-items:center;
     justify-content:center;background:#eef2f7;color:#64748b;font-weight:800;font-size:13px;border:1px solid var(--border)}
  .nr-nm{font-weight:700}
  .nr-ced{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .nr-role{font-size:11px;color:var(--muted);margin-top:1px}
  .nr-pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;white-space:nowrap}
  /* v5.76: paleta SUAVE, un color por motivo (Pablo: "salen muy fuertes").
     Fondo claro + texto medio + borde tenue, como los chips de Publicar.
     m1..m8 = no_rehire_reason.value; m0 = sin valor / desconocido. */
  .nr-pill.m1{background:#fff1f2;color:#be123c;border:1px solid #fecdd3}   /* Robo */
  .nr-pill.m2{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa}   /* Agresión verbal */
  .nr-pill.m3{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}   /* Agresión física */
  .nr-pill.m4{background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe}   /* Insubordinación */
  .nr-pill.m5{background:#fefce8;color:#a16207;border:1px solid #fde68a}   /* Negligencia */
  .nr-pill.m6{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}   /* Abandono del puesto */
  .nr-pill.m7{background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe}   /* Fraude */
  .nr-pill.m8{background:#fdf4ff;color:#a21caf;border:1px solid #f5d0fe}   /* Acoso */
  .nr-pill.m0{background:#f8fafc;color:#475569;border:1px solid #e2e8f0}   /* desconocido */
  .nr-pill.unk{background:#fefce8;color:#a16207;border:1px solid #fde68a}
  .nr-pill.vig{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .nr-pill.out{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
  .nr-pill.act{background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;font-weight:800}
  .nr-obs{font-size:12px;color:var(--muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nr-note{font-size:11.5px;color:var(--muted);margin:10px 2px 0;line-height:1.6}
  .nr-empty{padding:52px 20px;text-align:center}
  .nr-empty .big{font-size:38px;margin-bottom:10px}
  .nr-empty .t{font-weight:700;color:#16a34a;margin-bottom:5px;font-size:15px}
  .nr-empty .s{font-size:12.5px;color:var(--muted);max-width:460px;margin:0 auto;line-height:1.6}
  .nr-loading{padding:44px;text-align:center;color:var(--muted);font-size:13px}
  .nr-sync{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--card,#fff);
     border:1px solid var(--border);border-radius:12px;padding:11px 14px;margin-top:13px;font-size:12.5px}
  .nr-sync .st-ok{color:#15803d;font-weight:700}
  .nr-sync .st-err{color:#b91c1c;font-weight:700}
  .nr-sync input[type=time]{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:8px}
  .nr-sync .msg{font-size:12px}
  /* ---- modal de ficha ---- */
  .nr-ov{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:1200;
     display:flex;align-items:center;justify-content:center;padding:18px}
  .nr-mod{background:var(--card,#fff);border-radius:15px;max-width:460px;width:100%;
     max-height:90vh;overflow:auto;box-shadow:0 22px 60px rgba(0,0,0,.25)}
  .nr-mod-head{display:flex;justify-content:space-between;align-items:center;padding:14px 17px;
     border-bottom:1px solid var(--border)}
  .nr-mod-head b{font-size:15px}
  .nr-mod-x{border:none;background:none;font-size:17px;cursor:pointer;color:var(--muted);padding:4px 8px}
  .nr-mod-body{padding:17px}
  .nr-fic{display:flex;gap:14px;align-items:flex-start}
  .nr-fic img{width:84px;height:84px;border-radius:13px;object-fit:cover;border:1px solid var(--border);flex:none}
  .nr-fic .noimg{width:84px;height:84px;border-radius:13px;flex:none;display:flex;align-items:center;
     justify-content:center;background:#eef2f7;color:#64748b;font-weight:800;font-size:24px;border:1px solid var(--border)}
  .nr-fgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-top:15px;font-size:12.5px}
  .nr-fgrid .lbl{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:800}
  .nr-fobs{margin-top:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#7f1d1d;line-height:1.55}
  .nr-factivo{margin-top:11px;background:#dc2626;color:#fff;border-radius:10px;padding:11px 13px;font-size:12.5px;font-weight:700}
  .nr-mod-foot{display:flex;justify-content:flex-end;padding:0 17px 16px}
  @media(max-width:760px){
    .nr-tbl thead{display:none}
    .nr-tbl td{display:block;border:none;padding:4px 14px}
    .nr-tbl tbody tr{display:block;border-bottom:1px solid var(--border)!important;padding:11px 0}
    .nr-obs{white-space:normal;max-width:none}
    .nr-fgrid{grid-template-columns:1fr}
  }
  /* ===== v6.130: pantalla de Estadisticas ===== */
  .nrs-back{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;color:var(--muted);
     border:1px solid var(--border);background:var(--surface,#fff);border-radius:9px;padding:6px 11px;margin:0 0 14px;cursor:pointer}
  .nrs-back:hover{background:var(--bg-soft,#f8fafc)}
  .nrs-kpis{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0 16px}
  .nrs-kpi{background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:12px 15px;min-width:160px;flex:1 1 160px}
  .nrs-kpi .l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8)}
  .nrs-kpi .v{font-size:24px;font-weight:800;margin-top:2px}
  .nrs-kpi .s{font-size:11px;color:var(--muted);margin-top:1px}
  .nrs-kpi.mot{border-top:3px solid var(--muted)}
  .nrs-kpi .zl{font-size:11px;color:var(--muted);margin-top:8px;padding-top:7px;border-top:1px solid var(--border-soft,#eef1f5)}
  .nrs-kpi .zl b{color:var(--soft,#334155)}
  .nrs-kpi.zona .zrow{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;margin-top:6px}
  .nrs-kpi.zona .zrow:first-of-type{margin-top:8px}
  .nrs-kpi.zona .zrow b{font-weight:800}.nrs-kpi.zona .zrow.top b{color:#4f46e5}
  .nrs-kpi.zona .zrow span{color:var(--muted);font-weight:700}
  .nrs-grid{display:grid;grid-template-columns:1fr 1.35fr;gap:16px;align-items:start}
  @media(max-width:900px){.nrs-grid{grid-template-columns:1fr}}
  .nrs-card{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;padding:15px 16px;margin:0 0 16px}
  .nrs-card h3{font-size:13px;margin:0 0 12px;font-weight:800;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .nrs-card h3 .n{font-size:11.5px;color:var(--muted);font-weight:500}
  .nrs-row{display:grid;grid-template-columns:150px 1fr 30px;align-items:center;gap:10px;margin:0 0 9px;cursor:pointer;border-radius:8px}
  .nrs-row.static{cursor:default}
  .nrs-row .l{font-size:12.5px;color:var(--soft,#334155);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nrs-row .t{height:15px;background:#eef1f6;border-radius:99px;position:relative;overflow:hidden}
  .nrs-row .f{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:#4f46e5}
  .nrs-row .f.g{background:#cbd5e1}
  .nrs-row .v{font-size:12.5px;font-weight:800;text-align:right;color:var(--ink)}
  .nrs-row.sel{background:#eef2ff}
  .nrs-row.sel .l{font-weight:800;color:#4338ca}
  .nrs-row:not(.static):hover .l{color:#4338ca}
  .nrs-hint{font-size:11px;color:var(--faint,#94a3b8);margin:2px 0 10px}
  table.nrs-hm{border-collapse:separate;border-spacing:3px;font-size:12px;width:100%}
  table.nrs-hm th{font-weight:700;color:var(--muted);font-size:11px;padding:3px 4px;text-align:center;white-space:nowrap}
  table.nrs-hm th.rowh{text-align:left;color:var(--soft,#334155);font-weight:600;min-width:112px;cursor:pointer}
  table.nrs-hm th.rowh:hover{color:#4338ca}
  table.nrs-hm tr.sel th.rowh{color:#4338ca;font-weight:800}
  table.nrs-hm td{width:40px;height:28px;text-align:center;border-radius:7px;font-weight:800;color:#3730a3}
  table.nrs-hm td.z{background:#f8fafc;color:#cbd5e1;font-weight:600}
  table.nrs-hm td.tot{background:#eef2ff;color:#3730a3}
  table.nrs-hm tr.trtot th,table.nrs-hm tr.trtot td{color:#3730a3}
  table.nrs-hm tr.trtot th.rowh{cursor:default;font-weight:800}
  .nrs-legend{display:flex;gap:7px;align-items:center;font-size:11px;color:var(--muted);margin-top:10px;flex-wrap:wrap}
  .nrs-legend .sw{width:15px;height:11px;border-radius:3px;display:inline-block}
  table.nrs-lead{width:100%;border-collapse:collapse;font-size:12.5px}
  table.nrs-lead td,table.nrs-lead th{padding:7px 8px;border-bottom:1px solid var(--border-soft,#eef1f5);text-align:left}
  table.nrs-lead tbody tr:last-child td{border-bottom:none}
  table.nrs-lead th{font-size:11px;color:var(--faint,#94a3b8);text-transform:uppercase;letter-spacing:.04em}
  table.nrs-lead .mn{font-weight:700}table.nrs-lead .sz{color:var(--soft,#334155)}table.nrs-lead .nn{text-align:right;font-weight:800}
  .nrs-tie{font-size:10.5px;color:#b45309;background:#fff7ed;border:1px solid #fde7c8;border-radius:5px;padding:0 6px;margin-left:6px;white-space:nowrap}
  .nrs-note{font-size:11.5px;color:var(--muted);margin:12px 0 0;background:var(--bg-soft,#fafbff);border:1px dashed var(--border);border-radius:9px;padding:9px 12px;line-height:1.55}
  .nrs-note b{color:var(--soft,#334155)}
  @media(max-width:560px){
    .nrs-row{grid-template-columns:120px 1fr 28px}
    table.nrs-hm{font-size:11px}
    table.nrs-hm td{width:32px;height:26px}
  }
  /* ===== v6.134: ficha completa (solo lectura), estilo secciones ===== */
  .nrf-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;padding:11px 16px;margin:2px 0 14px;font-size:13px}
  .nrf-top .eg{display:inline-flex;align-items:center;gap:8px;font-weight:800;color:var(--soft,#334155)}
  .nrf-top .eg .dot{width:9px;height:9px;border-radius:50%;background:#94a3b8}
  .nrf-top .since{color:var(--muted)}
  .nrf-top.active .eg{color:#b91c1c}.nrf-top.active .eg .dot{background:#dc2626}
  .nrf-main{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
  .nrf-hd{display:flex;gap:16px;align-items:flex-start}
  .nrf-photo{width:96px;height:96px;border-radius:14px;object-fit:cover;border:1px solid var(--border);flex:none;cursor:zoom-in}
  .nrf-photo.noimg{display:flex;align-items:center;justify-content:center;background:#eef2f7;color:#64748b;font-weight:800;font-size:30px;cursor:default}
  .nrf-hid{min-width:0;flex:1}
  .nrf-nm{font-size:21px;font-weight:800;line-height:1.15}
  .nrf-ced{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);margin-top:2px}
  .nrf-tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;align-items:center}
  .nrf-obs{margin-top:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#7f1d1d;line-height:1.5}
  .nrf-sec{margin-top:18px}
  .nrf-sec-h{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--faint,#94a3b8);border-bottom:1px solid var(--border-soft,#eef1f5);padding-bottom:7px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .nrf-kv{display:grid;grid-template-columns:1fr 1fr;gap:12px 22px;font-size:13px}
  @media(max-width:640px){.nrf-kv{grid-template-columns:1fr}}
  .nrf-f.one{grid-column:1/-1}
  .nrf-f .lbl{display:block;font-size:11px;color:var(--muted);margin-bottom:2px}
  .nrf-f .val{font-weight:600;color:var(--ink)}
  .nrf-f .val.mut{font-weight:400;color:var(--faint,#94a3b8)}
  .nrf-empty{font-size:12.5px;color:var(--muted);line-height:1.55}
  .nrf-stats{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 4px}
  .nrf-stat{background:var(--bg-soft,#f8fafc);border:1px solid var(--border-soft,#eef1f5);border-radius:11px;padding:10px 13px;min-width:112px;flex:1 1 112px}
  .nrf-stat .l{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--faint,#94a3b8)}
  .nrf-stat .v{font-size:18px;font-weight:800;margin-top:2px}
  .nrf-stat .s{font-size:11px;color:var(--muted);margin-top:1px}
  details.nrf-tlwrap{margin-top:12px}
  details.nrf-tlwrap>summary{list-style:none;cursor:pointer;font-size:12.5px;font-weight:700;color:#4338ca;user-select:none}
  details.nrf-tlwrap>summary::-webkit-details-marker{display:none}
  details.nrf-tlwrap>summary::before{content:'▸ '}
  details.nrf-tlwrap[open]>summary::before{content:'▾ '}
  .nrf-tl{position:relative;margin:12px 0 0;padding-left:18px}
  .nrf-tl::before{content:'';position:absolute;left:5px;top:4px;bottom:4px;width:2px;background:var(--border)}
  .nrf-ti{position:relative;padding:0 0 15px 10px}
  .nrf-ti:last-child{padding-bottom:0}
  .nrf-ti::before{content:'';position:absolute;left:-16px;top:3px;width:11px;height:11px;border-radius:50%;background:#fff;border:2.5px solid #94a3b8}
  .nrf-ti.act::before{border-color:#16a34a}
  .nrf-ti .emp{font-size:13px;font-weight:700;line-height:1.25}
  .nrf-ti .loc{font-size:11.5px;color:var(--muted);margin-top:1px}
  .nrf-ti .per{font-size:12px;color:var(--soft,#334155);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .nrf-daychip{font-size:10.5px;font-weight:700;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px}
  .nrf-loading{padding:44px;text-align:center;color:var(--muted);font-size:13px}`;
  document.head.appendChild(css);
}

/* ---- exportacion (Excel + CSV + TXT, sobre lo VISIBLE) ---- */
function flatten(rows) {
  return rows.map(r => ({
    'Cédula': (r.ced_kind ? r.ced_kind + '-' : '') + (r.id_number || ''),
    'Colaborador': r.full_name || '',
    'Motivo': r.reason_label || '',
    'Observaciones': r.notes || '',
    'En la lista desde': fmtDate(r.detected_at),
    'Estado': r.removed_at ? `Salió de la lista (${fmtDate(r.removed_at)})` : 'Vigente',
    'Activo en': (r.activo_en || []).join(' · '),
    'Cargo': r.role || '',
  }));
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function expCsv(rows) {
  const data = flatten(rows);
  if (!data.length) return;
  const cols = Object.keys(data[0]);
  const lines = [cols.join(';')];
  data.forEach(d => lines.push(cols.map(c => String(d[c] ?? '').replace(/;/g, ',')).join(';')));
  download('no_reempleables.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}
function expTxt(rows) {
  const data = flatten(rows);
  if (!data.length) return;
  const cols = Object.keys(data[0]);
  const w = cols.map(c => Math.max(c.length, ...data.map(d => String(d[c] ?? '').length)));
  const line = a => a.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  const out = [line(cols), w.map(n => '-'.repeat(n)).join('  ')];
  data.forEach(d => out.push(line(cols.map(c => d[c]))));
  download('no_reempleables.txt', out.join('\r\n'), 'text/plain;charset=utf-8');
}
async function expXlsx(rows) {
  const data = flatten(rows);
  if (!data.length) return;
  if (!window.XLSX) {
    await new Promise((ok, err) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = ok; s.onerror = err;
      document.head.appendChild(s);
    });
  }
  const ws = window.XLSX.utils.json_to_sheet(data);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'No reempleables');
  window.XLSX.writeFile(wb, 'no_reempleables.xlsx');
}

/* ---- ficha (modal del portal: se cierra SOLO con sus botones) ---- */
function openFicha(r) {
  const prev = document.getElementById('nrOv');
  if (prev) prev.remove();

  const ov = document.createElement('div');
  ov.className = 'nr-ov'; ov.id = 'nrOv';
  const ced = (r.ced_kind ? r.ced_kind + '-' : '') + (r.id_number || '');
  const foto = r.thumb_url
    ? `<img class="nr-fic-zoom" data-zoom="1" title="Ampliar foto" src="${esc(r.thumb_url)}" alt="" onerror="this.outerHTML='&lt;div class=&quot;noimg&quot;&gt;${esc(initials(r.full_name))}&lt;/div&gt;'">`
    : `<div class="noimg">${esc(initials(r.full_name))}</div>`;
  const activos = r.activo_en || [];
  ov.innerHTML = `
    <div class="nr-mod" role="dialog" aria-modal="true">
      <div class="nr-mod-head"><b>Ficha del no reempleable</b>
        <button class="nr-mod-x" id="nrModX" title="Cerrar">✕</button></div>
      <div class="nr-mod-body">
        <div class="nr-fic">
          ${foto}
          <div style="min-width:0">
            <div style="font-weight:800;font-size:15px">${esc(r.full_name || 'Sin nombre')}</div>
            <div class="nr-ced">${esc(ced)}</div>
            ${r.role ? `<div class="nr-role">${esc(r.role)}</div>` : ''}
            <div style="margin-top:7px">
              <span class="nr-pill ${motClass(r.reason_value)}">${esc(r.reason_label || '')}</span>
              ${r.reason_unknown ? '<span class="nr-pill unk" title="Este motivo no está en el catálogo del portal">motivo sin traducir</span>' : ''}
            </div>
          </div>
        </div>
        ${activos.length ? `<div class="nr-factivo">⚠ Actualmente ACTIVO en: ${esc(activos.join(' · '))}. Está empleado y en la lista de no reempleables al mismo tiempo.</div>` : ''}
        ${r.notes ? `<div class="nr-fobs"><b>Observaciones:</b> ${esc(r.notes)}</div>` : ''}
        <div class="nr-fgrid">
          <div><span class="lbl">En la lista desde</span>${fmtDate(r.detected_at)}</div>
          <div><span class="lbl">Última vez visto</span>${fmtDate(r.last_seen_at)}</div>
          ${r.removed_at ? `<div><span class="lbl">Salió de la lista</span>${fmtDate(r.removed_at)}</div>` : ''}
          ${r.in_master ? `
            <div><span class="lbl">Empresa</span>${activos.length ? esc(activos.join(' · ')) : 'Sin empresa activa (egresado)'}</div>
            ${r.gender ? `<div><span class="lbl">Sexo</span>${esc(r.gender)}</div>` : ''}
            ${r.birth_date ? `<div><span class="lbl">Nacimiento</span>${fmtDate(r.birth_date)}</div>` : ''}
            ${r.phone ? `<div><span class="lbl">Teléfono</span>${esc(r.phone)}</div>` : ''}
            ${r.email ? `<div><span class="lbl">Correo</span>${esc(r.email)}</div>` : ''}
          ` : '<div style="grid-column:1/-1;color:var(--muted)">Esta persona no tiene ficha en el portal: solo existen los datos que envía el sistema.</div>'}
        </div>
      </div>
      <div class="nr-mod-foot"><button class="btn" id="nrModOk">Cerrar</button></div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#nrModX').addEventListener('click', close);
  ov.querySelector('#nrModOk').addEventListener('click', close);
  // v6.132: la foto de la ficha se amplía en el visor del portal.
  if (r.thumb_url) {
    ov.querySelector('.nr-fic-zoom')?.addEventListener('click', () =>
      openWorkerLightbox(r.thumb_url, `${r.full_name || ''} · ${ced}`, `${r.id_number}.jpg`));
  }
}

/* ---- fila ---- */
function rowHtml(r) {
  const ced = (r.ced_kind ? r.ced_kind + '-' : '') + (r.id_number || '');
  const ava = r.thumb_url
    ? `<img class="nr-ava zoom" data-zoom="1" title="Ampliar foto" src="${esc(r.thumb_url)}" alt="" loading="lazy"
         onerror="this.outerHTML='&lt;span class=&quot;nr-ava-ini&quot;&gt;${esc(initials(r.full_name))}&lt;/span&gt;'">`
    : `<span class="nr-ava-ini">${esc(initials(r.full_name))}</span>`;
  const activos = r.activo_en || [];
  const estado = r.removed_at
    ? `<span class="nr-pill out">Salió · ${fmtDate(r.removed_at)}</span>`
    : (activos.length
        ? `<span class="nr-pill act">⚠ ACTIVO en ${esc(activos.join(' · '))}</span>`
        : '<span class="nr-pill vig">Vigente</span>');
  return `
    <tr data-id="${esc(String(r.id))}" class="${r.removed_at ? 'baja' : ''}"
        data-search="${esc(((r.full_name || '') + ' ' + (r.id_number || '')).toLowerCase())}"
        data-motivo="${esc(String(r.reason_value ?? ''))}"
        data-baja="${r.removed_at ? '1' : '0'}">
      <td>
        <div class="nr-who">${ava}
          <div style="min-width:0">
            <div class="nr-nm">${esc(r.full_name || 'Sin nombre')}</div>
            <div class="nr-ced">${esc(ced)}</div>
            ${r.role ? `<div class="nr-role">${esc(r.role)}</div>` : ''}
          </div>
        </div>
      </td>
      <td><span class="nr-pill ${motClass(r.reason_value)}">${esc(r.reason_label || '')}</span>
        ${r.reason_unknown ? '<span class="nr-pill unk" title="Este motivo no está en el catálogo del portal">sin traducir</span>' : ''}</td>
      <td><div class="nr-obs" title="${esc(r.notes || '')}">${esc(r.notes || '—')}</div></td>
      <td style="white-space:nowrap;color:var(--muted);font-size:12px">${fmtDate(r.detected_at)}</td>
      <td>${estado}</td>
      <td class="nr-act"><button type="button" class="nr-iconbtn" data-ficha="1" title="Ver ficha">${icoFicha()}</button></td>
    </tr>`;
}

/* ---- filtros en cliente (son pocos casos) ---- */
function applyFilters() {
  const q = ($('#nrQ')?.value || '').trim().toLowerCase();
  const mot = $('#nrMot')?.value || '';
  const showBajas = !!$('#nrBajas')?.checked;
  document.querySelectorAll('#nrRows tr').forEach(tr => {
    let show = true;
    if (q && !(tr.dataset.search || '').includes(q)) show = false;
    if (mot && tr.dataset.motivo !== mot) show = false;
    if (!showBajas && tr.dataset.baja === '1') show = false;
    tr.style.display = show ? '' : 'none';
  });
}
function visibleRows(rows) {
  const shown = new Set([...document.querySelectorAll('#nrRows tr')]
    .filter(tr => tr.style.display !== 'none')
    .map(tr => tr.dataset.id));
  return rows.filter(r => shown.has(String(r.id)));
}

export async function renderNoRehire(user) {
  ensureStyles();

  $('#pnlMain').innerHTML = `
    <div class="nr-head">
      <div>
        <h2>No reempleables</h2>
        <p>Personas que el sistema marca como no aptas para recontratar. Se sincroniza a diario.</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" id="nrStats"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg> Ver estadísticas</button>
        ${exportMenuHtml('nrExp')}
      </div>
    </div>
    <div id="nrBody"><div class="nr-loading">Cargando la lista…</div></div>
  `;
  $('#nrStats')?.addEventListener('click', () => renderNoRehireStats(user));

  const r = await api(user, { action: 'list' });
  const body = $('#nrBody');
  if (!body) return;   // el usuario navego a otra vista mientras cargaba

  if (!r || !r.ok) {
    body.innerHTML = `<div class="nr-card"><div class="nr-loading">
      ${esc((r && r.error) || 'No se pudo cargar.')}</div></div>`;
    return;
  }

  const rows = r.rows || [];
  const cfg = r.config || null;
  const isSuper = user.kind === 'admin' && user.role === 'superadmin';

  const vigentes = rows.filter(x => !x.removed_at);
  const activos = vigentes.filter(x => (x.activo_en || []).length);
  const bajas = rows.length - vigentes.length;
  const desconocidos = vigentes.filter(x => x.reason_unknown).length;

  /* Barra de sincronizacion: todos ven cuando corrio; el superadmin ademas
     puede sincronizar ahora y cambiar la hora de la corrida diaria. */
  const lastTxt = cfg && cfg.last_run_at
    ? `${fmtDateTime(cfg.last_run_at)} · ${cfg.last_status === 'ok'
        ? '<span class="st-ok">OK</span>'
        : `<span class="st-err">${esc(cfg.last_status || 'error')}</span>`}`
    : 'aún no ha corrido';
  /* v5.75: los controles (Sincronizar ahora + hora) se MUDARON a
     Sincronización → Configurar (pedido de Pablo, 14/07). Acá queda solo
     la línea informativa; al superadmin se le dice dónde viven ahora. */
  const syncBar = `
    <div class="nr-sync">
      <span>Última sincronización: ${lastTxt}</span>
      ${cfg && cfg.last_error ? `<span class="st-err" title="${esc(cfg.last_error)}">⚠ ${esc(String(cfg.last_error).slice(0, 90))}</span>` : ''}
      ${isSuper ? `<span class="msg" style="margin-left:auto;color:var(--muted)">Se programa y se ejecuta desde <b>Sincronización → Configurar</b>.</span>` : ''}
    </div>`;

  if (!rows.length) {
    body.innerHTML = `
      ${syncBar}
      <div class="nr-card">
        <div class="nr-empty">
          <div class="big">✅</div>
          <div class="t">La lista está vacía</div>
          <div class="s">El sistema no reporta personas no reempleables por ahora.
            Esta lista se sincroniza automáticamente todos los días.</div>
        </div>
      </div>`;
  } else {
    // Motivos presentes (para el filtro), vigentes primero.
    const motivos = [...new Map(rows.map(x => [String(x.reason_value ?? ''), x.reason_label])).entries()]
      .filter(([v]) => v !== '');

    body.innerHTML = `
      <div class="nr-why">
        <span class="ic">🚫</span>
        <div>
          <b>Estas personas no deben ser recontratadas en ninguna empresa del grupo.</b>
          La lista viene del sistema y el portal no la modifica: se corrige allá y el cambio
          llega en la próxima sincronización. Al reportar un ingreso, el portal rechaza
          automáticamente estas cédulas.
        </div>
      </div>

      <div class="nr-kpis">
        <div class="nr-kpi"><small>Vigentes</small><b>${vigentes.length}</b>
          <div class="sub">en la lista hoy</div></div>
        ${activos.length ? `
        <div class="nr-kpi bad"><small>⚠ Activos en tienda</small><b>${activos.length}</b>
          <div class="sub">en la lista Y empleados</div></div>` : ''}
        <div class="nr-kpi"><small>Salieron de la lista</small><b>${bajas}</b>
          <div class="sub">histórico (no se borran)</div></div>
        ${desconocidos ? `
        <div class="nr-kpi bad"><small>Motivos sin traducir</small><b>${desconocidos}</b>
          <div class="sub">falta en el catálogo</div></div>` : ''}
      </div>

      ${syncBar}

      <div class="nr-filters">
        <input type="text" id="nrQ" placeholder="Buscar por cédula o nombre" style="width:230px">
        <select id="nrMot">
          <option value="">Todos los motivos</option>
          ${motivos.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
        </select>
        <label class="chk"><input type="checkbox" id="nrBajas"> Mostrar los que salieron de la lista</label>
      </div>

      <div class="nr-card">
        <table class="nr-tbl">
          <thead><tr>
            <th>Colaborador</th><th>Motivo</th><th>Observaciones</th>
            <th>En la lista desde</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody id="nrRows">${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <p class="nr-note">Haz clic en una fila para ver la ficha completa.
        ${bajas ? `Hay ${bajas} persona${bajas === 1 ? ' que salió' : 's que salieron'} de la lista (oculta${bajas === 1 ? '' : 's'} por defecto).` : ''}</p>
    `;

    applyFilters();   // arranca sin bajas

    const byId = new Map(rows.map(x => [String(x.id), x]));
    $('#nrRows')?.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const row = byId.get(tr.dataset.id);
      if (!row) return;
      // La foto del avatar amplía (lightbox) sin abrir la ficha. v6.132.
      if (e.target.closest('[data-zoom]') && row.thumb_url) {
        e.stopPropagation();
        const ced = (row.ced_kind ? row.ced_kind + '-' : '') + (row.id_number || '');
        openWorkerLightbox(row.thumb_url, `${row.full_name || ''} · ${ced}`, `${row.id_number}.jpg`);
        return;
      }
      renderNoRehireFicha(user, row.id_number);
    });

    $('#nrQ')?.addEventListener('input', applyFilters);
    $('#nrMot')?.addEventListener('change', applyFilters);
    $('#nrBajas')?.addEventListener('change', applyFilters);

    wireExportMenu('nrExp', fmt => {
      const rs = visibleRows(rows);
      if (fmt === 'xlsx') expXlsx(rs);
      else if (fmt === 'csv') expCsv(rs);
      else expTxt(rs);
    });
  }
}

/* =====================================================================
   v6.130 — ESTADISTICAS DE NO REEMPLEABLES (pantalla aparte)
   Se llega con el boton "Ver estadisticas" de la lista y se vuelve con
   "← Volver a la lista". TODO el calculo vive en la RPC de Postgres
   nomina_v2.no_rehire_stats (via accion 'stats' del endpoint): nada de
   numeros hardcodeados. La zona/subzona sale del ULTIMO egreso de cada
   persona (ax_egresos → companies → zones/subzones); quien no tiene egreso
   localizable cae en "Sin zona", que se cuenta aparte para no inventarle
   ubicacion. Solo VIGENTES (igual que los KPI de la lista).

   La card de Motivos y las filas del heatmap son clicables: seleccionan un
   motivo y el panel "Detalle por subzona" se actualiza (arranca en el
   motivo lider). Barras con relleno absoluto (no <span> con width, que en
   algunos visores queda gris). Sin escapes octales en el CSS/HTML. */
async function renderNoRehireStats(user) {
  ensureStyles();
  const main = $('#pnlMain');
  if (!main) return;
  main.innerHTML = `
    <button class="nrs-back" id="nrsBack">← Volver a la lista</button>
    <div class="nr-head"><div>
      <h2>Estadísticas · No reempleables</h2>
      <p>Dónde se concentra cada motivo, por zona y subzona. Se calcula sobre los vigentes, tomando el último egreso de cada persona.</p>
    </div></div>
    <div id="nrsBody"><div class="nr-loading">Calculando…</div></div>`;
  $('#nrsBack')?.addEventListener('click', () => renderNoRehire(user));

  const r = await api(user, { action: 'stats' });
  const body = $('#nrsBody');
  if (!body) return;   // navegó a otra vista mientras cargaba
  if (!r || !r.ok) {
    body.innerHTML = `<div class="nr-card"><div class="nr-loading">${esc((r && r.error) || 'No se pudo cargar.')}</div></div>`;
    return;
  }

  const st = r.stats || {};
  const total = st.total || 0;
  const motivos = st.motivos || [];
  const zonas = st.zonas || [];
  const byZona = st.by_zona || [];
  const bySub = st.by_subzona || [];
  const sinZona = st.sin_zona || 0;

  if (!total || !motivos.length) {
    body.innerHTML = `<div class="nr-card"><div class="nr-empty">
      <div class="big">📊</div><div class="t">Sin datos todavía</div>
      <div class="s">No hay personas vigentes en la lista para analizar.</div></div></div>`;
    return;
  }

  const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
  // v6.131: paleta ATENUADA (Pablo: "como en el resto del sitio"). Mismos
  // matices que los chips de la lista pero desaturados, para que las barras
  // no salgan tan fuertes.
  const MOTCOL = { 1: '#cd8792', 2: '#d29a6a', 3: '#cd8585', 4: '#9b8fca', 5: '#c6ad6a', 6: '#8098ce', 7: '#9095cc', 8: '#bd8cc2' };
  const colOf = v => MOTCOL[Number(v)] || '#475569';
  const shortPlace = p => String(p).split(' · ').pop();

  // Zona líder de un motivo (excluye "Sin zona": una ubicación desconocida
  // no lidera nada). Devuelve la zona real con más casos de ese motivo.
  const zonaLeader = v => byZona
    .filter(z => String(z.mval) === String(v) && !z.sinzona)
    .sort((a, b) => b.cnt - a.cnt)[0] || null;

  // Subzona líder de un motivo, con detección de empate.
  const subLeader = v => {
    const rows = bySub.filter(s => String(s.mval) === String(v)).sort((a, b) => b.cnt - a.cnt);
    if (!rows.length) return null;
    const top = rows[0];
    const ties = rows.filter(s => s.cnt === top.cnt).slice(1).map(s => s.place);
    return { place: top.place, cnt: top.cnt, ties };
  };

  const maxMot = Math.max(1, ...motivos.map(m => m.cnt));

  /* ---- KPIs: Vigentes + top 3 motivos (con su zona líder) + zonas ---- */
  const kpisMot = motivos.slice(0, 3).map((m, i) => {
    const zl = zonaLeader(m.mval);
    const zlTxt = zl
      ? `Zona líder: <b>${esc(zl.zona)}</b> · ${pct(zl.cnt, m.cnt)}% del motivo`
      : 'Sin zona localizable';
    return `<div class="nrs-kpi mot" style="border-top-color:${colOf(m.mval)}">
      <div class="l">${i + 1}º ${esc(m.label)}</div>
      <div class="v" style="color:${colOf(m.mval)}">${m.cnt}</div>
      <div class="s">${pct(m.cnt, total)}% del total</div>
      <div class="zl">${zlTxt}</div>
    </div>`;
  }).join('');
  const zonaTile = `<div class="nrs-kpi zona"><div class="l">Zonas con más casos</div>
    ${zonas.slice(0, 3).map((z, i) => `<div class="zrow ${i === 0 ? 'top' : ''}"><b>${esc(z.zona)}</b><span>${z.cnt} · ${pct(z.cnt, total)}%</span></div>`).join('')}
    ${sinZona ? `<div class="zrow"><b style="color:var(--muted);font-weight:700">Sin zona</b><span>${sinZona} · ${pct(sinZona, total)}%</span></div>` : ''}
  </div>`;

  /* ---- barras de Motivos (clicables) ---- */
  const motBars = motivos.map(m => `
    <div class="nrs-row" data-mval="${esc(String(m.mval))}">
      <span class="l" title="${esc(m.label)}">${esc(m.label)}</span>
      <span class="t"><span class="f" style="width:${Math.max(2, Math.round(m.cnt / maxMot * 100))}%;background:${colOf(m.mval)}"></span></span>
      <span class="v">${m.cnt}</span>
    </div>`).join('');

  /* ---- heatmap Motivo × Zona (columnas: zonas reales + Sin zona) ---- */
  const cols = zonas.map(z => z.zona).concat(sinZona ? ['Sin zona'] : []);
  const cellMap = new Map();
  byZona.forEach(z => cellMap.set(String(z.mval) + '|' + z.zona, z.cnt));
  let maxCell = 1;
  motivos.forEach(m => cols.forEach(c => { const v = cellMap.get(String(m.mval) + '|' + c) || 0; if (v > maxCell) maxCell = v; }));
  // v6.131: rampa índigo suave (antes naranja fuerte). Texto índigo oscuro
  // en todas las celdas: se lee sin necesidad de blanco.
  const CELLBG = { c1: '#eef2ff', c2: '#dbe3fb', c3: '#c7d2fe', c4: '#aeb9f2', c5: '#909ce4' };
  const cellClass = v => { if (!v) return 'z'; const r = v / maxCell; return r <= .12 ? 'c1' : r <= .28 ? 'c2' : r <= .55 ? 'c3' : r <= .8 ? 'c4' : 'c5'; };
  const cellStyle = cl => cl === 'z' ? '' : `background:${CELLBG[cl]}`;
  const abbr = z => z.length > 10 ? z.slice(0, 4) + '.' : z;
  const colTotal = {}; cols.forEach(c => colTotal[c] = 0);
  const hmRows = motivos.map(m => {
    const tds = cols.map(c => {
      const v = cellMap.get(String(m.mval) + '|' + c) || 0; colTotal[c] += v;
      const cl = cellClass(v);
      return v ? `<td class="${cl}" style="${cellStyle(cl)}">${v}</td>` : '<td class="z">·</td>';
    }).join('');
    return `<tr data-mval="${esc(String(m.mval))}"><th class="rowh" title="${esc(m.label)}">${esc(m.label)}</th>${tds}<td class="tot">${m.cnt}</td></tr>`;
  }).join('');
  const hmHead = `<tr><th class="rowh">Motivo</th>${cols.map(c => `<th title="${esc(c)}">${esc(abbr(c))}</th>`).join('')}<th>Total</th></tr>`;
  const hmFoot = `<tr class="trtot"><th class="rowh">Total</th>${cols.map(c => `<td class="tot">${colTotal[c]}</td>`).join('')}<td class="tot">${total}</td></tr>`;

  /* ---- tabla "subzona líder por motivo" ---- */
  const leadRows = motivos.map(m => {
    const sl = subLeader(m.mval);
    if (!sl) return `<tr><td class="mn">${esc(m.label)}</td><td class="sz" style="color:var(--muted)">—</td><td class="nn">0</td></tr>`;
    const tie = sl.ties.length
      ? `<span class="nrs-tie">empata ${esc(shortPlace(sl.ties[0]))}${sl.ties.length > 1 ? ' +' + (sl.ties.length - 1) : ''}</span>`
      : '';
    return `<tr><td class="mn">${esc(m.label)}</td><td class="sz">${esc(sl.place)}${tie}</td><td class="nn">${sl.cnt}</td></tr>`;
  }).join('');

  body.innerHTML = `
    <div class="nrs-kpis">
      <div class="nrs-kpi"><div class="l">Vigentes</div><div class="v">${total}</div><div class="s">en la lista hoy</div></div>
      ${kpisMot}${zonaTile}
    </div>
    <div class="nrs-grid">
      <div class="nrs-card">
        <h3>Motivos <span class="n">${total} vigentes</span></h3>
        <div class="nrs-hint">Toca un motivo para ver su detalle por subzona →</div>
        <div id="nrsMot">${motBars}</div>
      </div>
      <div class="nrs-card">
        <h3>¿Dónde ocurre? · Motivo × Zona <span class="n">color = cantidad</span></h3>
        <table class="nrs-hm"><thead>${hmHead}</thead><tbody id="nrsHm">${hmRows}${hmFoot}</tbody></table>
        <div class="nrs-legend">Menos <span class="sw" style="background:#eef2ff"></span><span class="sw" style="background:#dbe3fb"></span><span class="sw" style="background:#c7d2fe"></span><span class="sw" style="background:#aeb9f2"></span><span class="sw" style="background:#909ce4"></span> Más · <span style="color:#cbd5e1">·</span> = 0</div>
        ${sinZona ? `<div class="nrs-note"><b>“Sin zona” (${sinZona}):</b> personas sin un egreso localizable en el sistema, así que no se les puede asignar tienda. Se cuentan aparte para no inventarles una ubicación.</div>` : ''}
      </div>
    </div>
    <div class="nrs-grid">
      <div class="nrs-card">
        <h3>Subzona donde más ocurre cada motivo</h3>
        <table class="nrs-lead"><thead><tr><th>Motivo</th><th>Subzona líder</th><th style="text-align:right">Casos</th></tr></thead><tbody>${leadRows}</tbody></table>
      </div>
      <div class="nrs-card">
        <h3 id="nrsDetTitle">Detalle por subzona</h3>
        <div id="nrsDet"></div>
      </div>
    </div>`;

  /* ---- panel de detalle interactivo ---- */
  const detTitle = $('#nrsDetTitle'), det = $('#nrsDet');
  function showDetail(v) {
    const rows = bySub.filter(s => String(s.mval) === String(v)).sort((a, b) => b.cnt - a.cnt);
    const m = motivos.find(x => String(x.mval) === String(v));
    if (detTitle) detTitle.innerHTML = `Detalle · ${esc(m ? m.label : '')} por subzona <span class="n">${m ? m.cnt : 0} casos</span>`;
    if (det) {
      if (!rows.length) {
        det.innerHTML = '<div class="nrs-hint">Sin subzonas para este motivo.</div>';
      } else {
        const mx = Math.max(1, ...rows.map(x => x.cnt));
        det.innerHTML = rows.map(x => `
          <div class="nrs-row static">
            <span class="l" title="${esc(x.place)}">${esc(x.place)}</span>
            <span class="t"><span class="f${x.sinzona ? ' g' : ''}" style="width:${Math.max(2, Math.round(x.cnt / mx * 100))}%${x.sinzona ? '' : ';background:' + colOf(v)}"></span></span>
            <span class="v">${x.cnt}</span>
          </div>`).join('');
      }
    }
    document.querySelectorAll('#nrsMot .nrs-row').forEach(el => el.classList.toggle('sel', el.dataset.mval === String(v)));
    document.querySelectorAll('#nrsHm tr[data-mval]').forEach(el => el.classList.toggle('sel', el.dataset.mval === String(v)));
  }
  $('#nrsMot')?.addEventListener('click', e => { const row = e.target.closest('.nrs-row[data-mval]'); if (row) showDetail(row.dataset.mval); });
  $('#nrsHm')?.addEventListener('click', e => { const tr = e.target.closest('tr[data-mval]'); if (tr) showDetail(tr.dataset.mval); });
  showDetail(motivos[0].mval);
}

/* =====================================================================
   v6.133 — FICHA COMPLETA (solo lectura) del no reempleable / egresado
   Se abre desde la lista (clic en la fila o en el ícono de ficha) y se
   vuelve con "← Volver a la lista". La mayoría son EGRESADOS: no están en
   workers_master, pero su HISTORIA vive en ax_egresos. La acción 'ficha'
   (RPC no_rehire_ficha) trae datos del maestro si existe + el registro de
   no reempleable + la trayectoria laboral completa + un resumen. Todo de
   solo lectura: esta pantalla no edita nada (la lista se corrige en el
   sistema). La foto se amplía con el visor del portal. */
async function renderNoRehireFicha(user, idNumber) {
  ensureStyles();
  const main = $('#pnlMain');
  if (!main) return;
  main.innerHTML = `
    <button class="nrs-back" id="nrfBack">← Volver a la lista</button>
    <div id="nrfBody"><div class="nrf-loading">Cargando la ficha…</div></div>`;
  $('#nrfBack')?.addEventListener('click', () => renderNoRehire(user));

  const r = await api(user, { action: 'ficha', id_number: idNumber });
  const body = $('#nrfBody');
  if (!body) return;   // navegó a otra vista mientras cargaba
  if (!r || !r.ok || !r.ficha) {
    body.innerHTML = `<div class="nr-card"><div class="nr-loading">${esc((r && r.error) || 'No se pudo cargar la ficha.')}</div></div>`;
    return;
  }

  const f = r.ficha;
  const m = f.master || null;
  const kind = (m && m.ced_kind) || (Number(f.id_number) >= 80000000 ? 'E' : 'V');
  const ced = `${kind}-${f.id_number || ''}`;
  const name = f.full_name || 'Sin nombre';
  const activos = f.activo_en || [];
  const traj = f.trajectory || [];
  const sm = f.summary || {};

  const GEN = { M: 'Masculino', F: 'Femenino' };
  const MAR = { S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a', O: 'Conviviente', R: 'Unión registrada' };
  const edad = bd => {
    if (!bd) return null;
    const t = Date.parse(String(bd).slice(0, 10)); if (!Number.isFinite(t)) return null;
    const a = Math.floor((Date.now() - t) / (365.2425 * 86400000));
    return (a >= 0 && a < 130) ? a : null;
  };
  const relSince = d => {
    if (!d) return null;
    const t = Date.parse(String(d).slice(0, 10) + 'T00:00:00'); if (!Number.isFinite(t)) return null;
    return fmtDur(Math.max(0, Math.floor((Date.now() - t) / 86400000)));
  };
  // Campo etiqueta/valor (— cuando no hay dato).
  const F = (label, val, one) =>
    `<div class="nrf-f${one ? ' one' : ''}"><span class="lbl">${esc(label)}</span><span class="val${val ? '' : ' mut'}">${val ? esc(val) : '—'}</span></div>`;

  const estado = f.removed_at
    ? `<span class="nr-pill out">Salió de la lista · ${fmtDate(f.removed_at)}</span>`
    : (activos.length
        ? `<span class="nr-pill act">⚠ ACTIVO en ${esc(activos.join(' · '))}</span>`
        : '<span class="nr-pill vig">Vigente</span>');

  const foto = f.thumb_url
    ? `<img class="nrf-photo" data-zoom="1" title="Ampliar foto" src="${esc(f.thumb_url)}" alt="">`
    : `<div class="nrf-photo noimg">${esc(initials(name))}</div>`;

  // Barra superior: en lugar de la empresa, el estado de egreso + hace cuánto.
  const rel = relSince(sm.ultimo_fin);
  const topbar = activos.length
    ? `<div class="nrf-top active"><span class="eg"><span class="dot"></span>También ACTIVO en ${esc(activos.join(' · '))}</span><span class="since">· está en la lista de no reempleables y empleado a la vez</span></div>`
    : `<div class="nrf-top"><span class="eg"><span class="dot"></span>Egresado</span>${rel ? `<span class="since">· hace ${esc(rel)}${sm.ultimo_fin ? ` · último egreso ${fmtDate(sm.ultimo_fin)}` : ''}</span>` : ''}</div>`;

  const statsHtml = traj.length ? `
    <div class="nrf-stats">
      <div class="nrf-stat"><div class="l">Contratos</div><div class="v">${sm.contratos || traj.length}</div><div class="s">registros de egreso</div></div>
      <div class="nrf-stat"><div class="l">Empresas</div><div class="v">${sm.empresas != null ? sm.empresas : '—'}</div><div class="s">distintas</div></div>
      <div class="nrf-stat"><div class="l">Días trabajados</div><div class="v">${sm.dias_total || 0}</div><div class="s">${esc(fmtDur(sm.dias_total || 0))}</div></div>
      <div class="nrf-stat"><div class="l">Período</div><div class="v" style="font-size:12.5px">${fmtDate(sm.primer_inicio)} → ${fmtDate(sm.ultimo_fin)}</div><div class="s">del primer al último</div></div>
    </div>` : '';

  const tl = traj.length ? `<div class="nrf-tl">${traj.map((t, i) => {
    const loc = t.zona ? `${esc(t.zona)}${t.subzona ? ' · ' + esc(t.subzona) : ''}` : 'Sin zona';
    const dias = (t.dias != null) ? `<span class="nrf-daychip">${t.dias} día${t.dias === 1 ? '' : 's'}</span>` : '';
    return `<div class="nrf-ti${i === 0 ? ' act' : ''}">
      <div class="emp">${esc(t.empresa || t.alias || '—')}${t.alias ? ` <span style="color:var(--faint,#94a3b8);font-weight:600;font-size:11px">${esc(t.alias)}</span>` : ''}</div>
      <div class="loc">${loc}</div>
      <div class="per">${fmtDate(t.inicio)} → ${fmtDate(t.fin)} ${dias}</div>
    </div>`;
  }).join('')}</div>` : '';

  const trajSec = traj.length
    ? `${statsHtml}<details class="nrf-tlwrap"${traj.length <= 6 ? ' open' : ''}><summary>Ver trayectoria completa (${traj.length})</summary>${tl}</details>`
    : '<div class="nrf-empty">Sin historia laboral registrada en el sistema.</div>';

  // Secciones de datos del maestro (solo si la persona está en el maestro).
  const cargoSec = (m && m.role)
    ? `<div class="nrf-sec"><div class="nrf-sec-h">Cargo</div><div class="nrf-kv">${F('Cargo', m.role)}</div></div>` : '';
  const bancoSec = (m && m.account_number)
    ? `<div class="nrf-sec"><div class="nrf-sec-h">Datos bancarios</div><div class="nrf-kv">${F('Cuenta bancaria', m.account_number, true)}</div></div>` : '';
  const contactoSec = (m && (m.phone || m.email || m.address || m.fiscal_address))
    ? `<div class="nrf-sec"><div class="nrf-sec-h">Contacto</div><div class="nrf-kv">
        ${m.phone ? F('Teléfono', m.phone) : ''}
        ${m.email ? F('Correo', m.email) : ''}
        ${m.address ? F('Dirección personal', m.address, true) : ''}
        ${m.fiscal_address ? F('Dirección fiscal', m.fiscal_address, true) : ''}
      </div></div>` : '';

  body.innerHTML = `
    ${topbar}
    <div class="nrf-main">
      <div class="nrf-hd">
        ${foto}
        <div class="nrf-hid">
          <div class="nrf-nm">${esc(name)}</div>
          <div class="nrf-ced">${esc(ced)}</div>
          <div class="nrf-tags">
            <span class="nr-pill ${motClass(f.reason_value)}">${esc(f.reason_label || '')}</span>
            ${f.reason_unknown ? '<span class="nr-pill unk" title="Este motivo no está en el catálogo del portal">motivo sin traducir</span>' : ''}
            ${estado}
          </div>
          ${f.notes ? `<div class="nrf-obs"><b>Observaciones:</b> ${esc(f.notes)}</div>` : ''}
        </div>
      </div>

      <div class="nrf-sec">
        <div class="nrf-sec-h">Identidad</div>
        <div class="nrf-kv">
          ${F('Nombre completo', name, true)}
          ${F('Cédula', ced)}
          ${m && m.birth_date ? F('Fecha de nacimiento', fmtDate(m.birth_date)) : ''}
          ${m && edad(m.birth_date) != null ? F('Edad', edad(m.birth_date) + ' años') : ''}
          ${m && m.gender ? F('Género', GEN[m.gender] || m.gender) : ''}
          ${m && m.marital_status ? F('Estado civil', MAR[m.marital_status] || m.marital_status) : ''}
        </div>
      </div>

      <div class="nrf-sec">
        <div class="nrf-sec-h">No reempleable</div>
        <div class="nrf-kv">
          ${F('Motivo', f.reason_label)}
          ${F('En la lista desde', fmtDate(f.detected_at))}
          ${F('Última vez visto', fmtDate(f.last_seen_at))}
          ${f.removed_at ? F('Salió de la lista', fmtDate(f.removed_at)) : ''}
        </div>
      </div>

      <div class="nrf-sec">
        <div class="nrf-sec-h">Historia laboral <span style="font-weight:600;text-transform:none;letter-spacing:0;color:var(--muted)">${traj.length} contrato${traj.length === 1 ? '' : 's'}${sm.ultima_empresa ? ` · última: ${esc(sm.ultima_empresa)}` : ''}</span></div>
        ${trajSec}
      </div>

      ${cargoSec}${bancoSec}${contactoSec}
      ${!m ? '<div class="nrf-sec"><div class="nrf-empty">Es un <b>egresado</b>: no está en el maestro activo, así que el sistema no conserva sus datos bancarios ni de contacto. Lo que sí guarda es su <b>historia laboral</b> (arriba).</div></div>' : ''}
    </div>`;

  if (f.thumb_url) {
    body.querySelector('.nrf-photo[data-zoom]')?.addEventListener('click', () =>
      openWorkerLightbox(f.thumb_url, `${name} · ${ced}`, `${f.id_number}.jpg`));
  }
}

/* ===== v5.75: LA CONFIGURACION VIVE EN SINCRONIZACION → CONFIGURAR =====
   Pablo (14/07): "prefiero que la sincronizacion y su programacion vivan
   en el Configurar de Sincronizar". Esta funcion monta la tarjeta de No
   reempleables dentro de esa pagina, en el placeholder #norehireCfgCard
   del template de viewSync (panel.js la llama desde navigate al entrar a
   'sync'). Usa las mismas clases que las otras tarjetas (card,
   cfg-card-head, cfg-desc, cfg-foot) para verse identica.

   Solo superadmin: viewSync ni pinta la pagina para otros roles, y esta
   funcion ademas corta por su cuenta (defensa doble; el endpoint gatea
   igual). */
export async function mountNoRehireConfigCard(user) {
  const host = document.getElementById('norehireCfgCard');
  if (!host) return;   // no-superadmin (viewSync no pinto el template) o vista vieja
  if (!(user && user.kind === 'admin' && user.role === 'superadmin')) return;

  host.innerHTML = '<div class="card"><p class="muted" style="margin:0">Cargando No reempleables…</p></div>';
  const r = await api(user, { action: 'get_config' }).catch(() => null);
  if (!document.getElementById('norehireCfgCard')) return;   // navego a otra vista
  const cfg = (r && r.ok && r.config) || {};

  const hh = String(cfg.daily_hour ?? 5).padStart(2, '0');
  const mm = String(cfg.daily_minute ?? 0).padStart(2, '0');

  const lastLine = () => cfg.last_run_at
    ? `Última corrida: ${fmtDateTime(cfg.last_run_at)} · ${cfg.last_status === 'ok'
        ? '<b style="color:#15803d">OK</b>'
        : `<b style="color:#b91c1c">${esc(cfg.last_status || 'error')}</b>`}${
        cfg.last_error ? `<div style="color:#b91c1c;font-size:12px;margin-top:3px">⚠ ${esc(String(cfg.last_error).slice(0, 140))}</div>` : ''}`
    : '<span class="muted">Sin corridas todavía.</span>';

  host.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3 style="margin:0;font-size:15px">No reempleables</h3>
        <div class="head-actions"><button class="btn" id="nrcLog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg> Registro</button><button class="btn" id="nrcRun"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Sincronizar ahora</button></div>
      </div>
      <p class="cfg-desc" style="margin:0 0 6px">Trae del sistema la lista de personas no aptas para recontratar y la compara con la del portal: registra altas, bajas y cambios de motivo u observaciones. Es la lista que <b>bloquea los ingresos</b> en el reporte de Ingreso. Con una corrida al día alcanza.</p>
      <div style="margin:0 0 12px;font-size:13px" id="nrcLast">${lastLine()}</div>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <label style="display:inline-flex;gap:8px;align-items:center;font-size:13px;cursor:pointer">
          <input type="checkbox" id="nrcOn" ${cfg.enabled === false ? '' : 'checked'}> Sincronización automática</label>
        <label style="display:inline-flex;gap:8px;align-items:center;font-size:13px">Todos los días a las
          <input type="time" id="nrcHora" value="${hh}:${mm}" style="font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:8px"></label>
      </div>
      <div class="cfg-foot"><span class="cfg-saved" id="nrcSaved" style="visibility:hidden">✓ Guardado</span><button class="btn btn-primary" id="nrcSave">Guardar programación</button></div>
    </div>`;

  document.getElementById('nrcSave')?.addEventListener('click', async () => {
    const btn = document.getElementById('nrcSave');
    const okSpan = document.getElementById('nrcSaved');
    const v = String(document.getElementById('nrcHora')?.value || '').split(':');
    const h = parseInt(v[0], 10), m = parseInt(v[1], 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    btn.disabled = true;
    const res = await api(user, {
      action: 'save_config', daily_hour: h, daily_minute: m,
      enabled: !!document.getElementById('nrcOn')?.checked,
    }).catch(e => ({ ok: false, error: String(e) }));
    btn.disabled = false;
    if (res && res.ok && okSpan) {
      okSpan.style.visibility = 'visible';
      setTimeout(() => { okSpan.style.visibility = 'hidden'; }, 2500);
    } else if (okSpan) {
      okSpan.style.visibility = 'visible';
      okSpan.textContent = '✗ ' + ((res && res.error) || 'No se pudo guardar.');
      setTimeout(() => { okSpan.style.visibility = 'hidden'; okSpan.textContent = '✓ Guardado'; }, 4000);
    }
  });

  // v5.83: el Registro, filtrado directo al proceso No reempleables. Vuelve
  // a Configurar con el boton ← Volver (backView 'sync').
  document.getElementById('nrcLog')?.addEventListener('click', () => {
    renderSyncLog(user, 'norehire', 'sync');
  });

  document.getElementById('nrcRun')?.addEventListener('click', async () => {
    const btn = document.getElementById('nrcRun');
    const last = document.getElementById('nrcLast');
    btn.disabled = true; btn.textContent = 'Sincronizando…';
    const res = await api(user, { action: 'sync', source: 'manual' }).catch(e => ({ ok: false, error: String(e) }));
    btn.disabled = false; btn.textContent = 'Sincronizar ahora';
    if (!last) return;
    if (res && res.ok) {
      const s = res.summary || {};
      last.innerHTML = `Última corrida: recién · <b style="color:#15803d">OK</b> · ${s.altas || 0} altas · ${s.bajas || 0} bajas · ${s.cambios || 0} cambios${res.warn ? `<div style="color:#b91c1c;font-size:12px;margin-top:3px">⚠ ${esc(res.warn)}</div>` : ''}`;
    } else {
      last.innerHTML = `<b style="color:#b91c1c">✗ ${esc((res && res.error) || 'No se pudo sincronizar.')}</b>`;
    }
  });
}
