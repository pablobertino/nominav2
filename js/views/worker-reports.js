/* =====================================================================
   js/views/worker-reports.js — "Reportes del trabajador"        (v6.213)

   Todo lo que se reporto de UNA persona, en una pantalla propia que se abre
   desde su ficha (Personal → ficha → boton Reportes).

   POR QUE PANTALLA Y NO MODAL: porque lo que se viene a buscar no es la
   lista, son los TOTALES. Saber que alguien tiene 9 marcajes manuales es el
   dato; verlos uno por uno es la comprobacion. Un modal obliga a elegir
   entre las dos cosas, y ademas el portal ya navega asi -Personal,
   Movimientos, el Detalle del reporte- con su "Volver": un modal seria el
   unico que no.

   NAVEGACION ENCADENADA: ficha → Reportes → Detalle del reporte → Volver
   trae a Reportes → Volver trae a la ficha. Cada pantalla recuerda de donde
   vino, con el mismo patron de onExit que ya usa el resto del portal.

   LO QUE ESTA PANTALLA NO HACE: no interpreta. La primera version llevaba un
   aviso que marcaba "9 marcajes manuales en 9 dias" como patron sospechoso.
   Al mirar los datos reales, la causa que habia escrito la tienda era "esta
   presentado apoyo a otra tienda": la persona no se olvidaba de marcar,
   estaba prestada a otra sucursal y por eso no pasaba por su biometrico. El
   aviso habria estado señalando a alguien por hacer bien su trabajo. Los
   numeros se muestran; la conclusion la saca quien mira, que tiene contexto
   que el portal no tiene.

   ALCANCE: la lista viene ya filtrada por el backend con la MISMA reja del
   Historial. Si quedaron reportes afuera se dice CUANTOS -no cuales-, porque
   mostrar 2 de 5 en silencio invita a sacar conclusiones sobre un historial
   incompleto creyendolo completo.
   ===================================================================== */

import { $ } from '../core/dom.js';
import { initialsOf, avatarColors } from '../core/avatar.js';
import { attPill } from '../reports/shared/ticket-actions.js';
import { showReportDetail } from '../reports/report-detail.js';

const TYPES = {
  marcaje:      { label: 'Marcaje Manual', icon: '🕐' },
  ausencia:     { label: 'Período de Ausencia', icon: '📅' },
  ingreso:      { label: 'Ingreso — Alta', icon: '✅' },
  egreso:       { label: 'Egreso — Baja', icon: '🔴' },
  modificacion: { label: 'Modificación de Datos', icon: '✏️' },
  traslado:     { label: 'Traslado', icon: '🔁' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* timestamptz -> 'DD/MM/AAAA' en hora Caracas (GMT-4). Mismo corrimiento que
   usa el Historial: sin el, un reporte enviado a las 21:00 de Caracas
   aparece con la fecha del dia siguiente. */
function fmtFecha(iso) {
  if (!iso) return '—';
  const dt = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(dt)) return String(iso).slice(0, 10);
  const car = new Date(dt.getTime() - 4 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(car.getUTCDate())}/${p(car.getUTCMonth() + 1)}/${car.getUTCFullYear()}`;
}
function ddmm(iso) {
  const f = fmtFecha(iso);
  return f.length === 10 ? f.slice(0, 5) : f;
}

/* Tarjeta de total. El numero manda; la etiqueta explica. */
function statCard(label, valor, tono) {
  const color = tono ? ` style="color:${tono}"` : '';
  return `<div class="wr-stat"><div class="wr-stat-l">${esc(label)}</div>
    <div class="wr-stat-v"${color}>${esc(String(valor))}</div></div>`;
}

/**
 * Pinta la pantalla.
 * @param {object} user   sesion
 * @param {object} w      el trabajador tal como lo tiene la ficha
 *                        ({ id_number, ced_kind, full_name, role, thumb_url })
 * @param {string} companyCode  tienda desde la que se entro (para la cabecera)
 * @param {function} onExit     volver a la ficha
 */
export async function renderWorkerReports(user, w, companyCode, onExit) {
  const host = $('#pnlMain');
  host.innerHTML = '<div class="pnl-loading">Cargando reportes…</div>';

  const d = await fetch('/api/reports-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'worker_reports', user, id_number: w.id_number }),
  }).then(r => r.json()).catch(() => null);

  const volver = () => { if (onExit) onExit(); };

  if (!d || !d.ok) {
    host.innerHTML = `<button class="btn" id="wrBack" style="margin-bottom:18px">← Volver a la ficha</button>
      <div class="card"><p class="muted" style="margin:0">No se pudieron cargar los reportes: ${esc(d ? d.error : 'error de red')}.</p></div>`;
    $('#wrBack').addEventListener('click', volver);
    return;
  }

  const rows = d.rows || [];
  const fuera = d.fuera_de_alcance || 0;

  // --- Totales. Marcaje y ausencia tienen tarjeta propia porque son los dos
  //     que se repiten en el tiempo; los demas son eventos de una vez.
  const nMarcaje = rows.filter(r => r.type === 'marcaje').length;
  const nAusencia = rows.filter(r => r.type === 'ausencia').length;
  const nAbiertos = rows.filter(r => r.attention !== 'closed').length;
  const ultimo = rows.length ? ddmm(rows[0].sent_at) : '—';

  const cabecera = `
    <div class="wr-head">
      ${w.thumb_url
        ? `<div class="wr-ava"><img src="${esc(w.thumb_url)}" alt=""></div>`
        : (() => { const c = avatarColors(w.id_number);
            return `<div class="wr-ava" style="background:${c.bg};color:${c.fg}">${esc(initialsOf(w.full_name))}</div>`; })()}
      <div class="wr-head-id">
        <div class="wr-head-n">${esc(w.full_name || '')}</div>
        <div class="wr-head-s">${esc(w.ced_kind ? `${w.ced_kind}-${w.id_number}` : w.id_number)}${w.role ? ' · ' + esc(w.role) : ''}${companyCode ? ' · ' + esc(companyCode) : ''}</div>
      </div>
    </div>`;

  const stats = `
    <div class="wr-stats">
      ${statCard('Reportes', rows.length)}
      ${statCard('Marcaje manual', nMarcaje, nMarcaje ? 'var(--warn)' : '')}
      ${statCard('Período de ausencia', nAusencia)}
      ${statCard('Sin atender', nAbiertos)}
      ${statCard('Último', ultimo)}
    </div>`;

  /* Cuantos no se ven por alcance. Sin esto, un historial recortado se lee
     como un historial completo. */
  const nota = fuera
    ? `<div class="wr-nota">Hay <b>${fuera}</b> reporte${fuera === 1 ? '' : 's'} más de esta persona en tiendas fuera de tu alcance. No se muestran acá.</div>`
    : '';

  const tabla = rows.length
    ? `<table class="dtl-table wr-table"><thead><tr>
        <th>Fecha</th><th>Tipo</th><th>Qué se reportó</th><th>Tienda</th><th>Estado</th><th>Reporte</th>
      </tr></thead><tbody>
        ${rows.map(r => {
          const t = TYPES[r.type] || { label: r.type, icon: '📄' };
          const est = r.ax_published
            ? '<span class="pill att-closed">Publicado en AX</span>'
            : attPill(r.attention);
          return `<tr>
            <td>${fmtFecha(r.sent_at)}</td>
            <td><span class="wr-tipo">${t.icon} ${esc(t.label)}</span></td>
            <td class="wr-res">${esc(r.resumen)}</td>
            <td>${esc(r.company_code || '—')}</td>
            <td>${est}</td>
            <td><button type="button" class="wr-link" data-rep="${r.report_id}">N° ${r.report_id}</button></td>
          </tr>`;
        }).join('')}
      </tbody></table>`
    : `<p class="hint">A esta persona nunca la incluyeron en un reporte${fuera ? ' que puedas ver' : ''}.</p>`;

  host.innerHTML = `
    <button class="btn" id="wrBack" style="margin-bottom:18px">← Volver a la ficha</button>
    <div class="pnl-head"><div><h1>Reportes del trabajador</h1>
      <p>Todo lo que las tiendas reportaron sobre esta persona, de más reciente a más antiguo.</p></div></div>
    <div class="card">
      ${cabecera}
      ${stats}
      ${nota}
      ${tabla}
    </div>`;

  $('#wrBack').addEventListener('click', volver);

  /* Al abrir un reporte, el "Volver" de ahi trae de vuelta A ESTA pantalla y
     no al Historial: se entro desde la ficha, no desde el listado. */
  host.querySelectorAll('[data-rep]').forEach(b => {
    b.addEventListener('click', () => {
      showReportDetail({
        reportId: parseInt(b.dataset.rep, 10),
        user,
        onBack: () => renderWorkerReports(user, w, companyCode, onExit),
      });
    });
  });
}
