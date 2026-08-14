/* =====================================================================
   js/views/doc-control.js — "Control de recaudos"               (v6.226)

   Que recaudos tiene cada trabajador, cuales le faltan y cuales cargo con
   un problema.

   DE DONDE SALE. Los componentes de la ficha (RIF, referencia bancaria)
   validan al cargar y guardan el resultado desde julio. Esa columna solo
   aparecia en los tres modulos que la ESCRIBEN: nadie la leia. Habia
   referencias con la cedula cambiada y RIF vencidos, detectados y guardados,
   sin una sola pantalla que los mostrara. Esta pantalla no valida nada: lee
   lo que ya estaba escrito.

   QUE SE ALERTA Y QUE NO (v6.229). Solo lo que DISCRIMINA. La alerta por
   NOMBRE se retiro despues de revisar los datos: de 97 avisos, ninguno era
   un documento equivocado. En la referencia bancaria el nombre lo escribe el
   banco -y en 36 casos el parser ni pudo leerlo-; en el RIF, la ficha trae
   el nombre abreviado de AX y el PDF el legal completo, asi que la
   comparacion falla siempre. Se revisaron los 8 casos donde el nombre SI se
   leyo y era distinto: los 8 eran la misma persona, con la cedula correcta.

   DOS COSAS SEPARADAS, Y NO ES UN DETALLE:
     ADVERTENCIAS  ~120. Alguien mando el papel y algo no cuadra. Se puede
                   terminar. Es una lista de tareas.
     FALTANTES     ~4650. Solo 4 de 134 tiendas estan al dia con la
                   referencia bancaria y la tienda promedio debe 12 de sus
                   16 personas. Eso no es una lista: es un programa.
   Van separadas porque una lista que no se puede terminar deja de leerse,
   y mezclarlas convierte 120 casos accionables en ruido dentro de 4650.
   Por eso las advertencias van SIEMPRE primero en el orden.

   EL FALTANTE NO ES UN REPROCHE. Muchos de esos papeles dependen de que el
   empleado los traiga, no de la gestion del gerente. Esta pantalla es su
   herramienta para reclamar, no la lista de sus incumplimientos, y los
   textos estan escritos con ese criterio.
   ===================================================================== */

import { $ } from '../core/dom.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fdate = (iso) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return (d && m) ? `${d}/${m}/${y}` : iso; };

export async function renderDocControl(user) {
  const host = $('#pnlMain');
  host.innerHTML = '<div class="pnl-loading">Cargando…</div>';

  const ST = { tipo: '', estado: 'advertencia', q: '', resumen: null, data: null };

  const api = (payload) => fetch('/api/doc-control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, user }),
  }).then(r => r.json()).catch(() => null);

  async function cargar() {
    const [res, lis] = await Promise.all([
      ST.resumen ? Promise.resolve(ST.resumen) : api({ action: 'resumen' }),
      api({ action: 'list', tipo: ST.tipo, estado: ST.estado, q: ST.q }),
    ]);
    ST.resumen = res; ST.data = lis;
    pintar();
  }

  function tarjetas(r) {
    if (!r || !r.ok) return '';
    /* La tarjeta de advertencias cuenta PERSONAS y no documentos: para
       quien mira, dos problemas de la misma persona son una conversacion,
       no dos. El total de documentos va abajo, chico. */
    return `<div class="dc-stats">
      <div class="dc-stat dc-stat-w">
        <div class="dc-stat-l">Con advertencia</div>
        <div class="dc-stat-v">${r.personas_con_advertencia || 0}</div>
        <div class="dc-stat-u">persona${r.personas_con_advertencia === 1 ? '' : 's'} · ${r.advertencias || 0} documento${r.advertencias === 1 ? '' : 's'}</div>
      </div>
      <div class="dc-stat">
        <div class="dc-stat-l">Recaudos faltantes</div>
        <div class="dc-stat-v">${r.faltantes || 0}</div>
        <div class="dc-stat-u">sobre ${(r.personas || 0) * 3} esperados</div>
      </div>
      ${(r.por_tipo || []).map(t => `<div class="dc-stat">
        <div class="dc-stat-l">${esc(t.label)}</div>
        <div class="dc-stat-v">${t.ok || 0}</div>
        <div class="dc-stat-u">al día${t.advertencia ? ` · ${t.advertencia} con aviso` : ''}</div>
      </div>`).join('')}
    </div>`;
  }

  function fila(f) {
    const adv = f.estado === 'advertencia';
    return `<tr class="${adv ? 'dc-adv' : ''}">
      <td><b>${esc(f.worker_name || '')}</b><div class="rc-sub">${esc(f.id_number)}</div></td>
      <td>${esc(f.company_code)}</td>
      <td>${esc(f.doc_label || f.doc_type)}</td>
      <td>${adv
        ? `<span class="pill pill-pend">Revisar</span>`
        : `<span class="pill pill-out">Falta</span>`}</td>
      <td class="dc-det">${adv ? esc(f.detalle || '') : '<span class="muted">Todavía no se cargó</span>'}</td>
      <td>${adv ? fdate(f.cargado_at) : ''}</td>
    </tr>`;
  }

  function pintar() {
    const d = ST.data;
    if (!d || !d.ok) {
      host.innerHTML = `<div class="pnl-head"><div><h1>Control de recaudos</h1></div></div>
        <div class="card"><p class="muted" style="margin:0">${esc(d ? d.error : 'Error de red.')}</p></div>`;
      return;
    }
    const filas = d.filas || [];

    host.innerHTML = `
      <div class="pnl-head"><div><h1>Control de recaudos</h1>
        <p>Qué recaudos tiene cada persona, cuáles faltan y cuáles se cargaron con algún problema.</p></div></div>
      <div class="card">
        ${tarjetas(ST.resumen)}

        <div class="dc-bar">
          <label>Ver <select id="dcEstado">
            <option value="advertencia" ${ST.estado === 'advertencia' ? 'selected' : ''}>Con advertencia</option>
            <option value="falta" ${ST.estado === 'falta' ? 'selected' : ''}>Faltantes</option>
            <option value="" ${ST.estado === '' ? 'selected' : ''}>Todo lo pendiente</option>
          </select></label>
          <label>Recaudo <select id="dcTipo">
            <option value="">Todos</option>
            <option value="bank_reference" ${ST.tipo === 'bank_reference' ? 'selected' : ''}>Referencia bancaria</option>
            <option value="rif" ${ST.tipo === 'rif' ? 'selected' : ''}>RIF</option>
            <option value="cedula" ${ST.tipo === 'cedula' ? 'selected' : ''}>Cédula</option>
          </select></label>
          <div class="hsearch" style="max-width:280px">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input id="dcQ" placeholder="Nombre o cédula…" value="${esc(ST.q)}">
          </div>
          <span style="flex:1"></span>
          <span class="rc-sub">${d.total} pendiente${d.total === 1 ? '' : 's'}${d.truncado ? ' · se muestran los primeros 500' : ''}</span>
        </div>

        ${ST.estado === 'falta' || ST.estado === '' ? `<div class="dc-nota">
          Muchos de estos papeles dependen de que la persona los entregue. Esta lista
          es para poder reclamarlos, no un listado de incumplimientos de la tienda.
        </div>` : ''}

        ${filas.length ? `<table class="dtl-table dc-table"><thead><tr>
          <th>Trabajador</th><th>Empresa</th><th>Recaudo</th><th>Estado</th><th>Detalle</th><th>Cargado</th>
        </tr></thead><tbody>${filas.map(fila).join('')}</tbody></table>`
          : `<p class="hint">${ST.estado === 'advertencia'
            ? 'No hay recaudos con advertencia. Todo lo que se cargó validó bien.'
            : 'No hay recaudos pendientes con estos filtros.'}</p>`}
      </div>`;

    $('#dcEstado').addEventListener('change', e => { ST.estado = e.target.value; cargar(); });
    $('#dcTipo').addEventListener('change', e => { ST.tipo = e.target.value; cargar(); });
    let t = null;
    $('#dcQ').addEventListener('input', e => {
      clearTimeout(t); const v = e.target.value;
      t = setTimeout(() => { ST.q = v; cargar(); }, 350);
    });
  }

  await cargar();
}
