/* =====================================================================
   functions/api/department-cargos.js  →  /api/department-cargos
   ABM del catalogo de cargos de departamento (Gerente, Jefe, Encargado,
   Coordinador, Analista, Sin Cargo... editable). El cargo se asigna a la
   persona (enterprise_users.cargo_code).

   Acciones (POST con {action, adminId, ...}):
     - list   : lista de cargos (todos; el cliente filtra activos al asignar).
     - create : crea { label }.  [superadmin]
     - rename : renombra { id, label }.  [superadmin]
     - toggle : activa/desactiva { id, is_active }.  [superadmin]

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

import { shadowCan } from './_auth.js';

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

function slug(s) {
  return String(s || 'cargo').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 40) || 'cargo';
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud inválida.' }, 400); }
  const { action, adminId } = body;

  try {
    const admin = await getAdmin(env, adminId);
    if (!admin) return json({ ok: false, error: 'No autorizado.' }, 401);

    // Lectura: cualquier admin (para poblar el combo al asignar cargo).
    if (action === 'list') {
      // Orden alfabetico por etiqueta.
      const rows = await sb(env, 'department_cargos?order=label.asc&select=id,code,label,is_active');
      // Conteo de personas por cargo (para mostrar y decidir antes de desactivar).
      const people = await sb(env, 'enterprise_users?select=cargo_code');
      const counts = {};
      (people || []).forEach(p => { if (p.cargo_code) counts[p.cargo_code] = (counts[p.cargo_code] || 0) + 1; });
      const cargos = (rows || []).map(c => ({ ...c, people_count: counts[c.code] || 0 }));
      return json({ ok: true, cargos });
    }

    // Gestion: solo superadmin.
    const legacyOk = admin.role === 'superadmin';
    await shadowCan(env, adminId, 'department-cargos', action, 'config.cargos', legacyOk);
    if (!legacyOk) return json({ ok: false, error: 'Solo el superadmin gestiona los cargos.' }, 403);

    if (action === 'create') {
      const label = String(body.label || '').trim();
      if (!label) return json({ ok: false, error: 'Falta el nombre del cargo.' }, 400);
      // sort_order: al final
      const last = await sb(env, 'department_cargos?order=sort_order.desc&limit=1&select=sort_order');
      const so = (last && last.length ? (last[0].sort_order || 0) : 0) + 10;
      let code = slug(label);
      // evitar colision de code
      const exists = await sb(env, `department_cargos?code=eq.${encodeURIComponent(code)}&select=id`);
      if (exists && exists.length) code = code + '_' + Date.now().toString(36).slice(-4);
      const row = await sb(env, 'department_cargos', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ code, label, sort_order: so }),
      });
      return json({ ok: true, id: row && row[0] && row[0].id });
    }

    if (action === 'rename') {
      const id = parseInt(body.id, 10);
      const label = String(body.label || '').trim();
      if (!id || !label) return json({ ok: false, error: 'Faltan datos.' }, 400);
      await sb(env, `department_cargos?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ label }),
      });
      return json({ ok: true });
    }

    if (action === 'toggle') {
      const id = parseInt(body.id, 10);
      if (!id) return json({ ok: false, error: 'Falta id.' }, 400);
      await sb(env, `department_cargos?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: !!body.is_active }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida.' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
