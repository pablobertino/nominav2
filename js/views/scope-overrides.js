/* =====================================================================
   js/views/scope-overrides.js  →  Alcances por sección (v4.86)

   Editor de PÁGINA COMPLETA (mockup aprobado:
   _PRUEBAS/equipo_alcance_overrides_page_mockup.html v1-mock1).
   Se llega desde la grilla de Equipo con el botón ⚡ de cada fila
   (auRowCommonActs en panel.js); el ← vuelve a Equipo (callback onBack).

   Exporta:
     renderScopeOverridesEditor(user, member, onBack)
       member = { id, username, name, role } (dataset del botón de fila)
     decorateScovBadges(user)
       marca con .has-ov los botones ⚡ de miembros con override.

   Endpoint: /api/scope-overrides (list/save/preview/companies).
   Sección activa: 'bank' (Datos bancarios: Cuentas + Estadísticas).
   Editable solo con team.scope_override (list devuelve canEdit).
   ===================================================================== */

const SECTION = 'bank';
const KINDS = [
  ['inherit',    'Heredado',             'Su alcance base, sin excepción'],
  ['stores',     'Solo tiendas',         'Todas las empresas tipo Tienda'],
  ['non_stores', 'Solo no-tienda',       'Todas menos las tiendas'],
  ['types',      'Por tipos de empresa', 'Elige tipos con casillas'],
  ['all',        'Todas las empresas',   'Alcance total en la sección'],
  ['custom',     'Personalizado',        'Elegir empresas una a una'],
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = n => Number(n || 0).toLocaleString('es-VE');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function api(user, payload) {
  return fetch('/api/scope-overrides', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: user.kind, id: user.id || null, companyCode: user.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('scovPageStyles')) return;
  const st = document.createElement('style');
  st.id = 'scovPageStyles';
  st.textContent = `
  .scovp{max-width:1060px}
  .scovp .phead{display:flex;align-items:center;gap:13px;margin-bottom:4px}
  .scovp .back{width:34px;height:34px;border:1px solid var(--border);border-radius:10px;background:var(--surface,#fff);cursor:pointer;display:grid;place-items:center;color:var(--ink-soft,#475569);font-size:16px}
  .scovp .back:hover{background:#f8fafc}
  .scovp h1{font-size:20px;font-weight:750;margin:0}
  .scovp .sub{color:var(--muted);font-size:13px;margin:2px 0 16px;padding-left:47px}
  .scovp .who{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:14px 17px;display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
  .scovp .who .av{width:42px;height:42px;border-radius:50%;background:var(--accent,#2563eb);color:#fff;display:grid;place-items:center;font-weight:800;flex:none}
  .scovp .who b{font-size:15px;display:block}
  .scovp .who small{color:var(--muted)}
  .scovp .basebox{margin-left:auto;background:#f8fafc;border:1px solid var(--border);border-radius:9px;padding:7px 12px;font-size:12px;color:var(--ink-soft,#475569)}
  .scovp .panel{background:var(--card,#fff);border:1px solid var(--border);border-radius:13px;padding:17px 19px}
  .scovp .panel h3{font-size:13.5px;margin:0 0 2px}
  .scovp .pill{display:inline-block;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:999px;padding:1px 9px;font-size:10.5px;font-weight:800;color:#6d28d9;margin-left:7px;vertical-align:middle}
  .scovp .d{font-size:12px;color:var(--muted);margin:0 0 13px}
  .scovp .ro{font-size:12px;color:var(--muted);font-style:italic;margin-left:8px}
  .scovp .kinds{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px;margin-bottom:14px}
  .scovp .kind{border:1px solid var(--border);border-radius:11px;padding:11px 13px;cursor:pointer;background:var(--surface,#fff);display:flex;gap:9px;align-items:flex-start}
  .scovp .kind input{margin-top:2px;accent-color:#6d28d9}
  .scovp .kind b{display:block;font-size:12.5px}
  .scovp .kind small{color:var(--muted);font-size:11px;line-height:1.35;display:block;margin-top:1px}
  .scovp .kind.on{border-color:#ddd6fe;background:#f5f3ff;box-shadow:0 0 0 1px #ddd6fe}
  .scovp .kind.dis{opacity:.55;cursor:default}
  .scovp .typegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-bottom:6px}
  .scovp .tchk{border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;gap:9px;align-items:center;cursor:pointer;background:var(--surface,#fff);font-size:12.5px;font-weight:600;color:var(--ink-soft,#475569)}
  .scovp .tchk input{width:16px;height:16px;accent-color:#6d28d9}
  .scovp .tchk.on{border-color:#ddd6fe;background:#f5f3ff;color:#6d28d9}
  .scovp .tchk .n{margin-left:auto;font-size:11px;font-weight:800;color:var(--muted)}
  .scovp .comp-tools{display:flex;gap:9px;margin:4px 0 9px}
  .scovp .comp-tools input{flex:1;font:inherit;font-size:13px;padding:8px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface,#fff);color:var(--ink)}
  .scovp .comp-tools button{border:1px solid var(--border);background:var(--surface,#fff);border-radius:9px;padding:0 12px;font-size:12px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer}
  .scovp .complist{border:1px solid var(--border);border-radius:11px;max-height:260px;overflow:auto;background:var(--surface,#fff)}
  .scovp .cgroup{padding:7px 13px;background:#fbfcfe;border-top:1px solid var(--border-soft,#f1f4f8);font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;position:sticky;top:0}
  .scovp .complist .cgroup:first-child{border-top:none}
  .scovp .crow{display:flex;gap:10px;align-items:center;padding:8px 13px;border-top:1px solid var(--border-soft,#f1f4f8);cursor:pointer;font-size:12.5px}
  .scovp .crow:hover{background:#fafcff}
  .scovp .crow input{width:15px;height:15px;accent-color:#6d28d9}
  .scovp .crow small{color:var(--muted);margin-left:auto}
  .scovp .crow.on{background:#f5f3ff}
  .scovp .ccount{font-size:11px;color:var(--muted);margin-top:5px}
  .scovp .extra{margin-top:13px;padding-top:13px;border-top:1px dashed var(--border);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  .scovp .extra label{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-soft,#475569);cursor:pointer}
  .scovp .extra input{width:16px;height:16px;accent-color:#6d28d9}
  .scovp .preview{margin-left:auto;background:#f5f3ff;border:1px solid #ddd6fe;color:#5b21b6;border-radius:10px;padding:8px 14px;font-size:12.5px;font-weight:700}
  .scovp .note{margin-top:13px;background:var(--warn-bg,#fffbeb);border:1px solid #fde68a;border-radius:10px;padding:9px 12px;font-size:11.5px;color:#92400e;line-height:1.5}
  .scovp .acts{margin-top:15px;display:flex;gap:9px;justify-content:flex-end;align-items:center}
  .scovp .msg{font-size:12px;font-weight:700;margin-right:auto}
  .scovp .msg.ok{color:#15803d}.scovp .msg.err{color:#b91c1c}
  .scovp .btn2{border:1px solid var(--border);background:var(--surface,#fff);border-radius:10px;padding:9px 17px;font:inherit;font-size:13px;font-weight:600;color:var(--ink-soft,#475569);cursor:pointer}
  .scovp .btn2.pri{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
  .scovp .btn2.danger{color:#b91c1c;border-color:#fecaca}
  .scovp .btn2:disabled{opacity:.5;cursor:default}
  /* badge en el boton de fila de Equipo cuando el miembro tiene override */
  .au-scov.has-ov{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9}`;
  document.head.appendChild(st);
}

/* Marca .has-ov en los botones ⚡ de la grilla de Equipo cuyos miembros
   tienen override. Se llama tras pintar viewEquipo. */
export async function decorateScovBadges(user) {
  const btns = [...document.querySelectorAll('.au-scov[data-id]')];
  if (!btns.length) return;
  ensureStyles();
  const ids = btns.map(b => parseInt(b.dataset.id, 10)).filter(Number.isFinite);
  const r = await api(user, { action: 'list', admin_ids: ids });
  if (!r || !r.ok) return;
  const withOv = new Set((r.overrides || []).map(o => Number(o.admin_id)));
  btns.forEach(b => {
    if (withOv.has(parseInt(b.dataset.id, 10))) {
      b.classList.add('has-ov');
      b.title = 'Alcances por sección: tiene override activo';
    }
  });
}

/* Editor de página completa para un miembro. */
export async function renderScopeOverridesEditor(user, member, onBack) {
  ensureStyles();
  const main = document.getElementById('pnlMain');
  if (!main || !member || !member.id) return;

  main.innerHTML = `<div class="scovp"><div class="phead">
    <button class="back" id="scovBack" title="Volver a Equipo">←</button>
    <h1>⚡ Alcances por sección</h1></div>
    <p class="sub">Cargando…</p></div>`;
  document.getElementById('scovBack').addEventListener('click', onBack);

  const [lst, comp] = await Promise.all([
    api(user, { action: 'list', admin_ids: [member.id] }),
    api(user, { action: 'companies' }),
  ]);
  if (!lst || !lst.ok) {
    main.querySelector('.sub').textContent = (lst && lst.error) || 'No se pudo cargar.';
    return;
  }
  const canEdit = !!lst.canEdit;
  const companies = (comp && comp.ok && comp.companies) || [];
  const typeCounts = {};
  companies.forEach(c => {
    const t = c.company_type || '(sin tipo)';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const allTypes = Object.keys(typeCounts).sort();
  const ov = (lst.overrides || []).find(o => o.section === SECTION) || null;

  const st = {
    kind: ov ? ov.scope_kind : 'inherit',
    include_base: ov ? ov.include_base !== false : true,
    codes: new Set((ov && ov.company_codes) || []),
    types: new Set((ov && ov.company_types) || []),
    hadOv: !!ov,
    dirty: false,
    baseN: null,
  };

  const initials = (member.name || member.username || '?')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const compGroups = {};
  companies.forEach(c => {
    const t = c.company_type || '(sin tipo)';
    (compGroups[t] = compGroups[t] || []).push(c);
  });

  main.innerHTML = `<div class="scovp">
    <div class="phead">
      <button class="back" id="scovBack" title="Volver a Equipo">←</button>
      <h1>⚡ Alcances por sección</h1>
    </div>
    <p class="sub">Editando excepciones de la sección Datos bancarios.${canEdit ? '' : '<span class="ro">Solo lectura: requiere el permiso team.scope_override.</span>'}</p>

    <div class="who">
      <span class="av">${esc(initials)}</span>
      <span><b>${esc(member.name || member.username)}</b><small>${esc(member.role || '')} · ${esc(member.username || '')}</small></span>
      <span class="basebox" id="scovBase">📍 Alcance base: …</span>
    </div>

    <div class="panel">
      <h3>Datos bancarios <span class="pill">Cuentas y Estadísticas</span></h3>
      <p class="d">¿Qué empresas ve en esta sección?</p>

      <div class="kinds" id="scovKinds">
        ${KINDS.map(([v, t, d]) => `
          <label class="kind ${st.kind === v ? 'on' : ''} ${canEdit ? '' : 'dis'}">
            <input type="radio" name="scovK" value="${v}" ${st.kind === v ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
            <span><b>${t}</b><small>${d}</small></span>
          </label>`).join('')}
      </div>

      <div class="typegrid" id="scovTypes" style="${st.kind === 'types' ? '' : 'display:none'}">
        ${allTypes.map(t => `
          <label class="tchk ${st.types.has(t) ? 'on' : ''}">
            <input type="checkbox" value="${esc(t)}" ${st.types.has(t) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
            ${esc(t)} <span class="n">${nf(typeCounts[t])}</span>
          </label>`).join('')}
      </div>

      <div id="scovCustom" style="${st.kind === 'custom' ? '' : 'display:none'}">
        <div class="comp-tools">
          <input id="scovQ" placeholder="Buscar empresa por nombre o código…" ${canEdit ? '' : 'disabled'}>
          <button id="scovMarkVis" ${canEdit ? '' : 'disabled'}>Marcar visibles</button>
          <button id="scovClearSel" ${canEdit ? '' : 'disabled'}>Limpiar</button>
        </div>
        <div class="complist" id="scovList">
          ${allTypes.map(t => `
            <div class="cgroup" data-g="${esc(t)}">${esc(t)}</div>
            ${compGroups[t].map(c => `
              <label class="crow ${st.codes.has(c.company_code) ? 'on' : ''}" data-txt="${esc(norm((c.business_name || '') + ' ' + c.company_code))}">
                <input type="checkbox" value="${esc(c.company_code)}" ${st.codes.has(c.company_code) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
                ${esc(c.business_name || c.company_code)} <small>${esc(c.company_code)}</small>
              </label>`).join('')}`).join('')}
        </div>
        <div class="ccount" id="scovCount"></div>
      </div>

      <div class="extra" id="scovExtra" style="${st.kind === 'inherit' ? 'display:none' : ''}">
        <label><input type="checkbox" id="scovIncBase" ${st.include_base ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Sumar también su alcance base</label>
        <span class="preview" id="scovPrev">⚡ calculando…</span>
      </div>

      <div class="note">El override aplica a <b>Cuentas</b> y <b>Estadísticas</b>. <b>Sincronizar</b> e <b>Historial</b> bancarios siguen con el alcance base. Qué menús ve cada rol se decide en <b>Roles</b>.</div>

      ${canEdit ? `<div class="acts">
        <span class="msg" id="scovMsg"></span>
        <button class="btn2 danger" id="scovRemove" style="${st.hadOv ? '' : 'display:none'}">Quitar override</button>
        <button class="btn2" id="scovCancel">Cancelar</button>
        <button class="btn2 pri" id="scovSave" disabled>Guardar alcance</button>
      </div>` : ''}
    </div>
  </div>`;

  const q = id => document.getElementById(id);
  q('scovBack').addEventListener('click', onBack);

  function updCount() {
    const el = q('scovCount');
    if (el) el.innerHTML = `<b>${nf(st.codes.size)}</b> empresa${st.codes.size === 1 ? '' : 's'} seleccionada${st.codes.size === 1 ? '' : 's'}`;
  }
  updCount();

  let prevSeq = 0;
  async function refreshPreview() {
    const box = q('scovPrev');
    if (!box || st.kind === 'inherit') return;
    const seq = ++prevSeq;
    box.textContent = '⚡ calculando…';
    const p = await api(user, {
      action: 'preview', admin_id: member.id, scope_kind: st.kind,
      company_codes: st.kind === 'custom' ? [...st.codes] : null,
      company_types: st.kind === 'types' ? [...st.types] : null,
      include_base: st.include_base,
    });
    if (seq !== prevSeq) return;
    if (p && p.ok) {
      st.baseN = p.base_n;
      box.innerHTML = `⚡ Verá <b>${nf(p.total_n)}</b> empresas en esta sección — ${nf(p.extra_n)} del override${st.include_base ? ` + su base de ${nf(p.base_n)}` : ''}`;
      const bb = q('scovBase');
      if (bb) bb.innerHTML = `📍 Alcance base: <b>${nf(p.base_n)}</b> empresa${p.base_n === 1 ? '' : 's'}`;
    } else {
      box.textContent = (p && p.error) || 'No se pudo calcular.';
    }
  }

  // alcance base en cabecera aunque el kind sea inherit
  (async () => {
    const p = await api(user, {
      action: 'preview', admin_id: member.id, scope_kind: 'custom',
      company_codes: [], include_base: true,
    });
    const bb = q('scovBase');
    if (p && p.ok && bb) bb.innerHTML = `📍 Alcance base: <b>${nf(p.base_n)}</b> empresa${p.base_n === 1 ? '' : 's'}`;
  })();

  function sync() {
    const t = q('scovTypes'), c = q('scovCustom'), e = q('scovExtra');
    if (t) t.style.display = st.kind === 'types' ? '' : 'none';
    if (c) c.style.display = st.kind === 'custom' ? '' : 'none';
    if (e) e.style.display = st.kind === 'inherit' ? 'none' : '';
    const sv = q('scovSave');
    if (sv) sv.disabled = !st.dirty
      || (st.kind === 'custom' && !st.codes.size)
      || (st.kind === 'types' && !st.types.size);
    if (st.kind !== 'inherit') refreshPreview();
  }
  if (st.kind !== 'inherit') refreshPreview();

  if (!canEdit) return;

  q('scovKinds').addEventListener('change', e => {
    if (e.target.name !== 'scovK') return;
    st.kind = e.target.value; st.dirty = true;
    q('scovKinds').querySelectorAll('.kind').forEach(k => k.classList.remove('on'));
    e.target.closest('.kind').classList.add('on');
    const m = q('scovMsg'); if (m) { m.textContent = ''; m.className = 'msg'; }
    sync();
  });

  q('scovTypes').addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    e.target.checked ? st.types.add(e.target.value) : st.types.delete(e.target.value);
    e.target.closest('.tchk').classList.toggle('on', e.target.checked);
    st.dirty = true; sync();
  });

  q('scovList').addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    e.target.checked ? st.codes.add(e.target.value) : st.codes.delete(e.target.value);
    e.target.closest('.crow').classList.toggle('on', e.target.checked);
    st.dirty = true; updCount(); sync();
  });

  q('scovQ').addEventListener('input', () => {
    const needle = norm(q('scovQ').value.trim());
    const rows = q('scovList').querySelectorAll('.crow');
    rows.forEach(r => { r.style.display = !needle || r.dataset.txt.includes(needle) ? '' : 'none'; });
    q('scovList').querySelectorAll('.cgroup').forEach(g => {
      let n = g.nextElementSibling, any = false;
      while (n && !n.classList.contains('cgroup')) { if (n.style.display !== 'none') any = true; n = n.nextElementSibling; }
      g.style.display = any ? '' : 'none';
    });
  });

  q('scovMarkVis').addEventListener('click', () => {
    q('scovList').querySelectorAll('.crow').forEach(r => {
      if (r.style.display === 'none') return;
      const cb = r.querySelector('input');
      if (!cb.checked) { cb.checked = true; st.codes.add(cb.value); r.classList.add('on'); }
    });
    st.dirty = true; updCount(); sync();
  });

  q('scovClearSel').addEventListener('click', () => {
    q('scovList').querySelectorAll('.crow input:checked').forEach(cb => {
      cb.checked = false; cb.closest('.crow').classList.remove('on');
    });
    st.codes.clear(); st.dirty = true; updCount(); sync();
  });

  q('scovIncBase').addEventListener('change', e => {
    st.include_base = e.target.checked; st.dirty = true; sync();
  });

  q('scovCancel').addEventListener('click', onBack);

  async function doSave(kind) {
    const sv = q('scovSave'), rm = q('scovRemove'), m = q('scovMsg');
    sv.disabled = true; rm.disabled = true; m.textContent = ''; m.className = 'msg';
    const res = await api(user, {
      action: 'save', admin_id: member.id, section: SECTION,
      scope_kind: kind,
      company_codes: kind === 'custom' ? [...st.codes] : null,
      company_types: kind === 'types' ? [...st.types] : null,
      include_base: st.include_base,
    });
    if (res && res.ok) {
      m.textContent = kind === 'inherit' ? 'Override eliminado: vuelve al alcance base.' : 'Alcance guardado.';
      m.classList.add('ok');
      setTimeout(onBack, 650);
    } else {
      sv.disabled = false; rm.disabled = false;
      m.textContent = (res && res.error) || 'No se pudo guardar.';
      m.classList.add('err');
    }
  }

  q('scovSave').addEventListener('click', () => doSave(st.kind === 'inherit' ? 'inherit' : st.kind));
  q('scovRemove').addEventListener('click', () => doSave('inherit'));
}
