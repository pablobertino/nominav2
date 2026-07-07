/* =====================================================================
   functions/api/reset-transactional.js  →  POST /api/reset-transactional
   "Reiniciar datos de prueba": borrado FISICO y DEFINITIVO de lo
   transaccional generado durante el periodo de prueba, por categoria.
   Mockup aprobado: _PRUEBAS\reset_mockup.html (v0-mock1).

   Alcance (decidido con Pablo el 2026-07-07):
     - reportes          : reports_log + lineas de los 5 tipos + checklists.
     - avisos            : announcements (manuales) + announcement_seen +
                           notif_state. NO company_change (novedades fijas).
     - sincronizaciones  : ax_change_set + roster_run + roster_change +
                           sync_runs. NO estado de pago (period_pay_status /
                           pay_sync_run).
     - constancias       : cert_requests + lines + audit + bell_seen.
                           NO cert_signers ni cert-signatures.
     - constancias_pdfs  : archivos del bucket 'cert-docs' (Storage).
   NO se toca: personal, fotos, empresas, usuarios, catalogos, config,
   periodos, documentos de la pantalla Documentos.

   Acciones (POST {action, user}):
     - counts : conteos vivos por categoria (RPC reset_test_counts).
     - run    : { category, confirm:'REINICIAR' } ejecuta UNA categoria
                (RPC reset_test_data / Storage para los PDFs) y deja
                registro en nomina_v2.reset_log.

   SEGURIDAD (todo por diseno, no por confianza en el front):
     - SOLO superadmin (validado contra admin_users, como push_to_ax).
     - La palabra de confirmacion 'REINICIAR' se exige TAMBIEN aqui.
     - El borrado corre dentro de funciones SQL (1 subrequest por categoria).
     - Cada ejecucion queda en reset_log (quien, cuando, que se borro).

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const CATEGORIES = new Set(['reportes', 'avisos', 'sincronizaciones', 'constancias', 'constancias_pdfs']);
const CONFIRM_WORD = 'REINICIAR';
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

/* Borra objetos del bucket privado de constancias (Storage API real: quita
   el archivo fisico, no solo la fila de metadatos). */
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
    `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id,role,full_name,username`);
  if (!a || !a.length || a[0].role !== 'superadmin') return null;
  return { id: a[0].id, name: a[0].full_name || a[0].username || 'superadmin' };
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

    if (action === 'run') {
      const category = String(body.category || '').trim();
      if (!CATEGORIES.has(category)) return json({ ok: false, error: 'Categoria no valida.' }, 400);
      // Defensa: la palabra de confirmacion se valida TAMBIEN en el servidor.
      if (String(body.confirm || '').trim().toUpperCase() !== CONFIRM_WORD) {
        return json({ ok: false, error: 'Falta la confirmacion.' }, 400);
      }

      let detail;
      if (category === 'constancias_pdfs') {
        // Lista real de archivos (SQL sobre storage.objects) + borrado via
        // Storage API (asi se elimina el archivo fisico, no solo la fila).
        const names = await sb(env, 'rpc/reset_cert_pdf_list', { method: 'POST', body: JSON.stringify({}) });
        const list = Array.isArray(names) ? names.filter(Boolean) : [];
        if (list.length) await storageRemove(env, list);
        detail = { bucket: CERT_BUCKET, archivos: list.length };
      } else {
        detail = await sb(env, 'rpc/reset_test_data', {
          method: 'POST', body: JSON.stringify({ p_category: category }),
        });
      }

      // Registro permanente de la operacion (quien, cuando, que se borro).
      await sb(env, 'reset_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          executed_by: su.id, executed_by_name: su.name,
          category, detail,
        }),
      });

      return json({ ok: true, category, detail, executed_by: su.name, executed_at: new Date().toISOString() });
    }

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
