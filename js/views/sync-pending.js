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
import { renderWorkerPhotos, openWorkerLightbox } from './worker-photos.js';
import { renderSyncLog } from './sync-log.js';

/* Tipos de empresa que NO son tienda: definen el modo de la vista Personal al
   saltar a la ficha (mismo criterio que Buscar y Publicar). */
const NON_STORE_TYPES = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en l\u00ednea']);

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

/* v5.49: las tres decisiones (adoptar / enviar a publicar / anular) van todas a
   /api/sync-pending. Antes "Publicar" iba a /api/ax-review action:detect_commit,
   que crea el change_set pero NO limpia ax_diff — y la ficha quedaba pegada en
   esta pantalla para siempre. Ese endpoint sigue vivo y lo usa Comparar, donde
   NO hay que limpiar el ax_diff (ahi no hay una decision tomada, solo una
   deteccion). Por eso se hizo una accion propia en vez de tocarlo. */

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

  /* ===== LA FICHA DE LA CORRIDA (v5.48) =====
     El problema: la pagina abria con tres tarjetas de numeros y nada decia de
     donde salieron. Quedaban como tres cosas sueltas, comparables entre si — y
     el 63 (que NO se puede resolver desde aca) le ganaba el ojo al 5 (que si).

     Ahora primero va EL HECHO ("la corrida del 13/07 a las 16:50 sobre 132
     tiendas") y los numeros cuelgan de el como su consecuencia. Se lee: esto
     es lo que ESA corrida encontro. */
  .sp-run{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);
          padding:14px 16px;margin:18px 0 22px}
  .sp-run-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px}
  .sp-run-t{font-size:13.5px;color:var(--ink);font-weight:600}
  .sp-run-t b{font-weight:700}
  .sp-run-lnk{margin-left:auto;font:inherit;font-size:12px;font-weight:600;color:var(--brand,#2563eb);
              background:transparent;border:0;padding:0;cursor:pointer;white-space:nowrap}
  .sp-run-lnk:hover{text-decoration:underline}
  .sp-run-sub{font-size:12px;color:var(--muted);margin-bottom:12px}
  .sp-run-found{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint,#94a3b8);
                font-weight:700;margin-bottom:8px}
  /* Los tres resultados. Sin bordes ni cajas: son parte de la misma ficha, no
     tres tarjetas independientes. */
  .sp-res{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .sp-r{border-left:2px solid var(--border);padding-left:11px}
  .sp-r .v{font-size:24px;font-weight:700;line-height:1.15;color:var(--ink)}
  .sp-r .k{font-size:12px;color:var(--ink);font-weight:600;margin-top:1px}
  .sp-r .h{font-size:11px;color:var(--muted);margin-top:1px;line-height:1.4}
  /* Solo el accionable lleva color. Los otros dos son informativos: si los tres
     gritan, ninguno se escucha. */
  .sp-r.act{border-left-color:#2563eb}
  .sp-r.act .v{color:#1d4ed8}
  .sp-r.zero .v{color:var(--faint,#94a3b8)}
  @media(max-width:720px){ .sp-res{grid-template-columns:1fr;gap:10px} }

  .sp-sec{margin:0 0 24px}
  .sp-sec h2{margin:0 0 3px;font-size:15px;font-weight:700;color:var(--ink)}
  .sp-sec .lead{margin:0 0 12px;font-size:12.5px;color:var(--muted);line-height:1.6}

  /* ---- LA FILA (clon de axr-row) ---- */
  .sp-row{border:1px solid var(--border);border-radius:12px;background:var(--card,#fff);
          margin-bottom:8px;overflow:hidden}
  /* Ficha ya resuelta en esta sesion: se apaga, pero NO se saca de la lista.
     Si desapareciera de golpe, el usuario perderia la referencia de lo que
     acaba de decidir. Se va sola en la proxima carga. */
  .sp-row.done{opacity:.5}
  .sp-row.done .sp-foot{display:none}
  .sp-rowhead{display:flex;align-items:center;gap:13px;padding:12px 14px}
  /* v5.45: MISMO avatar que Publicar. Estaba redondo (border-radius:50%) y en el
     resto del portal es un cuadrado con esquinas redondeadas. Un circulo en una
     sola pantalla no es una decision de diseno: es un descuido. */
  .sp-ava{width:40px;height:40px;border-radius:10px;flex:none;display:flex;align-items:center;
          justify-content:center;font-weight:700;font-size:14px;overflow:hidden}
  .sp-ava.haspic{cursor:zoom-in;background:#eef2f7}
  .sp-ava img{width:100%;height:100%;object-fit:cover;display:block}
  /* v5.47: los botones de icono van PEGADOS AL NOMBRE, como en Publicar y en
     el Historial. Para eso .sp-who NO puede tener flex:1 (si se estira, empuja
     los botones contra el borde derecho): el espacio sobrante lo absorbe
     .sp-flex, que va DESPUES de los botones. Mismo patron que .axr-flex. */
  .sp-who{flex:0 1 auto;min-width:0;max-width:46%}
  .sp-flex{flex:1}
  .sp-nm{font-size:14px;font-weight:700;color:var(--ink);line-height:1.3}
  .sp-sub{font-size:12px;color:var(--muted);margin-top:1px}
  .sp-edit{font-size:11.5px;color:var(--faint,#94a3b8);margin-top:2px}
  .sp-rmeta{text-align:right;flex:none;font-size:11.5px;color:var(--muted);line-height:1.5}
  .sp-cc{color:var(--brand,#2563eb);font-weight:700;font-size:12px}
  .sp-emeta{color:var(--faint,#94a3b8)}
  .sp-chip{display:inline-block;margin-top:3px;padding:1px 7px;border-radius:20px;font-size:10.5px;
           font-weight:700;background:#fef3c7;color:#92400e}

  /* Botones de icono (Ver ficha / Copiar), identicos a los de Publicar. */
  .sp-rowacts{display:flex;gap:6px;flex:none;align-items:center}
  .sp-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
              border:1px solid var(--border);border-radius:8px;background:var(--surface,#fff);
              color:var(--ink-soft,#475569);cursor:pointer;padding:0}
  .sp-iconbtn:hover{background:var(--bg-soft,#f1f5f9);color:var(--ink)}
  .sp-iconbtn svg{width:15px;height:15px}

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

  /* v5.45: QUIEN toco el dato y CUANDO, debajo del valor.
     Es lo que decide: "la cuenta la cambio LUZ.GORD hace una semana" pesa mas
     que "la cuenta la toco th08.pmv en 2021". Y con las dos fechas se ve de un
     vistazo cual es el mas nuevo. */
  .sp-by{font-size:10.5px;color:var(--faint,#94a3b8);margin-top:3px;line-height:1.4}
  .sp-by b{font-weight:700;color:var(--muted)}
  /* AX registro el cambio pero no quien: se muestra en cursiva para que se lea
     como una aclaracion, no como el nombre de una persona. */
  .sp-by.anon span{font-style:italic}
  /* El lado mas RECIENTE se marca. No decide por vos, pero es el dato mas duro
     que hay para elegir. */
  .sp-by.new{color:#0f766e}
  .sp-by.new b{color:#0f766e}
  .sp-eco{font-size:10px;color:#92400e;background:#fef3c7;border-radius:4px;padding:0 4px;
          display:inline-block;margin-top:2px;font-weight:600}

  /* ---- BOTONES ----
     v5.47: EL ORDEN IMPORTA. Cada boton se alinea con LA COLUMNA DE DONDE SACA
     EL DATO:

         EN EL PORTAL          EN EL SISTEMA
         0424 8494408          0412 3570189
              └─ Publicar →         └─ ← Adoptar

     Antes estaban al reves (Adoptar antes que Publicar) y era contradictorio:
     el boton que trae el dato de la DERECHA estaba a la IZQUIERDA del que lo
     manda desde la izquierda. Las flechas apuntaban bien y el orden cruzaba los
     cables.

     Anular va aparte, contra el borde izquierdo: no es una tercera opcion del
     mismo tipo, es la salida. */
  .sp-foot{display:flex;gap:8px;align-items:center;margin-top:11px;flex-wrap:wrap}
  .sp-fspace{flex:1}
  .sp-b{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;
        padding:7px 13px;border-radius:8px;cursor:pointer;border:1px solid var(--border);
        background:var(--surface,#fff);color:var(--ink);white-space:nowrap}
  .sp-b svg{width:15px;height:15px;flex:none}
  .sp-b:hover:not(:disabled){background:var(--bg-soft,#f1f5f9)}
  .sp-b:disabled{opacity:.5;cursor:default}
  /* Publicar: ambar y flecha a la DERECHA (el dato sale del portal). El mismo
     boton, el mismo color y la misma flecha que en la pagina Publicar. */
  .sp-b.pub{background:#fffbeb;border-color:#fcd34d;color:#92400e}
  .sp-b.pub:hover:not(:disabled){background:#fef3c7;border-color:#d97706}
  /* Adoptar: azul y flecha a la IZQUIERDA (el dato viene del sistema). Color
     distinto a proposito: es la direccion contraria, no una variante de lo
     mismo. */
  .sp-b.ado{background:#eff6ff;border-color:#93c5fd;color:#1e40af}
  .sp-b.ado:hover:not(:disabled){background:#dbeafe;border-color:#2563eb}
  /* Anular: gris. Es la salida, no una opcion mas. */
  .sp-b.nul{color:var(--muted)}
  .sp-b.nul:hover:not(:disabled){color:#b91c1c;border-color:#fca5a5;background:#fef2f2}

  /* ===== EL AVISO DE PISADA (v5.49) =====
     Adoptar el dato del sistema cuando la tienda ya edito el suyo DESCARTA ese
     trabajo. Se avisa antes, con nombre y fecha de quien lo hizo. */
  .sp-ovl{position:fixed;inset:0;z-index:1200;background:rgba(15,23,42,.45);
          display:flex;align-items:center;justify-content:center;padding:20px}
  .sp-modal{background:var(--card,#fff);border-radius:14px;max-width:480px;width:100%;
            box-shadow:0 20px 50px rgba(15,23,42,.28);overflow:hidden}
  .sp-mhead{display:flex;gap:12px;align-items:flex-start;padding:16px 18px 12px;
            border-bottom:1px solid var(--border)}
  .sp-mico{width:36px;height:36px;border-radius:10px;flex:none;display:flex;align-items:center;
           justify-content:center;background:#fffbeb;color:#b45309}
  .sp-mico svg{width:19px;height:19px}
  .sp-mt{font-size:15px;font-weight:700;color:var(--ink);line-height:1.3}
  .sp-msub{font-size:12.5px;color:var(--muted);margin-top:2px}
  .sp-mbody{padding:14px 18px}
  .sp-mbody p{margin:0 0 12px;font-size:13px;color:var(--ink);line-height:1.6}
  .sp-mbody p:last-child{margin-bottom:0}
  /* Lo que se pierde, en su propia caja: es EL dato de la decision. */
  .sp-mbox{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;margin-bottom:12px}
  .sp-mbk{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#92400e;font-weight:700}
  .sp-mbv{font-size:13px;color:#78350f;font-weight:600;margin-top:2px}
  .sp-mbw{font-size:11.5px;color:#92400e;margin-top:3px}
  .sp-mbw b{font-weight:700}
  .sp-mnote{font-size:12px !important;color:var(--muted) !important}
  .sp-mfoot{display:flex;align-items:center;gap:8px;padding:12px 18px 16px;
            border-top:1px solid var(--border)}

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
/* Flechas de direccion. Publicar SALE (derecha), Adoptar VIENE (izquierda).
   Las mismas que en Publicar y Comparar: el mismo gesto, el mismo significado. */
const ARR_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
const ARR_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
const IC_FICHA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M14 9h4M14 13h4M5 16c.6-1.5 1.9-2 3-2s2.4.5 3 2"/></svg>';
const IC_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

/* Cuando el sistema dice que el ultimo en tocar un campo fue el portal (el eco
   de una publicacion nuestra), eso NO es una novedad de un tercero. Estos son
   los usuarios con los que el portal escribe en el sistema. */
const ECO_USERS = new Set(['PABLO']);

/* ===== EL "?" DEL SISTEMA =====
   AX devuelve `"modificadoPor": "?"` cuando NO GUARDO quien hizo el cambio. No
   es un usuario llamado "?": es un hueco en la auditoria del ERP.

   Hay que decirlo con todas las letras, porque son TRES estados distintos y
   antes se veian igual (la linea simplemente no aparecia):

     (nada)                  -> todavia no lo consultamos
     ISMAEL.M · 17/11/2025   -> una persona lo toco
     sin autor registrado    -> AX perdio el rastro

   Mostrar el "?" crudo seria peor que no mostrar nada: parece un usuario. */
const SIN_AUTOR = new Set(['?', '', '-', 'none', 'null']);
const esSinAutor = (by) => SIN_AUTOR.has(String(by == null ? '' : by).trim().toLowerCase());

/* Linea "quien · cuando" debajo de un valor. mas=true lo marca como el mas
   reciente de los dos lados. */
function byLine(by, at, mas) {
  if (!by && !at) return '';

  // El sistema tiene la fecha pero no el autor: se dice, no se disfraza.
  if (esSinAutor(by)) {
    const cuando = at ? esc(fmtDT(at)) : '';
    return `<div class="sp-by anon${mas ? ' new' : ''}">`
      + '<span title="El sistema registr\u00f3 el cambio pero no qui\u00e9n lo hizo">sin autor registrado</span>'
      + (cuando ? ` \u00b7 ${cuando}` : '')
      + '</div>';
  }

  const eco = by && ECO_USERS.has(String(by).toUpperCase());
  const partes = [];
  if (by) partes.push(`<b>${esc(by)}</b>`);
  if (at) partes.push(esc(fmtDT(at)));
  return `<div class="sp-by${mas ? ' new' : ''}">${partes.join(' \u00b7 ')}`
    + (eco ? '<div class="sp-eco">lo escribi\u00f3 el portal</div>' : '')
    + '</div>';
}

function conflictRow(c, i) {
  const ci = i % AVATAR_BG.length;
  const emeta = [c.zona, c.subzona, c.concepto].filter(Boolean).map(esc).join(' \u00b7 ');
  const ced = `${c.ced_kind ? esc(c.ced_kind) + '-' : ''}${esc(c.id_number)}`;

  const filas = c.fields.map((f) => {
    const roto = f.estado === 'dato_roto';
    /* Cual lado se toco mas recientemente. Si falta una de las dos fechas no se
       marca ninguno: no se puede comparar contra nada. */
    const tp = f.portal_at ? Date.parse(f.portal_at) : NaN;
    const ts = f.sistema_at ? Date.parse(f.sistema_at) : NaN;
    const pNuevo = !isNaN(tp) && !isNaN(ts) && tp > ts;
    const sNuevo = !isNaN(tp) && !isNaN(ts) && ts > tp;
    return `<tr>
      <td class="fld">${esc(CAMPO_LBL[f.campo] || f.campo)}</td>
      <td>
        <span class="sp-pv ${f.portal ? '' : 'sp-na'}">${f.portal ? esc(fmtValor(f.campo, f.portal)) : 'sin dato'}</span>
        ${byLine(f.portal_by, f.portal_at, pNuevo)}
      </td>
      <td>
        <span class="sp-sv ${f.sistema ? '' : 'sp-na'}">${f.sistema ? esc(fmtValor(f.campo, f.sistema)) : 'sin dato'}</span>
        ${roto ? '<div class="sp-warn">\u26a0 mal escrito</div>' : ''}
        ${byLine(f.sistema_by, f.sistema_at, sNuevo)}
      </td>
    </tr>`;
  }).join('');

  // Si TODOS los campos son dato_roto, no hay nada que adoptar: el sistema los
  // tiene mal. Adoptar un dato roto seria romper el portal a proposito.
  const todoRoto = c.fields.every(f => f.estado === 'dato_roto');

  return `
    <div class="sp-row" id="spRow_${i}">
      <div class="sp-rowhead">
        ${c.thumb_url
          ? `<div class="sp-ava haspic" data-pic="${i}" title="Ver foto"><img src="${esc(c.thumb_url)}" alt="" loading="lazy" onerror="this.remove()"></div>`
          : `<div class="sp-ava" style="background:${AVATAR_BG[ci]};color:${AVATAR_FG[ci]}">${esc(initialsOf(c.full_name))}</div>`}
        <div class="sp-who">
          <div class="sp-nm">${esc(c.full_name)}</div>
          <div class="sp-sub">${ced} \u00b7 ${esc(c.company_name || c.company_code)}</div>
          ${c.at ? `<div class="sp-edit">Diferencia detectada el ${esc(fmtDT(c.at))}</div>` : ''}
        </div>
        <div class="sp-rowacts">
          <button class="sp-iconbtn" data-ficha="${i}" title="Ver ficha">${IC_FICHA}</button>
          <button class="sp-iconbtn" data-copy="${i}" title="Copiar datos">${IC_COPY}</button>
        </div>
        <span class="sp-flex"></span>
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
          <span class="sp-fspace"></span>
          <button class="sp-b pub" data-act="portal" data-i="${i}" title="No publica todav\u00eda: prepara el env\u00edo. Se publica desde la p\u00e1gina Publicar.">Enviar a Publicar ${ARR_R}</button>
          <button class="sp-b ado" data-act="sistema" data-i="${i}"${todoRoto ? ' disabled title="El sistema tiene estos datos mal escritos: no hay nada que adoptar"' : ''}>${ARR_L} Adoptar</button>
        </div>
        <div class="sp-msg" id="spMsg_${i}" hidden></div>
      </div>
    </div>`;
}

/* ---------- RESOLVER ----------
   El usuario eligio un lado. Las dos decisiones van a /api/sync-pending y
   escriben EL VALOR QUE MUESTRA LA PANTALLA (leido de ax_diff_fields). No le
   vuelven a preguntar al sistema: lo que ves es lo que se hace.

   v5.49 — LAS DOS SACAN LA FICHA DE ESTA PANTALLA.

   Antes, "Publicar" llamaba a /api/ax-review action:detect_commit, que crea el
   change_set pero NO limpia ax_diff. La ficha quedaba en Diferencias Y en
   Publicar al mismo tiempo, y volvia a pedir la misma decision para siempre
   (Pablo: "nunca desaparece de las diferencias").

   Ahora la decision se toma UNA VEZ:
     Adoptar           -> escribe en el portal + anula el envio pendiente
     Enviar a Publicar -> crea el envio + limpia la diferencia

   ⚠ EL AVISO. Adoptar el dato del sistema cuando la tienda ya habia editado el
   suyo DESCARTA ese trabajo. Antes pasaba en silencio, y peor: el change_set
   sobrevivia y despues alguien publicaba el valor recien descartado. Ahora se
   avisa y se pide confirmacion. Estas pisando el trabajo de otro; que se vea. */
async function resolve(i, lado) {
  const c = SP.conflicts[i];
  if (!c) return;

  /* Adoptar con un cambio del portal esperando: hay que avisar ANTES. La ficha
     trae `pending` del backend (hay un ax_change_set en estado pending). */
  if (lado === 'sistema' && c.pending) {
    const ok = await confirmarPisada(c);
    if (!ok) return;
  }

  const row = $('#spRow_' + i);
  const msg = $('#spMsg_' + i);
  if (!row || !msg) return;

  row.querySelectorAll('.sp-b').forEach(b => { b.disabled = true; });
  msg.hidden = false;
  msg.className = 'sp-msg wait';

  let r;
  if (lado === 'sistema') {
    msg.textContent = 'Adoptando\u2026';
    r = await api({ action: 'adopt', id_number: c.id_number });
  } else {
    msg.textContent = 'Preparando el env\u00edo\u2026';
    r = await api({ action: 'publish_prep', id_number: c.id_number });
  }

  if (!r || !r.ok) {
    msg.className = 'sp-msg err';
    msg.textContent = (r && r.error) || 'No se pudo completar. Prob\u00e1 de nuevo.';
    row.querySelectorAll('.sp-b').forEach(b => { b.disabled = false; });
    return;
  }

  if (r.already) {
    msg.className = 'sp-msg ok';
    msg.textContent = '\u2713 Ya estaba resuelto.';
    marcarResuelta(row);
    return;
  }

  msg.className = 'sp-msg ok';

  if (lado === 'sistema') {
    let t = '\u2713 Listo. El portal tom\u00f3 el dato del sistema.';
    if (r.skipped_broken) {
      t += ` (${r.skipped_broken} campo${r.skipped_broken === 1 ? '' : 's'} mal escrito${r.skipped_broken === 1 ? '' : 's'} qued\u00f3 sin tocar)`;
    }
    // Que se sepa que se descarto algo, aunque ya se haya confirmado.
    if (r.discarded) {
      const q = r.discarded.by ? r.discarded.by : 'el portal';
      t += ` Se descart\u00f3 la edici\u00f3n que hab\u00eda hecho ${q}.`;
    }
    msg.textContent = t;
  } else {
    let t = '\u2713 Listo. El dato del portal qued\u00f3 para enviar: lo vas a ver en Publicar.';
    if (r.bank_blocked) {
      t += ' La cuenta bancaria no se incluy\u00f3: no ten\u00e9s permiso para enviarla.';
    }
    msg.textContent = t;
  }

  marcarResuelta(row);
}

/* ---------- EL AVISO: "esto descarta el trabajo de otro" ----------
   Modal del portal (nada de confirm() nativo: se cierra solo con sus botones).

   Por que existe: adoptar el dato del sistema cuando la tienda ya edito el suyo
   DESCARTA esa edicion. No es un detalle — es el trabajo de alguien, y en una
   cuenta bancaria es una decision sobre a donde va la plata.

   Devuelve una promesa: true = adelante, false = me arrepenti. */
function confirmarPisada(c) {
  return new Promise((resolver) => {
    // Que campos se van a descartar, con el nombre que ve el usuario.
    const campos = (c.fields || [])
      .filter(f => f.portal_by || f.portal_at)
      .map(f => CAMPO_LBL[f.campo] || f.campo);
    const lista = campos.length ? campos.join(', ') : 'el dato del portal';

    // Quien lo edito. Sale del primer campo que tenga atribucion.
    const conAutor = (c.fields || []).find(f => f.portal_by);
    const quien = conAutor && conAutor.portal_by ? conAutor.portal_by : null;
    const cuando = conAutor && conAutor.portal_at ? fmtDT(conAutor.portal_at) : null;

    const ov = document.createElement('div');
    ov.className = 'sp-ovl';
    ov.innerHTML = `
      <div class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="spCfT">
        <div class="sp-mhead">
          <div class="sp-mico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
          </div>
          <div>
            <div class="sp-mt" id="spCfT">Esto descarta una edici\u00f3n del portal</div>
            <div class="sp-msub">${esc(c.full_name)}</div>
          </div>
        </div>
        <div class="sp-mbody">
          <p>Esta ficha tiene un cambio <b>esperando enviarse al sistema</b>.
             Si adopt\u00e1s el dato del sistema, ese cambio <b>se descarta</b> y no se env\u00eda.</p>
          <div class="sp-mbox">
            <div class="sp-mbk">Se va a descartar</div>
            <div class="sp-mbv">${esc(lista)}</div>
            ${quien || cuando ? `<div class="sp-mbw">Lo edit\u00f3 ${quien ? `<b>${esc(quien)}</b>` : 'el portal'}${cuando ? ` el ${esc(cuando)}` : ''}</div>` : ''}
          </div>
          <p class="sp-mnote">El dato del sistema pasa a ser el bueno. La ficha sale de esta pantalla
             y tambi\u00e9n de Publicar.</p>
        </div>
        <div class="sp-mfoot">
          <button class="sp-b" id="spCfNo">Mejor no</button>
          <span class="sp-fspace"></span>
          <button class="sp-b ado" id="spCfSi">S\u00ed, adoptar el del sistema</button>
        </div>
      </div>`;

    const cerrar = (v) => { ov.remove(); resolver(v); };
    ov.querySelector('#spCfNo').addEventListener('click', () => cerrar(false));
    ov.querySelector('#spCfSi').addEventListener('click', () => cerrar(true));

    /* Solo los botones cierran. Ni el fondo, ni Escape: es una decision, no un
       aviso que se despacha sin leer. */
    document.body.appendChild(ov);
    setTimeout(() => { const b = ov.querySelector('#spCfNo'); if (b) b.focus(); }, 0);
  });
}

/* La ficha resuelta se apaga en el lugar (no se saca de la lista de golpe: si
   desapareciera, el usuario perderia la referencia de lo que acaba de hacer). */
function marcarResuelta(row) {
  row.classList.add('done');
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
  marcarResuelta(row);
}

/* ---------- ACCIONES DE FILA: foto, ficha, copiar ----------
   Las mismas tres que Publicar. Estaban solo alli y no habia razon: el que mira
   un conflicto necesita ver la cara, abrir la ficha y copiar los datos tanto o
   mas que el que publica. */

/* Foto en grande. Mismo lightbox que Personal y Publicar (imagen + Descargar +
   Escape + clic fuera). Firma: (src, pie, nombreDeArchivo). */
function openPic(i) {
  const c = SP.conflicts[i];
  if (!c || !c.thumb_url) return;
  const ced = `${c.ced_kind ? c.ced_kind + '-' : ''}${c.id_number}`;
  openWorkerLightbox(
    c.thumb_url,
    `${c.full_name || ''} \u00b7 ${ced}`,
    `${String(c.id_number).replace(/[^0-9]/g, '')}.jpg`,
  );
}

/* Abre la ficha en Personal.

   ⚠ EL DETALLE QUE IMPORTA: el callback de vuelta es renderSyncPending, NO
   renderAxReview. Si se copiaba el de Publicar tal cual, salias desde
   Pendientes, mirabas la ficha, apretabas Volver... y aparecias en Publicar.
   Una pantalla que no es la que dejaste. */
function gotoFicha(i) {
  const c = SP.conflicts[i];
  if (!c) return;
  const mode = NON_STORE_TYPES.has(c.company_type) ? 'enterprise' : 'store';
  renderWorkerPhotos(USER, c.company_code, () => renderSyncPending(USER),
    { mode, openCed: c.id_number });
}

/* Texto del conflicto para el portapapeles: para pegarlo en un ticket, un
   correo a la tienda, o un mensaje a quien haya que preguntarle. Lleva LOS DOS
   valores y quien toco cada uno — sin eso, el que lo recibe no puede decidir. */
function rowCopyText(c) {
  const L = [];
  L.push(c.full_name || '(sin nombre)');
  L.push(`C.I.: ${(c.ced_kind || 'V')}-${c.id_number}`);
  L.push(`Empresa: ${[c.company_code, c.company_name].filter(Boolean).join(' \u00b7 ')}`);
  const ubi = [c.zona, c.subzona, c.concepto].filter(Boolean).join(' \u00b7 ');
  if (ubi) L.push(ubi);
  L.push('');
  L.push(`Datos que no coinciden (${c.fields.length}):`);
  // Mismo criterio que la pantalla: el "?" de AX se traduce, no se copia crudo.
  const quien = (by, at) => {
    const partes = [];
    if (by) partes.push(esSinAutor(by) ? 'sin autor registrado' : by);
    if (at) partes.push(fmtDT(at));
    return partes.length ? `   [${partes.join(' \u00b7 ')}]` : '';
  };
  c.fields.forEach(f => {
    const lbl = CAMPO_LBL[f.campo] || f.campo;
    L.push(`- ${lbl}`);
    L.push(`    Portal:  ${f.portal ? fmtValor(f.campo, f.portal) : '(sin dato)'}`
      + quien(f.portal_by, f.portal_at));
    L.push(`    Sistema: ${f.sistema ? fmtValor(f.campo, f.sistema) : '(sin dato)'}`
      + (f.estado === 'dato_roto' ? '   (mal escrito)' : '')
      + quien(f.sistema_by, f.sistema_at));
  });
  if (c.at) { L.push(''); L.push(`Diferencia detectada el ${fmtDT(c.at)}`); }
  return L.join('\n');
}

async function copyRow(i, btn) {
  const c = SP.conflicts[i];
  if (!c) return;
  const text = rowCopyText(c);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (_) {
    // Sin permiso de portapapeles (http, navegador viejo): el truco del textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch (__) { ok = false; }
  }
  if (btn && ok) {
    const prev = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    btn.style.color = '#16a34a';
    setTimeout(() => { btn.innerHTML = prev; btn.style.color = ''; }, 1200);
  }
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

  // Foto en grande (mismo lightbox simple que Publicar).
  host.querySelectorAll('[data-pic]').forEach(b =>
    b.addEventListener('click', () => openPic(+b.dataset.pic)));

  /* Ver ficha. El backView es 'syncpend': al volver de la ficha, el portal
     regresa a PENDIENTES, no a Publicar. Antes volvia a la vista de donde salio
     el codigo original y era desorientador: te ibas desde una pantalla y
     aparecias en otra. */
  host.querySelectorAll('[data-ficha]').forEach(b =>
    b.addEventListener('click', () => gotoFicha(+b.dataset.ficha)));

  // Copiar los datos de la ficha (para pegarlos en un ticket o un correo).
  host.querySelectorAll('[data-copy]').forEach(b =>
    b.addEventListener('click', () => copyRow(+b.dataset.copy, b)));

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

/* ---------- LA FICHA DE LA CORRIDA ----------
   Primero el HECHO, despues sus consecuencias. La corrida es lo que le da
   sentido a todo lo que sigue: los tres numeros no son tres cosas sueltas, son
   LO QUE ESA CORRIDA ENCONTRO. */
function paintStats() {
  const el = $('#spRun');
  if (!el) return;
  const c = SP.counts || { conflicts: 0, rejected: 0, skipped: 0 };
  const lr = SP.last_run || {};

  const cuando = lr.run_at ? fmtDT(lr.run_at) : null;
  const tiendas = lr.stores != null ? lr.stores : null;

  const cabecera = cuando
    ? `La sincronizaci\u00f3n corri\u00f3 el <b>${esc(cuando)}</b>`
      + (tiendas ? ` sobre <b>${tiendas}</b> tienda${tiendas === 1 ? '' : 's'}.` : '.')
    : 'A\u00fan no hay ninguna sincronizaci\u00f3n registrada.';

  el.innerHTML = `
    <div class="sp-run-top">
      <div class="sp-run-t">${cabecera}</div>
      <button class="sp-run-lnk" id="spGoLog">Ver la corrida \u2192</button>
    </div>
    <div class="sp-run-sub">Corre sola cada 15 minutos. Compara el portal con el sistema y avisa lo que no coincide.</div>
    <div class="sp-run-found">Encontr\u00f3</div>
    <div class="sp-res">
      <div class="sp-r act">
        <div class="v">${c.conflicts}</div>
        <div class="k">para decidir</div>
        <div class="h">los dos lados tienen un dato distinto</div>
      </div>
      <div class="sp-r ${c.rejected ? '' : 'zero'}">
        <div class="v">${c.rejected}</div>
        <div class="k">mal escritos</div>
        <div class="h">se corrigen en el sistema, no ac\u00e1</div>
      </div>
      <div class="sp-r ${c.skipped ? '' : 'zero'}">
        <div class="v">${c.skipped}</div>
        <div class="k">tiendas saltadas</div>
        <div class="h">el sistema devolvi\u00f3 una lista corta</div>
      </div>
    </div>`;

  // La otra mitad de la historia: que paso EN esa corrida.
  const go = $('#spGoLog');
  if (go) go.addEventListener('click', () => renderSyncLog(USER, 'syncpend'));
}

export async function renderSyncPending(user) {
  USER = user;
  ensureStyles();
  SP = { conflicts: [], rejected: [], skipped: [], last_run: null, counts: null };

  $('#pnlMain').innerHTML = `
    <div class="sp-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
      <div>
        <h1>Diferencias</h1>
        <p>Lo que la sincronizaci\u00f3n encontr\u00f3 y necesita una decisi\u00f3n.</p>
      </div>
      <span id="spRefresh"></span>
    </div>
    <div class="sp-run" id="spRun"></div>
    <div id="spBody"></div>`;

  await load();
  attachRefresh('#spRefresh', () => load(), 'syncpend');
}
