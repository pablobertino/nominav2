/* =====================================================================
   js/views/sync-pending.js  →  vista "Pendientes" (v5.40)
   Menu: Recibir del sistema → Pendientes

   LA BANDEJA DE LO QUE HAY QUE RESOLVER.

   Hasta v5.39 esto vivia enterrado en el detalle expandible del Registro:
   habia que entrar a una corrida, abrir la fila, elegir una pestaña. Nadie lo
   hacia. Resultado: 3 cuentas bancarias distintas entre el portal y el sistema
   llevaban semanas sin que nadie las mirara. Eso es plata que puede estar
   yendo a la cuenta equivocada.

   Aca estan las tres cosas, en una pantalla, con los botones al lado:

     1. HAY QUE DECIDIR — los dos lados tienen dato y no coinciden.
        Dos botones POR CAMPO, uno debajo de cada valor. El usuario no elige
        "adoptar" o "publicar": elige CUAL DATO ES EL CORRECTO. Lo demas es
        plomeria.
          el del sistema  -> Adoptar   (/api/ax-review action:adopt)
          el del portal   -> Publicar  (/api/ax-review action:detect_commit)

        ⚠ Los dos endpoints RE-DETECTAN en el servidor antes de escribir (van y
        le preguntan al sistema). Por eso el boton tarda unos segundos. Es lo
        que queremos: si alguien ya lo arreglo alla mientras tanto, no hace
        nada. Idempotente.

     2. MAL ESCRITOS EN EL SISTEMA — solo lectura. No hay nada que decidir: el
        dato esta roto y se arregla en el sistema. Se ven y se exportan.

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
  cuenta: 'Cuenta bancaria',
  telefono: 'Tel\u00e9fono',
  correo: 'Correo',
  account_number: 'Cuenta bancaria',
  phone: 'Tel\u00e9fono',
  email: 'Correo',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Cuenta bancaria de 20 digitos: se muestra en grupos de 4 para que se pueda
   LEER y comparar de un vistazo. Comparar dos cadenas de 20 digitos pegados es
   imposible; en grupos de 4 la diferencia salta. */
function fmtValor(campo, v) {
  const s = String(v == null ? '' : v);
  if (!s) return '\u2014';
  const c = String(campo || '').toLowerCase();
  if (c.includes('cuenta') || c === 'account_number') {
    const d = s.replace(/\D/g, '');
    if (d.length === 20) return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  if (c.includes('tel') || c === 'phone') {
    // +584248494408 -> 0424 8494408 (formato nacional, legible)
    let d = s.replace(/[^\d+]/g, '');
    if (d.startsWith('+58')) d = '0' + d.slice(3);
    else if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);
    if (/^\d{11}$/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4);
  }
  return s;
}

function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const c = new Date(d.getTime() - 4 * 3600 * 1000);   // Caracas GMT-4
  const z = n => String(n).padStart(2, '0');
  return `${z(c.getUTCDate())}/${z(c.getUTCMonth() + 1)} ${z(c.getUTCHours())}:${z(c.getUTCMinutes())}`;
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

/* Las acciones van al endpoint que YA EXISTE. No se reimplementa nada. */
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
  st.textContent = `
  .sp-head h1{margin:0;font-size:21px;font-weight:700;color:var(--ink)}
  .sp-head p{margin:3px 0 0;color:var(--muted);font-size:13px}
  .sp-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 22px}
  .sp-stat{border-radius:13px;padding:14px 16px;border:1px solid transparent}
  .sp-stat .k{font-size:12px;font-weight:600}
  .sp-stat .v{font-size:27px;font-weight:700;margin-top:4px;line-height:1}
  .sp-stat .h{font-size:11.5px;margin-top:3px}
  .sp-stat.dec{background:#eff6ff;border-color:#bfdbfe}
  .sp-stat.dec .k,.sp-stat.dec .v,.sp-stat.dec .h{color:#1e40af}
  .sp-stat.rot{background:#fff7ed;border-color:#fed7aa}
  .sp-stat.rot .k,.sp-stat.rot .v,.sp-stat.rot .h{color:#b45309}
  .sp-stat.slt{background:var(--bg-soft,#f8fafc);border-color:var(--border)}
  .sp-stat.slt .k,.sp-stat.slt .h{color:var(--muted)}
  .sp-stat.slt .v{color:var(--ink)}

  .sp-sec{margin:0 0 26px}
  .sp-sec h2{margin:0 0 3px;font-size:15px;font-weight:700;color:var(--ink)}
  .sp-sec .lead{margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.6}

  .sp-card{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);
           padding:13px 15px;margin-bottom:9px}
  .sp-ctop{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:11px}
  .sp-nom{font-size:14px;font-weight:700;color:var(--ink)}
  .sp-meta{font-size:12px;color:var(--muted);white-space:nowrap}
  .sp-cc{color:var(--brand,#2563eb);font-weight:700}

  .sp-vs{display:grid;grid-template-columns:1fr 1fr;gap:9px}
  .sp-side{border:1px solid var(--border);border-radius:9px;padding:10px 12px;
           display:flex;flex-direction:column;gap:8px}
  /* v5.40 — MISMO CODIGO DE COLOR QUE COMPARAR: el portal es VERDE y el
     sistema es NARANJA. Es el par de colores que Pablo ya lee sin pensar. Dos
     cajas grises identicas obligan a leer la etiqueta cada vez. */
  .sp-side.pt{border-color:#bbf7d0;background:#f0fdf4}
  .sp-side.sy{border-color:#fed7aa;background:#fff7ed}
  .sp-side .lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .sp-side.pt .lbl{color:#15803d}
  .sp-side.sy .lbl{color:#b45309}
  .sp-side .val{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                font-size:13.5px;color:var(--ink);word-break:break-all;line-height:1.4;
                font-variant-numeric:tabular-nums;font-weight:600}
  .sp-side .val.na{color:var(--muted);font-style:italic;font-family:inherit;font-weight:400}

  /* El boton lleva el NOMBRE DE LA ACCION (Adoptar / Publicar), no una frase.
     Son las palabras que ya se usan en el resto del portal. */
  .sp-pick{font:inherit;font-size:12.5px;font-weight:700;padding:8px 10px;border-radius:8px;
           border:1px solid transparent;cursor:pointer;margin-top:auto;color:#fff}
  .sp-pick.pt{background:#16a34a}
  .sp-pick.pt:hover:not(:disabled){background:#15803d}
  .sp-pick.sy{background:#ea580c}
  .sp-pick.sy:hover:not(:disabled){background:#c2410c}
  .sp-pick:disabled{background:var(--bg-soft,#f1f5f9);color:var(--muted);cursor:default}
  .sp-pick .sub{display:block;font-size:10.5px;font-weight:500;opacity:.9;margin-top:1px}

  /* Anular: gris, discreto, ancho completo abajo. No compite con los dos de
     arriba: es la salida, no una opcion mas. */
  .sp-null{width:100%;margin-top:10px;font:inherit;font-size:12.5px;font-weight:600;
           padding:7px 10px;border-radius:8px;border:1px dashed var(--border);
           background:transparent;color:var(--muted);cursor:pointer}
  .sp-null:hover:not(:disabled){background:var(--bg-soft,#f1f5f9);color:var(--ink);
                                border-style:solid}
  .sp-null:disabled{opacity:.5;cursor:default}

  .sp-fld{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;
          letter-spacing:.04em;margin:0 0 7px}
  .sp-fld+.sp-vs{margin-bottom:11px}
  .sp-vs:last-child{margin-bottom:0}

  .sp-done{padding:9px 12px;border-radius:9px;background:#f0fdf4;border:1px solid #bbf7d0;
           color:#15803d;font-size:12.5px;font-weight:600}
  .sp-fail{padding:9px 12px;border-radius:9px;background:#fef2f2;border:1px solid #f3c2c2;
           color:#b91c1c;font-size:12.5px}

  .sp-tbl{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--card,#fff);
          border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .sp-tbl th{background:var(--bg-soft,#f8fafc);text-align:left;font-size:10.5px;text-transform:uppercase;
             letter-spacing:.04em;color:var(--muted);font-weight:700;padding:9px 11px;
             border-bottom:1px solid var(--border);white-space:nowrap}
  .sp-tbl td{padding:8px 11px;border-bottom:1px solid var(--border-soft,#eef1f5);color:var(--ink);
             vertical-align:middle}
  .sp-tbl tr:last-child td{border-bottom:0}
  .sp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .sp-bad{color:#9a3412}

  .sp-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;
          padding:8px 14px;border:1px solid var(--border);border-radius:9px;background:var(--surface);
          color:var(--ink);cursor:pointer}
  .sp-btn:hover{background:var(--bg-soft,#f1f5f9)}
  .sp-empty{padding:30px 16px;text-align:center;color:var(--muted);font-size:13px;
            border:1px dashed var(--border);border-radius:12px}
  .sp-ok{padding:26px 16px;text-align:center;color:#15803d;font-size:14px;font-weight:600;
         background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px}
  @media(max-width:640px){
    .sp-stats{grid-template-columns:1fr}
    .sp-vs{grid-template-columns:1fr}
  }`;
  document.head.appendChild(st);
}

/* ---------- UNA FICHA EN CONFLICTO ----------
   Un bloque por CAMPO. Dos columnas: el portal y el sistema. Un boton debajo de
   cada valor. El usuario elige CUAL ES EL BUENO; el portal traduce esa eleccion
   a adopt (si eligio el del sistema) o a detect_commit (si eligio el del portal).

   Se muestran los dos valores TAL CUAL estan en cada lado. Nada de "normalizar
   para mostrar": lo que el usuario tiene que ver es lo que hay. */
function conflictCard(c, i) {
  const bloques = c.fields.map((f, j) => {
    const lbl = CAMPO_LBL[f.campo] || f.campo;
    const roto = f.estado === 'dato_roto';
    // dato_roto: el portal lo tiene BIEN y el sistema MAL. No hay eleccion que
    // hacer (ya se sabe cual vale) -> no se ofrece "adoptar" un dato roto.
    return `
      <p class="sp-fld">${esc(lbl)}${roto ? ' \u00b7 el sistema lo tiene mal escrito' : ''}</p>
      <div class="sp-vs">
        <div class="sp-side pt">
          <span class="lbl">En el portal</span>
          <span class="val${f.portal ? '' : ' na'}">${f.portal ? esc(fmtValor(f.campo, f.portal)) : 'sin dato'}</span>
          <button class="sp-pick pt" data-pick="portal" data-i="${i}" data-j="${j}">Publicar<span class="sub">se envía al sistema</span></button>
        </div>
        <div class="sp-side sy">
          <span class="lbl">En el sistema</span>
          <span class="val${f.sistema ? '' : ' na'}">${f.sistema ? esc(fmtValor(f.campo, f.sistema)) : 'sin dato'}</span>
          ${roto
            ? '<button class="sp-pick" disabled title="Este dato est\u00e1 mal escrito: hay que corregirlo en el sistema">Mal escrito</button>'
            : `<button class="sp-pick sy" data-pick="sistema" data-i="${i}" data-j="${j}">Adoptar<span class="sub">entra al portal</span></button>`}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="sp-card" id="spCard_${i}">
      <div class="sp-ctop">
        <span class="sp-nom">${esc(c.full_name)}</span>
        <span class="sp-meta"><span class="sp-cc">${esc(c.company_code)}</span> \u00b7 ${esc(c.id_number)}</span>
      </div>
      ${bloques}
      <button class="sp-null" data-null="${i}">Anular · dejar los dos como están</button>
      <div id="spMsg_${i}" style="margin-top:10px" hidden></div>
    </div>`;
}

/* ---------- RESOLVER ----------
   El usuario eligio un lado. Se traduce a la accion que corresponde y se llama
   al endpoint que YA EXISTE (/api/ax-review). Los dos re-detectan en el server
   antes de escribir: por eso tarda, y por eso es seguro. */
async function resolve(i, lado) {
  const c = SP.conflicts[i];
  if (!c) return;
  const card = $('#spCard_' + i);
  const msg = $('#spMsg_' + i);
  if (!card || !msg) return;

  card.querySelectorAll('.sp-pick').forEach(b => { b.disabled = true; });
  msg.hidden = false;
  msg.className = '';
  msg.innerHTML = '<span style="font-size:12.5px;color:var(--muted)">Comprobando contra el sistema\u2026</span>';

  /* eligio el del SISTEMA -> ADOPTAR  (el valor del sistema entra al portal)
     eligio el del PORTAL  -> PUBLICAR (el valor del portal se manda al sistema;
                                        aparece en "Enviar al sistema → Publicar") */
  const action = lado === 'sistema' ? 'adopt' : 'detect_commit';
  const r = await axReview({
    action,
    id_numbers: [c.id_number],
    company_codes: [c.company_code],
  });

  if (!r || !r.ok) {
    msg.className = 'sp-fail';
    msg.textContent = (r && r.error) || 'No se pudo completar. Prob\u00e1 de nuevo.';
    card.querySelectorAll('.sp-pick').forEach(b => { b.disabled = false; });
    return;
  }

  const n = (r.count != null) ? r.count : ((r.adopted || r.marked || []).length);
  if (!n) {
    /* Re-detecto y ya no hay diferencia: alguien lo resolvio antes (en el
       sistema o en la ficha). No es un error; la marca se limpia sola en la
       proxima corrida. */
    msg.className = 'sp-done';
    msg.textContent = '\u2713 Ya estaba resuelto. La marca se limpia en la pr\u00f3xima sincronizaci\u00f3n.';
    return;
  }

  msg.className = 'sp-done';
  msg.textContent = lado === 'sistema'
    ? '\u2713 Listo. El portal tom\u00f3 el dato del sistema.'
    : '\u2713 Listo. El dato del portal qued\u00f3 para enviar: lo vas a ver en Publicar.';
}

/* ---------- ANULAR ----------
   No toca ningun dato: solo apaga el aviso. Los dos valores quedan como estan,
   cada uno en su lado.

   Para que sirve: cuando LOS DOS estan mal, o cuando el del portal esta bien
   pero no se quiere escribir en el sistema ahora. Sin esto, esas fichas se
   quedaban en la bandeja para siempre, porque la unica salida era elegir un
   lado.

   ⚠ NO confundir con el Anular de Publicar: aquel descarta un cambio que
   estaba por enviarse al sistema. Este solo silencia una etiqueta.

   La diferencia sigue existiendo. Si el dato cambia de algun lado, la proxima
   sincronizacion la vuelve a marcar — y esta bien: seria otro conflicto. */
async function dismiss(i) {
  const c = SP.conflicts[i];
  if (!c) return;
  const card = $('#spCard_' + i);
  const msg = $('#spMsg_' + i);
  if (!card || !msg) return;

  card.querySelectorAll('.sp-pick, .sp-null').forEach(b => { b.disabled = true; });
  msg.hidden = false;
  msg.className = '';
  msg.innerHTML = '<span style="font-size:12.5px;color:var(--muted)">Anulando…</span>';

  const r = await api({ action: 'dismiss', id_number: c.id_number });

  if (!r || !r.ok) {
    msg.className = 'sp-fail';
    msg.textContent = (r && r.error) || 'No se pudo anular. Prob\u00e1 de nuevo.';
    card.querySelectorAll('.sp-pick, .sp-null').forEach(b => { b.disabled = false; });
    return;
  }

  msg.className = 'sp-done';
  msg.textContent = '\u2713 Aviso anulado. No se cambi\u00f3 ning\u00fan dato; los dos quedaron como estaban.';
}

function paint() {
  const host = $('#spBody');
  if (!host) return;

  const nC = SP.conflicts.length;
  const nR = SP.rejected.length;
  const nS = SP.skipped.length;

  // Nada pendiente: se dice y punto. Una pantalla vacia con tres tablas vacias
  // es peor que un mensaje claro.
  if (!nC && !nR && !nS) {
    host.innerHTML = '<div class="sp-ok">\u2713 No hay nada pendiente. Todo al d\u00eda.</div>';
    return;
  }

  const partes = [];

  /* --- 1. HAY QUE DECIDIR --- */
  partes.push(`<div class="sp-sec">
    <h2>Hay que decidir</h2>
    <p class="lead">Los dos lados tienen un dato y no coinciden. El portal <b>no toc\u00f3 nada</b>: solo los se\u00f1al\u00f3.
       Eleg\u00ed cu\u00e1l vale.</p>
    ${nC
      ? SP.conflicts.map((c, i) => conflictCard(c, i)).join('')
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
      <table class="sp-tbl">
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
      <table class="sp-tbl">
        <thead><tr><th style="width:120px">Empresa</th><th>Motivo</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`);
  }

  host.innerHTML = partes.join('');

  // Botones de resolucion.
  host.querySelectorAll('[data-pick]').forEach(b =>
    b.addEventListener('click', () => resolve(+b.dataset.i, b.dataset.pick)));
  // Anular: apaga el aviso sin tocar ningun dato.
  host.querySelectorAll('[data-null]').forEach(b =>
    b.addEventListener('click', () => dismiss(+b.dataset.null)));

  const exp = $('#spExp');
  if (exp) exp.addEventListener('click', () => openExportMenu(exp));
}

/* ---------- EXPORTAR (patron del portal: xlsx / csv / txt) ---------- */
function exportRows() {
  return SP.rejected.map(d => ({
    'C\u00e9dula': d.ced,
    'Colaborador': d.nom,
    'Empresa': d.comp,
    'Campo': CAMPO_LBL[d.campo] || d.campo,
    'Vino as\u00ed': d.valor,
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
    <div class="sp-stat slt">
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
