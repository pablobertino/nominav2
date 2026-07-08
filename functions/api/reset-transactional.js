/* =====================================================================
   functions/api/reset-transactional.js  →  POST /api/reset-transactional
   "Reiniciar datos de prueba" v2 (v4.17): DOS MODOS.
   Mockup aprobado: _PRUEBAS\reset_mockup.html (v0-mock2).

   MODO SELECTIVO (por empresas): borra SOLO Reportes y Constancias (con sus
   PDFs) de las empresas indicadas. No toca avisos, sincronizaciones ni la
   numeracion. Palabra: REINICIAR.

   MODO TOTAL (hard reset): borra TODO lo transaccional (reportes, avisos,
   sincronizaciones, constancias + PDFs) y reinicia la NUMERACION a cero
   (el proximo reporte sera el N 1 y la proxima solicitud la 1).
   Palabra: REINICIAR TODO.

   NO se toca en ningun modo: personal, fotos, empresas, usuarios,
   catalogos, config, periodos, estado de pago, novedades de empresas,
   documentos de la pantalla Documentos, firmantes/firmas.

   Acciones (POST {action, user}):
     - counts    : conteos globales por categoria (RPC reset_test_counts).
     - companies : estadisticas por empresa para el picker
                   (RPC reset_company_stats).
     - run       : { category, confirm, company_codes? } ejecuta UN paso.
        * Totales   : reportes | avisos | sincronizaciones | constancias |
                      constancias_pdfs | numeracion       (REINICIAR TODO)
        * Selectivos: sel_reportes | sel_constancias | sel_constancias_pdfs
                      + company_codes[]                    (REINICIAR)
        OJO orden selectivo: sel_constancias_pdfs ANTES de sel_constancias
        (la lista de PDFs sale de las lineas que luego se borran).

   SEGURIDAD: SOLO superadmin (admin_users); palabra validada TAMBIEN aqui,
   distinta por modo (imposible disparar el hard reset creyendo que era una
   limpieza parcial); borrado dentro de funciones SQL (1 subrequest por
   paso); registro en nomina_v2.reset_log (modo/empresas incluidos).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const CAT_TOTAL = new Set(['reportes', 'avisos', 'sincronizaciones', 'constancias', 'constancias_pdfs', 'numeracion']);
const CAT_SEL = new Set(['sel_reportes', 'sel_constancias', 'sel_constancias_pdfs']);
const WORD_SEL = 'REINICIAR';
const WORD_TOTAL = 'REINICIAR TODO';
const CERT_BUCKET = 'cert-docs';

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

/* Borra objetos del bucket de constancias (Storage API real). */
async function storageRemove(env, names) {
  if (!names || !names.length) return true;
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${CERT_BUCKET}`, {
    method: 'DELETE',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new Error(`Storage ${res.status}: ${await res.text()}`);
  return true;
}

/* Gate: SOLO superadmin activo. Devuelve {id, name} o null. */
async function requireSuper(env, user) {
  if (!user || user.kind !== 'admin' || !user.id) return null;
  const a = await sb(env,
    `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role,name,username`);
  if (!a || !a.length || a[0].role !== 'superadmin') return null;
  return { id: a[0].id, name: a[0].name || a[0].username || 'superadmin' };
}

/* Normaliza y valida la lista de empresas del modo selectivo. */
function cleanCompanies(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => String(x || '').trim().toUpperCase()).filter(c => /^[A-Z0-9]{2,10}$/.test(c)))].slice(0, 250);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  try {
    const su = await requireSuper(env, body.user || null);
    if (!su) return json({ ok: false, error: 'Esta accion esta reservada al superadministrador.' }, 403);

    const action = body.action;

    if (action === 'counts') {
      const counts = await sb(env, 'rpc/reset_test_counts', { method: 'POST', body: JSON.stringify({}) });
      return json({ ok: true, counts });
    }

    if (action === 'companies') {
      const companies = await sb(env, 'rpc/reset_company_stats', { method: 'POST', body: JSON.stringify({}) });
      return json({ ok: true, companies: Array.isArray(companies) ? companies : (companies || []) });
    }

    if (action === 'run') {
      const category = String(body.category || '').trim();
      const isSel = CAT_SEL.has(category);
      const isTotal = CAT_TOTAL.has(category);
      if (!isSel && !isTotal) return json({ ok: false, error: 'Categoria no valida.' }, 400);

      // Palabra de confirmacion por MODO (validada aqui, no solo en el front).
      const word = String(body.confirm || '').trim().toUpperCase().replace(/\s+/g, ' ');
      const expected = isSel ? WORD_SEL : WORD_TOTAL;
      if (word !== expected) return json({ ok: false, error: 'Falta la confirmacion.' }, 400);

      // Empresas del modo selectivo.
      let companies = [];
      if (isSel) {
        companies = cleanCompanies(body.company_codes);
        if (!companies.length) return json({ ok: false, error: 'Sin empresas seleccionadas.' }, 400);
      }

      let detail;
      if (category === 'constancias_pdfs') {
        // TOTAL: todos los archivos del bucket.
        const names = await sb(env, 'rpc/reset_cert_pdf_list', { method: 'POST', body: JSON.stringify({}) });
        const list = Array.isArray(names) ? names.filter(Boolean) : [];
        if (list.length) await storageRemove(env, list);
        detail = { bucket: CERT_BUCKET, archivos: list.length };
      } else if (category === 'sel_constancias_pdfs') {
        // SELECTIVO: solo los PDFs de las constancias de esas empresas.
        // (Debe correr ANTES de sel_constancias: la lista sale de las lineas.)
        const names = await sb(env, 'rpc/reset_selective_pdf_list', {
          method: 'POST', body: JSON.stringify({ p_companies: companies }),
        });
        const list = Array.isArray(names) ? names.filter(Boolean) : [];
        if (list.length) await storageRemove(env, list);
        detail = { bucket: CERT_BUCKET, archivos: list.length };
      } else if (category === 'sel_reportes' || category === 'sel_constancias') {
        detail = await sb(env, 'rpc/reset_selective', {
          method: 'POST',
          body: JSON.stringify({ p_category: category.replace('sel_', ''), p_companies: companies }),
        });
      } else if (category === 'numeracion') {
        // HARD RESET: secuencias a 1 (correr al FINAL del modo total).
        detail = await sb(env, 'rpc/reset_restart_sequences', { method: 'POST', body: JSON.stringify({}) });
      } else {
        detail = await sb(env, 'rpc/reset_test_data', {
          method: 'POST', body: JSON.stringify({ p_category: category }),
        });
      }

      // Registro permanente (modo/empresas incluidos en el detalle).
      await sb(env, 'reset_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          executed_by: su.id, executed_by_name: su.name,
          category,
          detail: isSel ? { companies, ...detail } : detail,
        }),
      });

      return json({ ok: true, category, detail, companies: isSel ? companies : undefined, executed_by: su.name, executed_at: new Date().toISOString() });
    }

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
