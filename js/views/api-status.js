/* =====================================================================
   js/views/api-status.js  →  vista "Estado de APIs"
   (grupo Sincronizacion → Herramientas)

   POR QUE EXISTE (v6.199):
   el 10/08/2026 la lectura del padron de una tienda fallo y Publicar rechazo
   la ficha con "No se pudo leer la ficha actual del sistema". Nos enteramos
   porque un usuario intento publicar. No habia forma de PREGUNTAR si los
   servicios estaban vivos; solo de descubrirlo chocando. (Resulto ser la red
   del proveedor donde vive la API, no el portal ni el alias.)

   Distinta de "Consultar API": aquella trae datos y te hace elegir filtros.
   Aca solo interesa si contesta o no, y cuando no, por que.

   v6.201 — NO CORRE SOLA. Antes barria las 8 al entrar, y eso convertia una
   pantalla de diagnostico en 8 llamadas a produccion cada vez que alguien
   pasaba por el menu. Ahora se elige que probar y se aprieta el boton; ademas
   cada fila tiene su propio "Probar" para revisar una sola sin tocar el resto.

   El bucle lo hace ESTA pantalla, una llamada por API: en el servidor se
   comeria el limite de subrequests, y ademas asi se ve el avance en vivo.

   Datos por /api/api-status (list | check). Gate: view.apistatus.
   Export: renderApiStatus(user)
   ===================================================================== */

import { $ } from '../core/dom.js';

let USER = null;
let APIS = [];
let RES = {};          // code -> { estado, ... }  estado: wait|run|ok|fail|cfg
let SEL = new Set();   // v6.201: que APIs entran en la proxima corrida
let CORRIENDO = false;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

async function api(payload) {
  try {
    const r = await fetch('/api/api-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, user: USER }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function renderApiStatus(user) {
  USER = user;
  const host = $('#pnlMain');
  if (!host) return;
  host.innerHTML = styleBlock() + `<div class="as-wrap"><div id="asBody"><div class="as-hint">Cargando…</div></div></div>`;

  const r = await api({ action: 'list' });
  if (!r || !r.ok) {
    document.getElementById('asBody').innerHTML =
      `<div class="as-empty">${esc((r && r.error) || 'No se pudo cargar el catálogo de APIs.')}</div>`;
    return;
  }
  APIS = r.apis || [];
  RES = {};
  APIS.forEach(a => { RES[a.code] = { estado: 'wait' }; });
  // Vienen todas marcadas: elegir "todas" es el caso comun y desmarcar es
  // mas rapido que marcar de a una. Pero NO se dispara nada sola.
  SEL = new Set(APIS.map(a => a.code));
  pintar();
}

function pintar() {
  const body = document.getElementById('asBody');
  if (!body) return;

  const probadas = APIS.filter(a => ['ok', 'fail', 'cfg'].includes(RES[a.code].estado));
  const fallas = probadas.filter(a => ['fail', 'cfg'].includes(RES[a.code].estado)).length;

  // Agrupadas por servidor: si se cae un host entero, se ve de una.
  const porHost = new Map();
  APIS.forEach(a => {
    const h = a.host || '(sin host)';
    if (!porHost.has(h)) porHost.set(h, []);
    porHost.get(h).push(a);
  });

  const resumen = CORRIENDO
    ? `<span class="as-pill run">Revisando…</span>`
    : probadas.length
      ? (fallas
        ? `<span class="as-pill bad">${fallas} con problema${fallas === 1 ? '' : 's'} de ${probadas.length} probada${probadas.length === 1 ? '' : 's'}</span>`
        : `<span class="as-pill good">Las ${probadas.length} probada${probadas.length === 1 ? '' : 's'} responden</span>`)
      : `<span class="as-pill idle">Sin probar</span>`;

  body.innerHTML = `
    <div class="as-head">
      <div><h1>Estado de APIs</h1>
        <div class="sub">Comprueba si cada servicio responde. No trae datos: para eso está <b>Consultar API</b>.</div></div>
      <span class="as-sp"></span>${resumen}
    </div>

    <div class="as-bar">
      <button class="as-lnk" id="asAll" ${CORRIENDO ? 'disabled' : ''}>Marcar todas</button>
      <button class="as-lnk" id="asNone" ${CORRIENDO ? 'disabled' : ''}>Ninguna</button>
      <span class="as-sp"></span>
      <button class="as-btn go" id="asRun" ${CORRIENDO || !SEL.size ? 'disabled' : ''}>
        ${CORRIENDO ? 'Revisando…' : `▶ Revisar ${SEL.size === APIS.length ? 'todas' : `${SEL.size} seleccionada${SEL.size === 1 ? '' : 's'}`}`}
      </button>
    </div>

    ${[...porHost.entries()].map(([h, list]) => `
      <div class="as-host">
        <div class="as-hostname">${esc(h)}</div>
        ${list.map(a => fila(a)).join('')}
      </div>`).join('')}

    <div class="as-note">
      Se consulta con <b>parámetros mínimos</b> (la fecha de hoy y una empresa cualquiera): lo que se
      prueba es que el servicio conteste, no el dato que devuelve. Por eso <b>0 filas no es un error</b>.
      Las APIs salen del catálogo, así que si se registra una nueva aparece acá sola.
    </div>`;

  document.getElementById('asRun')?.addEventListener('click', () => {
    if (!CORRIENDO && SEL.size) revisar([...SEL]);
  });
  document.getElementById('asAll')?.addEventListener('click', () => {
    SEL = new Set(APIS.map(a => a.code)); pintar();
  });
  document.getElementById('asNone')?.addEventListener('click', () => {
    SEL = new Set(); pintar();
  });
  body.querySelectorAll('[data-sel]').forEach(el => el.addEventListener('click', () => {
    if (CORRIENDO) return;
    const c = el.dataset.sel;
    if (SEL.has(c)) SEL.delete(c); else SEL.add(c);
    pintar();
  }));
  body.querySelectorAll('[data-one]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (!CORRIENDO) revisar([b.dataset.one]);
  }));
}

/* v6.202: los parametros que se usaron REALMENTE en la prueba. Sin esto, ver
   la URL pelada no dice con que alias ni con que fecha se consulto, que es la
   mitad de la respuesta cuando algo devuelve 0 filas o rebota. */
function qsTxt(r) {
  const p = r && r.params;
  if (!p || !Object.keys(p).length) return '';
  return esc('?' + Object.keys(p).map(k => `${k}=${p[k]}`).join('&'));
}
function fila(a) {
  const r = RES[a.code] || { estado: 'wait' };
  const on = SEL.has(a.code);
  const ic = { wait: '<span class="as-ic wait">·</span>', run: '<span class="as-ic run">◌</span>',
    ok: '<span class="as-ic ok">✓</span>', fail: '<span class="as-ic bad">✕</span>',
    cfg: '<span class="as-ic cfg">⚙</span>' }[r.estado];

  const derecha = r.estado === 'ok'
    ? `<span class="as-ms">${r.ms} ms</span>${r.rows != null ? `<span class="as-rows">${r.rows} fila${r.rows === 1 ? '' : 's'}</span>` : ''}`
    : r.estado === 'fail' ? `<span class="as-ms bad">${r.ms != null ? r.ms + ' ms' : ''}</span>`
    : r.estado === 'run' ? `<span class="as-ms">consultando…</span>` : '';

  return `<div class="as-row ${r.estado}">
    <div class="as-chk ${on ? 'on' : ''}" data-sel="${esc(a.code)}" title="Incluir en la revisión">${on ? '✓' : ''}</div>
    ${ic}
    <div class="as-mid">
      <div class="as-lbl">${esc(a.label)}</div>
      <div class="as-url"><b>${esc(a.method || 'GET')}</b> ${esc(a.url || '')}${qsTxt(r)}</div>
      ${r.reason ? `<div class="as-reason ${r.estado === 'ok' ? 'soft' : ''}">${esc(r.reason)}</div>` : ''}
      ${a.note && r.estado === 'wait' ? `<div class="as-reason soft">${esc(a.note)}</div>` : ''}
    </div>
    ${derecha}
    <button class="as-btn mini" data-one="${esc(a.code)}" ${CORRIENDO ? 'disabled' : ''}>Probar</button>
  </div>`;
}

/* Secuencial y no en paralelo: son la misma infraestructura del otro lado y
   dispararles 8 a la vez es una forma tonta de fabricar el timeout que
   justamente venimos a medir. */
async function revisar(codes) {
  CORRIENDO = true;
  for (const code of codes) {
    RES[code] = { estado: 'run' };
    pintar();
    const r = await api({ action: 'check', code });
    if (!r || !r.ok) {
      RES[code] = { estado: 'fail', reason: (r && r.error) || 'No se pudo consultar.' };
    } else if (r.config) {
      RES[code] = { estado: 'cfg', reason: r.reason };
    } else if (r.ok_api) {
      RES[code] = { estado: 'ok', ms: r.ms, rows: r.rows, params: r.params, reason: r.reason || null };
    } else {
      RES[code] = { estado: 'fail', ms: r.ms, params: r.params, reason: r.reason || 'No respondió.' };
    }
    pintar();
  }
  CORRIENDO = false;
  pintar();
}

function styleBlock() {
  return `<style>
  .as-wrap{padding:18px 22px;max-width:1000px}
  .as-head{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
  .as-head h1{margin:0;font-size:21px;font-weight:800;color:var(--ink)}
  .as-head .sub{font-size:12.5px;color:var(--soft);margin-top:3px}
  .as-sp{flex:1}
  .as-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;
    background:#f8fafc;border:1px solid var(--border);border-radius:11px;padding:9px 12px}
  .as-lnk{background:none;border:0;padding:0;font-size:12.5px;font-weight:700;color:#1d4ed8;
    cursor:pointer;font-family:inherit;text-decoration:underline}
  .as-lnk:disabled{opacity:.5;cursor:default}
  .as-btn{border:1px solid var(--border-2);background:#fff;border-radius:9px;padding:8px 13px;
    font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;color:var(--ink)}
  .as-btn.go{background:var(--brand,#6d28d9);border-color:var(--brand,#6d28d9);color:#fff}
  .as-btn.mini{padding:5px 11px;font-size:11.5px;flex:none}
  .as-btn:disabled{opacity:.5;cursor:default}
  .as-pill{font-size:12px;font-weight:800;border-radius:999px;padding:4px 12px}
  .as-pill.good{background:#ecfdf5;color:#15803d}
  .as-pill.bad{background:#fef2f2;color:#b91c1c}
  .as-pill.run{background:#eff6ff;color:#1d4ed8}
  .as-pill.idle{background:#f1f5f9;color:#64748b}
  .as-host{margin-bottom:14px}
  .as-hostname{font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;
    color:var(--soft);margin:0 0 6px 2px;font-family:ui-monospace,monospace}
  .as-row{display:flex;align-items:flex-start;gap:11px;background:#fff;border:1px solid var(--border);
    border-radius:11px;padding:11px 13px;margin-bottom:7px}
  .as-row.fail,.as-row.cfg{border-color:#fecaca;background:#fffbfb}
  .as-chk{width:19px;height:19px;border:1.5px solid var(--border-2);border-radius:6px;flex:none;
    cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;
    font-weight:800;color:transparent;margin-top:1px}
  .as-chk.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
  .as-ic{width:22px;height:22px;border-radius:7px;display:flex;align-items:center;justify-content:center;
    font-weight:800;font-size:12px;flex:none}
  .as-ic.wait{background:#f1f5f9;color:#94a3b8}
  .as-ic.run{background:#eff6ff;color:#1d4ed8}
  .as-ic.ok{background:#ecfdf5;color:#15803d}
  .as-ic.bad{background:#fef2f2;color:#b91c1c}
  .as-ic.cfg{background:#fffbeb;color:#92400e}
  .as-mid{flex:1;min-width:0}
  .as-lbl{font-size:13.5px;font-weight:700;color:var(--ink)}
  /* v6.202 — el entrypoint, debajo del nombre. Se corta con ellipsis en
     pantallas angostas pero se puede seleccionar y copiar entero. */
  .as-url{font-size:11.5px;color:var(--soft);font-family:ui-monospace,SFMono-Regular,monospace;
    margin-top:2px;word-break:break-all;line-height:1.4;user-select:all}
  .as-url b{color:#475569;font-weight:800;margin-right:4px}
  .as-reason{font-size:12px;color:#b91c1c;margin-top:3px;line-height:1.45;word-break:break-word}
  .as-reason.soft{color:var(--soft)}
  .as-ms{font-size:12px;color:var(--soft);font-family:ui-monospace,monospace;flex:none}
  .as-ms.bad{color:#b91c1c}
  .as-rows{font-size:11.5px;color:var(--soft);background:#f8fafc;border:1px solid var(--border);
    border-radius:999px;padding:2px 9px;margin-left:8px;flex:none}
  .as-note{font-size:12px;color:var(--soft);line-height:1.6;background:#f8fafc;
    border:1px solid var(--border);border-radius:11px;padding:11px 13px;margin-top:14px}
  .as-hint,.as-empty{font-size:13px;color:var(--soft);padding:14px}
  </style>`;
}
