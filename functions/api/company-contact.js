/* =====================================================================
   functions/api/company-contact.js  →  POST /api/company-contact
   Actualiza los datos de contacto de una compañía: correo y teléfono.
   Autorización: { adminId }. superadmin = cualquiera; admin = solo
   compañías dentro de su alcance (get_admin_companies).

   Body: { adminId, companyCode, email, phone }
     - email: '' o null para limpiar; si hay valor se valida formato.
     - phone: se recibe en formato nacional (04121234567) o vacío.
              Se valida prefijo móvil VE y se guarda en E.164 (+58...).
   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

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

async function getAdmin(env, adminId) {
  if (!adminId) return null;
  const rows = await sb(env, `admin_users?id=eq.${encodeURIComponent(adminId)}&is_active=eq.true&select=id,role`);
  return rows && rows.length ? rows[0] : null;
}

async function canTouch(env, admin, code) {
  if (admin.role === 'superadmin') return true;
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: admin.id }),
  });
  return (rows || []).some(r => r.company_code === code);
}

// Prefijos móviles válidos en Venezuela
// Movistar 0414/0424 · Movilnet 0416/0426 · Digitel 0412/0422 (0422 nuevo)
const VE_PREFIXES = ['0412', '0414', '0416', '0422', '0424', '0426'];

/** Normaliza un móvil VE a E.164 (+58...). Devuelve {e164} o {error}. */
function normalizePhone(raw) {
  if (!raw || !raw.trim()) return { e164: null };           // vacío => limpiar
  let s = raw.replace(/[\s\-()]/g, '');                     // quita espacios/guiones/paréntesis
  // Acepta entrada en +58..., 58..., o 04...
  if (s.startsWith('+58')) s = '0' + s.slice(3);
  else if (s.startsWith('58') && s.length === 12) s = '0' + s.slice(2);
  // Ahora debe ser nacional 04XXXXXXXXX (11 dígitos)
  if (!/^\d{11}$/.test(s)) return { error: 'El teléfono debe tener 11 dígitos (ej. 04121234567).' };
  const prefix = s.slice(0, 4);
  if (!VE_PREFIXES.includes(prefix)) {
    return { error: `Prefijo inválido (${prefix}). Use ${VE_PREFIXES.join(', ')}.` };
  }
  return { e164: '+58' + s.slice(1) };                      // 0412... => +58412...
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { adminId, companyCode, email, phone, phone2 } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 401);
    if (!companyCode) return json({ ok: false, error: 'Falta la compañía.' }, 400);
    if (!(await canTouch(env, admin, companyCode))) return json({ ok: false, error: 'Fuera de tu alcance.' }, 403);

    const patch = {};

    // Correo (si viene la clave en el body)
    if (email !== undefined) {
      const clean = (email && email.trim()) ? email.trim().toLowerCase() : null;
      if (clean && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
        return json({ ok: false, error: 'Correo con formato inválido.' }, 400);
      }
      patch.email = clean;
    }

    // Teléfono (si viene la clave en el body)
    if (phone !== undefined) {
      const norm = normalizePhone(phone);
      if (norm.error) return json({ ok: false, error: 'Tel. 1: ' + norm.error }, 400);
      patch.phone = norm.e164;
    }
    // Teléfono 2 (si viene la clave en el body)
    if (phone2 !== undefined) {
      const norm2 = normalizePhone(phone2);
      if (norm2.error) return json({ ok: false, error: 'Tel. 2: ' + norm2.error }, 400);
      patch.phone2 = norm2.e164;
    }

    if (Object.keys(patch).length === 0) {
      return json({ ok: false, error: 'Nada que actualizar.' }, 400);
    }

    await sb(env, `companies?company_code=eq.${encodeURIComponent(companyCode)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    return json({ ok: true, email: patch.email, phone: patch.phone, phone2: patch.phone2 });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
