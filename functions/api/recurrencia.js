/* =====================================================================
   functions/api/recurrencia.js  →  POST /api/recurrencia         (v6.214)
   RECURRENCIA DE REPORTES: donde se repiten los marcajes manuales y las
   ausencias, separando lo que es de la TIENDA de lo que es de la PERSONA.

   POR QUE DOS VISTAS Y NO UN RANKING (medido el 13/08/2026):
   de 578 lineas de marcaje manual, solo 99 (17%) tienen una causa imputable
   a la persona. El resto es del sistema — 116 altas sin enrolar en el
   biometrico, 105 problemas electricos concentrados en 13 tiendas, 52 "sin
   dispositivo" en 8 tiendas que no tienen aparato. Un unico ranking de
   personas pondria primeras a las 21 de AL01, que acumulan 5 marcajes
   manuales cada una porque estan prestadas a otra tienda: el portal estaria
   señalando gente por hacer bien su trabajo. Cada señal a su vista.

   LA COLUMNA QUE HACE HONESTA LA VISTA DE TIENDAS es 'atribuibles'. AL01
   tiene 110 marcajes y CERO atribuibles: de un vistazo se ve que no es
   problema de gente. 0S01 tiene 21 y 21 atribuibles, todos "olvido", en 11
   personas distintas: eso si es comportamiento, pero colectivo.

   Acciones (POST { action, user, ... }):
     list      { desde, hasta, min? }   gate view.recurrencia
        Las dos vistas + los periodos del calendario para el filtro.
     silenciar { ambito, clave, tipo?, motivo, hasta }
                                        gate report.recurrencia.silenciar
        Apaga un aviso ya explicado. Exige motivo y fecha; la base rechaza
        vacios y no acepta "para siempre".
     levantar  { id }                   gate report.recurrencia.silenciar
        Devuelve el aviso antes de tiempo. NO borra: sella levantado_at,
        para que quede el rastro de que estuvo silenciado y por que.

   VER Y APAGAR NO SON LO MISMO, por eso son dos permisos. Silenciar una
   tienda apaga la alarma para todos los que miran la pantalla.

   EL ALCANCE se aplica aca, con la misma reja del Historial: las funciones
   de la base devuelven todo y este endpoint recorta. Repetir el alcance
   dentro del SQL seria tener dos versiones de quien-ve-que.
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

async function sb(env, path, init = {}) {
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2', 'Content-Profile': 'nomina_v2',
      'Content-Type': 'application/json', Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const isoDate = (v) => {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/* Empresas del alcance del actor. null = todas (superadmin). Mismo criterio
   que usa el Historial para no tener dos definiciones de alcance. */
async function empresasDelActor(env, actor) {
  if (!actor || actor.role === 'superadmin') return null;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: actor.id }),
  }).catch(() => null);
  // La RPC devuelve filas con company_code (mismo uso que en egresados.js).
  return Array.isArray(rows) ? rows.map(r => r.company_code).filter(Boolean) : [];
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const action = String(body.action || 'list').trim();

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);

    /* ---------------- list ---------------- */
    if (action === 'list') {
      if (!can(actor, 'view.recurrencia')) {
        return json({ ok: false, error: 'No tienes permiso para ver la recurrencia de reportes (view.recurrencia).' }, 403);
      }
      const desde = isoDate(body.desde);
      const hasta = isoDate(body.hasta);
      if (!desde || !hasta) return json({ ok: false, error: 'Indicá el período (desde y hasta).' }, 400);
      if (desde > hasta) return json({ ok: false, error: 'El rango está al revés.' }, 400);

      /* min 2 y no 3: con 3 la vista de personas queda vacia por meses
         (hoy nadie llega). Con 2 se ven 13 casos, y la comparacion contra
         el promedio de la tienda -que viaja en la misma fila- es lo que
         distingue "dos olvidos donde todos tienen dos" de "dos donde el
         resto tiene cero". El numero solo nunca alcanzo. */
      const min = Math.max(1, Math.min(50, parseInt(body.min, 10) || 2));

      const [tiendas, personas, causas, periodos] = await Promise.all([
        sb(env, 'rpc/recurrencia_tiendas', { method: 'POST', body: JSON.stringify({ p_desde: desde, p_hasta: hasta }) }),
        sb(env, 'rpc/recurrencia_personas', { method: 'POST', body: JSON.stringify({ p_desde: desde, p_hasta: hasta, p_min: min }) }),
        /* v6.215 — la composicion del periodo. Las tarjetas se generan de
           ACA y no de una lista escrita en el front: si mañana entra una
           causa nueva al catalogo, aparece sola. La version anterior
           comparaba etiquetas con texto y contaba solo donde la causa era
           dominante: decia 4 tiendas sin biometrico cuando eran 8. */
        sb(env, 'rpc/recurrencia_causas', { method: 'POST', body: JSON.stringify({ p_desde: desde, p_hasta: hasta }) }),
        sb(env, 'payroll_periods?select=name,range_start,range_end&order=range_start.desc&limit=24'),
      ]);

      const codes = await empresasDelActor(env, actor);
      const dentro = codes === null ? null : new Set(codes);
      const filtrar = (arr) => (dentro === null ? (arr || []) : (arr || []).filter(r => dentro.has(r.company_code)));

      return json({
        ok: true, desde, hasta, min,
        tiendas: filtrar(tiendas),
        personas: filtrar(personas),
        /* Las causas NO se recortan por alcance: son el panorama del grupo,
           no filas de nadie. Recortarlas exigiria recalcular los distinct de
           tiendas y personas empresa por empresa, y un coordinador vería
           "3 tiendas sin biométrico" queriendo decir "3 de las mías", que es
           otra cosa. Se muestran como lo que son: el total del período. */
        causas: causas || [],
        periodos: periodos || [],
        puede_silenciar: can(actor, 'report.recurrencia.silenciar'),
      });
    }

    /* ---------------- detalle de una tienda ----------------
       "Otros… ×101" no dice nada, y encima es la causa donde SI hay una
       explicacion escrita: las 101 de AL01 son 57 "esta presentado apoyo a
       otra tienda" + 42 "Presento apoyo a otra tienda" — la misma frase en
       dos grafias. Esto abre esa cifra. */
    if (action === 'detalle_tienda') {
      if (!can(actor, 'view.recurrencia')) {
        return json({ ok: false, error: 'No tienes permiso para ver esto.' }, 403);
      }
      const desde = isoDate(body.desde);
      const hasta = isoDate(body.hasta);
      const company = String(body.company_code || '').trim();
      if (!desde || !hasta || !company) return json({ ok: false, error: 'Faltan datos.' }, 400);

      // El alcance vale tambien aca: no se abre el detalle de una tienda
      // que el usuario no puede ver en el listado.
      const codes = await empresasDelActor(env, actor);
      if (codes !== null && !codes.includes(company)) {
        return json({ ok: false, error: 'Esa tienda está fuera de tu alcance.' }, 403);
      }

      /* v6.218 — el desglose venia sin nombres: decia "57 lineas, 13
         personas" y ahi se terminaba. El numero sin los nombres no sirve
         para hacer nada. Se piden las dos cosas juntas y la pantalla los
         agrupa; van en una sola ida porque son la misma pregunta. */
      const [filas, quienes] = await Promise.all([
        sb(env, 'rpc/recurrencia_tienda_detalle', {
          method: 'POST', body: JSON.stringify({ p_company: company, p_desde: desde, p_hasta: hasta }),
        }),
        sb(env, 'rpc/recurrencia_tienda_quienes', {
          method: 'POST', body: JSON.stringify({ p_company: company, p_desde: desde, p_hasta: hasta }),
        }),
      ]);
      return json({ ok: true, company_code: company, filas: filas || [], quienes: quienes || [] });
    }

    /* ---------------- silenciar ---------------- */
    if (action === 'silenciar') {
      if (!can(actor, 'report.recurrencia.silenciar')) {
        return json({ ok: false, error: 'No tienes permiso para silenciar avisos (report.recurrencia.silenciar).' }, 403);
      }
      const ambito = String(body.ambito || '').trim();
      if (ambito !== 'tienda' && ambito !== 'persona') {
        return json({ ok: false, error: 'Ámbito inválido.' }, 400);
      }
      const clave = String(body.clave || '').trim();
      if (!clave) return json({ ok: false, error: 'Falta indicar qué se silencia.' }, 400);
      const motivo = String(body.motivo || '').trim();
      if (motivo.length < 5) {
        return json({ ok: false, error: 'Escribí el motivo: silenciar sin decir por qué es tapar el problema.' }, 400);
      }
      const hasta = isoDate(body.hasta);
      if (!hasta) return json({ ok: false, error: 'Indicá hasta cuándo (AAAA-MM-DD).' }, 400);
      const hoy = new Date().toISOString().slice(0, 10);
      if (hasta <= hoy) return json({ ok: false, error: 'La fecha tiene que ser futura.' }, 400);

      const tipo = ['marcaje', 'ausencia', 'todo'].includes(body.tipo) ? body.tipo : 'todo';

      /* Si ya habia uno vigente se LEVANTA antes de crear el nuevo: el
         indice unico solo permite uno vivo, y asi el cambio queda como dos
         hechos (se levanto aquel, se creo este) y no como una edicion que
         borra el motivo anterior. */
      await sb(env, `recurrencia_silencios?ambito=eq.${encodeURIComponent(ambito)}&clave=eq.${encodeURIComponent(clave)}&tipo=eq.${tipo}&levantado_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ levantado_por: actor.id, levantado_at: new Date().toISOString() }),
      }).catch(() => null);

      await sb(env, 'recurrencia_silencios', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ambito, clave, tipo, motivo: motivo.slice(0, 300), hasta, creado_por: actor.id }),
      });
      return json({ ok: true });
    }

    /* ---------------- levantar ---------------- */
    if (action === 'levantar') {
      if (!can(actor, 'report.recurrencia.silenciar')) {
        return json({ ok: false, error: 'No tienes permiso para levantar avisos (report.recurrencia.silenciar).' }, 403);
      }
      const ambito = String(body.ambito || '').trim();
      const clave = String(body.clave || '').trim();
      if (!ambito || !clave) return json({ ok: false, error: 'Falta indicar qué se levanta.' }, 400);
      await sb(env, `recurrencia_silencios?ambito=eq.${encodeURIComponent(ambito)}&clave=eq.${encodeURIComponent(clave)}&levantado_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ levantado_por: actor.id, levantado_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
