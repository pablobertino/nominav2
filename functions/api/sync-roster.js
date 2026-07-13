/* =====================================================================
   functions/api/sync-roster.js  →  POST /api/sync-roster
   SINCRONIZACION AUTOMATICA DE MEMBRESIA en tiendas (v5.31).

   Alcance (decision de Pablo 2026-07-09, ampliada el 2026-07-13):
   - INGRESA a los trabajadores nuevos que el sistema trae y el portal no
     tiene. Entran con la FICHA COMPLETA: nombre, cargo, cuenta bancaria,
     telefono y correo.
   - RETIRA (egresa) a los que el sistema marca con fin de contrato.
   - RELLENA LOS HUECOS de los que ya estan: si un campo esta VACIO y el
     sistema trae el dato, se toma. (v5.34)
   - NO PISA ningun campo que YA TENGA VALOR en el portal. Eso sigue siendo
     manual via Actualizar/ficha.

   ⚠ "NO PISAR" NO ES "NO RELLENAR" (Pablo, 2026-07-13):
     campo CON valor  -> intocable. Alguien lo cargo; es un dato del portal.
     campo VACIO      -> es un hueco. Nadie lo edito. Si el sistema trae el
                         valor cierto, tomarlo no pisa a nadie.
   Sin esta distincion, una ficha que entro incompleta quedaba incompleta PARA
   SIEMPRE: el dato llegaba en cada corrida y se descartaba, porque el codigo
   solo miraba a los que NO existen.

   🔴 PENDIENTE — CONFLICTOS. El relleno solo llena VACIOS, asi que no puede
   pisar nada. Pero si un campo tiene valor EN LOS DOS LADOS y son distintos,
   eso es un CONFLICTO y no se resuelve aca: lo resuelve un humano en Comparar.
   La API ya da la municion (`auditoria.modificadoPor` dice si el cambio vino
   del portal o de un tercero en AX). Ver _PLANES/PENDIENTE_SYNC_ROSTER_BUGS.md.

   🔴 PENDIENTE — EL CRON NO AVANZA DE TANDA. La cadena de auto-invocacion se
   corta en el primer eslabon: cada corrida del cron procesa SIEMPRE las mismas
   10 tiendas y nunca llega a `done`, asi que nunca escribe last_run_at y el
   tick la vuelve a disparar a los 15 min, para siempre. Las tiendas 10-131 no
   se sincronizan solas nunca. Ver _PLANES/PENDIENTE_SYNC_ROSTER_BUGS.md §BUG 1.

   Reglas de seguridad:
   - Egreso SOLO con dato EXPLICITO (finContrato pasada). JAMAS por
     ausencia en la respuesta (una respuesta parcial no egresa a nadie).
   - Umbral anti-vaciado: si la API devuelve menos del 70% de los activos
     de una tienda (y la tienda tiene 5+), esa tienda se SALTA con alerta.
   - Centinelas: la API devuelve '-' / 'None' / 'No' / '0' cuando no hay dato.
     Se limpian (clean/cleanAccount) o se guardaria un guion como cuenta.
   - Presupuesto de tiempo: lotes de 8 tiendas en paralelo; si se agota el
     presupuesto, corta limpio y lo dice en el resumen (proxima corrida
     continua de forma natural: es idempotente).
   - Todo queda en nomina_v2.roster_sync_log (solo tiendas con movimiento
     o alerta) + resumen en roster_sync_config.

   Invocacion:
   - Cron: tick_roster_sync() -> POST {source:'cron', adminId}
   - Manual (Configurar, superadmin): POST {source:'manual', adminId}

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';
const TIME_BUDGET_MS = 90000;   // presupuesto total de corrida

/* ===== TANDAS (v5.14) =====
   Cloudflare corta en 50 SUBREQUESTS por invocacion. Esta sincronizacion
   recorre TODAS las tiendas abiertas (hoy 132) y cada tienda cuesta como
   minimo 2 subrequests (1 GET a la API del sistema + 1 SELECT del roster), sin
   contar los PATCH/POST de ingresos y egresos. O sea: 264+ subrequests en una
   sola invocacion, contra un techo de 50.

   Consecuencia: la corrida COMPLETA nunca pudo terminar; moria a mitad con
   "Too many subrequests" antes de escribir siquiera el log. Por eso la config
   mostraba last_run_at=null (nunca corrio) pese a estar el codigo entero.

   Arreglo: la corrida se hace por TANDAS de tiendas. Cada invocacion procesa
   como mucho STORES_PER_CALL y devuelve el offset siguiente; quien llama
   (el front con su barra de progreso, o el tick del cron) vuelve a invocar
   hasta terminar. La operacion ya era idempotente, asi que trocearla es
   seguro: reintentar una tanda no duplica ingresos ni re-egresa a nadie.

   Cuenta por tanda (peor caso realista):
     10 tiendas x 2 (API + roster)          = 20
     + movimientos (depto/insert/patch)     ~ 10-15
     + arranque (config, alcance) + log     ~  5
                                            = ~40  (cabe en 50, con aire)

   BATCH baja de 8 a 5: el paralelismo no ahorra subrequests (los gasta igual),
   y en tandas chicas no hace falta apretar tanto a la API del sistema. */
/* ===== TANDAS =====
   Cloudflare corta en 50 SUBREQUESTS por invocacion. Techo duro.

   v5.34: la cuenta cambio, porque ahora cada tienda ademas RELLENA HUECOS
   (1 SELECT al maestro + 1 PATCH por persona incompleta). Antes una tienda sin
   movimiento costaba 2 subrequests; ahora cuesta 3 + los rellenos.

   Cuenta por tanda (peor caso, tienda de 30 personas todas incompletas):
     5 tiendas x 1 GET a la API                 =  5
     5 tiendas x 1 SELECT roster                =  5
     5 tiendas x 1 SELECT maestro (acotado)     =  5
     rellenos + ingresos + egresos              = ~25
     arranque (config, alcance) + log           = ~5
                                                = ~45  (entra, con poco aire)

   La primera corrida despues de este cambio es la mas cara (hay muchos huecos
   que llenar). Las siguientes son baratas: una vez relleno, no hay nada que
   escribir y la tienda vuelve a costar 3.

   Baja de 10 a 5: mas tandas, pero ninguna muere. Una tanda que revienta no
   avanza el offset y la corrida se cuelga entera; mejor ir despacio. */
const STORES_PER_CALL = 3;      // tiendas por invocacion (limite de Cloudflare)
const BATCH = 3;                // tiendas en paralelo dentro de la tanda

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

const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
const iso10 = (v) => {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/* ===== CENTINELAS DE LA API (v5.31) =====
   El microservicio Flask usa `campo or '-'` como default, asi que un dato
   vacio en AX NO llega como null: llega como '-' (o 'None', 'No', '0' segun
   el campo). Si se guardaran tal cual, la ficha tendria un guion como cuenta
   bancaria y el portal lo mostraria como si fuera un dato real.

   Doc: _PLANES/API_HCM_EMPLEADOS_INTERNALS_2026-07-10.md §2.
   La carga manual (ax-roster.js) ya los filtra; el auto_sync tiene que hacer
   lo mismo o ensucia el maestro. Verificado 2026-07-13: hoy hay 0 centinelas
   guardados en workers_master. */
const SENTINELS = new Set(['-', 'none', 'no', '0', 'n/a', 'na', '--']);
const clean = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s || SENTINELS.has(s.toLowerCase())) return null;
  return s;
};

/* ===== VALIDACION: si esta mal formateado, NO PASA (decision de Pablo 2026-07-13)

   El portal NO arregla datos del ERP. Si un dato viene mal formado, se DESCARTA
   y la sincronizacion lo REPORTA ("3 correos no se escribieron por formato"),
   para que se corrija en AX, que es donde vive el dato.

   La alternativa — "normalizar" en el portal — es peor: enmascara el problema,
   el dato sigue mal en el ERP, y el portal termina con una version distinta de
   la verdad. Ademas nadie se entera nunca de que hay que arreglarlo.

   Cada validador devuelve el valor limpio, o null si no pasa. */

/* CUENTA: 20 digitos exactos. Ni uno mas ni uno menos.
   AX manda SOLO la cuenta marcada como Principal (verificado 2026-07-13 contra
   el ERP: JEAN RODRIGUEZ tiene 2 cuentas en AX y la API manda la Principal),
   asi que no hay que elegir: la que llega es la que vale. */
const cleanAccount = (v) => {
  const s = clean(v);
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 20 ? d : null;
};

/* TELEFONO: se acepta con o sin el 0, con guiones, con +58. Todo eso es el
   MISMO numero escrito distinto, no un dato malo: se normaliza a 04XXXXXXXXX.
   Lo que SI se rechaza es un numero que no puede existir: largo equivocado o
   prefijo de operadora inexistente.

   Prefijos validos (verificado 2026-07-13 contra los 233 telefonos que ya
   funcionan en la base): 0412 0414 0416 0422 0424 0426.
   ⚠ OJO: 0422 SI EXISTE — hay 81 numeros +58422 andando. Casi lo descarto por
   asumir que era un error de carga. */
const VE_PREFIXES = new Set(['0412', '0414', '0416', '0422', '0424', '0426']);
const cleanPhone = (v) => {
  const s = clean(v);
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);   // +584121234567
  if (d.length === 10) d = '0' + d;                                   // 4121234567 (sin el 0)
  if (d.length !== 11) return null;                                   // no es un movil VE
  if (!VE_PREFIXES.has(d.slice(0, 4))) return null;                   // operadora inexistente
  return d;
};

/* CORREO: tiene que parecer un correo. Nada mas que eso.
   El motivo real: AX esta devolviendo correos SIN la arroba ni los puntos
   ("erickmontanezgrupocanaimanet" en vez de "erick.montanez@grupocanaima.net").
   No se sabe todavia si el dato esta asi en AX o si algo lo rompe en el camino
   — pero en cualquier caso NO se guarda: quedaria como si fuera un correo
   valido y nadie lo notaria hasta que un envio falle.
   Se reporta y se arregla en AX. */
const cleanEmail = (v) => {
  const s = clean(v);
  if (!s) return null;
  const e = s.toLowerCase();
  // Minimo indispensable: algo@algo.algo, sin espacios.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
};

/* Departamento Retail de la tienda (cada tienda tiene el suyo); lo crea si
   no existe. Misma regla que las cargas manuales (roster.js/ax-roster.js). */
async function retailDeptId(env, cc) {
  const rows = await sb(env,
    `departments?company_code=eq.${encodeURIComponent(cc)}&name=eq.Retail&select=id&limit=1`);
  if (rows && rows.length) return rows[0].id;
  const ins = await sb(env, 'departments', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ company_code: cc, name: 'Retail' }),
  });
  return ins && ins[0] ? ins[0].id : null;
}

/* Procesa UNA tienda. Devuelve { company_code, added, removed, skipped,
   alert, detail } sin lanzar (los errores quedan como alerta). */
async function processStore(env, cc) {
  const out = { company_code: cc, added: 0, removed: 0, filled: 0, diffs: 0, skipped: false, alert: null, detail: {},
                // v5.31: datos que NO se escribieron por venir mal formateados.
                // No es un error de la sincronizacion: es un dato a corregir en AX.
                rejected: { account: 0, phone: 0, email: 0 },
                /* v5.34: el DETALLE de cada rechazo (cedula, nombre, empresa,
                   campo, valor crudo). Sin esto, el aviso dice "4 correos mal
                   escritos" y no hay forma de saber CUALES. Pablo tiene que
                   poder ver la lista para ir a corregirlos en AX. */
                rejDetail: [],
                /* v5.35: las DIFERENCIAS con el sistema en campos que el portal
                   YA TIENE llenos. No se tocan (esa es la regla), pero antes
                   tampoco se avisaban: quedaban invisibles para siempre. */
                diffDetail: [],
                /* v5.36: QUE se completo, no solo cuantos. El Registro lo muestra
                   en su propia pestana: "a EIVAR se le tomo el telefono del
                   sistema". Sin esto solo habria un numero. */
                fillDetail: [] };
  try {
    const today = new Date().toISOString().split('T')[0];
    const apiRes = await fetch(`${HCM_API}?alias=${encodeURIComponent(cc)}&fecha=${today}`, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!apiRes.ok) {
      out.skipped = true; out.alert = `API ${apiRes.status}`;
      return out;
    }
    let data = await apiRes.json();
    let rows = Array.isArray(data) ? data : (data.empleados || data.data || data.items || []);
    if (!Array.isArray(rows)) rows = [];

    // Normalizar: vigentes (sin finContrato o futura) y egresados explicitos.
    const vig = new Map();      // ced -> row vigente
    const fin = new Map();      // ced -> fecha fin (pasada) explicita
    for (const r of rows) {
      const ced = digits(r.ficha || r.cedula || r.id_number);
      if (!ced) continue;
      const f = iso10(r.finContrato);
      if (f && f <= today) fin.set(ced, f);
      else vig.set(ced, r);
    }

    // Roster actual de la tienda.
    const cur = await sb(env,
      `store_workers?company_code=eq.${encodeURIComponent(cc)}&select=id_number,is_active,end_date`) || [];
    const curByCed = new Map(cur.map(w => [digits(w.id_number), w]));
    const activos = cur.filter(w => w.is_active !== false && !w.end_date);

    // UMBRAL ANTI-VACIADO: respuesta sospechosamente corta -> no tocar nada.
    if (activos.length >= 5 && vig.size < activos.length * 0.7) {
      out.skipped = true;
      out.alert = `Respuesta corta del sistema (${vig.size} vigentes vs ${activos.length} activos): tienda saltada por seguridad.`;
      return out;
    }

    // INGRESOS: vigentes del sistema que el roster no tiene (o tiene egresados
    // -> reingreso). NO se toca a los que ya estan activos.
    const toInsert = [];
    const toReenter = [];
    for (const [ced, r] of vig) {
      const w = curByCed.get(ced);
      if (!w) toInsert.push([ced, r]);
      else if (w.is_active === false || w.end_date) toReenter.push([ced, r]);
    }
    // EGRESOS: SOLO con finContrato explicita, sobre los que siguen activos.
    const toEgress = [];
    for (const [ced, f] of fin) {
      const w = curByCed.get(ced);
      if (w && w.is_active !== false && !w.end_date) toEgress.push([ced, f]);
    }

    /* v5.34: ya no se puede cortar aca. Antes, si no habia ingresos ni egresos,
       la tienda se salteaba entera — y con ella el relleno de huecos, que es lo
       que arregla a la gente que ya esta cargada pero con la ficha incompleta.
       El relleno corre SIEMPRE que la tienda tenga gente vigente. */
    const hayMovimiento = toInsert.length || toReenter.length || toEgress.length;

    const deptId = (toInsert.length || toReenter.length) ? await retailDeptId(env, cc) : null;
    const fullNameOf = (r) => String(r.nombreCompleto
      || [r.primerNombre, r.segundoNombre, r.apellidos || [r.primerApellido, r.segundoApellido].filter(Boolean).join(' ')]
        .filter(Boolean).join(' ')).trim();

    if (toInsert.length) {
      /* v5.31 — LA FICHA ENTRA COMPLETA.

         El bug: el INSERT no traia cuenta bancaria, telefono ni correo, aunque
         la API los devuelve (cuentaBancaria/telefono/correo). Resultado: toda
         persona ingresada por auto_sync quedaba con la ficha a medias.
         Verificado 2026-07-13 contra AX: de las 2.689 personas vigentes, 79 no
         tenian cuenta — y AX SI las tenia. El corte era perfecto por origen:
           source='ax_api'    2.602 personas,  0 sin cuenta
           source='auto_sync'    87 personas, 79 sin cuenta  <-- el agujero

         Esto es SOLO el INSERT (persona que el portal no tiene). NO se toca a
         los que ya estan: esa sigue siendo la regla del 2026-07-09, y ademas
         hay 8 fichas con cambios del portal aun sin publicar a AX (ax_pending)
         que un UPDATE ciego se llevaria puesto. El UPDATE necesita la logica de
         conflictos (auditoria.modificadoPor) y va aparte. */
      const body = toInsert.map(([ced, r]) => {
        /* Se valida UNA vez por persona y se reusa en las dos tablas (roster y
           maestro), para que no puedan quedar distintas entre si. */
        const acc = cleanAccount(r.cuentaBancaria);
        const tel = cleanPhone(r.telefono);
        const mail = cleanEmail(r.correo);

        /* CONTAR LOS DESCARTES: el dato VENIA (no es que falte en AX) pero esta
           mal formado, asi que no se escribe. Esto es lo que despues reporta la
           sincronizacion para que se corrija en el ERP.
           v5.34: ademas del contador, se guarda el DETALLE. Sin esto, un ingreso
           nuevo con el correo roto subia el numero pero NO aparecia en la lista:
           el aviso decia "5 correos mal escritos" y solo se podian ver 4. */
        const nomIns = fullNameOf(r) || ced;
        if (clean(r.cuentaBancaria) && !acc) {
          out.rejected.account++;
          out.rejDetail.push({ ced, nom: nomIns, comp: cc, campo: 'cuenta', valor: clean(r.cuentaBancaria) });
        }
        if (clean(r.telefono) && !tel) {
          out.rejected.phone++;
          out.rejDetail.push({ ced, nom: nomIns, comp: cc, campo: 'telefono', valor: clean(r.telefono) });
        }
        if (clean(r.correo) && !mail) {
          out.rejected.email++;
          out.rejDetail.push({ ced, nom: nomIns, comp: cc, campo: 'correo', valor: clean(r.correo) });
        }

        r.__acc = acc; r.__tel = tel; r.__mail = mail;   // para el maestro

        return {
          company_code: cc,
          id_number: ced,
          full_name: fullNameOf(r) || ced,
          first_name: r.primerNombre || null,
          second_name: r.segundoNombre || null,
          last_names: r.apellidos || [r.primerApellido, r.segundoApellido].filter(Boolean).join(' ') || null,
          role: r.idCargo || null,
          start_date: iso10(r.inicioContrato),
          account_number: acc,
          phone: tel,
          email: mail,
          is_active: true,
          department_id: deptId,
          source: 'auto_sync',
        };
      });
      await sb(env, 'store_workers', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      // Maestro global: crear SOLO si no existe (jamas pisar datos/foto).
      // resolution=ignore-duplicates => si la persona ya existe (viene de otra
      // empresa), esta fila se descarta entera y NO le pisa nada. Por eso es
      // seguro mandar aca la ficha completa.
      const masterRows = toInsert.map(([ced, r]) => ({
        id_number: ced,
        full_name: fullNameOf(r) || ced,
        first_name: r.primerNombre || null,
        second_name: r.segundoNombre || null,
        last_names: r.apellidos || null,
        birth_date: iso10(r.fechaNacimiento),
        account_number: r.__acc,
        phone: r.__tel,
        email: r.__mail,
        last_source_company: cc,
      }));
      await sb(env, 'workers_master?on_conflict=id_number', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(masterRows),
      });
      out.added += toInsert.length;
      out.detail.added = toInsert.map(([c]) => c);
    }

    /* REINGRESO: la persona ya existe en el roster de esta tienda (egresada) y
       el sistema la trae vigente de nuevo. Se la reactiva y NADA MAS.
       Deliberadamente NO se tocan cuenta/telefono/correo aca: su ficha ya
       existe y puede tener datos cargados desde el portal. Reactivar no es
       excusa para pisar. (El INSERT si los trae, porque ahi no hay nada que
       pisar: la persona es nueva.) */
    for (const [ced, r] of toReenter) {
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: true, end_date: null, start_date: iso10(r.inicioContrato), source: 'auto_sync' }),
      });
    }

    /* ===================================================================
       v5.34 — RELLENO DE HUECOS (decision de Pablo 2026-07-13)

       "NO PISAR" NO ES LO MISMO QUE "NO RELLENAR".

       La regla del 2026-07-09 protege los datos que alguien cargo en el portal:
       si un campo TIENE valor, la sincronizacion no lo toca. Eso sigue igual.

       Pero un campo VACIO no es un dato que proteger: es un HUECO. Nadie lo
       edito nunca. Si el sistema trae el valor cierto, tomarlo no pisa a nadie.

       Caso real que lo motivo: EIVAR LUGO (18023148) ingreso por auto_sync con
       la cuenta vacia (bug del INSERT, ya arreglado). Su cuenta esta en AX y la
       API la devuelve en cada corrida... pero la sincronizacion no la escribia
       nunca, porque el codigo solo mira a los que NO existen. Quedaba en un
       limbo: el dato llegaba, y se descartaba.

       LA REGLA:
           el campo TIENE valor en el portal  ->  NO SE TOCA
           el campo esta VACIO                ->  se rellena con lo del sistema

       No hay conflicto posible: un vacio no compite con nada. El conflicto de
       verdad (los dos lados tienen valor y son distintos) sigue siendo cosa de
       Comparar, con la auditoria de la API. Esto no lo reemplaza.

       LA UNICA GUARDIA ES EL FORMATO (Pablo, 2026-07-13).

       Se saco la guardia de `ax_pending`: protegia el caso "cambio del portal
       sin publicar + campo vacio", que es IMPOSIBLE. La ficha de edicion tiene
       BLOQUEO DE VACIADO desde v4.43 (`ORIG_PROT` en worker-photos.js): un
       campo que TENIA valor no se puede guardar vacio, solo reemplazar. Y se
       midio: 0 ocurrencias en la base. La guardia protegia un imposible, y a
       cambio condenaba ese hueco a no llenarse nunca.

       Lo que SI se guarda: el dato mal formateado. Si el sistema manda un
       correo sin arroba o un telefono con un prefijo que no existe, NO se
       escribe. Se cuenta, se avisa en Sincronizar, y se guarda el DETALLE
       (cedula + empresa + valor crudo) para poder ir a corregirlo en AX, que
       es donde vive el dato. El portal no arregla datos del ERP: eso enmascara
       el problema y deja dos versiones de la verdad.
       =================================================================== */
    const toFill = [];
    const toDiff = [];      // v5.35: fichas con diferencia (se marcan, no se tocan)
    if (vig.size) {
      // Solo se piden las fichas de la gente VIGENTE de esta tienda (acotado:
      // no se trae el maestro entero, que es lo que reventaba el backfill).
      const ceds = [...vig.keys()];
      const inList = ceds.map(c => `"${c}"`).join(',');
      const master = await sb(env,
        `workers_master?id_number=in.(${inList})`
        + `&select=id_number,full_name,account_number,phone,email,ax_diff`) || [];

      for (const m of master) {
        const ced = digits(m.id_number);
        const r = vig.get(ced);
        if (!r) continue;

        const patch = {};
        const nom = m.full_name || '';
        /* v5.35: diferencias detectadas en ESTA ficha (campos llenos que no
           coinciden con el sistema). No se tocan; se MARCAN. */
        const diffs = {};

        /* Un campo se procesa de UNA de estas dos formas, nunca las dos:

           VACIO en el portal  -> es un HUECO. Se rellena (o se rechaza si el
                                  sistema lo manda mal formateado).
           LLENO en el portal  -> es un DATO DE ALGUIEN. No se toca JAMAS. Pero
                                  si el sistema tiene otra cosa, se MARCA para
                                  que un humano lo mire. Antes ni se miraba: la
                                  diferencia quedaba invisible para siempre. */
        /* ⚠ HAY QUE COMPARAR MANZANAS CON MANZANAS.

           El portal guarda los telefonos en formato internacional (+584128585089)
           y cleanPhone() devuelve el formato nacional (04128585089). Comparar los
           dos strings crudos da SIEMPRE distinto, aunque sea EL MISMO NUMERO.

           Medido: de 117 "conflictos" de telefono detectados en la primera
           corrida, 115 eran esto — el mismo numero escrito distinto. Solo 2 eran
           diferencias de verdad. Sin esto, la bandeja de revision nace con 98%
           de ruido y nadie la mira nunca.

           Por eso los dos lados pasan por el MISMO validador antes de comparar:
           el validador es la forma canonica. Si el validador no puede con el
           valor del portal (ej: un correo viejo raro), se cae al valor crudo. */
        const revisar = (campoUI, valPortal, crudoSistema, validador, contador) => {
          const portal = clean(valPortal);
          const crudo  = clean(crudoSistema);
          const valido = validador(crudoSistema);
          // Forma canonica del lado del PORTAL, para poder compararla de igual a igual.
          const portalCanon = portal ? (validador(portal) || portal) : null;

          // --- HUECO: el portal no tiene nada ---
          if (!portal) {
            if (valido) return { fill: valido };                 // se rellena
            if (crudo) {                                          // vino mal formateado
              out.rejected[contador]++;
              out.rejDetail.push({ ced, nom, comp: cc, campo: campoUI, valor: crudo });
            }
            return null;                                          // el sistema tampoco lo tiene
          }

          // --- EL PORTAL TIENE EL DATO: no se toca. Solo se compara. ---
          if (!crudo) return null;              // el sistema no lo tiene: no hay nada que comparar

          if (!valido) {
            /* DATO ROTO: el portal lo tiene BIEN, el sistema lo tiene MAL.
               No es un conflicto: sabemos cual es el bueno (el del portal).
               Es un dato a CORREGIR EN EL SISTEMA. Sin esta marca, un correo
               roto en AX se quedaba roto y NADIE lo veia (el validador solo
               miraba campos vacios). */
            diffs[campoUI] = { estado: 'dato_roto', portal, sistema: crudo };
            return null;
          }
          if (valido !== portalCanon) {
            /* CONFLICTO DE VERDAD: los dos tienen valor, los dos son validos, y
               una vez normalizados SIGUEN siendo distintos. Nadie sabe cual es
               el bueno. Lo decide un humano (la API trae auditoria.modificadoPor,
               que dice si el cambio salio del portal o de un tercero en AX).

               Se muestran los valores TAL CUAL estan en cada lado (no los
               normalizados): lo que el usuario tiene que ver es lo que hay. */
            diffs[campoUI] = { estado: 'conflicto', portal, sistema: valido };
          }
          return null;   // el mismo dato (aunque escrito distinto): nada que hacer
        };

        const fAcc  = revisar('cuenta',   m.account_number, r.cuentaBancaria, cleanAccount, 'account');
        const fTel  = revisar('telefono', m.phone,          r.telefono,       cleanPhone,   'phone');
        const fMail = revisar('correo',   m.email,          r.correo,         cleanEmail,   'email');
        if (fAcc)  { patch.account_number = fAcc.fill;
                     out.fillDetail.push({ ced, nom, comp: cc, campo: 'cuenta',   valor: fAcc.fill }); }
        if (fTel)  { patch.phone          = fTel.fill;
                     out.fillDetail.push({ ced, nom, comp: cc, campo: 'telefono', valor: fTel.fill }); }
        if (fMail) { patch.email          = fMail.fill;
                     out.fillDetail.push({ ced, nom, comp: cc, campo: 'correo',   valor: fMail.fill }); }

        if (Object.keys(patch).length) toFill.push([ced, patch]);

        /* La marca de diferencia se escribe SIEMPRE que cambie: si aparece una
           nueva, se marca; si se resolvio (en AX o en el portal), se limpia
           sola. Asi la bandeja no acumula fantasmas. */
        const teniaDiff = !!m.ax_diff;
        const tieneDiff = Object.keys(diffs).length > 0;
        if (tieneDiff) {
          toDiff.push([ced, {
            ax_diff: true,
            ax_diff_fields: diffs,
            ax_diff_at: new Date().toISOString(),
          }]);
          out.diffs++;
          for (const [campo, d] of Object.entries(diffs)) {
            out.diffDetail.push({ ced, nom, comp: cc, campo, ...d });
          }
        } else if (teniaDiff) {
          // Ya no hay diferencia: se limpia la marca (alguien la resolvio).
          toDiff.push([ced, { ax_diff: false, ax_diff_fields: null, ax_diff_at: null }]);
        }
      }
    }

    /* Los huecos se rellenan en el MAESTRO, que es la ficha de la persona y de
       donde el portal lee la cuenta (bank_accounts_list hace COALESCE con el
       maestro primero). Escribir tambien el roster costaria el doble de
       subrequests sin agregar nada. */
    for (const [ced, patch] of toFill) {
      await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
    }
    if (toFill.length) {
      out.filled = toFill.length;
      out.detail.filled = toFill.map(([c]) => c);
    }

    /* v5.35: marcar (o limpiar) las diferencias. Esto NO toca el dato: solo
       escribe la bandera para que la ficha y Comparar lo muestren. */
    for (const [ced, patch] of toDiff) {
      await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
    }
    if (toReenter.length) {
      out.added += toReenter.length;
      out.detail.reentered = toReenter.map(([c]) => c);
    }

    for (const [ced, f] of toEgress) {
      await sb(env, `store_workers?company_code=eq.${encodeURIComponent(cc)}&id_number=eq.${encodeURIComponent(ced)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: false, end_date: f }),
      });
    }
    if (toEgress.length) {
      out.removed = toEgress.length;
      out.detail.removed = toEgress.map(([c]) => c);
    }
    return out;
  } catch (e) {
    out.skipped = true;
    out.alert = String(e && e.message || e).slice(0, 300);
    return out;
  }
}

export async function onRequestPost({ request, env, ctx }) {
  const t0 = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const source = body.source === 'cron' ? 'cron' : 'manual';

  // Autorizacion (patron sync-companies): adminId debe ser superadmin activo.
  const adminId = parseInt(body.adminId, 10) || (body.user && parseInt(body.user.id, 10)) || null;
  if (!adminId) return json({ ok: false, error: 'Falta adminId.' }, 403);
  const adm = await sb(env, `admin_users?id=eq.${adminId}&is_active=eq.true&select=id,role`);
  if (!adm || !adm.length || adm[0].role !== 'superadmin') {
    return json({ ok: false, error: 'Solo el superadministrador puede ejecutar esta sincronizacion.' }, 403);
  }
  try { await shadowCan(env, { kind: 'admin', id: adminId }, 'sync-roster', source, 'hcm.sync', true); } catch (_) { /* no rompe */ }

  /* ---------- acciones de la tarjeta de Configurar (v4.56) ---------- */
  if (body.action === 'get_config') {
    const rows = await sb(env, 'roster_sync_config?id=eq.1&select=*');
    return json({ ok: true, config: rows && rows[0] ? rows[0] : null });
  }
  if (body.action === 'save_config') {
    const c = body.config || {};
    const patch = {
      enabled: !!c.enabled,
      frequency: ['hourly', '6h', '12h', 'daily', '2d'].includes(c.frequency) ? c.frequency : 'daily',
      daily_hour: Math.min(23, Math.max(0, parseInt(c.daily_hour, 10) || 6)),
      retry_minutes: Math.min(720, Math.max(0, parseInt(c.retry_minutes, 10) || 0)),
      endpoint_url: (c.endpoint_url || '').trim() || null,
    };
    await sb(env, 'roster_sync_config?id=eq.1', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
    return json({ ok: true });
  }
  if (body.action === 'runs') {
    /* Ultimas corridas: agrupadas por run_id (las filas del log son por tienda).
       v5.36: ademas de ingresos/egresos, se agregan los rellenos y las
       diferencias, con su detalle. El Registro los muestra en pestanas. */
    const rows = await sb(env,
      'roster_sync_log?select=run_id,run_at,source,company_code,added,removed,skipped,alert,detail,'
      + 'filled,diff_review,diff_broken,diff_detail,fill_detail,rej_detail'
      + '&order=run_at.desc&limit=400') || [];
    const byRun = new Map();
    for (const r of rows) {
      const k = r.run_id || r.run_at;
      if (!byRun.has(k)) byRun.set(k, {
        run_id: k, run_at: r.run_at, source: r.source,
        added: 0, removed: 0, filled: 0,
        diff_review: 0, diff_broken: 0, alerts: 0,
        stores: [],
        // El detalle fino, juntado de todas las tiendas de la corrida.
        diff_detail: [], fill_detail: [], rej_detail: [],
      });
      const g = byRun.get(k);
      g.added += r.added || 0;
      g.removed += r.removed || 0;
      g.filled += r.filled || 0;
      g.diff_review += r.diff_review || 0;
      g.diff_broken += r.diff_broken || 0;
      if (r.alert) g.alerts++;
      g.stores.push({ company_code: r.company_code, added: r.added, removed: r.removed, filled: r.filled, skipped: r.skipped, alert: r.alert });
      if (Array.isArray(r.diff_detail)) g.diff_detail.push(...r.diff_detail);
      if (Array.isArray(r.fill_detail)) g.fill_detail.push(...r.fill_detail);
      if (Array.isArray(r.rej_detail))  g.rej_detail.push(...r.rej_detail);
    }
    return json({ ok: true, runs: [...byRun.values()].slice(0, 12) });
  }

  const cfgRows = await sb(env, 'roster_sync_config?id=eq.1&select=*');
  const cfg = cfgRows && cfgRows[0] ? cfgRows[0] : null;
  if (source === 'cron' && (!cfg || !cfg.enabled)) {
    return json({ ok: true, skipped: true, message: 'Sincronizacion de personal desactivada.' });
  }
  if (!env.canaima_apikey) return json({ ok: false, error: 'La clave del sistema no esta configurada.' }, 500);

  // Alcance: tiendas abiertas.
  const stores = await sb(env,
    `companies?company_type=eq.Tienda&is_active=eq.true&select=company_code&order=company_code.asc`) || [];
  let codes = stores.map(s => s.company_code);

  /* v5.39 — SUBCONJUNTO OPCIONAL (`only`).

     El boton de Empresas ("Sincronizar personal") manda la lista de empresas
     VISIBLES con el filtro que el usuario tiene puesto. Sin `only`, el endpoint
     se comporta igual que siempre: TODAS las tiendas abiertas. Asi el cron y
     "Ejecutar ahora" (Configurar) no cambian en nada.

     Se INTERSECTA contra la lista real: lo que llega del front es una sugerencia,
     no una orden. Si mandan una empresa cerrada, una que no es tienda, o uno
     inventado, se cae solo. El alcance de verdad lo sigue decidiendo el backend.

     Ojo: el `only` viaja en CADA tanda (igual que run_id y los acumuladores), o
     la tanda 2 volveria a las 132 tiendas y el offset apuntaria a otra lista. */
  if (Array.isArray(body.only) && body.only.length) {
    const want = new Set(body.only.map(c => String(c || '').trim().toUpperCase()).filter(Boolean));
    codes = codes.filter(c => want.has(String(c).toUpperCase()));
    if (!codes.length) {
      return json({ ok: false, error: 'Ninguna de las empresas seleccionadas es una tienda abierta.' }, 400);
    }
  }

  /* v5.14: TANDA. offset = desde que tienda seguir; run_id se recibe para que
     todas las tandas de una misma corrida compartan el mismo id en el log (y
     el Registro las muestre como UNA corrida, no como 14 sueltas). */
  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const runId = (body.run_id && String(body.run_id).slice(0, 40))
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const slice = codes.slice(offset, offset + STORES_PER_CALL);
  const nextOffset = offset + slice.length;
  const done = nextOffset >= codes.length;

  const results = [];
  let incomplete = false;

  try {
  for (let i = 0; i < slice.length; i += BATCH) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { incomplete = true; break; }
    const chunk = slice.slice(i, i + BATCH);
    const rs = await Promise.all(chunk.map(cc => processStore(env, cc)));
    results.push(...rs);
  }

  const added = results.reduce((a, r) => a + r.added, 0);
  const removed = results.reduce((a, r) => a + r.removed, 0);
  const filled = results.reduce((a, r) => a + (r.filled || 0), 0);
  const diffs  = results.reduce((a, r) => a + (r.diffs || 0), 0);
  const alerts = results.filter(r => r.alert).length;

  /* v5.31 — DATOS RECHAZADOS POR FORMATO.
     El dato VENIA del sistema, pero mal formado, asi que no se escribio. No es
     un error de la sincronizacion: es un dato a corregir EN AX. Se cuenta y se
     informa; sin esto, el descarte seria silencioso y nadie sabria que hay algo
     que arreglar. */
  const rej = results.reduce((a, r) => ({
    account: a.account + ((r.rejected && r.rejected.account) || 0),
    phone:   a.phone   + ((r.rejected && r.rejected.phone)   || 0),
    email:   a.email   + ((r.rejected && r.rejected.email)   || 0),
  }), { account: 0, phone: 0, email: 0 });

  /* v5.34 — EL DETALLE, no solo el numero.
     El contador dice "4 correos mal escritos" y ahi se acaba: no hay forma de
     saber CUALES ni de ir a corregirlos. Pablo lo pidio explicito: "la
     sincronizacion debe advertirlo y debo poder ver cuales son los casos".
     Se junta el detalle de las tiendas de esta tanda; mas abajo se acumula con
     el de las tandas anteriores y viaja al front. */
  const rejDetail = results.reduce((a, r) => a.concat(r.rejDetail || []), []);
  // v5.35: las diferencias con el sistema (campos llenos que no coinciden).
  const diffDetail = results.reduce((a, r) => a.concat(r.diffDetail || []), []);

  /* Log: SOLO tiendas con movimiento o alerta (corridas limpias no ensucian).
     v5.36: ahora tambien guarda el DETALLE de los rellenos y las diferencias.
     Antes viajaba solo en la respuesta HTTP y se perdia al cerrar la pantalla;
     el Registro no tenia de donde leerlo. */
  const logRows = results
    .filter(r => r.added || r.removed || r.filled || r.diffs || r.skipped)
    .map(r => {
      const dd = r.diffDetail || [];
      return {
        run_id: runId, source, company_code: r.company_code,
        added: r.added, removed: r.removed, skipped: r.skipped,
        filled: r.filled || 0,
        diff_review: dd.filter(d => d.estado === 'conflicto').length,
        diff_broken: dd.filter(d => d.estado === 'dato_roto').length,
        diff_detail: dd.length ? dd : null,
        rej_detail: (r.rejDetail && r.rejDetail.length) ? r.rejDetail : null,
        fill_detail: (r.fillDetail && r.fillDetail.length) ? r.fillDetail : null,
        alert: r.alert, detail: r.detail && Object.keys(r.detail).length ? r.detail : null,
      };
    });
  if (logRows.length) {
    try { await sb(env, 'roster_sync_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(logRows) }); }
    catch (_) { /* el log nunca tumba la corrida */ }
  }

  /* v5.14: el resumen ACUMULA entre tandas. La corrida son N invocaciones; si
     cada una pisara el resumen con lo suyo, la config terminaria mostrando lo
     de la ULTIMA tanda ("2 ingresos") en vez del total de la corrida. Los
     totales llegan del llamador (que los viene sumando) y aca se les agrega lo
     de esta tanda. */
  const prevAdded = Math.max(0, parseInt(body.acc_added, 10) || 0);
  const prevRemoved = Math.max(0, parseInt(body.acc_removed, 10) || 0);
  const prevFilled = Math.max(0, parseInt(body.acc_filled, 10) || 0);
  const prevAlerts = Math.max(0, parseInt(body.acc_alerts, 10) || 0);
  const prevStores = Math.max(0, parseInt(body.acc_stores, 10) || 0);
  // Los rechazos tambien acumulan entre tandas (si no, el resumen mostraria
  // solo los de la ultima tanda de 10 tiendas).
  const prevRej = {
    account: Math.max(0, parseInt(body.acc_rej_account, 10) || 0),
    phone:   Math.max(0, parseInt(body.acc_rej_phone, 10) || 0),
    email:   Math.max(0, parseInt(body.acc_rej_email, 10) || 0),
  };

  const totAdded = prevAdded + added;
  const totRemoved = prevRemoved + removed;
  const totFilled = prevFilled + filled;
  const totAlerts = prevAlerts + alerts;
  const totStores = prevStores + results.length;
  /* v5.34: el DETALLE de los rechazos acumula entre tandas, igual que los
     contadores. Se corta en 300 filas: alcanza de sobra para ir a corregir en
     AX, y evita inflar el payload si un dia el ERP devuelve basura masiva. */
  const prevDetail = Array.isArray(body.acc_rej_detail) ? body.acc_rej_detail : [];
  const totDetail = prevDetail.concat(rejDetail).slice(0, 300);
  const prevDiffs = Math.max(0, parseInt(body.acc_diffs, 10) || 0);
  const totDiffs = prevDiffs + diffs;
  const prevDiffDetail = Array.isArray(body.acc_diff_detail) ? body.acc_diff_detail : [];
  const totDiffDetail = prevDiffDetail.concat(diffDetail).slice(0, 300);
  const totRej = {
    account: prevRej.account + rej.account,
    phone:   prevRej.phone   + rej.phone,
    email:   prevRej.email   + rej.email,
  };

  /* v5.36: el resumen que se guarda en la config (y que Configurar muestra al
     entrar) tiene que contar TODO lo que hizo la corrida. Antes solo guardaba
     ingresos/egresos: la corrida de las 15:35 escribio 888 telefonos y el
     resumen decia "0 y 0", como si no hubiera hecho nada.

     Los dos estatus de diferencia van SEPARADOS a proposito: no son lo mismo.
       diff_review = los dos lados tienen dato y no coinciden -> decide un humano
       diff_broken = el portal lo tiene bien, el sistema lo tiene mal escrito */
  const diffReview = totDiffDetail.filter(d => d.estado === 'conflicto').length;
  const diffBroken = totDiffDetail.filter(d => d.estado === 'dato_roto').length;

  const summary = {
    run_id: runId, stores: totStores, total_stores: codes.length,
    added: totAdded, removed: totRemoved, filled: totFilled, alerts: totAlerts,
    diffs: totDiffs,
    diff_review: diffReview,
    diff_broken: diffBroken,
    rejected: totRej,
    incomplete: incomplete || !done,
  };

  /* La config se marca como CORRIDA solo cuando la ultima tanda termina: si se
     escribiera last_run_at en cada tanda, el tick del cron creeria que la
     corrida ya se hizo y no dispararia las tandas que faltan. Mientras hay
     tandas pendientes se refresca last_attempt_at (senal de vida). */
  try {
    await sb(env, 'roster_sync_config?id=eq.1', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(done
        ? {
          last_run_at: new Date().toISOString(), last_source: source,
          last_status: 'ok', last_error: null,
          last_duration_ms: Date.now() - t0, last_summary: summary,
        }
        : { last_attempt_at: new Date().toISOString(), last_source: source }),
    });
  } catch (_) { /* resumen best-effort */ }

  /* v5.38 — LA CADENA DE TANDAS LA HACE EL TICK, NO EL WORKER.

     Aca habia una auto-invocacion: el Worker se llamaba a si mismo con el
     offset siguiente (`ctx.waitUntil(fetch(selfUrl, ...))`). NO FUNCIONABA.
     Se cortaba en el primer eslabon y el `.catch(() => {})` se tragaba el
     error, asi que no quedaba rastro.

     El efecto medido: el cron procesaba SIEMPRE las mismas 10 tiendas, cada
     15 minutos, sin avanzar jamas. Como nunca llegaba a `done`, nunca escribia
     last_run_at, y el tick lo volvia a disparar desde la tienda 1. Las tiendas
     10-131 (122 de 132) no se sincronizaron nunca de forma automatica.

     Ahora el bucle lo hace `tick_roster_sync()` desde la base: pide una tanda,
     ESPERA la respuesta, lee `done`/`next_offset`, y sigue. Es el mismo patron
     que usa el front en "Ejecutar ahora" — el camino que si funciona.

     El Worker vuelve a ser lo que debe ser: procesa SU tanda y contesta. Quien
     encadena es quien llama (el tick, o el front). */

  return json({
    ok: true, ...summary,
    // v5.14: el llamador usa esto para seguir con la proxima tanda.
    done,
    next_offset: done ? null : nextOffset,
    processed: results.length,     // tiendas de ESTA tanda
    duration_ms: Date.now() - t0,
    // v5.31/v5.34: los acumuladores viajan al front para la tanda siguiente.
    // Sin esto, el resumen final solo contaria lo de la ULTIMA tanda.
    acc_filled: totFilled,
    acc_rej_account: totRej.account,
    acc_rej_phone: totRej.phone,
    acc_rej_email: totRej.email,
    // v5.34: el detalle de los rechazos, para poder VER cuales son y corregir en AX.
    acc_rej_detail: totDetail,
    rechazados_detalle: totDetail,
    // v5.35: diferencias con el sistema (campos llenos que no coinciden).
    acc_diffs: totDiffs,
    acc_diff_detail: totDiffDetail,
    diferencias: totDiffs,
    diferencias_detalle: totDiffDetail,
  });
  } catch (e) {
    // v4.58: una falla dura marca la corrida como error en la config para
    // que el tick REINTENTE a los retry_minutes configurados.
    try {
      await sb(env, 'roster_sync_config?id=eq.1', {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          last_run_at: new Date().toISOString(), last_source: source,
          last_status: 'error', last_error: String(e && e.message || e).slice(0, 400),
          last_duration_ms: Date.now() - t0,
        }),
      });
    } catch (_) { /* best-effort */ }
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}
