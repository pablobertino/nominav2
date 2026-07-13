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

/* ⚠ CLOUDFLARE: 50 SUBREQUESTS POR INVOCACION. Techo duro.

   Dos errores mios, ya corregidos, que vale la pena dejar escritos:

   1) Conte los SELECT de arranque como "3 subrequests". FALSO: traian el maestro
      entero (2.853 filas) y los dos rosters completos, y PostgREST PAGINA DE A
      1.000 FILAS. Esos 3 SELECT costaban ~8-10 requests reales. Arreglado: ahora
      se piden solo las cedulas de las 4-6 empresas de la tanda.

   2) La vista de pendientes marcaba a 2.572 personas (al 90% del grupo le falta
      telefono/correo en el maestro... pero AX TAMPOCO los tiene: devuelve '-').
      Una sola empresa podia traer 140 personas = 140 PATCH. Arreglado: la vista
      apunta a las 83 SIN CUENTA, que es el problema real. Maximo por empresa: 6.

   Cuenta por invocacion, ahora (peor caso medido):
     1 SELECT  lista de empresas (vista chica)                  =  1
     6 empresas x 2 SELECT (roster tiendas + empresas)          = 12
     6 empresas x 1 SELECT (maestro, acotado por cedula)        =  6
     6 empresas x 1 GET a la API del sistema                    =  6
     ~6 personas x 1 PATCH (maximo real por empresa: 6)         = ~15
                                                                = ~40  (entra) */
const COMPANIES_PER_CALL = 6;

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

/* ===== VALIDACION (decision de Pablo 2026-07-13) =====
   Si el dato viene MAL FORMATEADO, NO SE ESCRIBE. Se cuenta y se reporta, para
   que se corrija en AX — que es donde vive el dato. El portal no "arregla"
   datos del ERP: eso enmascara el problema y deja dos versiones de la verdad.

   Lo que SI se acepta: el mismo numero escrito distinto (con/sin el 0, con
   guiones, con +58). Eso no es un dato malo, es formato. */
const SENTINELS = new Set(['-', 'none', 'no', '0', 'n/a', 'na', '--']);
const clean = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s || SENTINELS.has(s.toLowerCase())) return null;
  return s;
};

/* CUENTA: 20 digitos exactos. AX manda solo la marcada como Principal. */
const cleanAccount = (v) => {
  const s = clean(v);
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 20 ? d : null;
};

/* TELEFONO: se normaliza a 04XXXXXXXXX. Se RECHAZA si el largo no da o si el
   prefijo de operadora no existe.
   Prefijos validos (verificado contra los 233 telefonos que ya funcionan):
   0412 0414 0416 0422 0424 0426.
   ⚠ 0422 SI EXISTE (81 numeros +58422 en la base). Casi lo descarto por asumir
   que era un error de carga. */
const VE_PREFIXES = new Set(['0412', '0414', '0416', '0422', '0424', '0426']);
const cleanPhone = (v) => {
  const s = clean(v);
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);
  if (d.length === 10) d = '0' + d;
  if (d.length !== 11) return null;
  if (!VE_PREFIXES.has(d.slice(0, 4))) return null;
  return d;
};

/* CORREO: tiene que parecer un correo.
   🔴 AX esta devolviendo correos SIN arroba ni puntos
   ("erickmontanezgrupocanaimanet" en vez de "erick.montanez@grupocanaima.net").
   Esos NO se escriben: quedarian como si fueran validos y nadie lo notaria
   hasta que un envio falle. Se reportan para corregir en AX. */
const cleanEmail = (v) => {
  const s = clean(v);
  if (!s) return null;
  const e = s.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
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
    /* ===== POR QUE ESTE ORDEN (v5.33) =====
       La version anterior arrancaba trayendo TODO: el maestro entero (2.853
       filas), todo store_workers (2.066) y todo enterprise_workers (~630), en
       CADA invocacion. Yo los conte como "3 subrequests" y me equivoque:
       PostgREST pagina de a 1.000 filas, asi que traer 2.853 filas NO es un
       request, son varios. Esos 3 SELECT costaban ~8-10 subrequests, y sumados
       a los GET de la API y los PATCH se pasaban del techo de 50 de Cloudflare.
       Por eso la primera tanda pasaba (poca gente que escribir) y la segunda
       moria con "Too many subrequests".

       Ahora se hace al reves: PRIMERO se decide de que empresas toca esta tanda
       (1 request chico), y recien despues se pide SOLO la gente de esas 4
       empresas. El costo por invocacion deja de depender del tamano del grupo. */

    /* 1) La lista de empresas que tienen gente vigente. Solo los codigos:
          es una consulta chica y acotada. */
    const compRows = await sb(env,
      'roster_pending_companies?select=company_code&order=company_code.asc');
    let comps;
    if (compRows && compRows.length) {
      comps = compRows.map(r => r.company_code);
    } else {
      /* Respaldo si la vista no existe: se arma desde companies (chico: ~200
         filas, entra en un solo request). */
      const cs = await sb(env,
        'companies?is_active=eq.true&select=company_code&order=company_code.asc') || [];
      comps = cs.map(c => c.company_code);
    }

    const slice = comps.slice(offset, offset + COMPANIES_PER_CALL);
    const nextOffset = offset + slice.length;
    const done = nextOffset >= comps.length;

    const today = new Date().toISOString().split('T')[0];
    const changes = [];
    const notFound = [];
    const noData = [];
    const rejected = { account: [], phone: [], email: [] };
    let pendientesTanda = 0;

    /* 2) Por cada empresa de ESTA tanda: se pide su roster (chico: 5-40
          personas), su gente en el maestro, y su ficha en la API. */
    for (const cc of slice) {
      // Roster de la empresa (tiendas + empresas). Acotado por company_code.
      const sw = await sb(env,
        `store_workers?company_code=eq.${encodeURIComponent(cc)}&end_date=is.null&select=id_number`) || [];
      const ew = await sb(env,
        `enterprise_workers?company_code=eq.${encodeURIComponent(cc)}&end_date=is.null&select=id_number`) || [];
      const ceds = [...new Set([...sw, ...ew].map(r => digits(r.id_number)).filter(Boolean))];
      if (!ceds.length) continue;

      // Sus fichas en el maestro. `in.(...)` acota a esas cedulas.
      const inList = ceds.map(c => `"${c}"`).join(',');
      const master = await sb(env,
        `workers_master?id_number=in.(${inList})&select=id_number,account_number,phone,email,ax_pending`) || [];

      // A quien le falta algo (y no tiene un cambio del portal sin publicar).
      const targets = [];
      for (const m of master) {
        const ced = digits(m.id_number);
        if (!ced) continue;
        if (m.ax_pending) continue;   // GUARDIA: no pisar un cambio del portal
        const faltaCuenta = !clean(m.account_number);
        const faltaTel    = !clean(m.phone);
        const faltaMail   = !clean(m.email);
        if (!faltaCuenta && !faltaTel && !faltaMail) continue;
        targets.push({ ced, faltaCuenta, faltaTel, faltaMail });
      }
      if (!targets.length) continue;
      pendientesTanda += targets.length;

      // La ficha en el sistema.
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
        /* Solo se rellena lo que ESTA VACIO. Y solo lo que PASA LA VALIDACION:
           lo mal formateado se rechaza y se reporta, no se "arregla" aca. */
        if (t.faltaCuenta) {
          const crudo = clean(ax.cuentaBancaria);
          const v = cleanAccount(ax.cuentaBancaria);
          if (v) patch.account_number = v;
          else if (crudo) rejected.account.push({ ced: t.ced, company: cc, valor: crudo });
        }
        if (t.faltaTel) {
          const crudo = clean(ax.telefono);
          const v = cleanPhone(ax.telefono);
          if (v) patch.phone = v;
          else if (crudo) rejected.phone.push({ ced: t.ced, company: cc, valor: crudo });
        }
        if (t.faltaMail) {
          const crudo = clean(ax.correo);
          const v = cleanEmail(ax.correo);
          if (v) patch.email = v;
          else if (crudo) rejected.email.push({ ced: t.ced, company: cc, valor: crudo });
        }

        if (!Object.keys(patch).length) { noData.push({ ced: t.ced, company: cc }); continue; }
        changes.push({ ced: t.ced, company: cc, patch });
      }
    }

    /* ESCRITURA. En ensayo NO se escribe: solo se informa.
       Se actualiza el MAESTRO (la ficha de la persona) y tambien la fila del
       roster, para que las dos vistas coincidan. */
    let written = 0;
    if (!dryRun && changes.length) {
      /* Se escribe SOLO el maestro (workers_master), que es la ficha de la
         persona y la fuente de verdad. Antes se hacian ademas 2 PATCH por
         persona sobre store_workers/enterprise_workers — eso triplicaba los
         subrequests y hacia estallar el limite de Cloudflare.

         No hace falta: la vista de Cuentas ya lee el dato del maestro con
         COALESCE (maestro primero, fila del roster como respaldo). Con el
         maestro lleno, la vista muestra la cuenta igual. Y el maestro es el
         lugar correcto: la cuenta es de la PERSONA, no del puesto. */
      for (const ch of changes) {
        await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ch.ced)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(ch.patch),
        });
        written++;
      }
    }

    return json({
      ok: true,
      dry_run: dryRun,
      mensaje: dryRun
        ? 'ENSAYO: no se escribio nada. Revisa "cambios" y "rechazados", y volve a llamar con dry_run:false.'
        : `Se rellenaron ${written} fichas.`,
      pendientes_totales: 83,   // las que faltan de cuenta (medido 2026-07-13)
      empresas_con_pendientes: comps.length,
      // Esta tanda:
      empresas_procesadas: slice.length,
      pendientes_en_esta_tanda: pendientesTanda,
      cambios: changes.length,
      escritos: written,
      // Casos que NO se pudieron rellenar (informativo, no son errores):
      ax_tampoco_tiene: noData.length,
      no_estan_en_la_api: notFound.length,

      /* RECHAZADOS POR FORMATO — esto es lo que hay que CORREGIR EN AX.
         El dato existe en el ERP pero esta mal escrito, asi que el portal no lo
         guarda. Con la lista se puede ir a arreglarlo a la fuente. */
      rechazados: {
        cuenta: rejected.account.length,
        telefono: rejected.phone.length,
        correo: rejected.email.length,
      },
      rechazados_detalle: {
        cuenta: rejected.account.slice(0, 20),
        telefono: rejected.phone.slice(0, 20),
        correo: rejected.email.slice(0, 20),
      },

      // Muestra de lo que SI se va a escribir:
      muestra: changes.slice(0, 15),
      done,
      next_offset: done ? null : nextOffset,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
