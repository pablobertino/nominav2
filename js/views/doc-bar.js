/* =====================================================================
   js/views/doc-bar.js — barra de recaudos del Inicio            (v6.227)

   Una sola barra arriba de los KPIs, en los DOS Inicios (el del admin y el
   de la tienda). Vive aparte porque esos dos se arman por caminos
   distintos dentro de dashboard.js, y si cada uno pintara lo suyo
   terminarian diciendo cosas distintas sobre el mismo dato.

   MUESTRA AVANCE, NO DEUDA, y no es un adorno: lo que mata a un
   recordatorio permanente es que no cambia. "Te faltan 13" es el mismo
   numero todos los dias hasta que alguien haga algo, y en dos semanas
   nadie lo ve. "6 cargados esta quincena · faltan 13" se mueve cada vez
   que suben un papel, y el merito queda del lado de la tienda.

   Medido antes de decidirlo: se cargan ~500 documentos por semana desde
   julio, 48 de 134 tiendas cargaron algo esta quincena y NINGUNA cargo
   cero desde siempre. No es un atraso cronico: es una migracion a mitad de
   camino, y a ese ritmo lo que falta son unas nueve semanas ya en marcha.

   TRES TONOS, y la diferencia importa:
     ambar   hay algo MAL (advertencias). Es lo urgente y lo que se termina.
     neutro  solo FALTA. Faltar no es lo mismo que estar mal, y el color no
             tiene por que decir que si.
     verde   al dia. Se felicita, y no es hueco: 4 tiendas ya lo lograron
             con la referencia bancaria.

   La felicitacion dura la quincena en que se alcanzo. Fija seria decoracion
   ocupando el mejor lugar del Inicio; asi felicita cuando pasa y despues
   libera el espacio.
   ===================================================================== */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let CSS = false;
function ensureCss() {
  if (CSS) return;
  CSS = true;
  const s = document.createElement('style');
  s.textContent = `
  .rec-bar{display:flex;align-items:center;gap:16px;padding:14px 18px;border-radius:12px;
    border:1px solid var(--border);background:var(--surface,#fff);margin:16px 0 0}
  .rec-bar.alert{background:var(--warn-bg);border-color:#f0d9a8}
  .rec-bar.ok{background:var(--success-bg);border-color:#bbe7c4}
  .rec-ic{flex:none;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;
    justify-content:center;font-size:20px;background:#fff;border:1px solid var(--border)}
  .rec-bar.alert .rec-ic{border-color:#f0d9a8}
  .rec-bar.ok .rec-ic{border-color:#bbe7c4}
  .rec-b{flex:1;min-width:0}
  .rec-t{font-size:14.5px;font-weight:700;color:var(--ink)}
  .rec-bar.alert .rec-t{color:#92400e}
  .rec-bar.ok .rec-t{color:#15803d}
  .rec-d{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5}
  .rec-adv{display:inline-block;font-size:11.5px;font-weight:700;color:#15803d;
    background:var(--success-bg);border-radius:999px;padding:2px 9px;margin-top:6px}
  .rec-n{flex:none;text-align:right}
  .rec-n b{display:block;font-size:26px;line-height:1}
  .rec-bar.alert .rec-n b{color:var(--warn)}
  .rec-n span{font-size:11px;color:var(--faint)}
  @media (max-width:640px){
    .rec-bar{flex-wrap:wrap;gap:12px}
    .rec-b{flex:1 1 100%;order:2}
    .rec-n{order:1}
  }`;
  document.head.appendChild(s);
}

/**
 * Inyecta la barra ANTES del nodo indicado (normalmente .dash-kpis).
 * No hace nada si no hay nada que decir: un Inicio limpio es informacion,
 * no un espacio vacio que llenar.
 *
 * @param {HTMLElement} antesDe  nodo de referencia
 * @param {object} user          sesion
 * @param {function} irAControl  abre la pantalla de Control de recaudos
 */
export async function injectDocBar(antesDe, user, irAControl) {
  if (!antesDe || !antesDe.parentNode) return;

  const r = await fetch('/api/doc-control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resumen', user }),
  }).then(x => x.json()).catch(() => null);

  // Sin permiso, sin red o sin personal: no se pinta nada. Esta barra
  // nunca puede ser el motivo de que el Inicio se vea roto.
  if (!r || !r.ok || r.vacio) return;

  const adv = r.advertencias || 0;
  const personasAdv = r.personas_con_advertencia || 0;
  const falt = r.faltantes || 0;
  const avance = r.avance_quincena || 0;
  if (!adv && !falt && !r.al_dia) return;

  ensureCss();
  const esTienda = user && user.kind === 'company';
  const chip = avance
    ? `<span class="rec-adv">↑ ${avance} cargado${avance === 1 ? '' : 's'} esta quincena</span>`
    : '';

  let html;
  if (adv) {
    // Lo urgente manda: si hay algo mal, el faltante pasa a segunda linea.
    html = `<div class="rec-bar alert">
      <div class="rec-ic">📄</div>
      <div class="rec-b">
        <div class="rec-t">${personasAdv} persona${personasAdv === 1 ? '' : 's'} ${personasAdv === 1 ? 'tiene' : 'tienen'} un recaudo con problema</div>
        <div class="rec-d">Referencias a nombre de otra persona, RIF vencidos o con datos que no coinciden.
          Ya están cargados: hay que revisarlos y pedir el correcto.${falt
            ? ` Faltan además <b>${falt}</b> por cargar.` : ''}</div>
        ${chip}
      </div>
      <div class="rec-n"><b>${adv}</b><span>por revisar</span></div>
      <div><button class="btn btn-primary" data-recgo>Revisar</button></div>
    </div>`;
  } else if (falt) {
    /* Tono neutro a proposito: acá no hay nada MAL, hay cosas en curso. Y el
       texto dice que muchos dependen del empleado, porque es cierto y porque
       esta lista es la herramienta del gerente para reclamar, no la lista de
       sus incumplimientos. */
    html = `<div class="rec-bar">
      <div class="rec-ic">📄</div>
      <div class="rec-b">
        <div class="rec-t">Faltan ${falt} recaudo${falt === 1 ? '' : 's'} ${esTienda ? 'de tu personal' : 'en tu alcance'}</div>
        <div class="rec-d">Muchos dependen de que la persona los traiga. Acá podés ver quién debe qué.</div>
        ${chip}
      </div>
      <div class="rec-n"><b>${falt}</b><span>por cargar</span></div>
      <div><button class="btn" data-recgo>Ver quiénes</button></div>
    </div>`;
  } else {
    html = `<div class="rec-bar ok">
      <div class="rec-ic">✓</div>
      <div class="rec-b">
        <div class="rec-t">Recaudos al día</div>
        <div class="rec-d">${r.personas} persona${r.personas === 1 ? '' : 's'} con su referencia bancaria,
          su RIF y su cédula, y ninguno con problemas. Muy bien.</div>
      </div>
    </div>`;
  }

  const box = document.createElement('div');
  box.innerHTML = html;
  const el = box.firstElementChild;
  antesDe.parentNode.insertBefore(el, antesDe);
  const go = el.querySelector('[data-recgo]');
  if (go && irAControl) go.addEventListener('click', irAControl);
}
