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

import { resolveActor, can, shadowCan, AuthError } from './_auth.js';
import { hcmRosterRaw, fullHcmPayload } from './_hcm.js';

const HCM_API = 'https://api2.grupocanaima.com/empleados/datos/v1';

// Textos en ESPANOL solo para MOSTRAR en la UI (displayVal). Para ENVIAR al
// sistema se usan los textos en ingles de _hcm.js (la API cambio de idioma
// el 2026-07-07: Single/Married/... y Male/Female).
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

/* ===================== DETECCION CONTRA EL ERP =====================
   Campos COMPARABLES: los que el ERP devuelve por la API de empleados. El ERP
   SI trae correo y telefono (ademas de nombres, apellidos, nacimiento, genero,
   estado civil y cuenta). 'address' NO viaja (la API no lo maneja) -> no se
   compara.

   Se comparan en CODIGO INTERNO normalizado (S/C/D/V/O/R, M/F, YYYY-MM-DD,
   20 digitos, telefono nacional 0XXXXXXXXXX, correo en minusculas) para no
   generar falsos positivos por formato.

   OJO con el ERP: los vacios llegan como "-" (guion) tanto en correo como en
   telefono; se tratan como null. El correo a veces viene mal formado (sin @ o
   sin punto) -> se compara tal cual normalizado a minusculas (no validamos,
   solo comparamos texto). El telefono llega con o sin el 0 inicial. */
const DETECT_FIELDS = ['first_name', 'second_name', 'last_names',
  'birth_date', 'gender', 'marital_status', 'account_number', 'phone', 'email'];

// --- Normalizadores (mismos criterios que ax-roster.js) ---
// BILINGUE: el sistema puede responder en espanol o en ingles (cambio
// detectado 2026-07-07: Single/Married/Divorced/Widowed/Cohabiting/
// RegisteredPartnership, Male/Female). Se aceptan ambos idiomas.
function dGenderCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s.startsWith('MASC') || s === 'M' || s === 'MALE') return 'M';
  if (s.startsWith('FEM') || s === 'F') return 'F';
  return null;
}
function dMaritalCode(raw) {
  const s = String(raw || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (s.startsWith('SOLTER') || s.startsWith('SINGLE')) return 'S';
  if (s.startsWith('CASAD') || s.startsWith('MARRIED')) return 'C';
  if (s.startsWith('DIVORC')) return 'D';
  if (s.startsWith('VIUD') || s.startsWith('WIDOW')) return 'V';
  if (s.startsWith('COHABIT') || s.startsWith('CONVIV') || s.startsWith('UNION LIBRE')) return 'O';
  if (s.startsWith('ASOCIAC') || s.startsWith('UNION REGISTRAD') || s.startsWith('SOCIEDAD REGISTRAD') || s.startsWith('REGISTERED')) return 'R';
  return null;
}
function dDateOrNull(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function dAccountDigits(v) {
  const d = String(v || '').replace(/[^0-9]/g, '');
  return d.length === 20 ? d : null;
}
function dUpper(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return (!s || s === '-') ? null : s;
}
// Telefono a formato NACIONAL comparable: 0 + 10 digitos (04121234567). El ERP
// lo trae con o sin 0 inicial ("04227182280" o "4128974034") y "-" si vacio. El
// maestro guarda "+58XXXXXXXXXX". Ambos se reducen a 11 digitos 0XXXXXXXXXX.
function dPhoneNat(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s || s === '-') return null;
  if (s.startsWith('+58')) s = '0' + s.slice(3);
  const d = s.replace(/[^0-9]/g, '');
  let nat = d;
  if (nat.length === 10) nat = '0' + nat;         // sin el 0 inicial
  if (nat.length === 12 && nat.startsWith('58')) nat = '0' + nat.slice(2);
  return /^0\d{10}$/.test(nat) ? nat : (d || null);
}
// Correo comparable: minusculas, sin espacios, "-" -> null. NO se valida (el ERP
// a veces trae correos sin @ o sin punto); solo se compara como texto.
function dEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return (!s || s === '-') ? null : s;
}

/* Mapea un empleado crudo del ERP a los campos internos COMPARABLES, ya
   normalizados (mismo criterio que el maestro). "Apellidos" COMPLETOS vienen
   en el campo `apellidos` del ERP (ej. "HERRERA SALAZAR"); primerApellido y
   segundoApellido son cada uno por separado. El portal guarda los apellidos
   completos en last_names, asi que se compara contra `apellidos` (con
   fallback a la concatenacion de primer+segundo por si `apellidos` viniera
   vacio). */
function erpToComparable(e) {
  const id_number = String(e.ficha ?? '').replace(/[^0-9]/g, '');
  const account = dAccountDigits(e.cuentaBancaria);
  const apellidosFull = (e.apellidos && String(e.apellidos).trim() && String(e.apellidos).trim() !== '-')
    ? e.apellidos
    : [e.primerApellido, e.segundoApellido].filter(x => x && String(x).trim() && String(x).trim() !== '-').join(' ');
  return {
    id_number,
    first_name: dUpper(e.primerNombre),
    second_name: dUpper(e.segundoNombre),
    last_names: dUpper(apellidosFull),
    birth_date: dDateOrNull(e.fechaNacimiento),
    gender: dGenderCode(e.genero),
    marital_status: dMaritalCode(e.estadoCivil),
    account_number: account,
    phone: dPhoneNat(e.telefono),
    email: dEmail(e.correo),
  };
}

/* Normaliza el valor del MAESTRO al mismo formato comparable. */
function masterComparableVal(field, raw) {
  if (field === 'birth_date') return dDateOrNull(raw);
  if (field === 'account_number') return dAccountDigits(raw);
  if (field === 'gender') { const v = dUpper(raw); return (v === 'M' || v === 'F') ? v : null; }
  if (field === 'marital_status') { const v = dUpper(raw); return ['S', 'C', 'D', 'V', 'O', 'R'].includes(v) ? v : null; }
  if (field === 'phone') return dPhoneNat(raw);
  if (field === 'email') return dEmail(raw);
  return dUpper(raw);   // nombres/apellidos
}

/* Lee el padron del ERP para una empresa (por alias = company_code). Devuelve
   un mapa cedula -> objeto comparable, o null si la API fallo. */
async function erpRosterFor(env, cc) {
  try {
    const url = `${HCM_API}?alias=${encodeURIComponent(cc)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey } });
    if (!res.ok) return null;
    let data = await res.json();
    if (!Array.isArray(data)) data = data.empleados || data.data || data.items || [];
    const map = {};
    for (const raw of data) {
      const c = erpToComparable(raw);
      if (c.id_number && c.id_number.length >= 6 && c.id_number.length <= 8) map[c.id_number] = c;
    }
    return map;
  } catch (e) {
    return null;
  }
}

/* Empresas objetivo de la deteccion segun el alcance del actor y el body:
     { company_code }  -> esa empresa (si esta en el alcance)
     { all:true }      -> todas las del alcance (respaldo; el flujo normal
                          llama empresa-por-empresa, ver detect_scope)
   Devuelve lista de company_code. */
async function detectTargetCompanies(env, actor, user, body) {
  const allowed = await allowedCompanies(env, actor, user);
  // Lista explicita de empresas (usada por detect_commit/adopt desde el panel
  // de comparacion: solo las empresas de las fichas a resolver).
  if (Array.isArray(body.company_codes) && body.company_codes.length) {
    const asked = body.company_codes.map(c => String(c).trim()).filter(Boolean);
    return allowed !== null ? asked.filter(c => allowed.has(c)) : asked;
  }
  const one = (body.company_code || '').trim();
  if (one) {
    if (allowed !== null && !allowed.has(one)) return [];
    return [one];
  }
  if (body.all === true) {
    if (allowed !== null) return [...allowed];
    const comps = await sb(env, `companies?select=company_code&order=company_code`) || [];
    return comps.map(c => c.company_code);
  }
  return [];
}

/* ---------- DETECT_SCOPE: lista de empresas de un alcance (liviano) ----------
   Dado un filtro (tipo/zona/subzona/concepto/empresa), devuelve SOLO los
   company_code que caen en ese alcance, dentro del alcance del actor. Es una
   sola consulta a companies: el front usa esta lista para comparar empresa por
   empresa en bucle (evita el limite de 50 subrequests por invocacion).
   Tambien devuelve el catalogo de facetas (tipos/empresas/zonas/subzonas/
   conceptos) del universo permitido, para poblar los combos del modal con
   TODAS las empresas (no solo las que tienen pendientes). */
async function detectScope(env, actor, user, body) {
  const allowed = await allowedCompanies(env, actor, user);

  // Catalogo base: todas las empresas del alcance del actor.
  let path = `companies?select=company_code,business_name,company_type,zone_id,subzone_id,concept_id&order=company_code`;
  if (allowed !== null) {
    if (!allowed.size) return json({ ok: true, companies: [], facets: emptyFacets(), codes: [] });
    const inList = [...allowed].map(c => `"${c}"`).join(',');
    path += `&company_code=in.(${inList})`;
  }
  const comps = await sb(env, path) || [];

  // Resolver nombres de zona/subzona/concepto (para las facetas del modal).
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

  // Normalizar filas con ids en texto + nombres.
  const rows = comps.map(c => ({
    code: c.company_code,
    name: c.business_name || null,
    type: c.company_type || null,
    zone_id: c.zone_id != null ? String(c.zone_id) : null,
    subzone_id: c.subzone_id != null ? String(c.subzone_id) : null,
    concept_id: c.concept_id != null ? String(c.concept_id) : null,
    zona: c.zone_id != null ? (zoneN[String(c.zone_id)] || null) : null,
    subzona: c.subzone_id != null ? (subN[String(c.subzone_id)] || null) : null,
    concepto: c.concept_id != null ? (conN[String(c.concept_id)] || null) : null,
  }));

  // Facetas encadenables (todo el universo permitido).
  const uniq = (arr) => [...new Map(arr.filter(x => x && x.id != null).map(x => [String(x.id), x])).values()];
  const facets = {
    types: [...new Set(rows.map(r => r.type).filter(Boolean))].sort(),
    companies: rows.map(r => ({ code: r.code, name: r.name, type: r.type,
      zone_id: r.zone_id, subzone_id: r.subzone_id, concept_id: r.concept_id }))
      .sort((a, b) => String(a.code).localeCompare(String(b.code))),
    zones: uniq(rows.map(r => r.zone_id != null ? { id: r.zone_id, name: r.zona } : null))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    subzones: uniq(rows.map(r => r.subzone_id != null ? { id: r.subzone_id, name: r.subzona, zone_id: r.zone_id } : null))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    concepts: uniq(rows.map(r => r.concept_id != null ? { id: r.concept_id, name: r.concepto } : null))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
  };

  // Aplicar el filtro pedido para devolver los codes objetivo.
  const F = body.filter || {};
  const codes = rows.filter(r =>
    (!F.type || r.type === F.type) &&
    (!F.company || r.code === F.company) &&
    (!F.zone || String(r.zone_id) === String(F.zone)) &&
    (!F.subzone || String(r.subzone_id) === String(F.subzone)) &&
    (!F.concept || String(r.concept_id) === String(F.concept))
  ).map(r => r.code);

  return json({ ok: true, facets, codes, total: codes.length });
}

function emptyFacets() {
  return { types: [], companies: [], zones: [], subzones: [], concepts: [] };
}

/* Compara el maestro del portal contra el ERP para las empresas dadas y arma
   la lista de diferencias por ficha. NO marca nada (dry-run).
   Para cada empresa: lee su roster del portal (store_workers/enterprise_workers
   segun tipo) para saber QUE cedulas pertenecen a esa empresa, cruza con el
   maestro (datos personales) y con el ERP (verdad remota), y reporta los campos
   que difieren. */
async function detectDiffs(env, actor, user, body) {
  if (!env.canaima_apikey) {
    return json({ ok: false, error: 'La clave del ERP no esta configurada en el servidor.' }, 500);
  }
  const companies = await detectTargetCompanies(env, actor, user, body);
  if (!companies.length) {
    return json({ ok: true, rows: [], scanned: 0, companies_ok: 0, companies_failed: [], message: 'No hay empresas en el alcance indicado.' });
  }

  const NON_STORE = new Set(['Importadora', 'Externa', 'Administrativa', 'Servicio', 'Tienda en l\u00ednea']);
  const diffs = [];            // filas de diferencias (una por ficha)
  const failed = [];           // empresas cuyo ERP no respondio
  const partial = [];          // empresas con respuesta sospechosamente parcial
  let scanned = 0, okCount = 0;
  let rosterTotal = 0, erpMatched = 0;   // cobertura del cruce

  for (const cc of companies) {
    // Tipo de empresa -> tabla de roster.
    const compRows = await sb(env, `companies?company_code=eq.${encodeURIComponent(cc)}&select=company_type`);
    const ctype = compRows && compRows[0] ? compRows[0].company_type : null;
    const table = NON_STORE.has(ctype) ? 'enterprise_workers' : 'store_workers';

    // Cedulas que pertenecen a esta empresa (roster local).
    const roster = await sb(env, `${table}?company_code=eq.${encodeURIComponent(cc)}&select=id_number`) || [];
    const ceds = [...new Set(roster.map(r => String(r.id_number)).filter(Boolean))];
    if (!ceds.length) { okCount++; continue; }

    // ERP de esta empresa.
    const erpMap = await erpRosterFor(env, cc);
    if (erpMap === null) { failed.push(cc); continue; }
    okCount++;

    // Cobertura: cuantas cedulas del roster local aparecen en el ERP. Si el ERP
    // devolvio muchas menos de las esperadas, la respuesta es PARCIAL (comun
    // cuando el sistema esta inestable) y comparar daria un "0 diferencias"
    // enganoso. Se marca como parcial para avisar y NO dar por confiable.
    const erpCount = Object.keys(erpMap).length;
    const matched = ceds.filter(c => erpMap[c]).length;
    rosterTotal += ceds.length;
    erpMatched += matched;
    // Umbral: si el ERP trajo menos del 60% del roster local, es sospechoso.
    if (ceds.length >= 3 && matched < Math.ceil(ceds.length * 0.6)) {
      partial.push({ company_code: cc, roster: ceds.length, erp: erpCount, matched });
    }

    // Maestro de esas cedulas (datos personales del portal).
    const inList = ceds.map(c => `"${c}"`).join(',');
    const masterSel = ['id_number', 'ced_kind', 'full_name', 'ax_pending', ...DETECT_FIELDS].join(',');
    const master = await sb(env, `workers_master?id_number=in.(${inList})&select=${masterSel}`) || [];

    for (const m of master) {
      const ced = String(m.id_number);
      const erp = erpMap[ced];
      if (!erp) continue;   // el ERP no lo trae -> no se compara
      scanned++;
      const fields = [];
      for (const f of DETECT_FIELDS) {
        const mv = masterComparableVal(f, m[f]);
        const ev = erp[f] != null ? String(erp[f]) : null;
        // REGLA: solo se reporta una diferencia cuando AMBOS lados tienen valor
        // y difieren. Los casos "uno vacio, el otro con dato" NO se listan aqui
        // (esos se resuelven con el Actualizar normal, no en esta deteccion).
        // Asi la lista queda limpia: solo discrepancias reales de dato.
        if (mv == null || ev == null) continue;   // alguno vacio -> no aplica
        if (String(mv) === String(ev)) continue;   // iguales -> no aplica
        fields.push({
          field: f,
          label: FIELD_LABEL[f] || f,
          erp: displayVal(f, ev),        // valor del ERP
          portal: displayVal(f, mv),     // valor del portal
          erp_raw: ev,                    // valor interno ERP (para 'traer')
          portal_raw: mv,                 // valor interno portal (para 'publicar')
        });
      }
      if (fields.length) {
        diffs.push({
          id_number: ced,
          ced_kind: m.ced_kind || null,
          full_name: m.full_name || null,
          company_code: cc,
          already_pending: !!m.ax_pending,
          fields,
          field_count: fields.length,
        });
      }
    }
  }

  return json({
    ok: true,
    rows: diffs,
    scanned,
    companies_ok: okCount,
    companies_failed: failed,
    companies_partial: partial,
    roster_total: rosterTotal,
    erp_matched: erpMatched,
    diff_count: diffs.length,
  });
}

/* Marca como PENDIENTES (origin='erp_detect') las fichas confirmadas tras el
   dry-run. Recibe body.items = [{ id_number, company_code, fields:[{field,
   portal_raw?}] }] o, mas simple, body.id_numbers + body.company_code y se
   vuelve a comparar en el server (mas seguro: no confia en el valor del front).
   Implementacion segura: re-detecta y marca solo lo que sigue difiriendo.

   Al marcar: setea ax_pending=true + ax_pending_fields (union con lo previo) en
   el maestro, y hace UPSERT en ax_change_set con origin='erp_detect' y
   changes={campo:{old:valorERP, new:valorPortal}}. */
async function detectCommit(env, actor, user, body) {
  // Re-detectar para no confiar en el front (fuente de verdad: server).
  const asked = Array.isArray(body.id_numbers)
    ? new Set(body.id_numbers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean))
    : null;
  // Reusar detectDiffs para el alcance, luego filtrar por las cedulas pedidas.
  const detectRes = await detectDiffs(env, actor, user, body);
  const detectJson = await detectRes.json();
  if (!detectJson.ok) return json(detectJson, 200);
  let rows = detectJson.rows || [];
  if (asked && asked.size) rows = rows.filter(r => asked.has(String(r.id_number)));
  if (!rows.length) {
    return json({ ok: true, marked: [], count: 0, message: 'No hay diferencias vigentes para marcar.' });
  }

  const rid = await actorAdminId(env, user);
  const nowIso = new Date().toISOString();
  const marked = [];

  for (const r of rows) {
    const ced = String(r.id_number);
    const cc = r.company_code;
    // Campos que difieren (nombres internos) + deltas old(ERP)->new(portal).
    // OJO: en detectDiffs 'erp' y 'portal' quedaron ya como texto legible; para
    // el change_set guardamos el VALOR INTERNO del portal en new (lo que se
    // publicara), y el del ERP en old (referencia). Releemos el maestro para
    // tomar el valor interno exacto.
    const fieldNames = r.fields.map(f => f.field);
    const inSel = ['id_number', 'ax_pending', 'ax_pending_fields', ...fieldNames].join(',');
    const mRows = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=${inSel}`);
    const m = mRows && mRows[0] ? mRows[0] : null;
    if (!m) continue;

    // ERP de nuevo (valor interno) para el old. Lo tomamos del texto ya
    // calculado en r.fields (erp es texto legible); para old guardamos el texto
    // del ERP tal cual (la pagina lo muestra; no se publica el old).
    const deltas = {};
    const pendFields = (m.ax_pending_fields && typeof m.ax_pending_fields === 'object') ? { ...m.ax_pending_fields } : {};
    for (const f of r.fields) {
      deltas[f.field] = { old: f.erp ?? null, new: m[f.field] != null && m[f.field] !== '' ? m[f.field] : null };
      pendFields[f.field] = true;
    }

    // Marcar el maestro como pendiente (union de campos).
    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ax_pending: true, ax_pending_fields: pendFields, ax_pending_at: nowIso }),
    });

    // UPSERT en ax_change_set (origin erp_detect). Si ya hay uno pending para
    // (ficha,empresa), acumular; si no, crear.
    const existing = await sb(env,
      `ax_change_set?id_number=eq.${encodeURIComponent(ced)}&company_code=eq.${encodeURIComponent(cc)}&status=eq.pending&select=id,changes&limit=1`);
    if (existing && existing.length) {
      const prev = (existing[0].changes && typeof existing[0].changes === 'object') ? existing[0].changes : {};
      const merged = { ...prev };
      for (const k of Object.keys(deltas)) {
        merged[k] = (merged[k] && Object.prototype.hasOwnProperty.call(merged[k], 'old'))
          ? { old: merged[k].old, new: deltas[k].new } : deltas[k];
      }
      await sb(env, `ax_change_set?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ changes: merged, changed_by: rid, changed_at: nowIso, origin: 'erp_detect' }),
      });
    } else {
      await sb(env, 'ax_change_set', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          id_number: ced, company_code: cc, changes: deltas, status: 'pending',
          changed_by: rid, changed_at: nowIso, origin: 'erp_detect',
        }),
      });
    }
    marked.push(ced);
  }

  return json({ ok: true, marked, count: marked.length });
}

/* ---------- ADOPT: traer el valor del SISTEMA al portal (sistema -> portal) ----------
   Para las fichas indicadas, re-detecta las diferencias y ESCRIBE en el maestro
   el valor del sistema (erp_raw) en cada campo que difiere. Es la direccion
   inversa de publish: el portal ADOPTA el dato del sistema.

   Efectos:
   - workers_master: se pisan los campos detectados con el valor del sistema
     (ya normalizado a codigo interno). El telefono se guarda en formato +58
     (como lo guarda el portal); el resto en su codigo.
   - ax_pending: los campos adoptados se QUITAN de ax_pending_fields (ya no hay
     nada que publicar de ellos; el portal quedo igual al sistema). Si no queda
     ningun campo pendiente, ax_pending pasa a false.
   - ax_change_set: si habia un pending para esa ficha, se marca 'discarded'
     (se resolvio adoptando; historial permanente).

   Modo: body.id_numbers (+ company_code/all para el alcance de la deteccion).
   Re-detecta en el server (no confia en el front). */
async function adopt(env, actor, user, body) {
  const asked = Array.isArray(body.id_numbers)
    ? new Set(body.id_numbers.map(x => String(x).replace(/[^0-9]/g, '')).filter(Boolean))
    : null;
  const detectRes = await detectDiffs(env, actor, user, body);
  const detectJson = await detectRes.json();
  if (!detectJson.ok) return json(detectJson, 200);
  let rows = detectJson.rows || [];
  if (asked && asked.size) rows = rows.filter(r => asked.has(String(r.id_number)));
  if (!rows.length) {
    return json({ ok: true, adopted: [], count: 0, message: 'No hay diferencias vigentes para adoptar.' });
  }

  const rid = await actorAdminId(env, user);
  const nowIso = new Date().toISOString();
  const adopted = [];

  for (const r of rows) {
    const ced = String(r.id_number);
    const cc = r.company_code;

    // Valor del sistema por campo -> como lo guarda el portal. El erp_raw ya
    // viene normalizado a codigo interno (S/C/D/V/O/R, M/F, YYYY-MM-DD, 20
    // digitos, correo minusculas, telefono 0XXXXXXXXXX). El telefono el maestro
    // lo guarda en +58; el resto igual.
    const patch = {};
    const adoptedFields = [];
    for (const f of r.fields) {
      let val = f.erp_raw;
      if (val == null || val === '') continue;
      if (f.field === 'phone') {
        // 0XXXXXXXXXX -> +58XXXXXXXXXX (formato del maestro).
        const nat = String(val).replace(/[^0-9]/g, '');
        val = /^0\d{10}$/.test(nat) ? '+58' + nat.slice(1) : String(val);
      }
      if (f.field === 'account_number') {
        patch.bank_code = String(val).slice(0, 4);
      }
      patch[f.field] = val;
      adoptedFields.push(f.field);
    }
    if (!adoptedFields.length) continue;

    // Leer el pendiente actual para quitar los campos adoptados.
    const mRows = await sb(env,
      `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=ax_pending_fields`);
    const prevPend = (mRows && mRows[0] && mRows[0].ax_pending_fields && typeof mRows[0].ax_pending_fields === 'object')
      ? { ...mRows[0].ax_pending_fields } : {};
    for (const f of adoptedFields) delete prevPend[f];
    const stillPending = Object.keys(prevPend).length > 0;
    patch.ax_pending = stillPending;
    patch.ax_pending_fields = prevPend;
    if (!stillPending) patch.ax_pending_at = null;

    await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    // Si habia un change_set pendiente para esta ficha, marcarlo discarded
    // (se resolvio adoptando el valor del sistema).
    const existing = await sb(env,
      `ax_change_set?id_number=eq.${encodeURIComponent(ced)}&company_code=eq.${encodeURIComponent(cc)}&status=eq.pending&select=id&limit=1`);
    if (existing && existing.length) {
      await sb(env, `ax_change_set?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'discarded', resolved_by: rid, resolved_at: nowIso }),
      });
    }
    adopted.push(ced);
  }

  return json({ ok: true, adopted, count: adopted.length });
}

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}

/* Miniatura publica del esquema por photo_key (mismo bucket que Personal:
   URL directa, cacheable, sin firmar). null si la ficha no tiene foto nueva. */
const PUBLIC_THUMB_BUCKET = 'worker-thumbs';
function thumbUrlPub(env, photoKey) {
  if (!photoKey) return null;
  return `${env.supabase_url}/storage/v1/object/public/${PUBLIC_THUMB_BUCKET}/${photoKey}.jpg`;
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

/* ---------- v4.79: filtro por CAMPO del jsonb changes ----------
   Para el grupo "Datos bancarios": sus menues Sincronizar e Historial son la
   MISMA maquinaria de aqui con un unico filtro fijo: solo change_sets que
   TOCAN ese campo. Los valores de changes son objetos {old,new} (nunca null),
   asi que "la clave existe" equivale en PostgREST a `changes->campo=not.is.null`.
   Lista blanca: jamas se interpola texto libre del cliente en la query. */
const FIELD_FILTER_WHITELIST = new Set(['account_number']);
function fieldFilterOf(body) {
  const f = body ? String(body.field_filter || '').trim() : '';
  return FIELD_FILTER_WHITELIST.has(f) ? f : null;
}

/* ---------- HISTORY: bitacora completa del alcance (v4.44) ----------
   Todo lo que paso por Sincronizar: pendientes, publicados y anulados
   (ax_change_set es historial permanente). Paginado SERVER-SIDE con count
   exacto, busqueda por cedula o nombre, filtros por estado/origen y orden
   por fecha. Enriquece nombre/foto (workers_master), razon social
   (companies) y quien resolvio (admin_users). */
async function listHistory(env, actor, user, body) {
  const allowed = await allowedCompanies(env, actor, user);
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const size = [25, 50, 100].includes(+body.page_size) ? +body.page_size : 50;
  const dir = body.dir === 'asc' ? 'asc' : 'desc';
  const status = ['pending', 'published', 'discarded'].includes(body.status) ? body.status : '';
  const origin = ['edit', 'erp_detect', 'auto_sync'].includes(body.origin) ? body.origin : '';
  const q = String(body.q || '').trim();

  const parts = [];
  if (status) parts.push(`status=eq.${status}`);
  if (origin) parts.push(`origin=eq.${origin}`);
  // v4.79: Datos bancarios -> solo sets que tocan la cuenta.
  const ffield = fieldFilterOf(body);
  if (ffield) parts.push(`changes->${ffield}=not.is.null`);
  // v4.65: filtros de ALCANCE como en el resto del portal (Tipo, Zona,
  // Subzona, Concepto, Tienda/Empresa). Se resuelven contra companies a una
  // lista de codigos y se intersectan con el alcance del actor (AND).
  const fType = String(body.ftype || '').trim();
  const fCompany = String(body.fcompany || '').trim();
  const fZone = String(body.fzone || '').trim();
  const fSub = String(body.fsubzone || '').trim();
  const fCon = String(body.fconcept || '').trim();
  if (fCompany) {
    parts.push(`company_code=eq.${encodeURIComponent(fCompany)}`);
  } else if (fType || fZone || fSub || fCon) {
    const cf = ['select=company_code', 'limit=1000'];
    if (fType) cf.push(`company_type=eq.${encodeURIComponent(fType)}`);
    if (fZone) cf.push(`zone_id=eq.${encodeURIComponent(fZone)}`);
    if (fSub) cf.push(`subzone_id=eq.${encodeURIComponent(fSub)}`);
    if (fCon) cf.push(`concept_id=eq.${encodeURIComponent(fCon)}`);
    const comps = await sb(env, `companies?${cf.join('&')}`) || [];
    let codes = comps.map(c => c.company_code);
    if (allowed !== null) codes = codes.filter(c => allowed.has(c));
    if (!codes.length) return json({ ok: true, rows: [], total: 0, page, page_size: size });
    parts.push(`company_code=in.(${codes.map(c => `"${c}"`).join(',')})`);
  }
  if (allowed !== null) {
    if (!allowed.size) return json({ ok: true, rows: [], total: 0, page, page_size: size });
    parts.push(`company_code=in.(${[...allowed].map(c => `"${c}"`).join(',')})`);
  }
  // Busqueda: solo digitos -> cedula (contiene); con letras -> nombre en el
  // maestro (ilike con comodines entre palabras) y se filtra por esas cedulas.
  if (q) {
    const digits = q.replace(/[^0-9]/g, '');
    if (digits && /^[0-9\s.\-]+$/.test(q)) {
      parts.push(`id_number=ilike.*${digits}*`);
    } else {
      const pat = '*' + q.replace(/\s+/g, '*') + '*';
      const wm = await sb(env,
        `workers_master?full_name=ilike.${encodeURIComponent(pat)}&select=id_number&limit=300`) || [];
      if (!wm.length) return json({ ok: true, rows: [], total: 0, page, page_size: size });
      parts.push(`id_number=in.(${wm.map(w => `"${w.id_number}"`).join(',')})`);
    }
  }

  const offset = (page - 1) * size;
  const path = `ax_change_set?select=id,id_number,company_code,changes,status,origin,changed_by,changed_at,resolved_by,resolved_at`
    + (parts.length ? '&' + parts.join('&') : '')
    + `&order=changed_at.${dir},id.${dir}&limit=${size}&offset=${offset}`;

  // Fetch directo (no sb()) para leer el count exacto del header Content-Range.
  const res = await fetch(`${env.supabase_url}/rest/v1/${path}`, {
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Accept-Profile': 'nomina_v2',
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const range = res.headers.get('content-range') || '';
  const total = parseInt(range.split('/')[1], 10) || 0;
  const sets = await res.json() || [];
  if (!sets.length) return json({ ok: true, rows: [], total, page, page_size: size });

  // Enriquecimientos (solo de la pagina).
  const ceds = [...new Set(sets.map(s => s.id_number))];
  const nameByCed = {};
  if (ceds.length) {
    const inList = ceds.map(c => `"${c}"`).join(',');
    const wm = await sb(env,
      `workers_master?id_number=in.(${inList})&select=id_number,full_name,ced_kind,photo_key`) || [];
    wm.forEach(w => { nameByCed[w.id_number] = w; });
  }
  const codes = [...new Set(sets.map(s => s.company_code))];
  const compByCode = {};
  if (codes.length) {
    const inList = codes.map(c => `"${c}"`).join(',');
    const comps = await sb(env,
      `companies?company_code=in.(${inList})&select=company_code,business_name`) || [];
    comps.forEach(c => { compByCode[c.company_code] = c.business_name || null; });
  }
  const resolverIds = [...new Set(sets.map(s => s.resolved_by).filter(x => x != null))];
  const resolverById = {};
  if (resolverIds.length) {
    const admins = await sb(env,
      `admin_users?id=in.(${resolverIds.join(',')})&select=id,name,username`) || [];
    admins.forEach(a => { resolverById[a.id] = a.name || a.username || ('admin#' + a.id); });
  }

  const rows = sets.map(s => {
    const ch = (s.changes && typeof s.changes === 'object') ? s.changes : {};
    const fields = Object.keys(ch).map(f => ({
      field: f,
      label: FIELD_LABEL[f] || f,
      old: displayVal(f, ch[f] ? ch[f].old : null),
      new: displayVal(f, ch[f] ? ch[f].new : null),
    }));
    const nm = nameByCed[s.id_number] || {};
    return {
      id: s.id,
      id_number: s.id_number,
      ced_kind: nm.ced_kind || null,
      full_name: nm.full_name || null,
      thumb_url: thumbUrlPub(env, nm.photo_key),
      company_code: s.company_code,
      company_name: compByCode[s.company_code] || null,
      status: s.status,
      origin: s.origin || 'edit',
      fields,
      field_count: fields.length,
      changed_by: s.changed_by != null
        ? (/^\d+$/.test(String(s.changed_by)) ? ('admin#' + s.changed_by) : String(s.changed_by))
        : null,
      changed_at: s.changed_at,
      resolved_by: s.resolved_by != null ? (resolverById[s.resolved_by] || ('admin#' + s.resolved_by)) : null,
      resolved_at: s.resolved_at,
    };
  });

  return json({ ok: true, rows, total, page, page_size: size });
}

/* ---------- LIST: change_set pendientes del alcance ---------- */
async function listPending(env, actor, user, body) {
  const allowed = await allowedCompanies(env, actor, user);
  // v4.79: Datos bancarios -> solo pendientes que tocan la cuenta.
  const ffield = fieldFilterOf(body);
  const ff = ffield ? `&changes->${ffield}=not.is.null` : '';

  // Traer los pendientes (filtrando por empresa si hay alcance acotado).
  let path = `ax_change_set?status=eq.pending${ff}&select=id,id_number,company_code,changes,changed_by,changed_at,origin&order=changed_at.desc`;
  if (allowed !== null) {
    if (!allowed.size) return json({ ok: true, rows: [], companies: [] });
    const inList = [...allowed].map(c => `"${c}"`).join(',');
    path = `ax_change_set?status=eq.pending${ff}&company_code=in.(${inList})&select=id,id_number,company_code,changes,changed_by,changed_at,origin&order=changed_at.desc`;
  }
  const sets = await sb(env, path) || [];
  if (!sets.length) return json({ ok: true, rows: [], companies: [] });

  // Enriquecer: nombre del trabajador (workers_master) y su foto (thumb).
  const ceds = [...new Set(sets.map(s => s.id_number))];

  let nameByCed = {};
  if (ceds.length) {
    const inList = ceds.map(c => `"${c}"`).join(',');
    const wm = await sb(env, `workers_master?id_number=in.(${inList})&select=id_number,full_name,ced_kind,photo_key`);
    (wm || []).forEach(w => { nameByCed[w.id_number] = { full_name: w.full_name, ced_kind: w.ced_kind, photo_key: w.photo_key || null }; });
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
      thumb_url: thumbUrlPub(env, nm.photo_key),
      company_code: s.company_code,
      company_name: cm.name || null,
      company_type: cm.type || null,
      zone_id: cm.zone_id || null,
      subzone_id: cm.subzone_id || null,
      concept_id: cm.concept_id || null,
      zona: cm.zone || null,
      subzona: cm.subzone || null,
      concepto: cm.concept || null,
      // v4.37: changed_by YA es la etiqueta legible del actor (texto). Si
      // quedara algun id numerico viejo sin mapear, se muestra como admin#N.
      changed_by: s.changed_by != null
        ? (/^\d+$/.test(String(s.changed_by)) ? ('admin#' + s.changed_by) : String(s.changed_by))
        : null,
      changed_at: s.changed_at,
      origin: s.origin || 'edit',
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
  // v4.79: si la accion viene del menu Datos bancarios, el universo de
  // "todo" se limita a los sets que tocan la cuenta (Publicar todo / Anular
  // todo desde alli JAMAS deben alcanzar sets de otros campos).
  const ffield = fieldFilterOf(body);
  if (ffield) path += `&changes->${ffield}=not.is.null`;
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

  // ECO: leer la ficha ACTUAL del sistema (1 GET por empresa) para armar
  // SIEMPRE el payload completo (los 9 campos): pendientes con el valor del
  // portal (traducido, en ingles los enums) y el resto devolviendo lo que el
  // sistema ya tiene. Sin eco NO se envia (mejor rechazar que ir a medias).
  const byCompany = {};
  targets.forEach(t => {
    const cc = t.company_code;
    (byCompany[cc] = byCompany[cc] || []).push(t);
  });
  const erpByCed = {};
  const erpFailed = new Set();
  for (const cc of Object.keys(byCompany)) {
    const m = await hcmRosterRaw(env, cc);
    if (m === null) { erpFailed.add(cc); continue; }
    Object.assign(erpByCed, m);
  }

  const clean = [];         // payloads AX (completos, con eco)
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
    if (erpFailed.has(t.company_code)) {
      rejected.push({ id_number: ced, reason: 'No se pudo leer la ficha actual del sistema (eco); no se envia sin eso.' });
      continue;
    }
    const erpRaw = erpByCed[ced];
    if (!erpRaw) {
      rejected.push({ id_number: ced, reason: 'El sistema no devolvio esta ficha (respuesta parcial); no se envia sin el eco.' });
      continue;
    }
    const fields = (m.ax_pending_fields && typeof m.ax_pending_fields === 'object') ? m.ax_pending_fields : {};
    const { payload, changed } = fullHcmPayload(m, fields, erpRaw);
    if (!changed) {
      rejected.push({ id_number: ced, reason: 'Sin campos validos para enviar (todo quedo vacio).' });
      continue;
    }
    clean.push(payload);
    okCeds.push(ced);
    okSetIds.push(t.id);
  }

  if (!clean.length) {
    return json({ ok: false, error: 'Ningun cambio paso la validacion para enviar a AX.', rejected }, 422);
  }

  /* ===== ENVIO FICHA POR FICHA (v5.11) =====
     Antes se mandaba UN POST con el array completo. Problema: la API responde
     un unico status para todo el lote, asi que un solo registro malo tumbaba
     las 87 fichas y encima el error no decia CUAL fallaba ("La API de AX
     respondio 500" y nada mas). Peor: quedaba todo sin publicar, incluidas las
     86 sanas.

     Ahora una llamada por ficha. Cuesta N requests en vez de 1, pero:
       - una ficha mala no arrastra al resto,
       - el error queda ATRIBUIDO a su cedula, con el texto que devolvio la API,
       - se puede publicar parcialmente (lo que entro, entro).

     Pausa entre envios: la API es SOAP+NTLM contra el ERP, no aguanta una
     rafaga. Se espacian los envios (SEND_GAP_MS) y ademas se corta si hay
     demasiados errores seguidos (probable caida del ERP: seguir seria golpear
     al muerto y tardar 87 timeouts en avisar).

     Limite de subrequests de Cloudflare (50/invocacion en el plan gratuito,
     1000 en el pago): el resto de la funcion ya consume varios. Se acota el
     lote por invocacion a MAX_PER_CALL y se avisa al front, que reintenta con
     lo que quedo pendiente. */
  const SEND_GAP_MS = 250;        // respiro entre fichas
  const MAX_FAILS_IN_ROW = 5;     // si el ERP se cayo, no seguir golpeando
  const MAX_PER_CALL = 40;        // margen para los subrequests de Cloudflare

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const okCedsSent = [];
  const okSetIdsSent = [];
  const failed = [];              // { id_number, status, detail }
  let failsInRow = 0;
  let aborted = null;             // motivo del corte, si hubo
  let lastAxResponse = null;

  const batch = clean.slice(0, MAX_PER_CALL);
  const deferred = clean.length > MAX_PER_CALL ? clean.length - MAX_PER_CALL : 0;

  for (let i = 0; i < batch.length; i++) {
    const payload = batch[i];
    const ced = okCeds[i];
    const setId = okSetIds[i];

    if (i > 0) await sleep(SEND_GAP_MS);

    let r;
    try {
      // La API espera un ARRAY aunque sea una sola ficha (mismo contrato).
      const res = await fetch(HCM_API, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-Key': env.canaima_apikey },
        body: JSON.stringify([payload]),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* no-json */ }
      r = { ok: res.ok, status: res.status, data, text };
    } catch (e) {
      r = { ok: false, status: 0, data: null, text: String(e.message || e) };
    }

    if (r.ok) {
      okCedsSent.push(ced);
      okSetIdsSent.push(setId);
      lastAxResponse = r.data ?? r.text ?? null;
      failsInRow = 0;
    } else {
      failsInRow++;
      failed.push({
        id_number: ced,
        status: r.status,
        // El texto CRUDO de la API: aca esta la razon real del rechazo. Antes
        // se perdia (el front solo mostraba "respondio 500").
        detail: (r.text || '').slice(0, 600) || null,
      });
      if (failsInRow >= MAX_FAILS_IN_ROW) {
        aborted = `Se corto el envio tras ${MAX_FAILS_IN_ROW} errores seguidos: el sistema parece no estar respondiendo. Lo que ya se envio quedo publicado.`;
        break;
      }
    }
  }

  // Nada entro y ademas nada se pudo enviar -> error duro (no hay que marcar).
  if (!okCedsSent.length) {
    return json({
      ok: false,
      error: aborted || 'El sistema rechazo todas las fichas. Ninguna se publico.',
      failed,
      failed_count: failed.length,
      rejected,
      deferred,
    }, 502);
  }

  const axRes = { ok: true, data: lastAxResponse, text: null };
  const okCedsFinal = okCedsSent;
  const okSetIdsFinal = okSetIdsSent;

  // Exito: marcar change_set como published (con resolved_by/at y ax_response),
  // y limpiar ax_pending del master de los enviados.
  const nowIso = new Date().toISOString();
  const rid = await actorAdminId(env, user);
  if (okSetIdsFinal.length) {
    const setList = okSetIdsFinal.join(',');
    await sb(env, `ax_change_set?id=in.(${setList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'published', resolved_by: rid, resolved_at: nowIso,
        ax_response: axRes.data ?? { text: axRes.text ?? null },
      }),
    });
  }
  if (okCedsFinal.length) {
    const okList = okCedsFinal.map(c => `"${c}"`).join(',');
    await sb(env, `workers_master?id_number=in.(${okList})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ax_pending: false, ax_pending_fields: {}, ax_pending_at: null, ax_synced_at: nowIso,
      }),
    });
  }

  // v4.67: reflejar lo publicado en los ROSTERS LOCALES (store_workers y
  // enterprise_workers), que son lo que muestran Buscar y los directorios.
  // Sin esto el portal seguia mostrando el dato viejo hasta el proximo pull
  // (bug YONATHAN 28321728: master y sistema corregidos, Buscar corrupto).
  // Solo se tocan los campos PUBLICADOS (ax_pending_fields, leidos en
  // masterByCed ANTES de la limpieza); si cambio algun nombre se recalcula
  // full_name = primer + segundo + apellidos. Errores aqui no rompen la
  // publicacion (el pull posterior corrige igual).
  for (const ced of okCedsFinal) {
    const m = masterByCed[ced];
    if (!m) continue;
    const pf = (m.ax_pending_fields && typeof m.ax_pending_fields === 'object') ? Object.keys(m.ax_pending_fields) : [];
    const patch = {};
    for (const f of pf) if (f in AX_FIELD_MAP && f !== 'address') patch[f] = m[f] ?? null;
    if (pf.some(f => f === 'first_name' || f === 'second_name' || f === 'last_names')) {
      const full = [m.first_name, m.second_name, m.last_names]
        .map(x => String(x || '').trim()).filter(Boolean).join(' ');
      if (full) patch.full_name = full;
    }
    if (!Object.keys(patch).length) continue;
    for (const tbl of ['store_workers', 'enterprise_workers']) {
      try {
        await sb(env, `${tbl}?id_number=eq.${encodeURIComponent(ced)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });
      } catch (_) { /* roster local: el proximo pull lo corrige */ }
    }
  }

  return json({
    ok: true,
    sent: okCedsFinal.length,
    published: okCedsFinal,
    rejected,
    rejected_count: rejected.length,
    /* v5.11: fichas que el SISTEMA rechazo, cada una con su cedula y el texto
       crudo que devolvio la API. Antes esto no existia: el lote entero moria
       con un "respondio 500" sin decir de quien. */
    failed,
    failed_count: failed.length,
    aborted,          // motivo del corte, si se corto por errores en cadena
    deferred,         // fichas que no entraron en esta tanda (reintentar)
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
    // v4.57: GATES REALES POR MATRIZ (dominio Sincronizacion ya NO es shadow;
    // permissions.enforced=true y la vista Roles lo muestra con badge).
    //   lecturas -> hcm.view · adopciones al portal -> hcm.sync ·
    //   publicar/anular en el sistema -> hcm.publish
    // superadmin siempre pasa por can(). El shadowCan queda como BITACORA de
    // uso (legacy=true tras pasar el gate; jamas rompe la accion).
    const AXR_CODE_BY_ACTION = {
      list: 'hcm.view', history: 'hcm.view', detect: 'hcm.view', detect_scope: 'hcm.view',
      detect_commit: 'hcm.sync', adopt: 'hcm.sync',
      publish: 'hcm.publish', discard: 'hcm.publish',
    };
    const NEED = AXR_CODE_BY_ACTION[action] || 'hcm.publish';
    if (!can(actor, NEED)) {
      const MSG = {
        'hcm.view': 'No tienes permiso para ver la sincronizacion.',
        'hcm.sync': 'No tienes permiso para adoptar cambios del sistema.',
        'hcm.publish': 'No tienes permiso para publicar o anular cambios.',
      };
      return json({ ok: false, error: MSG[NEED] || 'Sin permiso.' }, 403);
    }
    try { await shadowCan(env, user, 'ax-review', action, NEED, true); } catch (_) { /* bitacora, jamas rompe */ }

    if (action === 'list') return await listPending(env, actor, user, body);
    if (action === 'history') return await listHistory(env, actor, user, body);
    if (action === 'publish') return await publish(env, actor, user, body);
    if (action === 'discard') return await discard(env, actor, user, body);
    if (action === 'detect') return await detectDiffs(env, actor, user, body);
    if (action === 'detect_scope') return await detectScope(env, actor, user, body);
    if (action === 'detect_commit') return await detectCommit(env, actor, user, body);
    if (action === 'adopt') return await adopt(env, actor, user, body);

    return json({ ok: false, error: 'Accion no reconocida.' }, 400);
  } catch (e) {
    if (e instanceof AuthError) return json({ ok: false, error: e.message }, e.status);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}
