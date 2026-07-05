/* =====================================================================
   functions/api/cert-download.js  →  /api/cert-download
   Descarga del PDF de una Constancia de Trabajo ya generada.

   Devuelve una URL FIRMADA (signed URL, 5 min) del objeto en el bucket
   privado 'cert-docs'. Valida que quien pide tenga derecho a la linea:
     - admin/superadmin: la empresa de la solicitud esta en su alcance
       (get_admin_companies; superadmin = todas).
     - company (tienda) / gestor: es el solicitante de la solicitud
       (requester coincide) O la solicitud es de su propia empresa.
   La linea debe estar 'disponible' y tener pdf_key.

   Accion (POST {action:'url'}):
     { actor, line_id }  ->  { ok, url, filename }

   'actor' = { kind:'company', companyCode } | { kind:'admin', id }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const DOCS_BUCKET = 'cert-docs';   // privado
const SIGNED_TTL = 5 * 60;         // 5 min

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

/* Firma una URL de descarga del bucket privado (con reintentos). */
async function storageSignedUrl(env, path) {
  if (!path) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${DOCS_BUCKET}/${path}`, {
        method: 'POST',
        headers: {
          apikey: env.supabase_service_role,
          Authorization: `Bearer ${env.supabase_service_role}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: SIGNED_TTL }),
      });
      if (res.ok) {
        const js = await res.json();
        const rel = js && (js.signedURL || js.signedUrl);
        if (rel) return `${env.supabase_url}/storage/v1${rel}`;
      }
    } catch { /* reintenta */ }
    if (attempt < 2) await new Promise(r => setTimeout(r, 120 * (attempt + 1)));
  }
  return null;
}

/* ---------- resolucion del ACTOR (misma forma que cert-requests) ---------- */
async function resolveActor(env, actor) {
  if (!actor || !actor.kind) return null;
  if (actor.kind === 'company') {
    const cc = String(actor.companyCode || '').trim();
    if (!cc) return null;
    return { kind: 'company', companyCode: cc, role: 'company', codes: [cc] };
  }
  if (actor.kind === 'admin') {
    const id = actor.id;
    if (!id) return null;
    const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(id)}&is_active=eq.true&select=id,role`);
    if (!a || !a.length) return null;
    if (a[0].role === 'superadmin') return { kind: 'admin', id: a[0].id, role: 'superadmin', codes: null };
    const rows = await sb(env, 'rpc/get_admin_companies', {
      method: 'POST', body: JSON.stringify({ p_admin_id: a[0].id }),
    });
    return { kind: 'admin', id: a[0].id, role: a[0].role, codes: (rows || []).map(r => r.company_code) };
  }
  return null;
}

function actorCanCompany(act, cc) {
  if (!act || !cc) return false;
  if (act.codes === null) return true;   // superadmin
  return act.codes.includes(cc);
}

/* Nombre de archivo amable para la descarga:
   "Constancia de trabajo - <CODIGO_EMPRESA> - #<solicitud> - <NOMBRE>.pdf".
   El nombre del trabajador se incluye porque una solicitud puede tener varias
   lineas (un PDF por empleado) y evita colisiones al descargar. */
function buildFilename(line, req) {
  const codigo = String((req && req.company_code) || '').trim() || 'EMP';
  const sol = (req && req.request_id != null) ? req.request_id : (line.request_id != null ? line.request_id : '');
  const name = String(line.worker_full_name || 'trabajador')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // sin acentos
    .replace(/\s+/g, ' ').trim()
    .replace(/[^A-Za-z0-9 ]+/g, '').slice(0, 45).trim();
  return `Constancia de trabajo - ${codigo} - #${sol}${name ? ' - ' + name : ''}.pdf`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }
  const action = body.action || 'url';

  try {
    const act = await resolveActor(env, body.actor);
    if (!act) return json({ ok: false, error: 'Sesion no valida.' }, 403);

    if (action !== 'url') return json({ ok: false, error: 'Accion desconocida.' }, 400);

    const lineId = parseInt(body.line_id, 10);
    if (!lineId) return json({ ok: false, error: 'Falta la constancia.' }, 400);

    const ls = await sb(env, `cert_request_lines?id=eq.${lineId}&select=*`);
    if (!ls || !ls.length) return json({ ok: false, error: 'Constancia no encontrada.' }, 404);
    const line = ls[0];

    if (line.status !== 'disponible' || !line.pdf_key) {
      return json({ ok: false, error: 'La constancia aun no esta disponible para descargar.' }, 409);
    }

    // Cabecera para validar acceso.
    const rs = await sb(env, `cert_requests?id=eq.${line.request_id}&select=company_code,requester_kind,requester_id`);
    if (!rs || !rs.length) return json({ ok: false, error: 'Solicitud no encontrada.' }, 404);
    const req = rs[0];

    // Autorizacion:
    //  - admin/super: la empresa esta en su alcance.
    //  - company: la solicitud es de su empresa (o es el solicitante).
    let allowed = false;
    if (act.kind === 'admin') {
      allowed = actorCanCompany(act, req.company_code);
    } else {
      allowed = req.company_code === act.companyCode
        || (req.requester_kind === 'company' && req.requester_id === act.companyCode);
    }
    if (!allowed) return json({ ok: false, error: 'Sin acceso a esta constancia.' }, 403);

    const url = await storageSignedUrl(env, line.pdf_key);
    if (!url) return json({ ok: false, error: 'No se pudo generar el enlace de descarga. Reintenta.' }, 502);

    return json({ ok: true, url, filename: buildFilename(line, req) });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
