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

/* =====================================================================
   TARJETAS GENERADAS DEL DATO (v6.215).

   Antes estaban escritas a mano y comparadas por TEXTO
   (`causa_top.startsWith('Sin dispositivo')`), lo que fallaba de dos
   formas: si alguien renombraba la etiqueta en el catalogo la tarjeta
   dejaba de contar sin avisar, y solo miraba la causa DOMINANTE de cada
   tienda -asi que una con 5 "sin dispositivo" y 6 "otros" no entraba-.
   Medido: decia 4 tiendas sin biometrico cuando eran 8, y 9 con problema
   electrico cuando eran 12. La mitad.

   Ahora salen de recurrencia_causas, que cuenta sobre las lineas. Una causa
   nueva en el catalogo aparece sola: aca no hay ninguna lista escrita.

   LA UNIDAD CAMBIA SEGUN EL TIPO, y no es un descuido. Una falla de marcaje
   se cuenta en TIENDAS porque eso es lo accionable -8 sucursales sin
   aparato es una orden de compra-. Una ausencia se cuenta en PERSONAS
   porque un reposo no es una falla de la tienda. Cada tarjeta dice su
   unidad debajo del numero para que nadie sume peras con manzanas.
   ===================================================================== */
  const CAUSA_TONO = {
    no_device: 'rc-danger',          // la tienda no tiene aparato
    power_outage: 'rc-warn',
    biometric_failure: 'rc-warn',
    system_failure: 'rc-warn',
    forgot: 'rc-att',                // atribuible a la persona
    early_close: 'rc-att',
  };

  function grupoCausas(tipo, causas) {
    const lista = (causas || []).filter(c => c.tipo === tipo);
    if (!lista.length) return '';
    // Las 5 mas pesadas; el resto se junta para no perder el total de vista.
    const top = lista.slice(0, 5);
    const resto = lista.slice(5);
    const restoLineas = resto.reduce((n, c) => n + (c.lineas || 0), 0);
    const esMarcaje = tipo === 'marcaje';
    const total = lista.reduce((n, c) => n + (c.lineas || 0), 0);

    const card = (c) => {
      const n = esMarcaje ? c.tiendas : c.personas;
      const un = esMarcaje ? (n === 1 ? 'tienda' : 'tiendas') : (n === 1 ? 'persona' : 'personas');
      return `<div class="rc-stat">
        <div class="rc-stat-l">${esc(c.label)}</div>
        <div class="rc-stat-v ${CAUSA_TONO[c.code] || ''}">${n}</div>
        <div class="rc-stat-u">${un} · ${c.lineas} línea${c.lineas === 1 ? '' : 's'}</div>
      </div>`;
    };

    return `<div class="rc-grupo">
      <div class="rc-grupo-t">${esMarcaje ? 'Marcaje manual' : 'Períodos de ausencia'}
        <span class="rc-sub">${total} línea${total === 1 ? '' : 's'} en el período</span></div>
      <div class="rc-stats">
        ${top.map(card).join('')}
        ${resto.length ? `<div class="rc-stat"><div class="rc-stat-l">Otras ${resto.length}</div>
          <div class="rc-stat-v">${restoLineas}</div><div class="rc-stat-u">líneas</div></div>` : ''}
      </div>
    </div>`;
  }

  /* "Otros… ×101" no dice nada, y es peor que eso: 'Otros' es JUSTAMENTE la
     causa donde quien reporto escribio una explicacion. Las 101 de AL01 son
     57 "esta presentado apoyo a otra tienda" mas 42 "Presento apoyo a otra
     tienda" — la misma frase en dos grafias. Cuando la causa dominante es
     'Otros' se muestra ESE texto arriba y la etiqueta abajo, que es el orden
     en que importan. Y toda la celda abre el desglose. */
  function causaCell(t) {
    if (!t.causa_top) return '<span class="muted">—</span>';
    const n = t.causa_top_n ? `<span class="rc-sub">×${t.causa_top_n}</span>` : '';
    const cuerpo = t.causa_top_txt
      ? `<span class="rc-txt">“${esc(t.causa_top_txt)}”</span> ${n}
         <div class="rc-sub">${esc(t.causa_top)} · escrito a mano</div>`
      : `${esc(t.causa_top)} ${n}`;
    return `<button type="button" class="rc-causa" data-det="${esc(t.company_code)}"
        title="Ver el desglose de ${esc(t.company_code)}">${cuerpo}</button>`;
  }

  /* =====================================================================
     LO QUE ESTA VISTA NO CUENTA, DICHO EN LA VISTA.

     Sin esto la pantalla se lee como incoherente, y con razon: AL01 muestra
     110 marcajes y 23 personas en la pestaña de tiendas, y en la de
     personas no aparece nadie. El motivo es correcto -las 110 son apoyo
     entre tiendas, falla del sistema y altas sin enrolar, ninguna
     imputable a la persona- pero vivia solo en un comentario del codigo.
     Quien mira la pantalla veia dos numeros que no cerraban.

     Ahora se dice con los numeros del propio periodo: cuantas lineas SI se
     cuentan y cuantas no, y por que.
     ===================================================================== */
  function notaPersonas() {
    return `<div class="rc-nota">
      Se cuentan <b>todos</b> los marcajes manuales, sin mirar la causa, y se comparan
      contra el promedio de <b>su propia tienda</b>. Esa comparación es la que importa:
      una falla del biométrico o de la luz le pasa a <b>toda</b> la tienda, así que el
      cociente da cerca de 1. Si una sola persona acumula el doble o el triple que sus
      compañeros, la causa declarada no explica la diferencia.
      La columna <b>Causa que declara</b> es contexto, no filtro.
    </div>`;
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
      <td>${causaCell(t)}</td>
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
      <td style="text-align:right"><b class="${p.veces_prom >= 2 ? 'rc-att' : ''}">${p.veces_prom == null ? '—' : `${p.veces_prom}×`}</b></td>
      <td>${p.causa_top ? esc(p.causa_top) : '<span class="muted">—</span>'}
        ${p.atribuibles ? `<div class="rc-sub">${p.atribuibles} de la persona</div>` : ''}</td>
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
    const causas = d.causas || [];
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
          ${grupoCausas('marcaje', causas)}
          ${grupoCausas('ausencia', causas)}
          <div class="rc-stats">
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
          ${notaPersonas()}
          ${personas.length ? `<table class="dtl-table rc-table"><thead><tr>
            <th>Trabajador</th><th>Tienda</th>
            <th style="text-align:right" title="Marcajes manuales de esta persona en el período, de cualquier causa">Marcajes</th>
            <th style="text-align:right" title="Promedio de marcajes por persona en esta misma tienda">Prom. tienda</th>
            <th style="text-align:right" title="Cuántas veces el promedio de su propia tienda">Veces</th>
            <th>Causa que declara</th><th>Último</th><th></th>
          </tr></thead><tbody>${personas.map(filaPersona).join('')}</tbody></table>`
            : `<p class="hint">Nadie llega a ${ST.min} marcajes manuales en este período dentro de una tienda con al menos 3 personas reportadas.</p>`}
        `}
      </div>`;

    $('#rcPer').addEventListener('change', (e) => {
      const [a, b] = e.target.value.split('|');
      ST.desde = a; ST.hasta = b; cargar();
    });
    host.querySelectorAll('[data-tab]').forEach(b =>
      b.addEventListener('click', () => { ST.tab = b.dataset.tab; pintar(); }));
    host.querySelectorAll('[data-det]').forEach(b =>
      b.addEventListener('click', () => vistaTienda(b.dataset.det)));
    host.querySelectorAll('[data-sil]').forEach(b =>
      b.addEventListener('click', () => modalSilencio('tienda', b.dataset.sil)));
    host.querySelectorAll('[data-silp]').forEach(b =>
      b.addEventListener('click', () => modalSilencio('persona', b.dataset.silp)));
    host.querySelectorAll('[data-lev]').forEach(b =>
      b.addEventListener('click', () => levantar('tienda', b.dataset.lev)));
    host.querySelectorAll('[data-levp]').forEach(b =>
      b.addEventListener('click', () => levantar('persona', b.dataset.levp)));
  }

  /* El desglose de una tienda. Lo que se viene a ver es la fila de "Otros":
     una linea por TEXTO distinto, con cuantas veces y cuanta gente. Ahi la
     cifra deja de ser anonima y se entiende de que se trata la recurrencia
     -si es apoyo entre tiendas, una falla del centro comercial o gente que
     se olvida-. Las causas del catalogo van igual, para tener el total. */
  /* =====================================================================
     DESGLOSE DE UNA TIENDA — PANTALLA, NO MODAL (v6.219).

     Era un modal y quedaba chico para lo que hay que mostrar: las causas,
     los textos escritos a mano y, debajo de cada uno, QUIENES y cuantas
     veces. En un cuadro flotante eso obliga a plegar la mitad y a scrollear
     dentro de una caja; en una pantalla entra todo abierto, que es como se
     lee de verdad. Ademas el portal ya navega asi -Personal, Movimientos,
     el Detalle del reporte, Reportes del trabajador- con su "Volver".

     El "Volver" repinta la lista con el MISMO periodo y la misma pestaña,
     porque ST no se toco: volver no puede costarte los filtros.
     ===================================================================== */
  async function vistaTienda(company) {
    host.innerHTML = `<button class="btn" id="rcBack" style="margin-bottom:18px">← Volver a Recurrencia</button>
      <div class="pnl-loading">Cargando…</div>`;
    $('#rcBack').addEventListener('click', pintar);

    const d = await fetch('/api/recurrencia', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'detalle_tienda', user, company_code: company, desde: ST.desde, hasta: ST.hasta }),
    }).then(r => r.json()).catch(() => null);

    const cab = `<button class="btn" id="rcBack" style="margin-bottom:18px">← Volver a Recurrencia</button>
      <div class="pnl-head"><div><h1>${esc(company)}</h1>
        <p>Marcajes manuales y ausencias del ${ddmm(ST.desde)} al ${ddmm(ST.hasta)}, por causa y por persona.</p></div></div>`;

    if (!d || !d.ok) {
      host.innerHTML = cab + `<div class="card"><p class="muted" style="margin:0">${esc(d ? d.error : 'Error de red.')}</p></div>`;
      $('#rcBack').addEventListener('click', pintar);
      return;
    }

    /* Todo abierto y sin plegar: en una pantalla hay lugar, y el dato que se
       viene a buscar son justamente los nombres. Plegarlos seria repetir el
       problema que tenia el modal. */
    const grupo = (tipo, titulo) => {
      const f = (d.filas || []).filter(x => x.tipo === tipo);
      if (!f.length) return '';
      const total = f.reduce((n, x) => n + (x.n || 0), 0);
      return `<h3 class="rd-section">${titulo} <span class="rc-sub">${total} línea${total === 1 ? '' : 's'}</span></h3>
        ${f.map(x => {
          const gente = (d.quienes || []).filter(q => q.tipo === x.tipo && q.etiqueta === x.etiqueta);
          const titulo2 = x.es_texto
            ? `<span class="rc-txt">“${esc(x.etiqueta)}”</span> <span class="rc-sub">· escrito a mano por la tienda</span>`
            : esc(x.etiqueta);
          return `<div class="rc-blq">
            <div class="rc-blq-h"><div class="rc-blq-t">${titulo2}</div>
              <div class="rc-blq-n"><b>${x.n}</b> línea${x.n === 1 ? '' : 's'} ·
                ${x.personas} persona${x.personas === 1 ? '' : 's'}</div></div>
            ${gente.length ? `<div class="rc-blq-g">${gente.map(q => `<div class="rc-q">
                <span class="rc-q-n">${esc(q.worker_name || '')}</span>
                <span class="rc-sub">${esc(q.id_number)}</span>
                <span class="rc-q-v">${q.n}</span>
              </div>`).join('')}</div>` : '<div class="rc-sub" style="padding:6px 0">Sin detalle de personas.</div>'}
          </div>`;
        }).join('')}`;
    };

    const cuerpo = grupo('marcaje', 'Marcaje manual') + grupo('ausencia', 'Períodos de ausencia');
    host.innerHTML = cab + `<div class="card">${cuerpo || '<p class="hint">Sin movimientos en este período.</p>'}</div>`;
    $('#rcBack').addEventListener('click', pintar);
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
