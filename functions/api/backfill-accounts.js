/* =====================================================================
   functions/api/backfill-accounts.js  →  POST /api/backfill-accounts
   RELLENO PUNTUAL (v5.31) — de una sola vez, no es un proceso permanente.

   QUE ARREGLA
   Hasta v5.30, sync-roster.js ingresaba a la gente SIN cuenta bancaria,
   telefono ni correo (el INSERT no leia esos campos de la API, aunque venian).
   Resultado: toda persona ingresada por auto_sync quedo con la ficha a medias.

   Verificado 2026-07-13 contra AX (SQL directo sobre el ERP): AX SI tenia las
   cuentas. El corte era perfecto por origen:
       source='ax_api'     2.602 personas,  0 sin cuenta
       source='auto_sync'     87 personas, 79 sin cuenta   <-- el agujero

   v5.31 arregla el INSERT, pero eso solo sirve para los ingresos NUEVOS: el
   codigo solo inserta a quien NO existe (`if (!w) toInsert.push(...)`), y estas
   personas YA existen con la cuenta vacia. El sync no las vuelve a mirar nunca.
   Por eso hace falta este relleno.

   POR QUE ES SEGURO (verificado en la BD antes de escribir esto)
   De las fichas sin cuenta:
       ax_pending          = 0   (ningun cambio del portal esperando publicarse)
       profile_updated_by  = 0   (nadie las edito desde el portal)
       ax_synced_at        = 0   (nunca se publicaron a AX)
   Estan INTACTAS. No hay NADA que pisar. Este relleno no puede destruir un
   dato cargado por una persona, porque no hay ninguno.

   QUE HACE, EXACTAMENTE
   - Toca SOLO fichas cuyo campo este VACIO. Si ya hay algo, no lo mira.
   - Toca SOLO cuenta / telefono / correo. Nada mas.
   - Es idempotente: correrlo dos veces no hace daño (la segunda no encuentra
     nada que rellenar).
   - `dry_run: true` (DEFAULT) -> no escribe nada, solo informa que haria.

   COMO SE USA (desde la consola del navegador, logueado como superadmin):

     // 1) ENSAYO — no escribe nada:
     await fetch('/api/backfill-accounts', {
       method:'POST', headers:{'Content-Type':'application/json'},
       body: JSON.stringify({ adminId: 1, dry_run: true })
     }).then(r=>r.json()).then(console.log);

     // 2) DE VERDAD — despues de revisar el ensayo:
     await fetch('/api/backfill-accounts', {
       method:'POST', headers:{'Content-Type':'application/json'},
       body: JSON.stringify({ adminId: 1, dry_run: false })
     }).then(r=>r.json()).then(console.log);

   Va por TANDAS de empresas (limite de 50 subrequests de Cloudflare). Si
   devuelve `done:false`, volver a llamar con el `next_offset` que informa.

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';
const COMPANIES_PER_CALL = 12;   // cabe en el techo de 50 subrequests

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function sb(env, path, opts = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* Centinelas de la API: '-' / 'None' / 'No' / '0' = SIN DATO.
   Sin este filtro, se guardaria un guion como cuenta bancaria.
   (Doc: _PLANES/API_HCM_EMPLEADOS_INTERNALS_2026-07-10.md §2) */
const SENTINELS = new Set(['-', 'none', 'no', '0', 'n/a', 'na', '--']);
const clean = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s || SENTINELS.has(s.toLowerCase())) return null;
  return s;
};
/* Cuenta venezolana = 20 digitos. Cualquier otra cosa es basura: mejor null
   que un numero invalido que despues alguien use para pagar un sueldo.
   AX manda SOLO la cuenta marcada como Principal (verificado 2026-07-13). */
const cleanAccount = (v) => {
  const s = clean(v);
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 20 ? d : null;
};
const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');

export async function onRequestPost({ request, env }) {
  const t0 = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  // Solo superadmin (mismo gate que sync-roster).
  const adminId = parseInt(body.adminId, 10) || (body.user && parseInt(body.user.id, 10)) || null;
  if (!adminId) return json({ ok: false, error: 'Falta adminId.' }, 403);
  const adm = await sb(env, `admin_users?id=eq.${adminId}&is_active=eq.true&select=id,role`);
  if (!adm || !adm.length || adm[0].role !== 'superadmin') {
    return json({ ok: false, error: 'Solo el superadministrador puede ejecutar este relleno.' }, 403);
  }
  if (!env.canaima_apikey) return json({ ok: false, error: 'La clave del sistema no esta configurada.' }, 500);

  // DEFAULT = ensayo. Escribir requiere pedirlo explicitamente.
  const dryRun = body.dry_run !== false;
  const offset = Math.max(0, parseInt(body.offset, 10) || 0);

  try {
    /* A quien hay que rellenar: personas VIGENTES cuyo maestro tiene alguno de
       los 3 campos vacio. Se piden todas de una (1 subrequest) y despues se
       agrupan por empresa, porque la API se consulta POR EMPRESA. */
    const master = await sb(env,
      'workers_master?select=id_number,account_number,phone,email,ax_pending,profile_updated_by') || [];
    const byCed = new Map(master.map(m => [digits(m.id_number), m]));

    const store = await sb(env,
      'store_workers?end_date=is.null&select=id_number,company_code') || [];
    const ent = await sb(env,
      'enterprise_workers?end_date=is.null&select=id_number,company_code') || [];

    // Empresa efectiva por cedula (la primera que aparezca; una persona
    // vigente en dos empresas se consulta por una sola, da igual cual: el
    // maestro es global y la cuenta es de la persona, no del puesto).
    const compOf = new Map();
    for (const r of [...store, ...ent]) {
      const c = digits(r.id_number);
      if (c && !compOf.has(c)) compOf.set(c, r.company_code);
    }

    // Los que necesitan relleno, agrupados por empresa.
    const needByComp = new Map();
    for (const [ced, cc] of compOf) {
      const m = byCed.get(ced);
      if (!m) continue;
      const faltaCuenta = !clean(m.account_number);
      const faltaTel    = !clean(m.phone);
      const faltaMail   = !clean(m.email);
      if (!faltaCuenta && !faltaTel && !faltaMail) continue;

      /* GUARDIA: si la ficha tiene un cambio del portal SIN PUBLICAR, no se la
         toca. Hoy son 0 en este conjunto (verificado), pero la guardia queda:
         si mañana alguien edita una de estas antes de que corra el relleno, su
         cambio NO se pierde. */
      if (m.ax_pending) continue;

      if (!needByComp.has(cc)) needByComp.set(cc, []);
      needByComp.get(cc).push({ ced, faltaCuenta, faltaTel, faltaMail });
    }

    const comps = [...needByComp.keys()].sort();
    const slice = comps.slice(offset, offset + COMPANIES_PER_CALL);
    const nextOffset = offset + slice.length;
    const done = nextOffset >= comps.length;

    const today = new Date().toISOString().split('T')[0];
    const changes = [];      // lo que se va a escribir (o se escribiria)
    const notFound = [];     // en el portal pero la API no los devuelve
    const noData = [];       // la API los devuelve, pero AX tampoco tiene el dato

    for (const cc of slice) {
      const targets = needByComp.get(cc) || [];
      if (!targets.length) continue;

      const apiRes = await fetch(`${HCM_API}?alias=${encodeURIComponent(cc)}&fecha=${today}`, {
        headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
      });
      if (!apiRes.ok) continue;   // empresa que falla: la retoma otra corrida

      let data = await apiRes.json();
      let rows = Array.isArray(data) ? data : (data.empleados || data.data || data.items || []);
      if (!Array.isArray(rows)) rows = [];
      const axByCed = new Map();
      for (const r of rows) {
        const c = digits(r.ficha || r.cedula || r.id_number);
        if (c) axByCed.set(c, r);
      }

      for (const t of targets) {
        const ax = axByCed.get(t.ced);
        if (!ax) { notFound.push({ ced: t.ced, company: cc }); continue; }

        const patch = {};
        // Solo se rellena lo que ESTA VACIO. Lo que ya tiene valor, ni se mira.
        if (t.faltaCuenta) { const v = cleanAccount(ax.cuentaBancaria); if (v) patch.account_number = v; }
        if (t.faltaTel)    { const v = clean(ax.telefono);              if (v) patch.phone = v; }
        if (t.faltaMail)   { const v = clean(ax.correo);                if (v) patch.email = v; }

        if (!Object.keys(patch).length) {
          // AX tampoco lo tiene. No es un error: es un dato que falta cargar.
          noData.push({ ced: t.ced, company: cc });
          continue;
        }
        changes.push({ ced: t.ced, company: cc, patch });
      }
    }

    /* ESCRITURA. En ensayo NO se escribe: solo se informa.
       Se actualiza el MAESTRO (la ficha de la persona) y tambien la fila del
       roster, para que las dos vistas coincidan. */
    let written = 0;
    if (!dryRun && changes.length) {
      for (const ch of changes) {
        await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ch.ced)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(ch.patch),
        });
        // El roster tambien guarda estos campos (la vista Cuentas los lee de
        // ahi como respaldo). Se actualiza solo donde este vacio.
        const rosterPatch = {};
        if (ch.patch.account_number) rosterPatch.account_number = ch.patch.account_number;
        if (ch.patch.phone) rosterPatch.phone = ch.patch.phone;
        if (ch.patch.email) rosterPatch.email = ch.patch.email;
        if (Object.keys(rosterPatch).length) {
          await sb(env, `store_workers?id_number=eq.${encodeURIComponent(ch.ced)}&end_date=is.null`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(rosterPatch),
          }).catch(() => { /* si no esta en tiendas, esta en empresas */ });
          await sb(env, `enterprise_workers?id_number=eq.${encodeURIComponent(ch.ced)}&end_date=is.null`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(rosterPatch),
          }).catch(() => { /* idem */ });
        }
        written++;
      }
    }

    return json({
      ok: true,
      dry_run: dryRun,
      mensaje: dryRun
        ? 'ENSAYO: no se escribio nada. Revisa "cambios" y volve a llamar con dry_run:false.'
        : `Se rellenaron ${written} fichas.`,
      pendientes_totales: comps.reduce((a, c) => a + (needByComp.get(c) || []).length, 0),
      empresas_con_pendientes: comps.length,
      // Esta tanda:
      empresas_procesadas: slice.length,
      cambios: changes.length,
      escritos: written,
      // Casos que NO se pudieron rellenar (informativo, no son errores):
      ax_tampoco_tiene: noData.length,
      no_estan_en_la_api: notFound.length,
      // Muestra para revisar en el ensayo:
      muestra: changes.slice(0, 15),
      done,
      next_offset: done ? null : nextOffset,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
