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

/* =====================================================================
   motivoNoPublicable — UNICA fuente de verdad de "¿este reporte se puede
   publicar?". La usan el boton de la fila y la cola de publicacion, para
   que nunca puedan opinar distinto.
   Devuelve el motivo (texto para el usuario) o null si SI se puede.
   El servidor vuelve a validar todo esto; aca es para no ofrecer lo que
   se sabe que va a ser rechazado.
   ===================================================================== */
export function motivoNoPublicable(r) {
  if (!r) return 'Reporte desconocido';
  if (r.type !== 'marcaje') return 'No es Marcaje Manual';
  if (r.ax_published_at) return 'Ya está publicado';
  // v6.175: "Cerrado" ya significa "cargado en AX a mano"; publicar encima
  // podria pisar una correccion hecha al cargarlo.
  if (r.attention === 'closed') return 'Está Cerrado (ya se cargó a mano)';
  return null;
}

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
            <span>Publicar — Reporte N° ${report.id}</span>
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
            <button class="btn btn-ax" data-act="go">${AX_ARROW} Publicar</button>
          </div>
        </div>`;
      wire();
      // preventScroll: .modal-box tiene overflow-y auto. Cuando el contenido
      // SI desborda (un reporte con muchas lineas), un focus() normal
      // arrastraria la caja hasta el boton y el usuario abriria el modal ya
      // scrolleado, sin leer el aviso. Se enfoca sin mover nada.
      const go = ov.querySelector('[data-act="go"]');
      if (go) go.focus({ preventScroll: true });
    };

    // ---------- 2) EN CURSO ----------
    const pintarEnCurso = () => {
      ov.innerHTML = `
        <div class="modal-box pax-box" role="dialog" aria-modal="true">
          <div class="modal-head"><span>Publicando…</span></div>
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
            <span>${bien ? 'Publicado' : 'Publicación incompleta'} — Reporte N° ${d.report_id}</span>
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

/* =====================================================================
   COLA DE PUBLICACION (v6.176) — publicar VARIOS reportes seguidos.

   POR QUE LA COLA VIVE EN EL NAVEGADOR Y NO EN UN ENDPOINT QUE HAGA TODO:
   cada publicacion cuesta del orden de 8 subrequests de Cloudflare mas la
   llamada a AX. Diez reportes en una sola invocacion se pasan del limite y
   ademas dejan una peticion larguisima escribiendo en AX y osTicket, con
   riesgo de timeout a mitad de camino. Mandando un pedido POR REPORTE:
     - cada uno entra comodo en su presupuesto,
     - cada reporte es atomico (o se publica y cierra, o no se toca),
     - y hay PROGRESO DE VERDAD que mostrar, reporte por reporte. Es lo que
       no pudimos hacer linea por linea cuando el middleware paso a lote.

   Secuencial, nunca en paralelo: del otro lado hay AX 2012 por SOAP con
   NTLM, y no es cosa de mandarle seis escrituras simultaneas.

   Si un reporte falla, la cola SIGUE (decision del 05/08/2026): son
   independientes entre si, y frenar todo por uno deja pendiente trabajo
   que igual habria entrado.

   Cerrar la pestaña a mitad de la cola no rompe nada: lo publicado quedo
   publicado y el resto sencillamente no se toco.
   ===================================================================== */

const QST = {
  pend:  '<span class="pill pill-pend">En espera</span>',
  going: '<span class="pill att-attended">Publicando…</span>',
  ok:    '<span class="pill att-closed">Publicado</span>',
  parc:  '<span class="pill pill-out">Incompleto</span>',
  err:   '<span class="pill pill-out">Error</span>',
  skip:  '<span class="pill pill-out">Salteado</span>',
};

/**
 * Abre la cola de publicacion.
 * @param {object} opts
 *   user      sesion
 *   reports   filas del Historial ya seleccionadas (con type, attention,
 *             ax_published_at, company_code, workers_count)
 *   faltantes cuantos ids seleccionados no estaban en la pagina actual
 *   onDone    callback al terminar (para recargar la lista)
 */
export function openPublishAxQueueModal({ user, reports, faltantes = 0, onDone }) {
  return new Promise(resolve => {
    // Separar lo publicable de lo que se saltea, con su motivo.
    const aptos = [], salteados = [];
    (reports || []).forEach(r => {
      const motivo = motivoNoPublicable(r);
      if (motivo) salteados.push({ r, motivo }); else aptos.push(r);
    });

    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    document.body.appendChild(ov);

    let corriendo = false, cancelar = false, hubo = false;
    const resultados = [];   // { r, d } por reporte procesado

    const finish = () => {
      document.removeEventListener('keydown', onKey);
      ov.remove();
      if (hubo && onDone) onDone(resultados);
      resolve(resultados);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !corriendo) finish(); };
    document.addEventListener('keydown', onKey);

    const wire = () => {
      ov.querySelectorAll('[data-act="close"]').forEach(b => b.addEventListener('click', finish));
      const go = ov.querySelector('[data-act="go"]');
      if (go) go.addEventListener('click', correr);
      const cx = ov.querySelector('[data-act="cancel"]');
      if (cx) cx.addEventListener('click', () => {
        cancelar = true;
        cx.disabled = true;
        cx.textContent = 'Cancelando…';
      });
    };

    const filaHtml = (r, estado) => `
      <tr id="paxq-${r.id}">
        <td><b>N° ${r.id}</b></td>
        <td>${esc(r.company_code)}<div class="pax-ced">${esc(r.company_name || '')}</div></td>
        <td style="text-align:center">${r.workers_count || 0}</td>
        <td class="paxq-st">${estado}</td>
        <td class="pax-msg paxq-msg"></td>
      </tr>`;

    // ---------- 1) AVISO ----------
    const totalTrab = aptos.reduce((n, r) => n + (r.workers_count || 0), 0);
    const pintarAviso = () => {
      const salteadosHtml = (salteados.length || faltantes)
        ? `<div class="pax-skip"><b>Se saltean ${salteados.length + faltantes}:</b>
             <ul>${salteados.map(s => `<li>N° ${s.r.id} — ${esc(s.motivo)}</li>`).join('')}
             ${faltantes ? `<li>${faltantes} seleccionado(s) de otra página del listado</li>` : ''}</ul></div>`
        : '';

      if (!aptos.length) {
        ov.innerHTML = `
          <div class="modal-box pax-box" role="dialog" aria-modal="true">
            <div class="modal-head"><span>Publicar</span>
              <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button></div>
            <div class="pax-body">
              <p class="confirm-msg">Ninguno de los reportes seleccionados se puede publicar.</p>
              ${salteadosHtml}
            </div>
            <div class="modal-actions"><button class="btn btn-primary" data-act="close">Entendido</button></div>
          </div>`;
        wire();
        return;
      }

      ov.innerHTML = `
        <div class="modal-box pax-box pax-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <span>Publicar ${aptos.length} reporte${aptos.length === 1 ? '' : 's'}</span>
            <button class="modal-x" data-act="close" aria-label="Cerrar">✕</button>
          </div>
          <div class="pax-body">
            <p class="confirm-msg">Se van a cargar en <b>AX 2012</b> los marcajes de
              <b>${aptos.length}</b> reporte${aptos.length === 1 ? '' : 's'}
              (${totalTrab} trabajador${totalTrab === 1 ? '' : 'es'} en total), uno detrás de otro.</p>
            <div class="pax-warn">
              <b>Esto no se puede deshacer desde el portal.</b>
              Cada reporte que entre completo queda <b>Cerrado</b>, con su ticket cerrado también,
              y ya no podrá volver a ningún estado anterior.
              <div class="pax-warn-soft">Si alguno falla, la cola sigue con los demás y al final
                se muestra el detalle de cada uno.</div>
            </div>
            ${salteadosHtml}
            <!-- Barra DETERMINADA: aca si se sabe cuantos son, asi que el
                 porcentaje es real. (La del modal de un solo reporte es
                 indeterminada porque el backend manda todo en un lote y no
                 hay avance parcial que informar.) -->
            <div class="paxq-barwrap" id="paxqBar" style="display:none"><span id="paxqFill"></span></div>
            <div class="pax-tablewrap"><table class="dtl-table pax-table"><thead><tr>
              <th>Reporte</th><th>Tienda</th><th style="text-align:center">Trab.</th><th>Estado</th><th>Detalle</th>
            </tr></thead><tbody>
              ${aptos.map(r => filaHtml(r, QST.pend)).join('')}
            </tbody></table></div>
          </div>
          <div class="modal-actions">
            <button class="btn" data-act="close">Cancelar</button>
            <button class="btn btn-ax" data-act="go">${AX_ARROW} Publicar ${aptos.length}</button>
          </div>
        </div>`;
      wire();
      const go = ov.querySelector('[data-act="go"]');
      if (go) go.focus({ preventScroll: true });
    };

    // ---------- 2) LA COLA ----------
    const setFila = (id, estado, msg, seguir) => {
      const tr = ov.querySelector(`#paxq-${id}`);
      if (!tr) return;
      const st = tr.querySelector('.paxq-st');
      if (st) st.innerHTML = estado;
      if (msg != null) {
        const m = tr.querySelector('.paxq-msg');
        if (m) m.textContent = msg;
      }
      /* Con muchos reportes la tabla scrollea, y el que se esta publicando
         puede quedar fuera de la vista. Se lo centra en su contenedor a mano
         (no con scrollIntoView, que ademas arrastraria el modal entero). */
      if (seguir) {
        const wrap = ov.querySelector('.pax-tablewrap');
        if (wrap) {
          const w = wrap.getBoundingClientRect(), t = tr.getBoundingClientRect();
          wrap.scrollTop += (t.top - w.top) - (w.height / 2 - t.height / 2);
        }
      }
    };

    // Barra de avance: aca SI es determinada, porque se sabe cuantos son.
    const setAvance = (hechos, total) => {
      const fill = ov.querySelector('#paxqFill');
      if (fill) fill.style.width = `${Math.round((hechos / total) * 100)}%`;
      const pr = ov.querySelector('#paxqProg');
      if (pr) pr.textContent = `${hechos} de ${total}`;
    };

    // Resumen de una publicacion, en una linea, para la columna Detalle.
    const resumenLinea = (d) => {
      if (!d) return 'Se perdió la conexión.';
      if (d.already) return 'Ya estaba publicado.';
      if (!d.ok && !d.lineas) return d.error || 'Rechazado.';
      const p = [];
      if (d.publicadas) p.push(`${d.publicadas} publicado${d.publicadas === 1 ? '' : 's'}`);
      if (d.omitidas) p.push(`${d.omitidas} ya estaba${d.omitidas === 1 ? '' : 'n'}`);
      if (d.fallidas) p.push(`${d.fallidas} sin entrar`);
      const detalle = (d.lineas || []).filter(l => l.status === 'error')
        .map(l => `${l.worker_id_number}: ${l.error || 'sin detalle'}`).join(' | ');
      return p.join(' · ') + (detalle ? ` — ${detalle}` : '');
    };

    async function correr() {
      corriendo = true;
      const box = ov.querySelector('.modal-actions');
      if (box) {
        box.innerHTML = `<span class="paxq-prog" id="paxqProg">0 de ${aptos.length}</span>
          <span style="flex:1"></span>
          <button class="btn" data-act="cancel">Detener</button>`;
        const cx = box.querySelector('[data-act="cancel"]');
        if (cx) cx.addEventListener('click', () => {
          cancelar = true; cx.disabled = true; cx.textContent = 'Deteniendo…';
        });
      }

      const barra = ov.querySelector('#paxqBar');
      if (barra) barra.style.display = '';
      setAvance(0, aptos.length);

      let hechos = 0;
      for (const r of aptos) {
        if (cancelar) { setFila(r.id, QST.skip, 'Cancelado antes de empezar.'); continue; }
        setFila(r.id, QST.going, '', true);
        const d = await postPublishAx(user, r.id, null);
        hubo = true;
        resultados.push({ r, d });
        const estado = !d ? QST.err
          : (d.already || d.ok) ? QST.ok
            : (d.lineas && d.lineas.length) ? QST.parc : QST.err;
        setFila(r.id, estado, resumenLinea(d));
        hechos++;
        setAvance(hechos, aptos.length);
      }

      corriendo = false;
      pintarCierre(hechos);
    }

    // ---------- 3) CIERRE ----------
    const pintarCierre = (hechos) => {
      const okN = resultados.filter(x => x.d && (x.d.ok || x.d.already)).length;
      const malN = resultados.length - okN;
      const head = ov.querySelector('.modal-head span');
      if (head) head.textContent = malN ? 'Publicación con incidencias' : 'Publicación terminada';
      const box = ov.querySelector('.modal-actions');
      if (box) {
        box.innerHTML = `<span class="paxq-prog">${okN} publicado${okN === 1 ? '' : 's'}${malN ? ` · ${malN} con problema${malN === 1 ? '' : 's'}` : ''}${cancelar ? ` · detenida en ${hechos}` : ''}</span>
          <span style="flex:1"></span>
          <button class="btn btn-primary" data-act="close">Entendido</button>`;
        const cb = box.querySelector('[data-act="close"]');
        if (cb) cb.addEventListener('click', finish);
      }
    };

    pintarAviso();
  });
}
