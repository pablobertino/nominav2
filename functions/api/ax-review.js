/* =====================================================================
   functions/api/ax-review.js  →  POST /api/ax-review
   Pagina de REVISION y PUBLICACION a AX ("Sincronizar").
   Lista los conjuntos de cambios pendientes (nomina_v2.ax_change_set) del
   alcance del actor, y permite PUBLICAR o ANULAR (individual, en lote por
   seleccion, o TODO el alcance).

   Acciones (POST {action, user, ...}):
     - list     : lista los change_set PENDIENTES del alcance, enriquecidos
                  con datos del trabajador (nombre, cedula) y quien edito.
                  Requiere hcm.publish (ver la pagina implica poder resolver).
     - publish  : envia a AX los cambios de las fichas indicadas y marca el
                  change_set como 'published'. Modos:
                    { id_numbers:[...] }  -> esas fichas (individual o seleccion)
                    { all:true }          -> TODOS los pendientes del alcance
                  Requiere hcm.publish.
     - discard  : anula (status 'discarded') los change_set indicados y limpia
                  ax_pending del master. El dato local NO se toca (se revierte
                  luego al Actualizar desde AX). Mismos modos que publish.
                  Requiere hcm.publish.

   PRINCIPIOS (por diseno, no por confianza en el front):
   - Gate por permiso sombra hcm.publish (superadmin siempre; otros segun la
     matriz de roles). El ALCANCE de empresa se resuelve con get_admin_companies
     (superadmin = todas).
   - Al PUBLICAR se envia SOLO lo que quedo pendiente en el master
     (ax_pending_fields), tomando el VALOR ACTUAL del master (fuente de verdad),
     no el del change_set (que es solo la bitacora old->new para mostrar).
   - RED ANTI-BORRADO: los campos que borran el dato en AX si van vacios se
     OMITEN cuando quedan vacios (nunca se manda "").
   - Traduccion codigo->texto AX (genero, estado civil) y mapeo de nombres de
     campo (AX_FIELD_MAP). 'apellidos' es el campo de escritura. address no viaja.
   - Historial permanente: publish/discard SOLO cambian status + resolved_*;
     nunca borran filas.

   Secrets: canaima_apikey, supabase_url, supabase_service_role
   ===================================================================== */

import { resolveActor, can, AuthError } from './_auth.js';

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

// Traduccion codigo interno -> TEXTO que la API HCM espera (mismos valores que
// worker-photo.js; verificados contra la respuesta real de AX).
const AX_GENDER = { M: 'Masculino', F: 'Femenino' };
const AX_MARITAL = {
  S: 'Soltero/a', C: 'Casado/a', D: 'Divorciado/a', V: 'Viudo/a',
  O: 'Conviviente', R: 'Uni\u00f3n Registrada',
};

// Campo interno (workers_master) -> campo del payload de la API de AX.
const AX_FIELD_MAP = {
  first_name: 'primerNombre',
  second_name: 'segundoNombre',
  last_names: 'apellidos',
  birth_date: 'fechaNacimiento',
  gender: 'genero',
  marital_status: 'estadoCivil',
  account_number: 'cuentaBancaria',
  phone: 'telefono',
  email: 'correo',
};

// Etiqueta legible por campo (para la pagina de revision).
const FIELD_LABEL = {
  first_name: 'Primer nombre', second_name: 'Segundo nombre', last_names: 'Apellidos',
  birth_date: 'Nacimiento', gender: 'Genero', marital_status: 'Estado civil',
  account_number: 'Cuenta', phone: 'Telefono', email: 'Correo',
};

// Traduccion de valor interno -> texto legible (para mostrar old/new).
function displayVal(field, raw) {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim();
  if (field === 'gender') return AX_GENDER[v] || v;
  if (field === 'marital_status') return AX_MARITAL[v] || v;
  if (field === 'phone') return v.startsWith('+58') ? '0' + v.slice(3) : v;
  if (field === 'birth_date') return String(v).slice(0, 10);
  return v;
}

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

/* Alcance de empresas del actor. null = todas (superadmin). Set = solo esas.
   Reusa el RPC get_admin_companies (mismo patron que el resto de endpoints). */
async function allowedCompanies(env, actor, user) {
  if (actor.role === 'superadmin') return null; // todas
  const rows = await sb(env, 'rpc/get_admin_companies', {
    method: 'POST', body: JSON.stringify({ p_admin_id: user.id }),
  });
  return new Set((rows || []).map(r => r.company_code));
}

/* id numerico del actor admin (para resolved_by / changed_by lookups). */
async function actorAdminId(env, user) {
  if (!user || user.kind !== 'admin' || !user.id) return null;
  const a = await sb(env, `admin_users?id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&select=id`);
  return a && a.length ? a[0].id : null;
}

/* ---------- LIST: change_set pendientes del alcance ---------- */
async function listPending(env, actor, user) {
  const allowed = await allowedCompanies(env, actor, user);

  // Traer los pendientes (filtrando por empresa si hay alcance acotado).
  let path = `ax_change_set?status=eq.pending&select=id,id_number,company_code,changes,changed_by,changed_at&order=changed_at.desc`;
  if (allowed !== null) {
    if (!allowed.size) return json({ ok: true, rows: [], companies: [] });
    const inList = [...allowed].map(c => `"${c}"`).join(',');
    path = `ax_change_set?status=eq.pending&company_code=in.(${inList})&select=id,id_number,company_code,changes,changed_by,changed_at&order=changed_at.desc`;
  }
  const sets = await sb(env, path) || [];
  if (!sets.length) return json({ ok: true, rows: [], companies: [] });

  // Enriquecer: nombre del trabajador (workers_master) y nombre de quien edito.
  const ceds = [...new Set(sets.map(s => s.id_number))];
  const editorIds = [...new Set(sets.map(s => s.changed_by).filter(x => x != null))];

  let nameByCed = {};
  if (ceds.length) {
    const inList = ceds.map(c => `"${c}"`).join(',');
    const wm = await sb(env, `workers_master?id_number=in.(${inList})&select=id_number,full_name,ced_kind`);
    (wm || []).forEach(w => { nameByCed[w.id_number] = { full_name: w.full_name, ced_kind: w.ced_kind }; });
  }
  let editorById = {};
  if (editorIds.length) {
    const inList = editorIds.join(',');
    const admins = await sb(env, `admin_users?id=in.(${inList})&select=id,username,name`);
    (admins || []).forEach(a => { editorById[a.id] = a.name || a.username || ('admin#' + a.id); });
  }

  // Empresas presentes: razon social + tipo + zona/subzona/concepto (para los
  // combos encadenados y para filtrar en cliente). Se resuelven los nombres de
  // zona/subzona/concepto por id (igual que el directorio de Personal).
  const companyCodes = [...new Set(sets.map(s => s.company_code))];
  let companyMeta = {};
  if (companyCodes.length) {
    const inList = companyCodes.map(c => `"${c}"`).join(',');
    const comps = await sb(env,
      `companies?company_code=in.(${inList})`
      + `&select=company_code,business_name,company_type,zone_id,subzone_id,concept_id`) || [];
    // Ids a resolver (unicos, no nulos).
    const zoneIds = [...new Set(comps.map(c => c.zone_id).filter(x => x != null))];
    const subIds = [...new Set(comps.map(c => c.subzone_id).filter(x => x != null))];
    const conIds = [...new Set(comps.map(c => c.concept_id).filter(x => x != null))];
    const nameMap = async (tbl, ids) => {
      if (!ids.length) return {};
      const q = ids.map(i => `"${i}"`).join(',');
      const rows = await sb(env, `${tbl}?id=in.(${q})&select=id,name`) || [];
      const m = {};
      rows.forEach(r => { m[String(r.id)] = r.name; });
      return m;
    };
    const [zoneN, subN, conN] = await Promise.all([
      nameMap('zones', zoneIds), nameMap('subzones', subIds), nameMap('concepts', conIds),
    ]);
    comps.forEach(c => {
      companyMeta[c.company_code] = {
        name: c.business_name || null,
        type: c.company_type || null,
        zone_id: c.zone_id != null ? String(c.zone_id) : null,
        subzone_id: c.subzone_id != null ? String(c.subzone_id) : null,
        concept_id: c.concept_id != null ? String(c.concept_id) : null,
        zone: c.zone_id != null ? (zoneN[String(c.zone_id)] || null) : null,
        subzone: c.subzone_id != null ? (subN[String(c.subzone_id)] || null) : null,
        concept: c.concept_id != null ? (conN[String(c.concept_id)] || null) : null,
      };
    });
  }

  // Armar filas para la UI: por ficha, la lista de campos con old->new legible,
  // mas los datos de empresa (tipo/zona/subzona/concepto) para los filtros.
  const rows = sets.map(s => {
    const ch = (s.changes && typeof s.changes === 'object') ? s.changes : {};
    const fields = Object.keys(ch).map(f => ({
      field: f,
      label: FIELD_LABEL[f] || f,
      old: displayVal(f, ch[f] ? ch[f].old : null),
      new: displayVal(f, ch[f] ? ch[f].new : null),
    }));
    const nm = nameByCed[s.id_number] || {};
    const cm = companyMeta[s.company_code] || {};
    return {
      id: s.id,
      id_number: s.id_number,
      ced_kind: nm.ced_kind || null,
      full_name: nm.full_name || null,
      company_code: s.company_code,
      company_name: cm.name || null,
      company_type: cm.type || null,
      zone_id: cm.zone_id || null,
      subzone_id: cm.subzone_id || null,
      concept_id: cm.concept_id || null,
      zona: cm.zone || null,
      subzona: cm.subzone || null,
      concepto: cm.concept || null,
      changed_by: s.changed_by != null ? (editorById[s.changed_by] || ('admin#' + s.changed_by)) : null,
      changed_at: s.changed_at,
      fields,
      field_count: fields.length,
    };
  });

  // Facetas para los combos encadenados (solo lo presente en los pendientes).
  const companies = companyCodes.map(c => ({
    code: c,
    name: (companyMeta[c] && companyMeta[c].name) || null,
    type: (companyMeta[c] && companyMeta[c].type) || null,
  })).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const uniq = (arr) => [...new Map(arr.filter(x => x && x.id != null).map(x => [String(x.id), x])).values()];
  const facets = {
    types: [...new Set(rows.map(r => r.company_type).filter(Boolean))].sort(),
    companies,
    zones: uniq(rows.map(r => r.zone_id != null ? { id: r.zone_id, name: r.zona } : null))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    subzones: uniq(rows.map(r => r.subzone_id != null ? { id: r.subzone_id, name: r.subzona, zone_id: r.zone_id } : null))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    concepts: uniq(rows.map(r => r.concept_id != null ? { id: r.concept_id, name: r.concepto } : null))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
  };

  return json({ ok: true, rows, companies, facets });
}

/* Resuelve el set de change_set a operar segun el modo del body:
     { all:true }        -> todos los pendientes del alcance
     { id_numbers:[...] }-> los pendientes de esas fichas (dentro del alcance)
   Devuelve las filas de ax_change_set pendientes (id, id_number, company_code).
   Aplica el alcance de empresa siempre. */
async function resolveTargetSets(env, actor, user, body) {
  const allowed = await allowedCompanies(env, actor, user);
  let path = `ax_change_set?status=eq.pending&select=id,id_number,company_code`;
  if (allowed !== null) {
    if (!allowed.size) return [];
    const inList = [...allowed].map(c => `"${c}"`).join(',');
    path += `&company_code=in.(${inList})`;
  }
  const all = await sb(env, path) || [];
  if (body.all === true) return all;
  const asked = Array.isArray(body.id_numbers)
    ? new Set(body.id_numbers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean))
    : null;
  if (!asked || !asked.size) return [];
  return all.filter(s => asked.has(String(s.id_number)));
}

/* ---------- PUBLISH: enviar a AX + marcar published ---------- */
async function publish(env, actor, user, body) {
  if (!env.canaima_apikey) {
    return json({ ok: false, error: 'La clave de AX no esta configurada en el servidor.' }, 500);
  }
  const targets = await resolveTargetSets(env, actor, user, body);
  if (!targets.length) {
    return json({ ok: true, sent: 0, published: [], rejected: [], message: 'No hay cambios pendientes para publicar.' });
  }

  // Valor a enviar = el ACTUAL del master (fuente de verdad), solo los campos
  // que quedaron pendientes (ax_pending_fields). El change_set es la bitacora,
  // pero lo que viaja a AX es el dato vigente.
  const ceds = [...new Set(targets.map(t => t.id_number))];
  const inList = ceds.map(c => `"${c}"`).join(',');
  const AX_SEL = ['id_number', 'first_name', 'second_name', 'last_names',
    'birth_date', 'gender', 'marital_status', 'account_number', 'phone', 'email',
    'ax_pending', 'ax_pending_fields'].join(',');
  const master = await sb(env, `workers_master?id_number=in.(${inList})&select=${AX_SEL}`) || [];
  const masterByCed = {};
  master.forEach(m => { masterByCed[String(m.id_number)] = m; });

  const toAxValue = (field, raw) => {
    const v = (raw == null) ? '' : String(raw).trim();
    if (v === '') return null;
    if (field === 'gender') return AX_GENDER[v] || null;
    if (field === 'marital_status') return AX_MARITAL[v] || null;
    if (field === 'phone') return v.startsWith('+58') ? '0' + v.slice(3) : v;
    if (field === 'birth_date') return String(v).slice(0, 10);
    return v;
  };

  const clean = [];         // payloads AX
  const okCeds = [];        // cedulas que se enviaran
  const okSetIds = [];      // change_set.id correspondientes
  const rejected = [];      // { id_number, reason }
  for (const t of targets) {
    const ced = String(t.id_number);
    const m = masterByCed[ced];
    if (!m || !m.ax_pending) {
      rejected.push({ id_number: ced, reason: 'Sin cambios pendientes en el maestro.' });
      continue;
    }
    const fields = (m.ax_pending_fields && typeof m.ax_pending_fields === 'object') ? m.ax_pending_fields : {};
    const out = { ficha: ced };
    for (const field of Object.keys(fields)) {
      const axKey = AX_FIELD_MAP[field];
      if (!axKey) continue;                 // address u otros no viajan
      const val = toAxValue(field, m[field]);
      if (val == null || val === '') continue;   // RED ANTI-BORRADO: se omite
      out[axKey] = val;
    }
    if (Object.keys(out).length <= 1) {
      rejected.push({ id_number: ced, reason: 'Sin campos validos para enviar (todo quedo vacio).' });
      continue;
    }
    clean.push(out);
    okCeds.push(ced);
    okSetIds.push(t.id);
  }

  if (!clean.length) {
    return json({ ok: false, error: 'Ningun cambio paso la validacion para enviar a AX.', rejected }, 422);
  }

  // Enviar a AX (POST).
  let axRes;
  try {
    const r = await fetch(HCM_API, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-Key': env.canaima_apikey },
      body: JSON.stringify(clean),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* no-json */ }
    axRes = { ok: r.ok, status: r.status, data, text };
  } catch (e) {
    return json({ ok: false, error: `No se pudo conectar con AX: ${String(e.message || e)}`, rejected }, 502);
  }
  if (!axRes.ok) {
    return json({ ok: false, error: `La API de AX respondio ${axRes.status} al enviar.`, detail: axRes.text || null, rejected }, 502);
  }

  // Exito: marcar change_set como published (con resolved_by/at y ax_response),
  // y limpiar ax_pending del master de los enviados.
  const nowIso = new Date().toISOString();
  const rid = await actorAdminId(env, user);
  if (okSetIds.length) {
    const setList = okSetIds.join(',');
    await sb(env, `ax_change_set?id=in.(${setList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'published', resolved_by: rid, resolved_at: nowIso,
        ax_response: axRes.data ?? { text: axRes.text ?? null },
      }),
    });
  }
  if (okCeds.length) {
    const okList = okCeds.map(c => `"${c}"`).join(',');
    await sb(env, `workers_master?id_number=in.(${okList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ax_pending: false, ax_pending_fields: {}, ax_pending_at: null, ax_synced_at: nowIso,
      }),
    });
  }

  return json({
    ok: true,
    sent: clean.length,
    published: okCeds,
    rejected,
    rejected_count: rejected.length,
    ax_response: axRes.data ?? axRes.text ?? null,
  });
}

/* ---------- DISCARD: anular (status discarded) + limpiar ax_pending ---------- */
async function discard(env, actor, user, body) {
  const targets = await resolveTargetSets(env, actor, user, body);
  if (!targets.length) {
    return json({ ok: true, discarded: [], message: 'No hay cambios pendientes para anular.' });
  }
  const nowIso = new Date().toISOString();
  const rid = await actorAdminId(env, user);

  const setIds = targets.map(t => t.id);
  const ceds = [...new Set(targets.map(t => String(t.id_number)))];

  // Marcar los change_set como discarded (historial permanente).
  if (setIds.length) {
    const setList = setIds.join(',');
    await sb(env, `ax_change_set?id=in.(${setList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'discarded', resolved_by: rid, resolved_at: nowIso }),
    });
  }
  // Limpiar ax_pending del master (el dato local NO se toca: se revierte luego
  // al Actualizar desde AX, que trae la verdad del ERP).
  if (ceds.length) {
    const okList = ceds.map(c => `"${c}"`).join(',');
    await sb(env, `workers_master?id_number=in.(${okList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ax_pending: false, ax_pending_fields: {}, ax_pending_at: null }),
    });
  }

  return json({ ok: true, discarded: ceds, count: ceds.length });
}

/* ===================== Handler ===================== */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Solicitud invalida.' }, 400); }

  const action = body.action;
  const user = body.user || null;

  try {
    const actor = await resolveActor(env, user);
    if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);
    // Gate unico: hcm.publish (superadmin siempre pasa por can()).
    if (!can(actor, 'hcm.publish')) {
      return json({ ok: false, error: 'No tienes permiso para revisar/publicar cambios en AX.' }, 403);
    }

    if (action === 'list') return await listPending(env, actor, user);
    if (action === 'publish') return await publish(env, actor, user, body);
    if (action === 'discard') return await discard(env, actor, user, body);

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
