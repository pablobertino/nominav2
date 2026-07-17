/* =====================================================================
   js/views/ax-egresos-card.js — v6.09
   Tarjeta "Egresos del sistema" para la pantalla Configurar (viewSync).

   Modulo PROPIO (patron v5.75 de No reempleables: viewSync no engorda;
   panel.js solo deja el placeholder #axEgCfgCard y hace import dinamico).

   Gobierna la corrida automatica de egresos AX (v6.08):
   - nomina_v2.ax_sync_config (singleton id=1) via /api/ax-sync,
     acciones cfg_get / cfg_set (gate hcm.sync).
   - "Ejecutar ahora" reusa el MISMO camino del tick (accion egresos_cron
     con el adminId del superadmin + manual:true): pull de la ventana +
     ax_egresos_apply (cierra en el roster lo que el sistema ya termino,
     jamas por ausencia) + refresco del catalogo de empresas. El resultado
     queda en ax_sync_config y se repinta aca.

   Calibracion real (17/07): 60d~40s · 120d~55s · 200d~70s · 365d revienta
   el timeout del middleware (504). Por eso el barrido mensual es de 180.
   ===================================================================== */
import { $ } from '../core/dom.js';

const FREQ_LABEL = { daily: 'Una vez al día', '2d': 'Cada 2 días', '3d': 'Cada 3 días', weekly: 'Semanal' };

const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDT = (iso) => {
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export async function mountAxEgresosCard(user) {
  const host = document.getElementById('axEgCfgCard');
  if (!host) return;

  const api = (payload) => fetch('/api/ax-sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(x => x.json()).catch(() => null);

  const res = await api({ action: 'cfg_get', user });
  if (!res || !res.ok) {
    host.innerHTML = `<div class="card"><p class="muted" style="margin:0">Egresos del sistema: no se pudo cargar la configuración (${escH((res && res.error) || 'error')}).</p></div>`;
    return;
  }
  const cfg = res.config || {};

  const lastHtml = (c) => {
    if (!c || !c.last_run_at) return '<span class="muted">Aún no se ha ejecutado. La primera corrida automática sale a la hora ancla del próximo día que toque.</span>';
    const src = c.last_source === 'manual' ? 'manual' : 'automática';
    if (c.last_status === 'ok') {
      const r = c.last_result || {}; const a = r.api || {}; const ap = r.apply || {};
      return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill pill-open">✅ OK</span><b>${fmtDT(c.last_run_at)}</b><span class="muted">${src}</span></div>`
        + `<div style="margin-top:8px">${a.egresos || 0} egresos · ${a.asignaciones || 0} asignaciones recibidas · <b>${ap.cerrados || 0}</b> contrato(s) cerrado(s) en el portal · ventana ${r.days || '—'} días (${r.desde || '—'} → ${r.hasta || '—'})</div>`;
    }
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="pill pill-closed">❌ Error</span><b>${fmtDT(c.last_run_at)}</b><span class="muted">${src}</span></div>`
      + `<div style="margin-top:8px;color:var(--danger)">${escH(c.last_error || 'error desconocido')}</div>`;
  };

  const freqOpts = Object.entries(FREQ_LABEL).map(([v, l]) =>
    `<option value="${v}" ${(cfg.frequency || 'daily') === v ? 'selected' : ''}>${l}</option>`).join('');
  const hh = String(cfg.daily_hour != null ? cfg.daily_hour : 8).padStart(2, '0');
  const mm = String(cfg.daily_minute != null ? cfg.daily_minute : 15).padStart(2, '0');

  host.innerHTML = `
    <div class="card">
      <div class="cfg-card-head"><h3 style="margin:0;font-size:15px">Egresos del sistema</h3>
        <div class="head-actions"><button class="btn" id="axEgRunBtn">Ejecutar ahora</button></div>
      </div>
      <p class="cfg-desc" style="margin:0 0 6px">Consulta la API dedicada de egresos y <b>cierra en el portal</b> los contratos que el sistema ya terminó (solo con fecha de fin explícita, jamás por ausencia). Con esto, Doble empleo y el personal de tiendas se limpian solos. De paso refresca el catálogo de estatus de empresas.</p>
      <div id="axEgLast" style="margin:0 0 12px">${lastHtml(cfg)}</div>
      <p class="cfg-desc" style="margin:0 0 12px">La corrida cede el turno si la sincronización de Personal está en marcha (nunca corren dos a la vez) y lo reintenta minutos después.</p>
      <div class="cfg-grid3">
        <div><label class="flabel">Estado</label>
          <select id="axEgEnabled"><option value="1" ${cfg.enabled ? 'selected' : ''}>Activa</option><option value="0" ${!cfg.enabled ? 'selected' : ''}>Inactiva</option></select></div>
        <div><label class="flabel">Frecuencia</label><select id="axEgFreq">${freqOpts}</select></div>
        <div><label class="flabel">Hora ancla (Caracas)</label>
          <input type="time" id="axEgTime" value="${hh}:${mm}" step="60" style="width:130px"></div>
      </div>
      <div class="cfg-grid3" style="margin-top:12px">
        <div><label class="flabel">Días hacia atrás</label>
          <input type="number" id="axEgDays" min="1" max="365" value="${cfg.days_back != null ? cfg.days_back : 30}" style="width:110px">
          <p class="muted" style="font-size:11px;margin:6px 0 0">La API filtra por fecha de fin: la ventana debe cubrir el retraso con que se registran los egresos.</p></div>
        <div><label class="flabel">Barrido profundo mensual</label>
          <select id="axEgDeep"><option value="1" ${cfg.deep_monthly ? 'selected' : ''}>Sí (día 1 del mes)</option><option value="0" ${!cfg.deep_monthly ? 'selected' : ''}>No</option></select></div>
        <div><label class="flabel">Días del barrido</label>
          <input type="number" id="axEgDeepDays" min="1" max="365" value="${cfg.deep_days != null ? cfg.deep_days : 180}" style="width:110px">
          <p class="muted" style="font-size:11px;margin:6px 0 0">Máximo probado: 200 (365 excede el tiempo del sistema).</p></div>
      </div>
      <div class="cfg-grid3" style="margin-top:12px">
        <div><label class="flabel">Reintento si falla <span class="muted">(minutos, 0 = no)</span></label>
          <input type="number" id="axEgRetry" min="0" max="720" value="${cfg.retry_minutes != null ? cfg.retry_minutes : 60}" style="width:110px"></div>
      </div>
      <details style="margin-top:14px">
        <summary class="muted" style="cursor:pointer;font-size:12.5px">Opciones avanzadas</summary>
        <div style="margin-top:10px"><label class="flabel">URL del portal <span class="muted">(donde corre /api/ax-sync)</span></label>
          <input type="text" id="axEgUrl" value="${escH(cfg.endpoint_url || '')}" placeholder="https://nominav2.pages.dev">
          <p class="muted" style="font-size:11.5px;margin:6px 0 0">El cron llama a esta URL. Si se deja vacío, usa el valor por defecto.</p></div>
      </details>
      <div class="cfg-foot"><span class="cfg-saved" id="axEgSaved">✓ Guardado</span><button class="btn btn-primary" id="axEgSave">Guardar programación</button></div>
    </div>`;

  /* Guardar — mismo efecto que las otras tarjetas (cfgSaveFlash vive en
     panel.js y no se exporta: efecto equivalente, autocontenido). */
  $('#axEgSave').addEventListener('click', async () => {
    const btn = $('#axEgSave'); const sv = $('#axEgSaved');
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…';
    const t = ($('#axEgTime').value || '08:15').split(':');
    const r = await api({
      action: 'cfg_set', user,
      config: {
        enabled: $('#axEgEnabled').value === '1',
        frequency: $('#axEgFreq').value,
        daily_hour: +t[0] || 0,
        daily_minute: +t[1] || 0,
        days_back: +$('#axEgDays').value,
        deep_monthly: $('#axEgDeep').value === '1',
        deep_days: +$('#axEgDeepDays').value,
        retry_minutes: +$('#axEgRetry').value,
        endpoint_url: $('#axEgUrl').value.trim(),
      },
    });
    btn.disabled = false;
    if (!r || !r.ok) { btn.textContent = '✗ No se guardó'; setTimeout(() => { btn.textContent = orig; }, 2600); return; }
    btn.textContent = orig;
    if (sv) { sv.style.display = 'inline'; setTimeout(() => { sv.style.display = 'none'; }, 2500); }
  });

  /* Ejecutar ahora — el MISMO camino del tick (egresos_cron), con la
     ventana que está en pantalla. Según los días puede tardar ~40-70 s. */
  $('#axEgRunBtn').addEventListener('click', async () => {
    const b = $('#axEgRunBtn'); b.disabled = true; const prev = b.textContent; b.textContent = 'Ejecutando…';
    const el = $('#axEgLast');
    if (el) el.innerHTML = '<span class="muted">Consultando egresos y aplicando al portal… (puede tardar hasta un minuto según la ventana)</span>';
    const days = Math.max(1, Math.min(365, +$('#axEgDays').value || 30));
    let r = null;
    try { r = await api({ source: 'cron', action: 'egresos_cron', adminId: user.id, days, manual: true }); } catch (_) { /* abajo se repinta el estado real */ }
    const fresh = await api({ action: 'cfg_get', user });
    if (fresh && fresh.ok && el) el.innerHTML = lastHtml(fresh.config || {});
    else if (el) el.innerHTML = `<span style="color:#b91c1c">⚠ ${escH((r && r.error) || 'No se pudo ejecutar.')}</span>`;
    b.disabled = false; b.textContent = prev;
  });
}
