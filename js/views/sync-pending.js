/* =====================================================================
   js/views/sync-pending.js  →  vista "Pendientes" (v5.44)
   Menu: Sincronizacion → Recibir del sistema → Pendientes

   LA BANDEJA DE LO QUE HAY QUE RESOLVER.

   Hasta v5.39 esto vivia enterrado en el detalle expandible del Registro:
   habia que entrar a una corrida, abrir la fila, elegir una pestaña. Nadie lo
   hacia. Resultado: 3 cuentas bancarias distintas entre el portal y el sistema
   llevaban semanas sin que nadie las mirara. Eso es plata que puede estar
   yendo a la cuenta equivocada.

   ---------------------------------------------------------------------
   v5.44 — SE ADOPTA EL LENGUAJE VISUAL DE PUBLICAR.

   v5.40/41 construyeron esta pagina con un estilo propio: dos cajas de color
   saturado, botones enormes, y como toda identificacion "BG04". Al lado de
   Publicar parecian dos portales distintos — y el de Publicar era mejor:
   informacion densa, colores discretos, y todo lo necesario para decidir.

   Publicar tiene, en el ancho de una fila: foto, nombre, cedula, razon social,
   zona · subzona · concepto, quien edito y cuando. Aca habia un codigo de 4
   letras. Con 195 empresas, "BG04" no dice ni de que ciudad es la tienda.

   Entonces:
     - La ficha es una FILA (axr-row), no una tarjeta. Misma cabecera, misma
       foto o iniciales, mismo bloque de identidad, mismo pie de metadatos.
     - La comparacion es una TABLA de campos, como el detalle de Publicar:
       CAMPO | EN EL PORTAL | EN EL SISTEMA. Verde y naranja quedan como COLOR
       DE TEXTO, no como fondo de una caja gigante.
     - Los botones son chicos y van al pie, a la derecha. Los mismos tres de
       siempre: Publicar (ambar, como en Publicar), Adoptar (naranja), Anular.
     - Se agregan las fechas: cuando el portal DETECTO la diferencia, y si la
       ficha ademas tiene un cambio del portal esperando publicarse.

   ---------------------------------------------------------------------
   LAS TRES SECCIONES

     1. HAY QUE DECIDIR — los dos lados tienen dato y no coinciden.
        el del portal   -> Publicar  (/api/ax-review action:detect_commit)
        el del sistema  -> Adoptar   (/api/ax-review action:adopt)
        ninguno         -> Anular    (/api/sync-pending action:dismiss)

        ⚠ Publicar y Adoptar RE-DETECTAN en el servidor antes de escribir (van
        y le preguntan al sistema). Por eso tardan unos segundos. Es lo que
        queremos: si alguien ya lo arreglo alla, no hacen nada. Idempotente.

     2. MAL ESCRITOS EN EL SISTEMA — solo lectura. El dato esta roto y se
        arregla en el sistema. Se ven y se exportan.

     3. TIENDAS SALTADAS — solo lectura. El sistema devolvio una lista corta y
        el portal no toco nada.

   Datos por /api/sync-pending. Acciones por /api/ax-review (ya existian).
   Export: renderSyncPending(user)
   ===================================================================== */

import { $ } from '../core/dom.js';
import { attachRefresh } from '../core/refresh.js';

let USER = null;
let SP = { conflicts: [], rejected: [], skipped: [], last_run: null, counts: null };

/* Etiqueta legible del campo. El backend manda la clave interna. */
const CAMPO_LBL = {
  cuenta: 'Cuenta bancaria', telefono: 'Tel\u00e9fono', correo: 'Correo',
  account_number: 'Cuenta bancaria', phone: 'Tel\u00e9fono', email: 'Correo',
};

/* Mismos colores de avatar que Publicar (identidad visual compartida). */
const AVATAR_BG = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#e0e7ff', '#ccfbf1'];
const AVATAR_FG = ['#1e40af', '#166534', '#92400e', '#9d174d', '#3730a3', '#115e59'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initialsOf(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '')).toUpperCase();
}

/* Cuenta de 20 digitos en grupos de 4: comparar dos cadenas de 20 digitos
   pegados es imposible; en grupos de 4 la diferencia salta a la vista. */
function fmtValor(campo, v) {
  const s = String(v == null ? '' : v);
  if (!s) return '\u2014';
  const c = String(campo || '').toLowerCase();
  if (c.includes('cuenta') || c === 'account_number') {
    const d = s.replace(/\D/g, '');
    if (d.length === 20) return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  if (c.includes('tel') || c === 'phone') {
    let d = s.replace(/[^\d+]/g, '');
    if (d.startsWith('+58')) d = '0' + d.slice(3);
    else if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);
    if (/^\d{11}$/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4);
  }
  return s;
}

/* Fecha y hora en Caracas (GMT-4), formato del portal. */
function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const c = new Date(d.getTime() - 4 * 3600 * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)}/${c.getUTCFullYear()} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
}

async function api(payload) {
  return fetch('/api/sync-pending', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminId: USER.id,
      user: { kind: USER.kind, id: USER.id || null, companyCode: USER.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

/* Las acciones van a /api/ax-review, que YA las tenia. No se reimplementa nada. */
async function axReview(payload) {
  return fetch('/api/ax-review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: { kind: USER.kind, id: USER.id || null, companyCode: USER.companyCode || null },
      ...payload,
    }),
  }).then(x => x.json()).catch(() => null);
}

function ensureStyles() {
  if (document.getElementById('spStyles')) return;
  const st = document.createElement('style');
  st.id = 'spStyles';
  /* Las clases replican las de ax-review.js (axr-*) a proposito: si algun dia
     se unifican en una hoja comun, el cambio es mecanico. */
  st.textContent = `
  .sp-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .sp-head p{margin:3px 0 0;color:var(--muted);font-size:13px}

  /* Tarjetas de conteo: mismo peso visual que las de Publicar (borde suave,
     numero grande, sin fondos saturados). */
  .sp-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 20px}
  .sp-stat{border:1px solid var(--border);border-radius:12px;padding:13px 16px;background:var(--card,#fff)}
  .sp-stat .k{font-size:12px;color:var(--muted);font-weight:600;display:flex;align-items:center;gap:6px}
  .sp-stat .v{font-size:26px;font-weight:700;margin-top:3px;line-height:1.15;color:var(--ink)}
  .sp-stat .h{font-size:11.5px;color:var(--faint,#94a3b8);margin-top:1px}
  .sp-stat.dec .v{color:#1d4ed8}
  .sp-stat.rot .v{color:#b45309}

  .sp-sec{margin:0 0 24px}
  .sp-sec h2{margin:0 0 3px;font-size:15px;font-weight:700;color:var(--ink)}
  .sp-sec .lead{margin:0 0 12px;font-size:12.5px;color:var(--muted);line-height:1.6}

  /* ---- LA FILA (clon de axr-row) ---- */
  .sp-row{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);
          margin-bottom:8px;overflow:hidden}
  .sp-rowhead{display:flex;align-items:center;gap:11px;padding:11px 14px}
  .sp-ava{width:38px;height:38px;border-radius:50%;flex:none;display:flex;align-items:center;
          justify-content:center;font-size:13px;font-weight:700;overflow:hidden}
  .sp-ava img{width:100%;height:100%;object-fit:cover}
  .sp-who{flex:1;min-width:0}
  .sp-nm{font-size:14px;font-weight:700;color:var(--ink);line-height:1.3}
  .sp-sub{font-size:12px;color:var(--muted);margin-top:1px}
  .sp-edit{font-size:11.5px;color:var(--faint,#94a3b8);margin-top:2px}
  .sp-rmeta{text-align:right;flex:none;font-size:11.5px;color:var(--muted);line-height:1.5}
  .sp-cc{color:var(--brand,#2563eb);font-weight:700;font-size:12px}
  .sp-emeta{color:var(--faint,#94a3b8)}
  .sp-chip{display:inline-block;margin-top:3px;padding:1px 7px;border-radius:20px;font-size:10.5px;
           font-weight:700;background:#fef3c7;color:#92400e}

  /* ---- LA TABLA DE CAMPOS (clon de axr-tbl) ----
     El color va en el TEXTO, no en un fondo. Verde = portal, naranja = sistema:
     los mismos que Comparar, pero sin gritar. */
  .sp-body{padding:0 14px 12px}
  .sp-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .sp-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
             color:var(--muted);font-weight:700;padding:6px 10px;border-bottom:1px solid var(--border)}
  .sp-tbl td{padding:9px 10px;border-bottom:1px solid var(--border-soft,#eef1f5);vertical-align:middle}
  .sp-tbl tr:last-child td{border-bottom:0}
  .sp-tbl .fld{font-weight:600;color:var(--ink);width:140px}
  .sp-pv{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
         font-variant-numeric:tabular-nums;color:#15803d;font-weight:600}
  .sp-sv{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
         font-variant-numeric:tabular-nums;color:#b45309;font-weight:600}
  .sp-na{color:var(--faint,#94a3b8);font-style:italic;font-family:inherit;font-weight:400}
  .sp-warn{font-size:11px;color:#b45309;font-weight:600;white-space:nowrap}

  /* ---- BOTONES (mismo tamaño y peso que los de Publicar) ---- */
  .sp-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;
           margin-top:11px;flex-wrap:wrap}
  .sp-b{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;
        padding:7px 13px;border-radius:8px;cursor:pointer;border:1px solid var(--border);
        background:var(--surface,#fff);color:var(--ink);white-space:nowrap}
  .sp-b:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .sp-b:disabled{opacity:.5;cursor:default}
  /* Publicar: ambar, EL MISMO de la pagina Publicar (es la misma accion). */
  .sp-b.pub{background:#fffbeb;border-color:#fcd34d;color:#92400e}
  .sp-b.pub:hover:not(:disabled){background:#fef3c7;border-color:#d97706}
  /* Adoptar: naranja, el color del sistema en todo el portal. */
  .sp-b.ado{background:#fff7ed;border-color:#fdba74;color:#9a3412}
  .sp-b.ado:hover:not(:disabled){background:#ffedd5;border-color:#ea580c}
  /* Anular: gris. Es la salida, no una opcion mas. */
  .sp-b.nul{color:var(--muted)}
  .sp-b.nul:hover:not(:disabled){color:#b91c1c;border-color:#fca5a5;background:#fef2f2}

  .sp-msg{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:12.5px}
  .sp-msg.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;font-weight:600}
  .sp-msg.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}
  .sp-msg.wait{background:var(--bg-soft,#f8fafc);border:1px solid var(--border);color:var(--muted)}

  /* ---- TABLAS DE SOLO LECTURA (secciones 2 y 3) ---- */
  .sp-flat{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--card,#fff);
           border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .sp-flat th{background:var(--bg-soft,#f8fafc);text-align:left;font-size:10.5px;text-transform:uppercase;
              letter-spacing:.04em;color:var(--muted);font-weight:700;padding:9px 11px;
              border-bottom:1px solid var(--border);white-space:nowrap}
  .sp-flat td{padding:8px 11px;border-bottom:1px solid var(--border-soft,#eef1f5);color:var(--ink)}
  .sp-flat tr:last-child td{border-bottom:0}
  .sp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .sp-bad{color:#9a3412}

  .sp-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;
          padding:7px 13px;border:1px solid var(--border);border-radius:8px;background:var(--surface,#fff);
          color:var(--ink);cursor:pointer}
  .sp-btn:hover{background:var(--bg-soft,#f1f5f9)}
  .sp-empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:13px;
            border:1px dashed var(--border);border-radius:12px}
  .sp-ok{padding:26px 16px;text-align:center;color:#15803d;font-size:14px;font-weight:600;
         background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px}
  @media(max-width:720px){
    .sp-stats{grid-template-columns:1fr}
    .sp-rmeta{display:none}
    .sp-tbl .fld{width:auto}
  }`;
  document.head.appendChild(st);
}

/* ---------- UNA FICHA EN CONFLICTO ----------
   Estructura calcada de Publicar: cabecera con foto e identidad completa, tabla
   de campos, botones chicos al pie.

   Que se ve de cada ficha (y antes NO se veia):
     - foto (o iniciales con el color del portal)
     - cedula con su tipo (V-28166758)
     - RAZON SOCIAL, no solo el alias
     - zona · subzona · concepto  <- sin esto, "BG04" no dice de donde es
     - cuando se detecto la diferencia
     - si ademas hay un cambio del portal esperando publicarse */
function conflictRow(c, i) {
  const ci = i % AVATAR_BG.length;
  const emeta = [c.zona, c.subzona, c.concepto].filter(Boolean).map(esc).join(' \u00b7 ');
  const ced = `${c.ced_kind ? esc(c.ced_kind) + '-' : ''}${esc(c.id_number)}`;

  const filas = c.fields.map((f, j) => {
    const roto = f.estado === 'dato_roto';
    return `<tr>
      <td class="fld">${esc(CAMPO_LBL[f.campo] || f.campo)}</td>
      <td><span class="sp-pv ${f.portal ? '' : 'sp-na'}">${f.portal ? esc(fmtValor(f.campo, f.portal)) : 'sin dato'}</span></td>
      <td><span class="sp-sv ${f.sistema ? '' : 'sp-na'}">${f.sistema ? esc(fmtValor(f.campo, f.sistema)) : 'sin dato'}</span>
          ${roto ? '<div class="sp-warn">\u26a0 mal escrito</div>' : ''}</td>
    </tr>`;
  }).join('');

  // Si TODOS los campos son dato_roto, no hay nada que adoptar: el sistema los
  // tiene mal. Adoptar un dato roto seria romper el portal a proposito.
  const todoRoto = c.fields.every(f => f.estado === 'dato_roto');

  return `
    <div class="sp-row" id="spRow_${i}">
      <div class="sp-rowhead">
        ${c.thumb_url
          ? `<div class="sp-ava"><img src="${esc(c.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`
          : `<div class="sp-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(c.full_name))}</div>`}
        <div class="sp-who">
          <div class="sp-nm">${esc(c.full_name)}</div>
          <div class="sp-sub">${ced} \u00b7 ${esc(c.company_name || c.company_code)}</div>
          ${c.at ? `<div class="sp-edit">Diferencia detectada el ${esc(fmtDT(c.at))}</div>` : ''}
        </div>
        <div class="sp-rmeta">
          <div class="sp-cc">${esc(c.company_code)}</div>
          ${emeta ? `<div class="sp-emeta">${emeta}</div>` : ''}
          ${c.pending ? `<div class="sp-chip" title="Alguien edit\u00f3 esta ficha en el portal y el cambio a\u00fan no se envi\u00f3">Ya editada</div>` : ''}
        </div>
      </div>
      <div class="sp-body">
        <table class="sp-tbl">
          <thead><tr><th>Campo</th><th>En el portal</th><th>En el sistema</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
        <div class="sp-foot">
          <button class="sp-b nul" data-act="null" data-i="${i}">Anular</button>
          <button class="sp-b ado" data-act="sistema" data-i="${i}"${todoRoto ? ' disabled title="El sistema tiene estos datos mal escritos: no hay nada que adoptar"' : ''}>Adoptar</button>
          <button class="sp-b pub" data-act="portal" data-i="${i}">Publicar</button>
        </div>
        <div class="sp-msg" id="spMsg_${i}" hidden></div>
      </div>
    </div>`;
}

/* ---------- RESOLVER ----------
   El usuario eligio un lado. Se traduce a la accion de /api/ax-review, que ya
   existia. Los dos endpoints re-detectan en el server antes de escribir: por eso
   tardan, y por eso son seguros. */
async function resolve(i, lado) {
  const c = SP.conflicts[i];
  if (!c) return;
  const row = $('#spRow_' + i);
  const msg = $('#spMsg_' + i);
  if (!row || !msg) return;

  row.querySelectorAll('.sp-b').forEach(b => { b.disabled = true; });
  msg.hidden = false;
  msg.className = 'sp-msg wait';
  msg.textContent = 'Comprobando contra el sistema\u2026';

  /* portal  -> PUBLICAR (el valor del portal se manda; aparece en Publicar)
     sistema -> ADOPTAR  (el valor del sistema entra al portal) */
  const action = lado === 'sistema' ? 'adopt' : 'detect_commit';
  const r = await axReview({
    action, id_numbers: [c.id_number], company_codes: [c.company_code],
  });

  if (!r || !r.ok) {
    msg.className = 'sp-msg err';
    msg.textContent = (r && r.error) || 'No se pudo completar. Prob\u00e1 de nuevo.';
    row.querySelectorAll('.sp-b').forEach(b => { b.disabled = false; });
    return;
  }

  const n = (r.count != null) ? r.count : ((r.adopted || r.marked || []).length);
  if (!n) {
    // Re-detecto y ya no hay diferencia: alguien lo resolvio antes. No es error.
    msg.className = 'sp-msg ok';
    msg.textContent = '\u2713 Ya estaba resuelto. La marca se limpia en la pr\u00f3xima sincronizaci\u00f3n.';
    return;
  }

  msg.className = 'sp-msg ok';
  msg.textContent = lado === 'sistema'
    ? '\u2713 Listo. El portal tom\u00f3 el dato del sistema.'
    : '\u2713 Listo. El dato del portal qued\u00f3 para enviar: lo vas a ver en Publicar.';
}

/* ---------- ANULAR ----------
   No toca ningun dato: solo apaga el aviso. Los dos valores quedan como estan.

   Para que sirve: cuando LOS DOS estan mal, o cuando el del portal esta bien
   pero no se quiere escribir en el sistema ahora. Sin esto, esas fichas se
   quedaban en la bandeja para siempre.

   ⚠ NO es el Anular de Publicar. Aquel descarta un cambio que iba a enviarse;
   este solo silencia una etiqueta. Si el dato cambia de algun lado, la proxima
   sincronizacion lo vuelve a marcar — y esta bien: seria otro conflicto. */
async function dismiss(i) {
  const c = SP.conflicts[i];
  if (!c) return;
  const row = $('#spRow_' + i);
  const msg = $('#spMsg_' + i);
  if (!row || !msg) return;

  row.querySelectorAll('.sp-b').forEach(b => { b.disabled = true; });
  msg.hidden = false;
  msg.className = 'sp-msg wait';
  msg.textContent = 'Anulando\u2026';

  const r = await api({ action: 'dismiss', id_number: c.id_number });

  if (!r || !r.ok) {
    msg.className = 'sp-msg err';
    msg.textContent = (r && r.error) || 'No se pudo anular. Prob\u00e1 de nuevo.';
    row.querySelectorAll('.sp-b').forEach(b => { b.disabled = false; });
    return;
  }

  msg.className = 'sp-msg ok';
  msg.textContent = '\u2713 Aviso anulado. No se cambi\u00f3 ning\u00fan dato.';
}

function paint() {
  const host = $('#spBody');
  if (!host) return;

  const nC = SP.conflicts.length;
  const nR = SP.rejected.length;
  const nS = SP.skipped.length;

  if (!nC && !nR && !nS) {
    host.innerHTML = '<div class="sp-ok">\u2713 No hay nada pendiente. Todo al d\u00eda.</div>';
    return;
  }

  const partes = [];

  /* --- 1. HAY QUE DECIDIR --- */
  partes.push(`<div class="sp-sec">
    <h2>Hay que decidir</h2>
    <p class="lead">Los dos lados tienen un dato y no coinciden. El portal <b>no toc\u00f3 nada</b>: solo los se\u00f1al\u00f3.
       Eleg\u00ed cu\u00e1l vale, o anul\u00e1 el aviso para dejar los dos como est\u00e1n.</p>
    ${nC
      ? SP.conflicts.map((c, i) => conflictRow(c, i)).join('')
      : '<div class="sp-empty">Nada que decidir.</div>'}
  </div>`);

  /* --- 2. MAL ESCRITOS EN EL SISTEMA --- */
  if (nR) {
    const filas = SP.rejected.slice(0, 300).map(d => `<tr>
      <td class="sp-mono">${esc(d.ced)}</td>
      <td>${esc(d.nom)}</td>
      <td class="sp-cc">${esc(d.comp)}</td>
      <td>${esc(CAMPO_LBL[d.campo] || d.campo)}</td>
      <td class="sp-mono sp-bad">${esc(d.valor)}</td>
    </tr>`).join('');
    partes.push(`<div class="sp-sec">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:3px">
        <h2 style="margin:0">Mal escritos en el sistema</h2>
        <button class="sp-btn" id="spExp">Exportar</button>
      </div>
      <p class="lead">El sistema mand\u00f3 estos datos mal escritos, as\u00ed que <b>no se guardaron</b>.
         El portal no arregla datos del sistema: hay que corregirlos all\u00e1.
         Cuando se corrijan, dejan de aparecer solos.</p>
      <table class="sp-flat">
        <thead><tr><th>C\u00e9dula</th><th>Colaborador</th><th>Empresa</th><th>Campo</th><th>Vino as\u00ed</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      ${nR > 300 ? `<p class="lead" style="margin-top:9px">Mostrando 300 de ${nR}. Us\u00e1 Exportar para la lista completa.</p>` : ''}
    </div>`);
  }

  /* --- 3. TIENDAS SALTADAS --- */
  if (nS) {
    const filas = SP.skipped.map(s => `<tr>
      <td class="sp-cc">${esc(s.company_code)}</td>
      <td style="color:#b45309">${esc(s.alert)}</td>
    </tr>`).join('');
    partes.push(`<div class="sp-sec">
      <h2>Tiendas saltadas</h2>
      <p class="lead">El sistema devolvi\u00f3 una lista sospechosamente corta para estas tiendas.
         El portal prefiri\u00f3 <b>no tocar nada</b> antes que dar de baja a gente que sigue trabajando.</p>
      <table class="sp-flat">
        <thead><tr><th style="width:120px">Empresa</th><th>Motivo</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`);
  }

  host.innerHTML = partes.join('');

  host.querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => {
      const i = +b.dataset.i;
      if (b.dataset.act === 'null') dismiss(i);
      else resolve(i, b.dataset.act);
    }));

  const exp = $('#spExp');
  if (exp) exp.addEventListener('click', () => openExportMenu(exp));
}

/* ---------- EXPORTAR (patron del portal: xlsx / csv / txt) ---------- */
function exportRows() {
  return SP.rejected.map(d => ({
    'C\u00e9dula': d.ced, 'Colaborador': d.nom, 'Empresa': d.comp,
    'Campo': CAMPO_LBL[d.campo] || d.campo, 'Vino as\u00ed': d.valor,
  }));
}
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tstamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function doExport(fmt) {
  const data = exportRows();
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const fname = `datos_mal_escritos_${tstamp()}`;
  if (fmt === 'csv') {
    const escv = v => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.join(';')].concat(data.map(r => headers.map(h => escv(r[h])).join(';')));
    downloadBlob('\uFEFF' + lines.join('\r\n'), `${fname}.csv`, 'text/csv;charset=utf-8');
    return;
  }
  if (fmt === 'txt') {
    const w = headers.map(h => Math.max(h.length, ...data.map(r => String(r[h] ?? '').length)));
    const row = cells => cells.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ');
    const lines = [row(headers), w.map(x => '-'.repeat(x)).join('  ')]
      .concat(data.map(r => row(headers.map(h => r[h]))));
    downloadBlob(lines.join('\r\n'), `${fname}.txt`, 'text/plain;charset=utf-8');
    return;
  }
  if (fmt === 'xlsx') {
    try {
      if (!window.XLSX) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload = res; s.onerror = () => rej(new Error('CDN'));
          document.head.appendChild(s);
        });
      }
      const ws = window.XLSX.utils.json_to_sheet(data, { header: headers });
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Mal escritos');
      window.XLSX.writeFile(wb, `${fname}.xlsx`);
    } catch (_) { /* sin CDN: reintentar luego */ }
  }
}
function openExportMenu(btn) {
  const old = document.getElementById('spExpMenu');
  if (old) { old.remove(); return; }
  const r = btn.getBoundingClientRect();
  const m = document.createElement('div');
  m.id = 'spExpMenu';
  m.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${Math.max(8, r.right - 170)}px;z-index:1100;`
    + `background:var(--card,#fff);border:1px solid var(--border);border-radius:12px;`
    + `box-shadow:0 10px 32px rgba(15,23,42,.18);padding:6px;min-width:170px;display:flex;flex-direction:column;gap:2px`;
  const item = (lbl, fmt) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.style.cssText = 'font:inherit;font-size:13px;text-align:left;padding:8px 12px;border:0;'
      + 'border-radius:8px;background:transparent;color:var(--ink);cursor:pointer';
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft,#f1f5f9)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { m.remove(); doExport(fmt); });
    return b;
  };
  m.appendChild(item('Excel (.xlsx)', 'xlsx'));
  m.appendChild(item('CSV (.csv)', 'csv'));
  m.appendChild(item('Texto (.txt)', 'txt'));
  document.body.appendChild(m);
  setTimeout(() => {
    const away = ev => {
      if (!m.contains(ev.target) && ev.target !== btn) { m.remove(); document.removeEventListener('click', away); }
    };
    document.addEventListener('click', away);
  }, 0);
}

async function load() {
  const host = $('#spBody');
  if (host) host.innerHTML = '<div class="sp-empty">Cargando\u2026</div>';
  const r = await api({});
  if (!r || !r.ok) {
    if (host) host.innerHTML = `<div class="sp-empty">No se pudo cargar${r && r.error ? ': ' + esc(r.error) : ''}.</div>`;
    return;
  }
  SP = {
    conflicts: r.conflicts || [],
    rejected: r.rejected || [],
    skipped: r.skipped || [],
    last_run: r.last_run || null,
    counts: r.counts || null,
  };
  paintStats();
  paint();
}

function paintStats() {
  const el = $('#spStats');
  if (!el) return;
  const c = SP.counts || { conflicts: 0, rejected: 0, skipped: 0 };
  el.innerHTML = `
    <div class="sp-stat dec">
      <div class="k">Hay que decidir</div>
      <div class="v">${c.conflicts}</div>
      <div class="h">los dos lados tienen dato</div>
    </div>
    <div class="sp-stat rot">
      <div class="k">Mal escritos en el sistema</div>
      <div class="v">${c.rejected}</div>
      <div class="h">se corrigen all\u00e1</div>
    </div>
    <div class="sp-stat">
      <div class="k">Tiendas saltadas</div>
      <div class="v">${c.skipped}</div>
      <div class="h">respuesta corta del sistema</div>
    </div>`;

  const sub = $('#spSub');
  if (sub) {
    sub.textContent = SP.last_run && SP.last_run.run_at
      ? `\u00daltima sincronizaci\u00f3n: ${fmtDT(SP.last_run.run_at)}`
      : '';
  }
}

export async function renderSyncPending(user) {
  USER = user;
  ensureStyles();
  SP = { conflicts: [], rejected: [], skipped: [], last_run: null, counts: null };

  $('#pnlMain').innerHTML = `
    <div class="sp-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
      <div>
        <h1>Pendientes</h1>
        <p>Lo que la sincronizaci\u00f3n encontr\u00f3 y necesita una decisi\u00f3n. <span id="spSub" style="color:var(--faint,#94a3b8)"></span></p>
      </div>
      <span id="spRefresh"></span>
    </div>
    <div class="sp-stats" id="spStats"></div>
    <div id="spBody"></div>`;

  await load();
  attachRefresh('#spRefresh', () => load(), 'syncpend');
}
