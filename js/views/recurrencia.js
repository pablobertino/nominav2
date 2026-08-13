/* =====================================================================
   js/views/recurrencia.js — "Recurrencia de reportes"           (v6.214)

   Donde se repiten los marcajes manuales y las ausencias. DOS vistas, no
   un ranking, y la separacion no es cosmetica: de 578 lineas de marcaje
   manual medidas el 13/08, solo 99 (17%) tienen una causa imputable a la
   persona. Lo demas es el sistema — altas sin enrolar en el biometrico,
   problemas electricos, tiendas que directamente no tienen aparato.

   Si esto fuera un solo ranking de personas, arriba de todo estarian las 21
   de AL01: 5 marcajes manuales cada una porque estan prestadas a otra
   tienda. La pantalla de "casos sospechosos" empezaria señalando gente por
   hacer bien su trabajo.

   POR TIENDA: donde falla el sistema. La columna que la hace honesta es
   "de la persona": AL01 tiene 110 marcajes y CERO atribuibles.
   POR PERSONA: solo causas atribuibles, y SIEMPRE con el promedio de su
   tienda al lado. Dos olvidos donde el resto tiene dos no es lo mismo que
   dos donde el resto tiene cero, y el numero solo no lo distingue.

   EL PERIODO IMPORTA y por eso no hay modo "todo": una tienda con 110
   marcajes en seis meses y otra con 110 en una semana no son el mismo
   problema. Arranca en la quincena en curso, que es la unidad con la que
   ya se mira todo lo demas en el portal.
   ===================================================================== */

import { $ } from '../core/dom.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ddmm = (iso) => { if (!iso) return '—'; const [, m, d] = String(iso).slice(0, 10).split('-'); return (d && m) ? `${d}/${m}` : iso; };

/* Quincena que contiene a hoy, para arrancar en algo con sentido si el
   calendario todavia no tiene el periodo cargado. */
function quincenaDeHoy() {
  const h = new Date();
  const y = h.getFullYear(); const m = h.getMonth() + 1; const d = h.getDate();
  const p = (n) => String(n).padStart(2, '0');
  return d <= 15
    ? { desde: `${y}-${p(m)}-01`, hasta: `${y}-${p(m)}-15` }
    : { desde: `${y}-${p(m)}-16`, hasta: new Date(y, m, 0).toISOString().slice(0, 10) };
}

export async function renderRecurrencia(user) {
  const host = $('#pnlMain');
  host.innerHTML = '<div class="pnl-loading">Cargando…</div>';

  const ST = { ...quincenaDeHoy(), min: 2, tab: 'tiendas', data: null };

  async function cargar() {
    const d = await fetch('/api/recurrencia', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', user, desde: ST.desde, hasta: ST.hasta, min: ST.min }),
    }).then(r => r.json()).catch(() => null);
    ST.data = d;
    pintar();
  }

  function filaTienda(t) {
    const silenciada = !!t.silencio_hasta;
    /* La silenciada NO se esconde: se apaga. Si desapareciera, silenciar
       seria una forma de hacer desaparecer problemas sin que nadie se
       entere; asi sigue a la vista, con su motivo y su vencimiento. */
    const acc = ST.data.puede_silenciar
      ? (silenciada
        ? `<button class="btn btn-sm" data-lev="${esc(t.company_code)}">Reactivar</button>`
        : `<button class="btn btn-sm" data-sil="${esc(t.company_code)}">Silenciar</button>`)
      : '';
    return `<tr class="${silenciada ? 'rc-off' : ''}">
      <td><b>${esc(t.company_code)}</b></td>
      <td style="text-align:right">${t.marcajes}</td>
      <td style="text-align:right">${t.ausencias}</td>
      <td style="text-align:right"><b>${t.por_persona == null ? '—' : t.por_persona}</b>
        <div class="rc-sub">${t.personas} persona${t.personas === 1 ? '' : 's'}</div></td>
      <td>${esc(t.causa_top || '—')}${t.causa_top_n ? ` <span class="rc-sub">×${t.causa_top_n}</span>` : ''}</td>
      <td style="text-align:right">${t.atribuibles
        ? `<b class="rc-att">${t.atribuibles}</b>`
        : '<span class="muted">0</span>'}</td>
      <td>${ddmm(t.ultimo)}</td>
      <td>${silenciada
        ? `<span class="rc-silpill" title="${esc(t.silencio_motivo || '')}">🔕 al ${ddmm(t.silencio_hasta)}</span>`
        : ''}${acc}</td>
    </tr>`;
  }

  function filaPersona(p) {
    const silenciada = !!p.silencio_hasta;
    const acc = ST.data.puede_silenciar
      ? (silenciada
        ? `<button class="btn btn-sm" data-levp="${esc(p.id_number)}">Reactivar</button>`
        : `<button class="btn btn-sm" data-silp="${esc(p.id_number)}">Silenciar</button>`)
      : '';
    return `<tr class="${silenciada ? 'rc-off' : ''}">
      <td><b>${esc(p.worker_name || '')}</b><div class="rc-sub">${esc(p.id_number)}</div></td>
      <td>${esc(p.company_code)}</td>
      <td style="text-align:right"><b>${p.eventos}</b></td>
      <td style="text-align:right">${p.prom_tienda}</td>
      <td style="text-align:right">${p.veces_prom == null ? '—' : `${p.veces_prom}×`}</td>
      <td>${ddmm(p.ultimo)}</td>
      <td>${silenciada
        ? `<span class="rc-silpill" title="${esc(p.silencio_motivo || '')}">🔕 al ${ddmm(p.silencio_hasta)}</span>`
        : ''}${acc}</td>
    </tr>`;
  }

  function pintar() {
    const d = ST.data;
    if (!d || !d.ok) {
      host.innerHTML = `<div class="pnl-head"><div><h1>Recurrencia de reportes</h1></div></div>
        <div class="card"><p class="muted" style="margin:0">${esc(d ? d.error : 'Error de red.')}</p></div>`;
      return;
    }
    const tiendas = d.tiendas || [];
    const personas = d.personas || [];
    const sinBio = tiendas.filter(t => (t.causa_top || '').startsWith('Sin dispositivo')).length;
    const luz = tiendas.filter(t => (t.causa_top || '').startsWith('Problema el')).length;
    const silenciadas = tiendas.filter(t => t.silencio_hasta).length;

    const opts = (d.periodos || []).map(p =>
      `<option value="${p.range_start}|${p.range_end}" ${p.range_start === ST.desde ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

    host.innerHTML = `
      <div class="pnl-head"><div><h1>Recurrencia de reportes</h1>
        <p>Dónde se repiten los marcajes manuales y las ausencias. Las fallas de la tienda y las de la persona se miran por separado.</p></div></div>

      <div class="card">
        <div class="rc-bar">
          <label>Período <select id="rcPer">${opts}</select></label>
          <span class="rc-rango">${ddmm(ST.desde)} → ${ddmm(ST.hasta)}</span>
          <span style="flex:1"></span>
          <div class="rc-tabs">
            <button class="btn btn-sm ${ST.tab === 'tiendas' ? 'btn-primary' : ''}" data-tab="tiendas">Por tienda · ${tiendas.length}</button>
            <button class="btn btn-sm ${ST.tab === 'personas' ? 'btn-primary' : ''}" data-tab="personas">Por persona · ${personas.length}</button>
          </div>
        </div>

        ${ST.tab === 'tiendas' ? `
          <div class="rc-stats">
            <div class="rc-stat"><div class="rc-stat-l">Sin biométrico</div><div class="rc-stat-v rc-danger">${sinBio}</div></div>
            <div class="rc-stat"><div class="rc-stat-l">Problema eléctrico</div><div class="rc-stat-v rc-warn">${luz}</div></div>
            <div class="rc-stat"><div class="rc-stat-l">Tiendas con reportes</div><div class="rc-stat-v">${tiendas.length}</div></div>
            <div class="rc-stat"><div class="rc-stat-l">Silenciadas</div><div class="rc-stat-v">${silenciadas}</div></div>
          </div>
          ${tiendas.length ? `<table class="dtl-table rc-table"><thead><tr>
            <th>Tienda</th><th style="text-align:right">Marcajes</th><th style="text-align:right">Ausencias</th>
            <th style="text-align:right">Por persona</th><th>Causa dominante</th>
            <th style="text-align:right" title="Marcajes cuya causa es imputable a la persona (olvido, cierre temprano). El resto son fallas del sistema.">De la persona</th>
            <th>Último</th><th></th>
          </tr></thead><tbody>${tiendas.map(filaTienda).join('')}</tbody></table>`
            : '<p class="hint">Ninguna tienda reportó marcajes manuales ni ausencias en este período.</p>'}
        ` : `
          ${personas.length ? `<table class="dtl-table rc-table"><thead><tr>
            <th>Trabajador</th><th>Tienda</th><th style="text-align:right">Eventos</th>
            <th style="text-align:right" title="Promedio de esta misma tienda">Prom. tienda</th>
            <th style="text-align:right">Veces</th><th>Último</th><th></th>
          </tr></thead><tbody>${personas.map(filaPersona).join('')}</tbody></table>`
            : `<p class="hint">Nadie llega a ${ST.min} eventos de causa atribuible en este período. Solo se cuentan olvido de marcaje y cierre temprano: las fallas del biométrico, la electricidad y las altas sin enrolar no son de la persona.</p>`}
        `}
      </div>`;

    $('#rcPer').addEventListener('change', (e) => {
      const [a, b] = e.target.value.split('|');
      ST.desde = a; ST.hasta = b; cargar();
    });
    host.querySelectorAll('[data-tab]').forEach(b =>
      b.addEventListener('click', () => { ST.tab = b.dataset.tab; pintar(); }));
    host.querySelectorAll('[data-sil]').forEach(b =>
      b.addEventListener('click', () => modalSilencio('tienda', b.dataset.sil)));
    host.querySelectorAll('[data-silp]').forEach(b =>
      b.addEventListener('click', () => modalSilencio('persona', b.dataset.silp)));
    host.querySelectorAll('[data-lev]').forEach(b =>
      b.addEventListener('click', () => levantar('tienda', b.dataset.lev)));
    host.querySelectorAll('[data-levp]').forEach(b =>
      b.addEventListener('click', () => levantar('persona', b.dataset.levp)));
  }

  /* El modal pide las dos cosas que la base exige. No es burocracia: sin
     motivo, el que lo lea en dos meses no sabe si sigue valiendo; sin
     fecha, la alarma queda apagada para siempre y nadie se entera. */
  function modalSilencio(ambito, clave) {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    const en30 = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
    ov.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <div class="modal-head"><span>Silenciar ${ambito === 'tienda' ? 'la tienda' : 'a'} ${esc(clave)}</span>
          <button class="modal-x" data-x aria-label="Cerrar">✕</button></div>
        <div style="padding:16px 18px">
          <p class="confirm-msg">Deja de avisar sobre esta recurrencia hasta la fecha que indiques.
            La fila <b>sigue apareciendo</b>, apagada y con el motivo a la vista.</p>
          <label class="flabel">Motivo</label>
          <input type="text" id="rcMot" placeholder="Ej: sin biométrico, equipo pedido el 05/08" maxlength="300">
          <label class="flabel" style="margin-top:10px">Hasta</label>
          <input type="date" id="rcHasta" value="${en30}">
          <p class="hint" style="margin-top:8px">Cuando llegue esa fecha vuelve a contar solo. No hay silencio permanente.</p>
          <div id="rcErr" class="rc-err"></div>
        </div>
        <div class="modal-actions">
          <button class="btn" data-x>Cancelar</button>
          <button class="btn btn-primary" id="rcOk">Silenciar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const cerrar = () => ov.remove();
    ov.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', cerrar));
    ov.querySelector('#rcOk').addEventListener('click', async () => {
      const motivo = ov.querySelector('#rcMot').value.trim();
      const hasta = ov.querySelector('#rcHasta').value;
      const err = ov.querySelector('#rcErr');
      if (motivo.length < 5) { err.textContent = 'Escribí el motivo (al menos unas palabras).'; return; }
      const r = await fetch('/api/recurrencia', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'silenciar', user, ambito, clave, motivo, hasta }),
      }).then(x => x.json()).catch(() => null);
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'No se pudo silenciar.'; return; }
      cerrar(); cargar();
    });
  }

  async function levantar(ambito, clave) {
    await fetch('/api/recurrencia', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'levantar', user, ambito, clave }),
    }).then(x => x.json()).catch(() => null);
    cargar();
  }

  await cargar();
}
