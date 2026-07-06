/* =====================================================================
   functions/api/store-contacts.js  →  /api/store-contacts
   Responsables de cada tienda (quien reporta las incidencias).
   Maximo 4 activos por tienda (lo fuerza el trigger en BD).
   Se precargan con los GERENTE / SUB-GERENTE detectados del Reporte 10,
   y la tienda o el admin pueden gestionarlos.

   Acciones (POST {action}):
     - list   : lista los responsables activos de una tienda.
                { action:'list', company_code }
     - add    : agrega un responsable.
                { action:'add', company_code, full_name, role, id_number? }
     - update : edita un responsable.
                { action:'update', id, full_name, role, id_number? }
     - remove : baja logica (is_active=false) de un responsable.
                { action:'remove', id }

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

import { shadowCan } from './_auth.js';

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

const RESP_MAX = 4;

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido' }, 400); }

  const action = body.action;
  try {
    // SHADOW: este endpoint HOY no valida sesion (agujero real). El shadow
    // solo REGISTRA si el actor (body.user) tendria el permiso
    // company.responsables; legacyAllowed=true porque el comportamiento actual
    // permite todo. En la pasada FINAL hay que AGREGAR el gate real aqui
    // (validar sesion: tienda su propia empresa, admin con alcance, superadmin).
    await shadowCan(env, body.user || null, 'store-contacts', action || '?', 'company.responsables', true);

    if (action === 'list') {
      const cc = (body.company_code || '').trim();
      if (!cc) return json({ ok: false, error: 'Falta company_code' }, 400);
      const rows = await sb(env,
        `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true`
        + `&select=id,full_name,role,id_number,source&order=created_at.asc`);
      return json({ ok: true, contacts: rows || [], max: RESP_MAX });
    }

    if (action === 'add') {
      const cc = (body.company_code || '').trim();
      const full_name = (body.full_name || '').trim();
      const role = (body.role || '').trim();
      const id_number = (body.id_number || '').replace(/[^0-9]/g, '') || null;
      if (!cc || !full_name || !role) return json({ ok: false, error: 'Faltan datos (tienda, nombre, cargo)' }, 400);

      // chequeo de tope (ademas del trigger, para dar mensaje limpio)
      const cur = await sb(env,
        `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true&select=id`);
      if (cur && cur.length >= RESP_MAX) {
        return json({ ok: false, error: `Maximo ${RESP_MAX} responsables por tienda.` }, 409);
      }

      const ins = await sb(env, 'store_contacts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ company_code: cc, full_name, role, id_number, source: 'manual' }),
      });
      return json({ ok: true, contact: ins && ins[0] });
    }

    if (action === 'update') {
      const id = body.id;
      if (!id) return json({ ok: false, error: 'Falta id' }, 400);
      const patch = {};
      if (body.full_name != null) patch.full_name = String(body.full_name).trim();
      if (body.role != null) patch.role = String(body.role).trim();
      if (body.id_number != null) patch.id_number = String(body.id_number).replace(/[^0-9]/g, '') || null;
      patch.updated_at = new Date().toISOString();

      const upd = await sb(env, `store_contacts?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      return json({ ok: true, contact: upd && upd[0] });
    }

    if (action === 'remove') {
      const id = body.id;
      if (!id) return json({ ok: false, error: 'Falta id' }, 400);
      await sb(env, `store_contacts?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Accion no reconocida' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
