/* =====================================================================
   views/no-rehire-verify.js — Verificar candidato (v5.79)
   Consulta rapida: ¿esta persona puede ser contratada en el grupo?

   Mockup aprobado: _PRUEBAS\norehire_verificar_mockup.html (v2, 14/07).

   PARA QUIEN ES: tiendas y roles operativos. La tienda tiene un candidato
   enfrente y quiere saber si puede ofrecerle el puesto ANTES de abrir un
   reporte de Ingreso. Gate: view.norehirecheck (permiso propio, separado
   de view.norehire).

   LO QUE NUNCA MUESTRA: el motivo ni las observaciones. Solo identidad
   (nombre oficial, cedula, foto si existe) y si puede o no ser contratada.
   El endpoint (action 'verify') tampoco los manda: ni inspeccionando la
   respuesta se ven.

   Los 4 estados (del mockup):
   1. Cedula LIBRE      -> tarjeta verde, SIN mencionar la lista.
   2. Cedula BLOQUEADA  -> tarjeta compacta con fondo rojo (foto, nombre,
                           cedula, pill NO REEMPLEABLE).
   3. Nombre con coincidencias -> mismas tarjetas rojas compactas, con la
                           nota de que la cedula es la verificacion real.
   4. Nombre sin coincidencias -> neutro, con la advertencia de que el
                           nombre puede variar.
   ===================================================================== */
import { $ } from '../core/dom.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

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
  /* OJO: sin escapes octales en este template literal (leccion de v5.13). */
  css.textContent = `
  .nv-head h2{margin:0;font-size:20px;font-weight:700}
  .nv-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .nv-box{background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;
     padding:20px 22px;margin-top:16px;max-width:760px}
  .nv-box label{font-size:12.5px;font-weight:700;display:block;margin-bottom:7px}
  .nv-row{display:flex;gap:10px}
  .nv-row input{flex:1;font:inherit;font-size:15px;padding:12px 15px;
     border:1.5px solid var(--border);border-radius:11px;background:var(--surface,#fff);color:var(--ink);min-width:0}
  .nv-row button{font:inherit;font-size:14px;font-weight:700;padding:12px 22px;border-radius:11px;
     border:none;background:var(--brand,#2563eb);color:#fff;cursor:pointer;flex:none}
  .nv-row button:disabled{opacity:.6;cursor:wait}
  .nv-hint{font-size:11.5px;color:var(--muted);margin-top:8px;line-height:1.5}
  .nv-out{max-width:760px}
  .nv-err{margin-top:14px;background:#fff7ed;border:1px solid #fed7aa;color:#92400e;
     border-radius:12px;padding:13px 16px;font-size:12.5px}
  /* libre (verde, sin mencionar la lista) */
  .nv-ok{margin-top:14px;background:#f0fdf4;border:1.5px solid #86efac;border-radius:14px;
     padding:16px 20px;display:flex;gap:14px;align-items:center}
  .nv-ok .ico{width:44px;height:44px;border-radius:50%;background:#dcfce7;border:1.5px solid #86efac;
     display:flex;align-items:center;justify-content:center;font-size:21px;flex:none;color:#15803d;font-weight:800}
  .nv-ok .tt{font-size:15px;font-weight:800;color:#15803d}
  .nv-ok .ms{font-size:12.5px;color:#166534;margin-top:2px}
  .nv-cedchip{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px;
     background:#fff;border:1px solid var(--border);border-radius:8px;padding:2px 9px}
  /* tarjeta compacta bloqueada (fondo rojo) — la misma para cedula y nombre */
  .nv-hit{margin-top:10px;background:#fef2f2;border:1.5px solid #fca5a5;border-left:4px solid #ef4444;
     border-radius:12px;padding:13px 16px;display:flex;gap:12px;align-items:center}
  .nv-hit img,.nv-hit .noimg{width:44px;height:44px;border-radius:50%;object-fit:cover;
     border:1px solid #fca5a5;flex:none}
  .nv-hit .noimg{display:flex;align-items:center;justify-content:center;background:#fee2e2;
     color:#991b1b;font-weight:800;font-size:14px}
  .nv-hit .nm{font-weight:800;font-size:14px;color:#7f1d1d}
  .nv-hit .cd{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#991b1b}
  .nv-hit .sub2{font-size:11.5px;color:#b91c1c;margin-top:2px;line-height:1.45}
  .nv-hit .pill{margin-left:auto;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;
     border-radius:999px;padding:3px 11px;font-size:10.5px;font-weight:800;white-space:nowrap;flex:none}
  .nv-mtitle{font-size:12.5px;color:var(--muted);margin:14px 0 0}
  /* nombre sin coincidencias */
  .nv-none{margin-top:14px;background:var(--card,#fff);border:1px solid var(--border);border-radius:14px;
     padding:16px 20px;display:flex;gap:14px;align-items:center}
  .nv-none .ico{width:44px;height:44px;border-radius:50%;background:#f1f5f9;
     display:flex;align-items:center;justify-content:center;font-size:20px;flex:none}
  .nv-none .tt{font-size:14px;font-weight:700}
  .nv-none .ms{font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.5}
  .nv-loading{margin-top:14px;color:var(--muted);font-size:13px}
  @media(max-width:560px){
    .nv-row{flex-direction:column}
    .nv-hit{flex-wrap:wrap}
    .nv-hit .pill{margin-left:56px}
  }`;
  document.head.appendChild(css);
}

/* Tarjeta compacta de persona bloqueada (misma para cedula y coincidencias). */
function hitCard(p) {
  const ced = `${esc(p.ced_kind || 'V')}-${esc(p.id_number || '')}`;
  const ava = p.thumb_url
    ? `<img src="${esc(p.thumb_url)}" alt="" loading="lazy"
         onerror="this.outerHTML='&lt;span class=&quot;noimg&quot;&gt;${esc(initials(p.full_name))}&lt;/span&gt;'">`
    : `<span class="noimg">${esc(initials(p.full_name))}</span>`;
  return `
    <div class="nv-hit">
      ${ava}
      <div style="min-width:0">
        <div class="nm">${esc(p.full_name || 'Sin nombre registrado')}</div>
        <div class="cd">${ced}</div>
        <div class="sub2">No se puede contratar en el grupo. Para más información, contacta a Capital Humano.</div>
      </div>
      <span class="pill">🚫 NO REEMPLEABLE</span>
    </div>`;
}

export function renderNoRehireVerify(user) {
  ensureStyles();

  $('#pnlMain').innerHTML = `
    <div class="nv-head">
      <h2>Verificar candidato</h2>
      <p>Consulta si una persona puede ser contratada en el grupo, antes de reportar el ingreso.</p>
    </div>
    <div class="nv-box">
      <label for="nvQ">Cédula o nombre del candidato</label>
      <div class="nv-row">
        <input type="text" id="nvQ" placeholder="Ej: 27947416 · o un nombre: WILTON GARCIA" autocomplete="off">
        <button id="nvGo">Verificar</button>
      </div>
      <div class="nv-hint">💡 La <b>cédula</b> da la respuesta definitiva. El nombre solo muestra coincidencias
      (una persona puede tener nombres parecidos o estar registrada distinto).</div>
    </div>
    <div class="nv-out" id="nvOut"></div>
  `;

  const out = () => $('#nvOut');

  async function run() {
    const q = ($('#nvQ')?.value || '').trim();
    if (!q) return;
    const btn = $('#nvGo');
    btn.disabled = true; btn.textContent = 'Verificando…';
    if (out()) out().innerHTML = '<div class="nv-loading">Consultando…</div>';

    const r = await api(user, { action: 'verify', q }).catch(e => ({ ok: false, error: String(e) }));
    btn.disabled = false; btn.textContent = 'Verificar';
    if (!out()) return;   // navego a otra vista mientras cargaba

    if (!r || !r.ok) {
      out().innerHTML = `<div class="nv-err">${esc((r && r.error) || 'No se pudo consultar. Intenta de nuevo.')}</div>`;
      return;
    }

    /* ---- cedula: respuesta definitiva ---- */
    if (r.mode === 'ced') {
      if (!r.blocked) {
        // LIBRE: verde, SIN mencionar la lista (decision de Pablo, mockup v2).
        const kind = Number(r.id_number) >= 80000000 ? 'E' : 'V';
        out().innerHTML = `
          <div class="nv-ok">
            <div class="ico">✓</div>
            <div>
              <div class="tt">Se puede contratar</div>
              <div class="ms">La cédula <span class="nv-cedchip">${esc(kind)}-${esc(r.id_number)}</span>
              no tiene impedimentos. Continúa con el reporte de Ingreso normalmente.</div>
            </div>
          </div>`;
      } else {
        out().innerHTML = hitCard(r.person || {});
      }
      return;
    }

    /* ---- nombre: coincidencias ---- */
    const matches = r.matches || [];
    if (!matches.length) {
      out().innerHTML = `
        <div class="nv-none">
          <div class="ico">🔎</div>
          <div>
            <div class="tt">Sin coincidencias para "${esc(r.q || q)}"</div>
            <div class="ms">Ningún registro coincide con ese nombre. <b>Ojo:</b> el nombre puede estar
            escrito distinto — la verificación definitiva es por <b>cédula</b>.</div>
          </div>
        </div>`;
      return;
    }
    out().innerHTML = `
      <p class="nv-mtitle">${matches.length} coincidencia${matches.length === 1 ? '' : 's'} para
      <b>"${esc(r.q || q)}"</b> — verifica por cédula para confirmar que es la misma persona:</p>
      ${matches.map(hitCard).join('')}`;
  }

  $('#nvGo')?.addEventListener('click', run);
  $('#nvQ')?.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  setTimeout(() => $('#nvQ')?.focus(), 60);
}
