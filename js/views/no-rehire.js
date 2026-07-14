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

/* Iniciales para el avatar sin foto. */
function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
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
  .nr-ava-ini{width:38px;height:38px;border-radius:50%;flex:none;display:inline-flex;align-items:center;
     justify-content:center;background:#eef2f7;color:#64748b;font-weight:800;font-size:13px;border:1px solid var(--border)}
  .nr-nm{font-weight:700}
  .nr-ced{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .nr-role{font-size:11px;color:var(--muted);margin-top:1px}
  .nr-pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:800;white-space:nowrap}
  .nr-pill.motivo{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .nr-pill.unk{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
  .nr-pill.vig{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .nr-pill.out{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
  .nr-pill.act{background:#dc2626;color:#fff;border:1px solid #dc2626}
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
  }`;
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
    ? `<img src="${esc(r.thumb_url)}" alt="" onerror="this.outerHTML='&lt;div class=&quot;noimg&quot;&gt;${esc(initials(r.full_name))}&lt;/div&gt;'">`
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
              <span class="nr-pill motivo">${esc(r.reason_label || '')}</span>
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
}

/* ---- fila ---- */
function rowHtml(r) {
  const ced = (r.ced_kind ? r.ced_kind + '-' : '') + (r.id_number || '');
  const ava = r.thumb_url
    ? `<img class="nr-ava" src="${esc(r.thumb_url)}" alt="" loading="lazy"
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
      <td><span class="nr-pill motivo">${esc(r.reason_label || '')}</span>
        ${r.reason_unknown ? '<span class="nr-pill unk" title="Este motivo no está en el catálogo del portal">sin traducir</span>' : ''}</td>
      <td><div class="nr-obs" title="${esc(r.notes || '')}">${esc(r.notes || '—')}</div></td>
      <td style="white-space:nowrap;color:var(--muted);font-size:12px">${fmtDate(r.detected_at)}</td>
      <td>${estado}</td>
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
      <div style="display:flex;gap:8px">
        <button class="btn" id="nrXlsx">Excel</button>
        <button class="btn" id="nrCsv">CSV</button>
        <button class="btn" id="nrTxt">TXT</button>
      </div>
    </div>
    <div id="nrBody"><div class="nr-loading">Cargando la lista…</div></div>
  `;

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
  const hh = cfg ? String(cfg.daily_hour ?? 5).padStart(2, '0') : '05';
  const mm = cfg ? String(cfg.daily_minute ?? 0).padStart(2, '0') : '00';
  const syncBar = `
    <div class="nr-sync">
      <span>Última sincronización: ${lastTxt}</span>
      ${cfg && cfg.last_error ? `<span class="st-err" title="${esc(cfg.last_error)}">⚠ ${esc(String(cfg.last_error).slice(0, 90))}</span>` : ''}
      ${isSuper ? `
        <span style="margin-left:auto;display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="chk" style="font-size:12.5px">Corrida diaria a las
            <input type="time" id="nrHora" value="${hh}:${mm}"></label>
          <button class="btn btn-sm" id="nrHoraSave">Guardar</button>
          <button class="btn btn-sm btn-primary" id="nrSyncNow">Sincronizar ahora</button>
        </span>
        <span class="msg" id="nrSyncMsg"></span>` : ''}
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
            <th>En la lista desde</th><th>Estado</th>
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
      if (row) openFicha(row);
    });

    $('#nrQ')?.addEventListener('input', applyFilters);
    $('#nrMot')?.addEventListener('change', applyFilters);
    $('#nrBajas')?.addEventListener('change', applyFilters);

    $('#nrXlsx')?.addEventListener('click', () => expXlsx(visibleRows(rows)));
    $('#nrCsv')?.addEventListener('click', () => expCsv(visibleRows(rows)));
    $('#nrTxt')?.addEventListener('click', () => expTxt(visibleRows(rows)));
  }

  /* ---- controles de superadmin ---- */
  if (isSuper) {
    const msg = () => $('#nrSyncMsg');

    $('#nrSyncNow')?.addEventListener('click', async () => {
      const btn = $('#nrSyncNow');
      btn.disabled = true; btn.textContent = 'Sincronizando…';
      const res = await api(user, { action: 'sync', source: 'manual' }).catch(e => ({ ok: false, error: String(e) }));
      if (res && res.ok) {
        const s = res.summary || {};
        if (msg()) msg().innerHTML = `<span class="st-ok">Listo:</span> ${s.altas || 0} altas · ${s.bajas || 0} bajas · ${s.cambios || 0} cambios${res.warn ? ` · <span class="st-err">${esc(res.warn)}</span>` : ''}`;
        // Recargar la vista para que la tabla refleje la corrida.
        setTimeout(() => renderNoRehire(user), 900);
      } else {
        btn.disabled = false; btn.textContent = 'Sincronizar ahora';
        if (msg()) msg().innerHTML = `<span class="st-err">✗ ${esc((res && res.error) || 'No se pudo sincronizar.')}</span>`;
      }
    });

    $('#nrHoraSave')?.addEventListener('click', async () => {
      const v = String($('#nrHora')?.value || '').split(':');
      const h = parseInt(v[0], 10), m = parseInt(v[1], 10);
      if (!Number.isFinite(h) || !Number.isFinite(m)) {
        if (msg()) msg().innerHTML = '<span class="st-err">Hora inválida.</span>';
        return;
      }
      const res = await api(user, { action: 'save_config', daily_hour: h, daily_minute: m })
        .catch(e => ({ ok: false, error: String(e) }));
      if (msg()) {
        msg().innerHTML = (res && res.ok)
          ? '<span class="st-ok">✓ Hora guardada.</span>'
          : `<span class="st-err">✗ ${esc((res && res.error) || 'No se pudo guardar.')}</span>`;
      }
    });
  }
}
