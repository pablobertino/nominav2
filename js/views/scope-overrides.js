/* =====================================================================
   js/views/scope-overrides.js  →  Bloque "Alcance por sección" (v4.83)

   Se INYECTA en el panel/ficha del miembro dentro de la vista Equipo.
   Mockup aprobado: _PRUEBAS/equipo_alcance_overrides_mockup.html (v0-mock2).

   INTEGRACIÓN (pendiente en viewEquipo de panel.js):
     import { injectScopeOverridesBlock } from './scope-overrides.js';
     // ...al terminar de pintar el panel del miembro (member = {id, role, name}):
     injectScopeOverridesBlock(hostElement, member, user);
   hostElement: un contenedor (div) al final del panel del miembro.

   Comportamiento:
   - Miembro superadmin: no pinta nada (ya lo ve todo).
   - Con view.equipo se VE el bloque (solo lectura). Con team.scope_override
     (llave que nace solo-superadmin) se puede EDITAR.
   - Sección activa: 'bank' (Datos bancarios: Cuentas + Estadísticas).
   - Kinds: inherit (borra el override) / all / stores / non_stores / custom.
   - Preview en vivo ("verá N empresas en esta sección") via acción preview.
   - Personalizado: multiselect de empresas (catálogo por acción companies).
   ===================================================================== */

const SECTION = 'bank';
const KIND_LABELS = [
  ['inherit', 'Heredado (alcance base)'],
  ['stores', 'Solo tiendas — todas'],
  ['non_stores', 'Solo empresas no-tienda — todas'],
  ['all', 'Todas las empresas'],
  ['custom', 'Personalizado (elegir empresas)'],
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = n => Number(n || 0).toLocaleString('es-VE');

function ensureStyles() {
  if (document.getElementById('scovStyles')) return;
  const st = document.createElement('style');
  st.id = 'scovStyles';
  st.textContent = `
  .scov{margin-top:16px;border-top:1px solid var(--border-soft,#f1f4f8);padding-top:13px}
  .scov h3{margin:0 0 2px;font-size:13.5px;color:var(--ink)}
  .scov h3 .pill{display:inline-block;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:999px;padding:1px 9px;font-size:10.5px;font-weight:800;color:#6d28d9;margin-left:7px;vertical-align:middle}
  .scov .d{font-size:12px;color:var(--muted);margin:0 0 10px}
  .scov-row{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--card,#fff)}
  .scov-row.active{border-color:#ddd6fe;background:#fdfcff}
  .scov-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .scov-top .ic{width:29px;height:29px;border-radius:9px;background:var(--pri-soft,#eff6ff);color:var(--accent,#2563eb);display:grid;place-items:center;flex:none}
  .scov-top b{font-size:13px;color:var(--ink)}
  .scov-top small{display:block;color:var(--muted);font-size:11.5px}
  .scov-top select{margin-left:auto;font:inherit;font-size:13px;padding:7px 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink);min-width:230px}
  .scov-det{margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);display:flex;gap:13px;align-items:center;flex-wrap:wrap;font-size:12.5px}
  .scov-det label{display:flex;gap:7px;align-items:center;color:var(--ink-soft,#475569);cursor:pointer}
  .scov-prev{margin-left:auto;background:#f5f3ff;border:1px solid #ddd6fe;color:#5b21b6;border-radius:9px;padding:5px 11px;font-size:11.5px;font-weight:700}
  .scov-custom{margin-top:10px;display:none}
  .scov-custom.open{display:block}
  .scov-custom select{width:100%;min-height:150px;font:inherit;font-size:12.5px;border:1px solid var(--border);border-radius:9px;padding:6px}
  .scov-custom .hint{font-size:11px;color:var(--muted);margin-top:4px}
  .scov-note{margin-top:10px;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;border-radius:9px;padding:8px 11px;font-size:11.5px;color:#92400e;line-height:1.5}
  .scov-acts{margin-top:11px;display:flex;gap:8px;justify-content:flex-end}
  .scov-btn{border:1px solid var(--border);background:var(--surface,#fff);border-radius:9px;padding:7px 14px;font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer}
  .scov-btn.pri{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
  .scov-btn:disabled{opacity:.5;cursor:default}
  .scov-ro{font-size:12px;color:var(--muted);font-style:italic}
  .scov-msg{font-size:12px;font-weight:700;margin-right:auto;align-self:center}
  .scov-msg.ok{color:#15803d}.scov-msg.err{color:#b91c1c}`;
  document.head.appendChild(st);
}

async function api(user, payload) {
  return fetch('/api/scope-overrides', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

/* Pinta el bloque dentro de host. member = { id, role, name? } (fila de
   admin_users del miembro mostrado). user = sesión actual. */
export async function injectScopeOverridesBlock(host, member, user) {
  if (!host || !member || !member.id) return;
  if (member.role === 'superadmin') return;   // ya lo ve todo
  ensureStyles();

  const r = await api(user, { action: 'list', admin_ids: [member.id] });
  if (!r || !r.ok) return;                    // sin permiso de ver Equipo: nada
  const canEdit = !!r.canEdit;
  const ov = (r.overrides || []).find(o => o.section === SECTION) || null;

  const st = {
    kind: ov ? ov.scope_kind : 'inherit',
    include_base: ov ? ov.include_base !== false : true,
    codes: (ov && ov.company_codes) || [],
    dirty: false,
    companies: null,
  };

  host.innerHTML = `
    <div class="scov">
      <h3>Alcance por sección <span class="pill">override</span></h3>
      <p class="d">Solo para las pantallas de la sección; lo demás sigue usando el alcance base.
        ${canEdit ? '' : '<span class="scov-ro">Solo lectura (requiere el permiso team.scope_override).</span>'}</p>
      <div class="scov-row ${st.kind !== 'inherit' ? 'active' : ''}" id="scovRow">
        <div class="scov-top">
          <span class="ic"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg></span>
          <span><b>Datos bancarios</b><small>Cuentas y Estadísticas (consulta)</small></span>
          <select id="scovKind" ${canEdit ? '' : 'disabled'}>
            ${KIND_LABELS.map(([v, l]) => `<option value="${v}"${v === st.kind ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="scov-det" id="scovDet" style="${st.kind === 'inherit' ? 'display:none' : ''}">
          <label><input type="checkbox" id="scovBase" ${st.include_base ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Sumar también su alcance base</label>
          <span class="scov-prev" id="scovPrev">⚡ calculando…</span>
        </div>
        <div class="scov-custom" id="scovCustom">
          <select id="scovCodes" multiple ${canEdit ? '' : 'disabled'}></select>
          <div class="hint">Ctrl+clic para elegir varias empresas.</div>
        </div>
        <div class="scov-note">El override aplica a <b>Cuentas</b> y <b>Estadísticas</b>. <b>Sincronizar</b> e <b>Historial</b> bancarios siguen con el alcance base. Qué menús ve cada rol se decide en <b>Roles</b>.</div>
        ${canEdit ? `<div class="scov-acts"><span class="scov-msg" id="scovMsg"></span>
          <button class="scov-btn pri" id="scovSave" disabled>Guardar alcance</button></div>` : ''}
      </div>
    </div>`;

  const $k = host.querySelector('#scovKind');
  const $base = host.querySelector('#scovBase');
  const $det = host.querySelector('#scovDet');
  const $cust = host.querySelector('#scovCustom');
  const $codes = host.querySelector('#scovCodes');
  const $prev = host.querySelector('#scovPrev');
  const $save = host.querySelector('#scovSave');
  const $msg = host.querySelector('#scovMsg');
  const $row = host.querySelector('#scovRow');

  async function ensureCompanies() {
    if (st.companies) return;
    const c = await api(user, { action: 'companies' });
    st.companies = (c && c.ok && c.companies) || [];
    $codes.innerHTML = st.companies.map(x =>
      `<option value="${esc(x.company_code)}"${st.codes.includes(x.company_code) ? ' selected' : ''}>${esc(x.business_name || x.company_code)} (${esc(x.company_code)} · ${esc(x.company_type || '')})</option>`).join('');
  }

  async function refreshPreview() {
    if (st.kind === 'inherit') return;
    $prev.textContent = '⚡ calculando…';
    const p = await api(user, {
      action: 'preview', admin_id: member.id, scope_kind: st.kind,
      company_codes: st.kind === 'custom' ? st.codes : null,
      include_base: st.include_base,
    });
    if (p && p.ok) {
      $prev.textContent = `⚡ Verá ${nf(p.total_n)} empresas en esta sección (${nf(p.extra_n)} del override${st.include_base ? ` + su base de ${nf(p.base_n)}` : ''})`;
    } else {
      $prev.textContent = (p && p.error) ? p.error : 'No se pudo calcular.';
    }
  }

  async function sync() {
    const isInh = st.kind === 'inherit';
    $det.style.display = isInh ? 'none' : '';
    $row.classList.toggle('active', !isInh);
    $cust.classList.toggle('open', st.kind === 'custom');
    if (st.kind === 'custom') await ensureCompanies();
    if ($save) $save.disabled = !st.dirty || (st.kind === 'custom' && !st.codes.length);
    if (!isInh && canEdit) refreshPreview();
  }

  if (canEdit) {
    $k.addEventListener('change', () => { st.kind = $k.value; st.dirty = true; if ($msg) $msg.textContent = ''; sync(); });
    $base.addEventListener('change', () => { st.include_base = $base.checked; st.dirty = true; sync(); });
    $codes.addEventListener('change', () => {
      st.codes = [...$codes.selectedOptions].map(o => o.value);
      st.dirty = true; sync();
    });
    $save.addEventListener('click', async () => {
      $save.disabled = true; $save.textContent = 'Guardando…'; $msg.textContent = ''; $msg.className = 'scov-msg';
      const res = await api(user, {
        action: 'save', admin_id: member.id, section: SECTION,
        scope_kind: st.kind,
        company_codes: st.kind === 'custom' ? st.codes : null,
        include_base: st.include_base,
      });
      $save.textContent = 'Guardar alcance';
      if (res && res.ok) {
        st.dirty = false;
        $msg.textContent = st.kind === 'inherit' ? 'Override eliminado: vuelve al alcance base.' : 'Alcance guardado.';
        $msg.classList.add('ok');
      } else {
        $save.disabled = false;
        $msg.textContent = (res && res.error) || 'No se pudo guardar.';
        $msg.classList.add('err');
      }
    });
  }
  sync();
}
