/* =====================================================================
   js/reports/shared/publish-ax.js                            (v6.168)
   Modal de "Publicar en AX" para los reportes de Marcaje Manual.
   Lo usan el Historial (js/reports/history.js) y la pantalla de Detalle
   (js/reports/report-detail.js), para que el aviso y el resultado se vean
   IGUAL en los dos sitios.

   Tres momentos, en el mismo cuadro:
     1) AVISO. Esto no es un guardar cualquiera: escribe en AX 2012 y, si
        entran todas las lineas, cierra el reporte y su ticket PARA
        SIEMPRE. Se dice con todas las letras antes de tocar nada.
     2) EN CURSO. El backend manda todo en UN lote, asi que no hay avance
        linea por linea que mostrar: seria mentir con una barra que no
        sabe nada. Se muestra una espera honesta.
     3) RESULTADO. Una fila por marcaje, con lo que dijo AX de cada uno.
        Si alguno fallo, el reporte queda ABIERTO y se explica que
        reintentar es seguro (AX omite lo que ya esta cargado).

   Sin onclick inline: la CSP del sitio los bloquea.
   ===================================================================== */

import { postPublishAx } from './ticket-actions.js';

/* Flecha de "publicar", IDENTICA a la de Sincronizacion > Publicar
   (.axr-btn-pub en js/views/ax-review.js). Vive aca para que el Historial y
   el Detalle la saquen del mismo sitio: en el portal, esta flecha ambar
   significa siempre lo mismo — algo sale del portal y entra a AX. */
export const AX_ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : iso;
}

/* Horas de una linea. En Descanso no se muestran horas porque no las tiene:
   el portal las deja vacias y a AX se le mandan en 0. */
function fmtHoras(l) {
  if (l.day_type === 'D') return '<span class="pill pill-pend">Descanso</span>';
  const a = l.time_in || '—', b = l.time_out || '—';
  return `<span class="time-badge">${esc(a)}</span> → <span class="time-badge">${esc(b)}</span>`;
}

const ESTADO = {
  ok:      { cls: 'att-closed',   txt: 'Publicado' },
  omitida: { cls: 'att-resolved', txt: 'Ya estaba' },
  error:   { cls: 'pill-out',     txt: 'No entró' },
};

function lineasTabla(lineas) {
  if (!lineas || !lineas.length) return '';
  return `<div class="pax-tablewrap"><table class="dtl-table pax-table"><thead><tr>
      <th>Trabajador</th><th>Fecha</th><th>Horas</th><th>Estado</th><th>Detalle</th>
    </tr></thead><tbody>
    ${lineas.map(l => {
      const e = ESTADO[l.status] || ESTADO.error;
      const detalle = l.error || l.mensaje || '';
      return `<tr class="pax-${l.status}">
        <td><b>${esc(l.worker_name || '—')}</b><div class="pax-ced">${esc(l.worker_id_number)}</div></td>
        <td>${fmtDate(l.mark_date)}</td>
        <td>${fmtHoras(l)}</td>
        <td><span class="pill ${e.cls}">${e.txt}</span></td>
        <td class="pax-msg">${esc(detalle)}</td>
      </tr>`;
    }).join('')}
  </tbody></table></div>`;
}

/**
 * Abre el modal de publicacion.
 * @param {object} opts
 *   user      sesion
 *   report    { id, company_code, company_name, workers_count }
 *   onDone    callback(resultado) cuando se publico algo (para refrescar)
 * Devuelve una Promesa que resuelve al cerrar: el JSON del backend o null.
 */
export function openPublishAxModal({ user, report, onDone }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    document.body.appendChild(ov);

    let resultado = null;
    let cerrado = false;
    const finish = () => {
      if (cerrado) return; cerrado = true;
      document.removeEventListener('keydown', onKey);
      ov.remove();
      if (resultado && onDone) onDone(resultado);
      resolve(resultado);
    };
    // Escape solo sirve mientras NO se esta publicando: cortar a mitad de
    // camino no cancela nada del lado de AX y solo confunde.
    let publicando = false;
    const onKey = (e) => { if (e.key === 'Escape' && !publicando) finish(); };
    document.addEventListener('keydown', onKey);

    const wire = () => {
      ov.querySelectorAll('[data-act="close"]').forEach(b => b.addEventListener('click', finish));
      const go = ov.querySelector('[data-act="go"]');
      if (go) go.addEventListener('click', publicar);
    };

    // ---------- 1) AVISO ----------
    const nombre = report.company_name ? `${report.company_code} · ${report.company_name}` : report.company_code;
    const cuantos = report.workers_count || 0;
    const pintarAviso = () => {
      ov.innerHTML = `
        <div class="modal-box pax-box" role="dialog" aria-modal="true">
          <div class="modal-head">
            <span>Publicar en AX — Reporte N° ${report.id}</span>
            <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button>
          </div>
          <div class="pax-body">
            <p class="confirm-msg">Se van a cargar en <b>AX 2012</b> los marcajes de
              <b>${esc(nombre)}</b>${cuantos ? ` (${cuantos} trabajador${cuantos === 1 ? '' : 'es'})` : ''}.</p>
            <div class="pax-warn">
              <b>Esto no se puede deshacer desde el portal.</b>
              Si entran todas las líneas, el reporte queda <b>Cerrado</b>, su ticket
              en osTicket también, y ya no podrá volver a ningún estado anterior.
              <div class="pax-warn-soft">Si alguna línea no entra, el reporte sigue abierto
                y se puede reintentar: lo que ya se cargó no se duplica.</div>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn" data-act="close">Cancelar</button>
            <button class="btn btn-ax" data-act="go">${AX_ARROW} Publicar en AX</button>
          </div>
        </div>`;
      wire();
      const go = ov.querySelector('[data-act="go"]');
      if (go) go.focus();
    };

    // ---------- 2) EN CURSO ----------
    const pintarEnCurso = () => {
      ov.innerHTML = `
        <div class="modal-box pax-box" role="dialog" aria-modal="true">
          <div class="modal-head"><span>Publicando en AX…</span></div>
          <div class="pax-body pax-working">
            <div class="pax-bar"><span></span></div>
            <p class="confirm-msg">Enviando los marcajes a AX 2012. Puede tardar unos segundos.</p>
            <p class="hint">No cierres esta ventana ni recargues la página.</p>
          </div>
        </div>`;
    };

    // ---------- 3) RESULTADO ----------
    const pintarResultado = (d) => {
      if (!d) {
        ov.innerHTML = `
          <div class="modal-box pax-box notice-error" role="dialog" aria-modal="true">
            <div class="modal-head"><span>No se pudo publicar</span>
              <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button></div>
            <div class="pax-body"><p class="confirm-msg">Se perdió la conexión con el servidor.
              Nada quedó a medias del lado del portal: podés reintentar sin problema.</p></div>
            <div class="modal-actions"><button class="btn btn-primary" data-act="close">Entendido</button></div>
          </div>`;
        wire();
        return;
      }

      // Rechazo del backend (permisos, alcance, lineas repetidas, sin key...).
      if (!d.ok && !d.lineas) {
        ov.innerHTML = `
          <div class="modal-box pax-box notice-error" role="dialog" aria-modal="true">
            <div class="modal-head"><span>No se pudo publicar</span>
              <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button></div>
            <div class="pax-body"><p class="confirm-msg">${esc(d.error || 'Error desconocido.')}</p></div>
            <div class="modal-actions"><button class="btn btn-primary" data-act="close">Entendido</button></div>
          </div>`;
        wire();
        return;
      }

      // Ya estaba publicado (segundo clic, o dos pestañas abiertas).
      if (d.already) {
        const quien = d.published_by_name ? ` por ${esc(d.published_by_name)}` : '';
        ov.innerHTML = `
          <div class="modal-box pax-box" role="dialog" aria-modal="true">
            <div class="modal-head"><span>Este reporte ya estaba publicado</span>
              <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button></div>
            <div class="pax-body"><p class="confirm-msg">El reporte N° ${d.report_id} ya se había
              publicado en AX${quien}. No se envió nada de nuevo.</p></div>
            <div class="modal-actions"><button class="btn btn-primary" data-act="close">Entendido</button></div>
          </div>`;
        wire();
        return;
      }

      const bien = d.fallidas === 0;
      const partes = [];
      if (d.publicadas) partes.push(`<b>${d.publicadas}</b> publicad${d.publicadas === 1 ? 'o' : 'os'}`);
      if (d.omitidas) partes.push(`<b>${d.omitidas}</b> ya estaba${d.omitidas === 1 ? '' : 'n'}`);
      if (d.fallidas) partes.push(`<b>${d.fallidas}</b> sin entrar`);

      const cierre = bien
        ? `<div class="pax-ok">El reporte quedó <b>Cerrado</b> y sellado como publicado en AX.
             ${d.osticket && d.osticket.synced ? 'Su ticket en osTicket también se cerró.' : ''}
             ${d.osticket && d.osticket.failed ? '<br><b>Ojo:</b> no se pudo cerrar el ticket en osTicket. El reporte sí quedó publicado; el ticket se puede sincronizar aparte.' : ''}
           </div>`
        : `<div class="pax-warn">El reporte <b>sigue abierto</b> porque no entraron todas las líneas.
             Corregi lo que dice cada fila y volvé a intentar: lo que ya se cargó en AX
             no se vuelve a cargar ni se duplica.</div>`;

      ov.innerHTML = `
        <div class="modal-box pax-box pax-wide ${bien ? 'notice-success' : 'notice-error'}" role="dialog" aria-modal="true">
          <div class="modal-head">
            <span>${bien ? 'Publicado en AX' : 'Publicación incompleta'} — Reporte N° ${d.report_id}</span>
            <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button>
          </div>
          <div class="pax-body">
            <p class="confirm-msg">${partes.join(' · ')} de ${d.total}.</p>
            ${cierre}
            ${lineasTabla(d.lineas)}
          </div>
          <div class="modal-actions"><button class="btn btn-primary" data-act="close">Entendido</button></div>
        </div>`;
      wire();
    };

    async function publicar() {
      publicando = true;
      pintarEnCurso();
      const d = await postPublishAx(user, report.id, null);
      publicando = false;
      // Solo se avisa al llamador (para recargar) si algo cambio de verdad.
      if (d && d.ok !== false) resultado = d;
      pintarResultado(d);
    }

    pintarAviso();
  });
}
