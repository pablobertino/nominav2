/* =====================================================================
   functions/api/version.js  →  GET /api/version
   Devuelve la última versión registrada en nomina_v2.app_versions.
   Público (sin auth): el login lo consulta para comparar con la versión
   del código y avisar si no coinciden.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env }) {
  try {
    // Orden por id (siempre incremental y unico) en vez de released_at:
    // si dos versiones comparten timestamp (mismo INSERT), released_at
    // empata y el orden queda indefinido. id nunca empata.
    const res = await fetch(
      `${env.supabase_url}/rest/v1/app_versions?select=version,summary,released_at&order=id.desc&limit=1`,
      {
        headers: {
          apikey: env.supabase_service_role,
          Authorization: `Bearer ${env.supabase_service_role}`,
          'Accept-Profile': 'nomina_v2',
        },
      }
    );
    if (!res.ok) return json({ ok: false, error: `Supabase ${res.status}` }, 502);
    const rows = await res.json();
    const latest = rows[0] || null;
    return json({ ok: true, latest });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
