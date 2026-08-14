/* =====================================================================
   functions/api/doc-control.js  →  POST /api/doc-control        (v6.226)
   CONTROL DE RECAUDOS: que tiene cada trabajador, que le falta y que
   cargó con un problema.

   POR QUE NACE. Los componentes de la ficha (RIF, referencia bancaria)
   validan al cargar y guardan el resultado en 'validaciones' desde julio.
   Buscando esa columna en TODAS las vistas del portal, aparece unicamente
   en los tres modulos que la ESCRIBEN: nadie la leia. Habia documentos con
   el nombre cambiado, la cedula de otra persona y RIF vencidos, detectados
   y guardados, sin una sola pantalla que los mostrara. Esto no valida nada
   nuevo: lee lo que ya estaba escrito.

   DOS COSAS DISTINTAS, Y CONVIENE NO MEZCLARLAS:
     ADVERTENCIAS  ~120 casos. Alguien ya mando el papel y algo no cuadra.
                   Es una lista de tareas: se puede terminar.
     FALTANTES     ~4650. No es una pantalla, es un programa. Solo 4 de 134
                   tiendas estan al dia con la referencia bancaria, y la
                   tienda promedio debe 12 de sus 16 personas.
   Por eso el resumen las devuelve separadas: una lista que no se puede
   terminar deja de leerse, y mezclarlas convierte a las 120 accionables en
   ruido dentro de 4650.

   Y EL FALTANTE NO ES UN REPROCHE AL GERENTE. Muchos de esos papeles
   dependen de que el empleado los traiga, no de su gestion. La pantalla es
   su herramienta para reclamar, no una lista de sus incumplimientos; los
   textos estan escritos con ese criterio.

   Acciones (POST { action, user, ... }):
     resumen  { }            gate view.doccontrol
        Contadores del alcance del actor. Lo usan los dos Inicios.
     list     { tipo?, estado?, company_code?, q? }   gate view.doccontrol
        El detalle, para la pantalla de control.

   El ALCANCE se resuelve como en el resto del portal: la tienda ve la suya,
   el admin las de get_admin_companies, el superadmin todas.

   Secrets: supabase_url, supabase_service_role
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

/* Empresas del alcance. null = todas (superadmin). Para la tienda, la suya
   y nada mas: el actor de tipo company trae su companyCode. */
async function alcance(env, actor, body) {
  const u = body.user || {};
  if (u.kind === 'company') return u.companyCode ? [u.companyCode] : [];
  if (!actor || actor.role === 'superadmin') return null;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: actor.id }),
  }).catch(() => null);
  return Array.isArray(rows) ? rows.map(r => r.company_code).filter(Boolean) : [];
}

const TIPOS = { bank_reference: 'Referencia bancaria', rif: 'RIF', cedula: 'Cédula' };

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const action = String(body.action || 'resumen').trim();

  try {
    const actor = await resolveActor(env, body.user || null);
    if (!actor) return json({ ok: false, error: 'Sesión no válida.' }, 403);
    if (!can(actor, 'view.doccontrol')) {
      return json({ ok: false, error: 'No tienes permiso para ver el control de recaudos (view.doccontrol).' }, 403);
    }

    const codes = await alcance(env, actor, body);
    // Alcance vacio (admin sin empresas): se contesta vacio, no un error.
    if (Array.isArray(codes) && !codes.length) {
      return json({ ok: true, vacio: true, advertencias: 0, faltantes: 0, personas: 0, filas: [] });
    }

    /* v6.228 — SE CUENTA EN LA BASE, NO EN EL BACKEND.
       La primera version traia todas las filas de doc_estado_personal y
       contaba aca. Pero son 6264 (2088 personas x 3 recaudos) y PostgREST
       corta la respuesta en 1000 por defecto: el resumen salia calculado
       sobre una fraccion y el superadmin veia 6 advertencias en vez de 120.
       El numero era plausible y estaba mal, que es la peor clase de error
       porque nadie sospecha de una cifra razonable. Ahora la base cuenta y
       devuelve una fila, y la lista filtra y limita en SQL. */
    if (action === 'resumen') {
      const [res, tip] = await Promise.all([
        sb(env, 'rpc/doc_resumen_personal', { method: 'POST', body: JSON.stringify({ p_codes: codes }) }),
        sb(env, 'rpc/doc_resumen_tipo', { method: 'POST', body: JSON.stringify({ p_codes: codes }) }),
      ]);
      const r = (res && res[0]) || { personas: 0, advertencias: 0, personas_con_advertencia: 0, faltantes: 0, al_dia: false };

      return json({
        ok: true,
        personas: r.personas || 0,
        advertencias: r.advertencias || 0,
        personas_con_advertencia: r.personas_con_advertencia || 0,
        faltantes: r.faltantes || 0,
        al_dia: !!r.al_dia,
        /* El avance viene de la MISMA funcion y con el MISMO alcance. Antes
           se contaba aparte en el backend y salia del grupo entero aunque
           mirara una tienda: el gerente habria visto como propio el merito
           de las otras 133. */
        avance_quincena: r.avance_quincena || 0,
        quincena_desde: r.quincena_desde || null,
        por_tipo: (tip || []).map(t => ({ ...t, label: TIPOS[t.doc_type] || t.doc_type })),
      });
    }

    if (action === 'list') {
      const filas = await sb(env, 'rpc/doc_pendientes', {
        method: 'POST',
        body: JSON.stringify({
          p_codes: codes,
          p_tipo: String(body.tipo || '') || null,
          p_estado: String(body.estado || '') || null,
          p_q: String(body.q || '').trim() || null,
          p_limit: 500,
        }),
      }) || [];
      // total_real viaja en cada fila: asi se puede decir "500 de 4658" con
      // un total que es cierto, y no "500 de 500".
      const total = filas.length ? Number(filas[0].total_real) : 0;
      return json({
        ok: true,
        total,
        truncado: total > filas.length,
        filas: filas.map(f => ({
          company_code: f.company_code, id_number: f.id_number, worker_name: f.worker_name,
          doc_type: f.doc_type, estado: f.estado, detalle: f.detalle, cargado_at: f.cargado_at,
          doc_label: TIPOS[f.doc_type] || f.doc_type,
        })),
      });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
