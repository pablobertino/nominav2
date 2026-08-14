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

    const filas = await sb(env, 'rpc/doc_estado_personal', {
      method: 'POST', body: JSON.stringify({ p_codes: codes }),
    }) || [];

    if (action === 'resumen') {
      /* Se cuentan las PERSONAS con advertencia, no los documentos: para
         quien mira el Inicio, dos problemas de la misma persona son una
         sola conversacion, no dos. */
      const conAdv = new Set();
      let advertencias = 0, faltantes = 0;
      const porTipo = {};
      filas.forEach(f => {
        if (!porTipo[f.doc_type]) porTipo[f.doc_type] = { advertencia: 0, falta: 0, ok: 0 };
        porTipo[f.doc_type][f.estado] = (porTipo[f.doc_type][f.estado] || 0) + 1;
        if (f.estado === 'advertencia') { advertencias++; conAdv.add(f.id_number); }
        if (f.estado === 'falta') faltantes++;
      });
      return json({
        ok: true,
        advertencias,
        personas_con_advertencia: conAdv.size,
        faltantes,
        personas: new Set(filas.map(f => f.id_number)).size,
        por_tipo: Object.entries(porTipo).map(([k, v]) => ({
          doc_type: k, label: TIPOS[k] || k, ...v,
        })),
      });
    }

    if (action === 'list') {
      const tipo = String(body.tipo || '').trim();
      const estado = String(body.estado || '').trim();
      const cc = String(body.company_code || '').trim();
      const q = String(body.q || '').trim().toLowerCase();

      let out = filas;
      // 'ok' no se lista nunca: la pantalla es de lo que falta hacer.
      out = out.filter(f => f.estado !== 'ok');
      if (tipo) out = out.filter(f => f.doc_type === tipo);
      if (estado) out = out.filter(f => f.estado === estado);
      if (cc) out = out.filter(f => f.company_code === cc);
      if (q) {
        out = out.filter(f => String(f.worker_name || '').toLowerCase().includes(q)
          || String(f.id_number || '').includes(q));
      }

      /* Las advertencias primero SIEMPRE: son las accionables y son pocas.
         Si quedaran mezcladas por orden alfabetico, 120 casos concretos se
         perderian entre 4650 faltantes. */
      const peso = { advertencia: 0, falta: 1 };
      out.sort((a, b) => (peso[a.estado] - peso[b.estado])
        || String(a.company_code).localeCompare(String(b.company_code))
        || String(a.worker_name).localeCompare(String(b.worker_name)));

      const total = out.length;
      return json({
        ok: true,
        total,
        // Tope para no mandar 4650 filas de una: la pantalla filtra.
        truncado: total > 500,
        filas: out.slice(0, 500).map(f => ({ ...f, doc_label: TIPOS[f.doc_type] || f.doc_type })),
      });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status || 403);
    return json({ ok: false, error: 'Error del servidor: ' + (e && e.message ? e.message : e) }, 500);
  }
}
