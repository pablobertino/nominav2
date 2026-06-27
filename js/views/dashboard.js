/* =====================================================================
   js/views/dashboard.js  →  vista "Inicio" (landing post-login)

   Dos caras segun el rol:
   - company (tienda/empresa): identificacion + accesos rapidos + stats
     (sexo/edades/estado civil) + cumpleanos (hoy + proximos). Se arma en el
     cliente con /api/worker-photo (directory).
   - admin/superadmin/editor: saludo + KPIs (empresas/empleados/zonas/
     subzonas) + personal por tipo de empresa + empresas por tipo +
     cumpleaneros del alcance, con su empresa/zona/subzona para ubicarlos.
     Datos de /api/dashboard.

   Estetica alineada a la vista Empresas: liviana, poca negrita.
   Exporta renderDashboard(user) que pinta dentro de #pnlMain.
   ===================================================================== */

import { $ } from '../core/dom.js';

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function ageFrom(ymd) {
  if (!ymd) return null;
  const t = new Date(), b = new Date(ymd);
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a;
}
/* Hoy en hora de Caracas, como {y,m,d}. */
function caracasToday() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => +(p.find(x => x.type === t) || {}).value;
  return { y: g('year'), m: g('month'), d: g('day') };
}
/* Dias hasta el proximo cumpleanos (0 = hoy). null si falta o es 29-feb. */
function daysUntilBd(ymd) {
  if (!ymd) return null;
  const mm = +String(ymd).slice(5, 7), dd = +String(ymd).slice(8, 10);
  if (!mm || !dd || (mm === 2 && dd === 29)) return null;
  const t = caracasToday();
  const today = Date.UTC(t.y, t.m - 1, t.d);
  let next = Date.UTC(t.y, mm - 1, dd);
  if (next < today) next = Date.UTC(t.y + 1, mm - 1, dd);
  return Math.round((next - today) / 86400000);
}
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function bdDateLabel(ymd) {
  const mm = +String(ymd).slice(5, 7), dd = +String(ymd).slice(8, 10);
  return `${dd} ${MES[mm - 1] || ''}`;
}
function inDaysLabel(n) { return n === 1 ? 'mañana' : `en ${n} días`; }

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const AVATAR_BG = ['#dbeafe', '#fae8ff', '#dcfce7', '#fef9c3', '#fee2e2', '#e0e7ff', '#ccfbf1', '#ffedd5'];
const AVATAR_FG = ['#1e40af', '#86198f', '#166534', '#854d0e', '#991b1b', '#3730a3', '#0f766e', '#9a3412'];
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AVATAR_BG.length;
}
/* Color por tipo de empresa (consistente con el resto del portal). */
const TYPE_COLORS = {
  'Tienda': '#2563eb', 'Importadora': '#9333ea', 'Externa': '#0d9488',
  'Administrativa': '#d97706', 'Servicio': '#dc2626', 'Tienda en línea': '#db2777',
};
function typeColor(t) { return TYPE_COLORS[t] || '#64748b'; }

/* Salta a otra seccion del menu reutilizando el wiring del sidebar. */
function clickNav(view) {
  const b = document.querySelector(`#pnlNav button[data-view="${view}"]`);
  if (b) b.click();
}

/* ---------- estilos (una vez) ---------- */
function ensureStyles() {
  if (document.getElementById('dashStyles')) return;
  const st = document.createElement('style');
  st.id = 'dashStyles';
  st.textContent = `
  .dash-greet h1 { margin:0; font-size:21px; font-weight:700; color:var(--ink); }
  .dash-greet p { margin:3px 0 0; color:var(--muted); font-size:13px; }

  /* KPIs (estilo Empresas: etiqueta arriba, numero, subtexto) */
  .dash-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:16px 0 6px; }
  .dash-kpi { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:15px 17px; box-shadow:var(--shadow-sm); }
  .dash-kpi .l { font-size:12px; color:var(--muted); margin-bottom:7px; }
  .dash-kpi .n { font-size:27px; font-weight:700; color:var(--ink); line-height:1; }
  .dash-kpi .sub { font-size:11px; color:var(--faint); margin-top:6px; }
  @media (max-width:760px){ .dash-kpis { grid-template-columns:repeat(2,1fr); } }

  .dash-sec { margin:22px 0 10px; font-size:14px; font-weight:600; color:var(--ink); }
  .dash-sec small { font-weight:400; color:var(--muted); font-size:12px; margin-left:6px; }

  /* Personal por tipo (barras) */
  .dash-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:16px 18px; box-shadow:var(--shadow-sm); }
  .dash-bars { display:flex; flex-direction:column; gap:10px; }
  .dash-brow { display:grid; grid-template-columns:118px 1fr 56px; align-items:center; gap:10px; }
  .dash-bl { font-size:12.5px; color:var(--ink-soft); text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dash-bt { height:13px; border-radius:7px; background:var(--border-soft); overflow:hidden; }
  .dash-bt i { display:block; height:100%; border-radius:7px; opacity:.9; }
  .dash-bn { font-size:12.5px; font-weight:600; color:var(--ink); text-align:right; }

  /* Empresas por tipo (mini cards) */
  .dash-types { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
  .dash-tc { border:1px solid var(--border); border-left-width:3px; border-radius:var(--radius-md);
    padding:11px 13px; background:var(--surface); }
  .dash-tc .n { font-size:19px; font-weight:700; color:var(--ink); }
  .dash-tc .l { font-size:11.5px; color:var(--muted); margin-top:2px; }

  /* Identificacion (empresa) */
  .dash-idcard { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:18px 20px; box-shadow:var(--shadow-sm); }
  .dash-idcode { display:inline-block; font-family:ui-monospace,Menlo,monospace; font-weight:600; font-size:13px;
    color:var(--brand); background:var(--brand-bg); border-radius:6px; padding:2px 9px; }
  .dash-idname { margin:9px 0 15px; font-size:19px; font-weight:700; color:var(--ink); }
  .dash-idgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:13px 18px; }
  .dash-idgrid > div { display:flex; flex-direction:column; gap:3px; }
  .dash-idlbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  .dash-idval { font-size:13.5px; color:var(--ink); }
  @media (max-width:680px){ .dash-idgrid { grid-template-columns:repeat(2,1fr); } }

  /* Accesos rapidos */
  .dash-quick { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:12px; }
  .dash-qbtn { display:flex; align-items:center; gap:12px; text-align:left; cursor:pointer;
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:14px 16px; box-shadow:var(--shadow-sm); transition:border-color .12s, box-shadow .12s; font:inherit; }
  .dash-qbtn:hover { border-color:var(--brand); box-shadow:var(--shadow-md); }
  .dash-qic { width:38px; height:38px; flex:0 0 auto; border-radius:10px; display:flex; align-items:center;
    justify-content:center; font-size:18px; }
  .dash-qtext { display:flex; flex-direction:column; min-width:0; }
  .dash-qt { font-size:14px; font-weight:600; color:var(--ink); }
  .dash-qd { font-size:11.5px; color:var(--muted); margin-top:2px; }
  @media (max-width:680px){ .dash-quick { grid-template-columns:1fr; } }

  /* Demografia (sexo/edades/civil) */
  .dash-demo { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .dash-dcard { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:15px 17px; box-shadow:var(--shadow-sm); }
  .dash-dhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:11px; }
  .dash-dhead .t { font-size:13px; font-weight:600; color:var(--ink); }
  .dash-dhead .n { font-size:11px; color:var(--muted); }
  .dash-sexbar { display:flex; height:13px; border-radius:7px; overflow:hidden; background:var(--border-soft); }
  .dash-sexbar i { display:block; height:100%; opacity:.9; }
  .dash-sexleg { display:flex; justify-content:space-between; margin-top:9px; }
  .dash-sexleg .lab { font-weight:600; font-size:11px; padding:1px 6px; border-radius:5px; }
  .dash-sexleg .lab.m { color:#1e40af; background:#dbeafe; } .dash-sexleg .lab.f { color:#9d174d; background:#fce7f3; }
  .dash-sexleg .pct { font-weight:700; margin:0 4px; } .dash-sexleg .cnt { color:var(--muted); font-size:11px; }
  .dash-dbar { display:grid; grid-template-columns:46px 1fr 24px; align-items:center; gap:8px; margin:5px 0; }
  .dash-dbl { font-size:11px; color:var(--muted); text-align:right; }
  .dash-dbt { height:9px; border-radius:5px; background:var(--border-soft); overflow:hidden; }
  .dash-dbt i { display:block; height:100%; border-radius:5px; opacity:.9; }
  .dash-dbn { font-size:11px; font-weight:600; text-align:right; color:var(--ink); }
  .dash-dempty { font-size:11.5px; color:var(--faint); font-style:italic; text-align:center; padding:10px; }
  @media (max-width:760px){ .dash-demo { grid-template-columns:1fr; } }

  /* Cumpleanos — tarjetas limpias (estilo Personal, sin sobrecarga) */
  .dash-bdays { display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr)); gap:12px; }
  .dash-bcard { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:14px 12px 13px; text-align:center; box-shadow:var(--shadow-sm); }
  .dash-btoday { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:600;
    color:#b45309; background:#fef3c7; border-radius:999px; padding:2px 9px; margin-bottom:11px; }
  .dash-bava { width:62px; height:62px; border-radius:50%; margin:0 auto 10px; overflow:hidden; position:relative;
    box-shadow:0 0 0 2px #fcd34d; }
  .dash-bava img { width:100%; height:100%; object-fit:cover; display:block; }
  .dash-bava .ini { width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:21px; font-weight:700; }
  .dash-bname { font-size:13px; font-weight:600; color:var(--ink); line-height:1.25; }
  .dash-bcargo { font-size:11px; color:var(--muted); margin-top:3px; }
  .dash-bcomp { font-size:11.5px; color:var(--ink-soft); margin-top:6px; line-height:1.3; }
  .dash-bloc { font-size:10.5px; color:var(--muted); margin-top:1px; line-height:1.3; }
  .dash-bage { display:inline-block; margin-top:9px; font-size:11px; font-weight:600; color:#b45309; }

  /* Proximos (lista) */
  .dash-up { display:flex; flex-direction:column; background:var(--surface);
    border:1px solid var(--border); border-radius:var(--radius-lg); overflow:hidden; box-shadow:var(--shadow-sm); }
  .dash-urow { display:flex; align-items:center; gap:11px; padding:10px 14px; border-top:1px solid var(--border-soft); }
  .dash-urow:first-child { border-top:none; }
  .dash-uava { width:34px; height:34px; flex:0 0 auto; border-radius:50%; display:flex; align-items:center;
    justify-content:center; font-size:12px; font-weight:700; }
  .dash-umain { flex:1; min-width:0; }
  .dash-uname { font-size:13px; color:var(--ink); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dash-usub { font-size:11px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:1px; }
  .dash-uwhen { font-size:11.5px; color:var(--ink-soft); text-align:right; white-space:nowrap; }
  .dash-uwhen b { color:var(--brand); font-weight:600; }
  .dash-empty { background:var(--surface); border:1px dashed var(--border); border-radius:var(--radius-lg);
    padding:18px; text-align:center; color:var(--muted); font-size:13px; }

  /* Demografia admin (2 columnas) y movimientos recientes (ingresos/egresos) */
  .dash-demo2 { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
  .dash-mov2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .dash-movh { font-size:12.5px; font-weight:600; color:var(--ink-soft); margin:0 2px 8px;
    display:flex; align-items:center; gap:6px; }
  @media (max-width:760px){ .dash-demo2, .dash-mov2 { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(st);
}

/* ---------- markup de cumpleanos ---------- */
function bcardHtml(p, showCompany) {
  const ci = avatarColor(p.id_number);
  const ava = p.thumb_url
    ? `<img src="${p.thumb_url}" alt="${esc(p.full_name)}">`
    : `<div class="ini" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(p.full_name))}</div>`;
  const age = ageFrom(p.birth_date);
  const loc = [p.zone, p.subzone, p.concept].filter(Boolean).join(' · ');
  return `<div class="dash-bcard">
    <span class="dash-btoday">🎂 Cumple hoy</span>
    <div class="dash-bava">${ava}</div>
    <div class="dash-bname">${esc(p.full_name)}</div>
    ${p.role ? `<div class="dash-bcargo">${esc(p.role)}</div>` : ''}
    ${showCompany && p.company_name ? `<div class="dash-bcomp">${esc(p.company_name)}</div>` : ''}
    ${showCompany && loc ? `<div class="dash-bloc">${esc(loc)}</div>` : ''}
    ${age != null ? `<span class="dash-bage">cumple ${age}</span>` : ''}
  </div>`;
}
function urowHtml(p, showCompany) {
  const ci = avatarColor(p.id_number);
  const du = p.days_until != null ? p.days_until : daysUntilBd(p.birth_date);
  const sub = showCompany
    ? [p.role, p.company_name].filter(Boolean).join(' · ')
    : (p.role || '');
  return `<div class="dash-urow">
    <div class="dash-uava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(p.full_name))}</div>
    <div class="dash-umain">
      <div class="dash-uname">${esc(p.full_name)}</div>
      ${sub ? `<div class="dash-usub">${esc(sub)}</div>` : ''}
    </div>
    <div class="dash-uwhen">${bdDateLabel(p.birth_date)} · <b>${inDaysLabel(du)}</b></div>
  </div>`;
}
function bdaysSectionHtml(today, upcoming, showCompany) {
  let html = '';
  if (today.length) {
    html += `<div class="dash-bdays">${today.map(p => bcardHtml(p, showCompany)).join('')}</div>`;
  } else {
    html += `<div class="dash-empty">Nadie cumple años hoy.</div>`;
  }
  if (upcoming.length) {
    html += `<div class="dash-sec" style="font-size:13px;margin:16px 0 8px;color:var(--muted);font-weight:500">Próximos cumpleaños</div>`;
    html += `<div class="dash-up">${upcoming.map(p => urowHtml(p, showCompany)).join('')}</div>`;
  }
  return html;
}

/* ---------- markup demografia (admin: desde agregados de /api/dashboard) ---------- */
function sexCardHtml(sex) {
  const m = (sex && sex.m) || 0, f = (sex && sex.f) || 0, t = (sex && sex.total) || 0;
  const mp = t ? Math.round(m / t * 100) : 0, fp = t ? 100 - mp : 0;
  const body = t
    ? `<div class="dash-sexbar"><i style="width:${mp}%;background:#2563eb"></i><i style="width:${fp}%;background:#ec4899"></i></div>
       <div class="dash-sexleg"><span><span class="lab m">M</span><b class="pct">${mp}%</b><span class="cnt">${m}</span></span>
       <span><span class="lab f">F</span><b class="pct">${fp}%</b><span class="cnt">${f}</span></span></div>`
    : '<div class="dash-dempty">Sin datos de sexo</div>';
  return `<div class="dash-dcard"><div class="dash-dhead"><span class="t">Sexo</span><span class="n">${t} con dato</span></div>${body}</div>`;
}
function agesCardHtml(ages) {
  const a = ages || {}; const buckets = a.buckets || [];
  const maxA = Math.max(1, ...buckets.map(b => b.n || 0));
  const body = a.count
    ? buckets.map(b => `<div class="dash-dbar"><span class="dash-dbl">${esc(b.label)}</span><div class="dash-dbt"><i style="width:${Math.round((b.n || 0) / maxA * 100)}%;background:#4f46e5"></i></div><span class="dash-dbn">${b.n || 0}</span></div>`).join('')
    : '<div class="dash-dempty">Sin fechas de nacimiento</div>';
  const head = `${a.count || 0} con fecha${a.avg != null ? ` · prom ${a.avg}` : ''}`;
  return `<div class="dash-dcard"><div class="dash-dhead"><span class="t">Edades</span><span class="n">${head}</span></div>${body}</div>`;
}
/* Barras de edad PROMEDIO por tipo de empresa (numero = promedio, entre parentesis el n). */
function ageByTypeBarsHtml(ages) {
  const byType = (ages && ages.by_type) || [];
  if (!byType.length) return '<div class="dash-dempty">Sin fechas de nacimiento.</div>';
  const maxAvg = Math.max(1, ...byType.map(t => Number(t.avg) || 0));
  return byType.map(t => `<div class="dash-brow">
    <span class="dash-bl">${esc(t.tipo)} <span style="color:var(--faint)">(${Number(t.n || 0).toLocaleString('es-VE')})</span></span>
    <div class="dash-bt"><i style="width:${Math.round((Number(t.avg) || 0) / maxAvg * 100)}%;background:${typeColor(t.tipo)}"></i></div>
    <span class="dash-bn">${t.avg}</span></div>`).join('');
}

/* ---------- markup movimientos recientes (ingresos / egresos) ---------- */
/* Dias transcurridos desde una fecha YMD hasta hoy (Caracas). */
function daysAgoFrom(ymd) {
  if (!ymd) return null;
  const t = caracasToday();
  const today = Date.UTC(t.y, t.m - 1, t.d);
  const d = new Date(ymd);
  if (isNaN(d)) return null;
  const that = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((today - that) / 86400000);
}
function agoLabel(n) {
  if (n == null) return '';
  if (n <= 0) return 'hoy';
  if (n === 1) return 'ayer';
  if (n < 30) return `hace ${n} días`;
  const m = Math.round(n / 30);
  return m <= 1 ? 'hace 1 mes' : `hace ${m} meses`;
}
function ymdShort(ymd) {
  if (!ymd) return '';
  const mm = +String(ymd).slice(5, 7), dd = +String(ymd).slice(8, 10);
  return `${dd} ${MES[mm - 1] || ''}`;
}
function movRowHtml(p) {
  const ci = avatarColor(p.id_number);
  const loc = [p.zone, p.subzone].filter(Boolean).join(' · ');
  const sub = [p.role, p.company_name].filter(Boolean).join(' · ');
  const ago = agoLabel(daysAgoFrom(p.mov_date));
  return `<div class="dash-urow">
    <div class="dash-uava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(p.full_name))}</div>
    <div class="dash-umain">
      <div class="dash-uname">${esc(p.full_name)}</div>
      ${sub || loc ? `<div class="dash-usub">${esc([sub, loc].filter(Boolean).join(' — '))}</div>` : ''}
    </div>
    <div class="dash-uwhen">${ymdShort(p.mov_date)} · <b>${ago}</b></div>
  </div>`;
}
function movListHtml(rows, emptyMsg) {
  if (!rows || !rows.length) return `<div class="dash-empty">${emptyMsg}</div>`;
  return `<div class="dash-up">${rows.map(movRowHtml).join('')}</div>`;
}

/* ===================== ENTRADA ===================== */
export async function renderDashboard(user) {
  ensureStyles();
  if (user && user.kind === 'company') return renderCompanyDash(user);
  return renderAdminDash(user);
}

/* ===================== DASHBOARD EMPRESA / TIENDA ===================== */
async function renderCompanyDash(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  let d;
  try {
    d = await fetch('/api/worker-photo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'directory', company_code: user.companyCode, user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null } }),
    }).then(r => r.json());
  } catch (e) { d = { ok: false, error: String(e.message || e) }; }

  if (!d || !d.ok) {
    $('#pnlMain').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar el inicio: ${esc((d && d.error) || 'error')}</p></div>`;
    return;
  }
  const c = d.company || { code: user.companyCode };
  const workers = (d.workers || []).filter(w => !w.end_date);   // activos
  const withBd = workers.filter(w => w.birth_date);
  const today = withBd.filter(w => daysUntilBd(w.birth_date) === 0);
  const upcoming = withBd
    .map(w => ({ ...w, days_until: daysUntilBd(w.birth_date) }))
    .filter(w => w.days_until != null && w.days_until > 0)
    .sort((a, b) => a.days_until - b.days_until)
    .slice(0, 6);

  const statusPill = /abier/i.test(c.status || '')
    ? '<span class="pill pill-open">Abierta</span>'
    : (c.status ? `<span class="pill pill-gray">${esc(c.status)}</span>` : '—');

  $('#pnlMain').innerHTML = `
    <div class="dash-greet"><h1>Inicio</h1><p>Resumen de tu empresa</p></div>

    <div class="dash-idcard" style="margin-top:14px">
      <span class="dash-idcode">${esc(c.code || '')}</span>
      <div class="dash-idname">${esc(c.business_name || '')}</div>
      <div class="dash-idgrid">
        <div><span class="dash-idlbl">Concepto</span><span class="dash-idval">${esc(c.concept || '—')}</span></div>
        <div><span class="dash-idlbl">Zona</span><span class="dash-idval">${esc(c.zone || '—')}</span></div>
        <div><span class="dash-idlbl">Subzona</span><span class="dash-idval">${esc(c.subzone || '—')}</span></div>
        <div><span class="dash-idlbl">RIF</span><span class="dash-idval">${esc(c.tax_id || '—')}</span></div>
        <div><span class="dash-idlbl">Estado</span><span class="dash-idval">${statusPill}</span></div>
        <div><span class="dash-idlbl">Personal</span><span class="dash-idval">${workers.length} colaboradores</span></div>
      </div>
    </div>

    <div class="dash-quick">
      <button class="dash-qbtn" data-go="reportar"><span class="dash-qic" style="background:#eff6ff;color:#2563eb">📝</span><span class="dash-qtext"><span class="dash-qt">Reportar a Nómina</span><span class="dash-qd">Marcaje, ausencia, ingreso…</span></span></button>
      <button class="dash-qbtn" data-go="fotos"><span class="dash-qic" style="background:#f5f3ff;color:#7c3aed">👥</span><span class="dash-qtext"><span class="dash-qt">Personal</span><span class="dash-qd">Fichas y fotos del equipo</span></span></button>
      <button class="dash-qbtn" data-go="documentos"><span class="dash-qic" style="background:#ecfdf5;color:#059669">📁</span><span class="dash-qtext"><span class="dash-qt">Documentos</span><span class="dash-qd">Recaudos y archivos</span></span></button>
    </div>

    <div class="dash-sec">Personal de la empresa</div>
    <div id="dashDemo"></div>

    <div class="dash-sec">Cumpleaños 🎂</div>
    <div id="dashBdays"></div>`;

  $('#pnlMain').querySelectorAll('[data-go]').forEach(b =>
    b.addEventListener('click', () => {
      const go = b.dataset.go;
      clickNav(go === 'reportar' ? 'miempresa' : go);
    }));

  $('#dashDemo').innerHTML = demoHtml(workers);
  $('#dashBdays').innerHTML = bdaysSectionHtml(today, upcoming, false);
}

/* ===================== DASHBOARD ADMIN ===================== */
async function renderAdminDash(user) {
  $('#pnlMain').innerHTML = `<div class="pnl-loading">Cargando…</div>`;
  let d;
  try {
    d = await fetch('/api/dashboard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { kind: user.kind, id: user.id || null }, days: 30 }),
    }).then(r => r.json());
  } catch (e) { d = { ok: false, error: String(e.message || e) }; }

  if (!d || !d.ok) {
    $('#pnlMain').innerHTML = `<div class="card"><p class="muted" style="margin:0">No se pudo cargar el inicio: ${esc((d && d.error) || 'error')}</p></div>`;
    return;
  }
  const s = d.summary || {};
  const fmt = n => (n == null ? '0' : Number(n).toLocaleString('es-VE'));
  const name = user.name || user.username || 'admin';
  const scopeNote = d.scope === 'scoped' ? 'Tu alcance' : 'Todo el grupo';

  // Subtextos de los KPIs (tiendas vs otras), como en la vista Empresas.
  const pbt = (s.personal_by_type || []);
  const cbt = (s.companies_by_type || []);
  const find = (arr, t, k) => { const x = arr.find(o => o.tipo === t); return x ? x[k] : 0; };
  const empTotal = s.empresas || 0, tiendasN = find(cbt, 'Tienda', 'n'), otrasN = empTotal - tiendasN;
  const persTotal = s.empleados || 0, persTienda = find(pbt, 'Tienda', 'personal'), persOtras = persTotal - persTienda;

  const kpis = [
    ['Empresas', fmt(s.empresas), `${fmt(tiendasN)} tiendas · ${fmt(otrasN)} otras`],
    ['Empleados', fmt(s.empleados), `${fmt(persTienda)} en tiendas · ${fmt(persOtras)} en otras`],
    ['Zonas', fmt(s.zonas), 'con empresas'],
    ['Subzonas', fmt(s.subzonas), 'con empresas'],
  ].map(([l, n, sub]) => `<div class="dash-kpi"><div class="l">${l}</div><div class="n">${n}</div><div class="sub">${sub}</div></div>`).join('');

  // Personal por tipo (barras)
  const pbtPos = pbt.filter(x => x.personal > 0);
  const maxP = Math.max(1, ...pbtPos.map(x => x.personal));
  const barsHtml = pbtPos.length
    ? pbtPos.map(x => `<div class="dash-brow">
        <span class="dash-bl">${esc(x.tipo)}</span>
        <div class="dash-bt"><i style="width:${Math.round(x.personal / maxP * 100)}%;background:${typeColor(x.tipo)}"></i></div>
        <span class="dash-bn">${fmt(x.personal)}</span></div>`).join('')
    : '<div class="dash-dempty">Sin personal cargado.</div>';

  // Empresas por tipo (mini cards)
  const typesHtml = cbt.map(x =>
    `<div class="dash-tc" style="border-left-color:${typeColor(x.tipo)}"><div class="n">${fmt(x.n)}</div><div class="l">${esc(x.tipo)}</div></div>`).join('');

  // Demografia (sexo + edades) y edad promedio por tipo de empresa.
  const sexCard = sexCardHtml(s.sex);
  const edadesCard = agesCardHtml(s.ages);
  const ageTypeBars = ageByTypeBarsHtml(s.ages);
  const agAvg = (s.ages && s.ages.avg != null) ? `${s.ages.avg}` : '—';
  const agCount = fmt((s.ages && s.ages.count) || 0);

  // Movimientos recientes (ingresos / egresos) del alcance.
  const mov = d.movimientos || { ingresos: [], egresos: [] };
  const ingList = movListHtml(mov.ingresos, 'Sin ingresos recientes.');
  const egrList = movListHtml(mov.egresos, 'Sin egresos recientes.');

  $('#pnlMain').innerHTML = `
    <div class="dash-greet"><h1>Hola, ${esc(name)} 👋</h1><p>${scopeNote} · resumen de hoy</p></div>

    <div class="dash-kpis">${kpis}</div>

    <div class="dash-sec">Personal por tipo de empresa</div>
    <div class="dash-card"><div class="dash-bars">${barsHtml}</div></div>

    <div class="dash-sec">Empresas por tipo <small>${fmt(s.empresas)} en total</small></div>
    <div class="dash-types">${typesHtml}</div>

    <div class="dash-sec">Demografía del personal <small>${scopeNote}</small></div>
    <div class="dash-demo2">${sexCard}${edadesCard}</div>

    <div class="dash-sec">Edad promedio por tipo de empresa <small>prom. general ${agAvg} años · ${agCount} con fecha</small></div>
    <div class="dash-card"><div class="dash-bars">${ageTypeBars}</div></div>

    <div class="dash-sec">Movimientos recientes <small>${scopeNote}</small></div>
    <div class="dash-mov2">
      <div><div class="dash-movh">➕ Últimos ingresos</div>${ingList}</div>
      <div><div class="dash-movh">🔴 Últimos egresos</div>${egrList}</div>
    </div>

    <div class="dash-sec">Cumpleaños 🎂 <small>${scopeNote}</small></div>
    <div id="dashBdays"></div>`;

  $('#dashBdays').innerHTML = bdaysSectionHtml(d.today || [], (d.upcoming || []).slice(0, 12), true);
}

/* ===================== demografia (sexo / edades / estado civil) ===================== */
function demoHtml(workers) {
  if (!workers || !workers.length) return '<div class="dash-empty">Sin personal cargado.</div>';
  const m = workers.filter(w => w.gender === 'M').length;
  const f = workers.filter(w => w.gender === 'F').length;
  const sexTot = m + f;
  const mp = sexTot ? Math.round(m / sexTot * 100) : 0, fp = sexTot ? 100 - mp : 0;
  const sexBody = sexTot
    ? `<div class="dash-sexbar"><i style="width:${mp}%;background:#2563eb"></i><i style="width:${fp}%;background:#ec4899"></i></div>
       <div class="dash-sexleg"><span><span class="lab m">M</span><b class="pct">${mp}%</b><span class="cnt">${m}</span></span>
       <span><span class="lab f">F</span><b class="pct">${fp}%</b><span class="cnt">${f}</span></span></div>`
    : '<div class="dash-dempty">Sin datos de sexo</div>';

  const ages = workers.map(w => ageFrom(w.birth_date)).filter(a => a != null && a >= 15 && a <= 75);
  const buckets = [['< 20', a => a < 20], ['20–24', a => a >= 20 && a <= 24], ['25–29', a => a >= 25 && a <= 29],
  ['30–34', a => a >= 30 && a <= 34], ['35–44', a => a >= 35 && a <= 44], ['45+', a => a >= 45]]
    .map(([l, fn]) => [l, ages.filter(fn).length]);
  const maxA = Math.max(1, ...buckets.map(b => b[1]));
  const ageBody = ages.length
    ? buckets.map(([l, v]) => `<div class="dash-dbar"><span class="dash-dbl">${l}</span><div class="dash-dbt"><i style="width:${Math.round(v / maxA * 100)}%;background:#4f46e5"></i></div><span class="dash-dbn">${v}</span></div>`).join('')
    : '<div class="dash-dempty">Sin fechas de nacimiento</div>';

  const civDefs = [['Soltero', 'S'], ['Casado', 'C'], ['Divorc.', 'D'], ['Viudo', 'V']];
  const civB = civDefs.map(([l, code]) => [l, workers.filter(w => w.marital_status === code).length]);
  const civTot = civB.reduce((a, x) => a + x[1], 0);
  const maxC = Math.max(1, ...civB.map(b => b[1]));
  const civBody = civTot
    ? civB.map(([l, v]) => `<div class="dash-dbar"><span class="dash-dbl">${l}</span><div class="dash-dbt"><i style="width:${Math.round(v / maxC * 100)}%;background:#0d9488"></i></div><span class="dash-dbn">${v}</span></div>`).join('')
    : '<div class="dash-dempty">Sin estado civil</div>';

  return `<div class="dash-demo">
    <div class="dash-dcard"><div class="dash-dhead"><span class="t">Sexo</span><span class="n">${sexTot} con dato</span></div>${sexBody}</div>
    <div class="dash-dcard"><div class="dash-dhead"><span class="t">Edades</span><span class="n">${ages.length} con fecha${ages.length ? ` · prom ${(ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1)}` : ''}</span></div>${ageBody}</div>
    <div class="dash-dcard"><div class="dash-dhead"><span class="t">Estado civil</span><span class="n">${civTot} con dato</span></div>${civBody}</div>
  </div>`;
}
