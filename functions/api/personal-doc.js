/* =====================================================================
   functions/api/personal-doc.js — Documentos personales (PDF) de la ficha.
   Modelo GENERAL y escalable: una tabla nomina_v2.personal_documents con
   doc_type ('rif' hoy; otros a futuro) + datos jsonb con los campos propios
   de cada tipo. El PDF se extrae en el NAVEGADOR (pdfjs); aqui solo se guarda:
   el archivo al bucket privado 'personal-docs' y una fila en la tabla.

   NO reemplaza ningun dato de la ficha (la cedula NO se toca). Las
   advertencias viven en validaciones (jsonb) y persisten hasta corregir o
   cambiar el PDF. La referencia bancaria sigue en su propio endpoint
   (bank-ref.js / bank_references); esto arranca con el RIF.

   Acciones:
     save  (rif.upload)  : sube el PDF + inserta el documento (pendiente)
     list  (view.fotos)  : lista los documentos de un trabajador (recientes 1o)
     sign  (view.fotos)  : firma la URL de un PDF de respaldo (1h)
     annul (rif.upload)  : marca un documento como anulado (al reemplazar)
   ===================================================================== */
import { resolveActor, can } from './_auth.js';

const BUCKET = 'personal-docs';
const SIGNED_TTL = 60 * 60;   // 1h
const MAX_BYTES = 10 * 1024 * 1024;

// Permiso de ESCRITURA por tipo de documento. Escalable: al sumar un tipo
// nuevo se agrega aqui su permiso (o se reutiliza uno existente). Lectura
// (list/sign) se permite desde la ficha con view.fotos.
const WRITE_CODE = {
  rif: ['rif.upload'],
  cedula: ['cedula.upload'],
};
const READ_CODE = ['view.fotos'];
const REMOVE_CODE = ['docs.remove'];   // quitar/anular un documento (correccion)

const DOC_TYPES = new Set(Object.keys(WRITE_CODE));

// Formatos permitidos y extension por tipo de documento. El RIF es PDF; la
// cedula es imagen (se recorta/comprime en el navegador y llega como JPG).
const TYPE_MIME = {
  rif:    { ext: { 'application/pdf': 'pdf' }, def: 'application/pdf' },
  cedula: { ext: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }, def: 'image/jpeg' },
};
function resolveMime(docType, wanted) {
  const t = TYPE_MIME[docType] || TYPE_MIME.rif;
  const m = String(wanted || '').toLowerCase();
  if (t.ext[m]) return { mime: m, ext: t.ext[m] };
  return { mime: t.def, ext: t.ext[t.def] };
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

/* Trae TODAS las filas, no las primeras 1000.                     (v6.260)

   PostgREST corta en 1000 y no avisa: devuelve un array corto y valido. Las
   dos herramientas de re-proceso de abajo pedian todos los RIF ordenados por
   fecha DESC y filtraban en memoria, asi que al pasar de 1000 documentos los
   que se caian de la lista eran los MAS VIEJOS — justo los incompletos, que
   son viejos porque el parser de entonces sabia menos. La herramienta habria
   dicho "listo, 0 pendientes" con los pendientes intactos.

   Se pagina hasta que una pagina viene corta. El orden lo pone quien llama y
   debe incluir un desempate estable (id), o una fila puede repetirse o
   saltearse entre paginas.

   POR QUE 500 Y NO 1000. La condicion de fin -"una pagina corta es la
   ultima"- solo vale si el servidor nunca devuelve menos de `pagina` teniendo
   mas filas. Con pagina=1000 y el tope de PostgREST tambien en 1000 el margen
   es cero: si alguien baja db-max-rows a 500, la primera pagina viene corta y
   sbTodo se va convencido de haber leido todo. Seria el mismo truncado
   silencioso, con otro numero.

   FRENO POR PAGINAS, NO POR FILAS. Cada pagina es un subrequest y en Workers
   Free hay 50 por invocacion. Si se llega al tope se avisa por consola en vez
   de devolver un total corto en silencio. */
async function sbTodo(env, path, pagina = 500, maxPaginas = 8) {
  const todo = [];
  for (let p = 0; p < maxPaginas; p++) {
    const sep = path.includes('?') ? '&' : '?';
    const lote = await sb(env, `${path}${sep}limit=${pagina}&offset=${p * pagina}`) || [];
    todo.push(...lote);
    if (lote.length < pagina) return todo;
  }
  console.warn(`[sbTodo] TRUNCADO en ${todo.length} filas (${maxPaginas} paginas): ${path}`);
  return todo;
}

async function storageUpload(env, path, bytes, mime) {
  const res = await fetch(`${env.supabase_url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.supabase_service_role,
      Authorization: `Bearer ${env.supabase_service_role}`,
      'Content-Type': mime || 'application/pdf',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${await res.text()}`);
  return true;
}

async function storageSignedUrl(env, path, intentos = 3) {
  if (!path) return null;
  for (let attempt = 0; attempt < intentos; attempt++) {
    try {
      const res = await fetch(`${env.supabase_url}/storage/v1/object/sign/${BUCKET}/${path}`, {
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
    if (attempt < intentos - 1) await new Promise(r => setTimeout(r, 120 * (attempt + 1)));
  }
  return null;
}

/* ---------- El techo de 50 subrequests, y por que se trabaja por bloques ----
                                                                     (v6.261)
   Cloudflare Workers en plan Free permite 50 subrequests (fetch) POR
   INVOCACION. No es por segundo: ir mas lento no cambia nada, el contador no
   se reinicia con el tiempo. Lo unico que reinicia el presupuesto es una
   invocacion nueva, o sea otro pedido HTTP.

   Asi se descubrio: la herramienta de re-proceso firmaba las URLs de a una
   dentro de un for. Con 249 documentos pendientes entregaba 47 y los otros
   202 desaparecian sin dejar rastro -la excepcion del tope la comia el catch
   del reintento-. Dos corridas seguidas dieron 47 clavado: 2 de resolveActor
   + 1 de la consulta + 47 firmas = 50. Un techo, no un azar.

   LA FORMA DE TRABAJAR QUE SE ADOPTA. Cada endpoint atiende un BLOQUE con un
   presupuesto que se puede contar con los dedos, y el navegador encadena los
   bloques. Se separa "que falta" (una consulta, sin firmar nada) de "dame las
   URLs de estos 40". Ningun handler se acerca al techo y el que lo hiciera se
   nota en la cuenta, no en un numero raro tres semanas despues.

   Se evaluo firmar en lote con POST /object/sign/<bucket>, que hace 250
   firmas en 3 subrequests. Se descarto: obliga a emparejar cada URL devuelta
   con su documento comparando rutas, y un emparejamiento mal hecho le muestra
   a una persona el PDF de otra. Con bloques ese problema no existe: se firma
   de a uno, en orden, y cada URL sale con el documento en la mano. */
const BLOQUE_FIRMAS = 40;

function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const norm = s => String(s == null ? '' : s).trim();
function cleanDigits(s, max) { const d = String(s || '').replace(/\D/g, ''); return max ? d.slice(0, max) : d; }
function safeDocType(t) { const v = norm(t) || 'rif'; return DOC_TYPES.has(v) ? v : null; }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalido.' }, 400); }

  const action = norm(body.action);
  const known = (action === 'save' || action === 'annul' || action === 'list' || action === 'sign'
    || action === 'fiscal_pending' || action === 'fiscal_set_bulk'
    || action === 'reparse_pending' || action === 'reparse_sign'
    || action === 'reparse_save_bulk');
  if (!known) return json({ ok: false, error: 'Accion no valida.' }, 400);

  const actor = await resolveActor(env, body.user);
  if (!actor) return json({ ok: false, error: 'Sesion no valida.' }, 403);

  // save: permiso de carga segun el tipo. annul: permiso de QUITAR (docs.remove).
  // list/sign: lectura desde la ficha.
  let codes;
  if (action === 'save') {
    const dt = safeDocType(body.doc_type);
    if (!dt) return json({ ok: false, error: 'Tipo de documento no valido.' }, 400);
    codes = WRITE_CODE[dt];
  } else if (action === 'annul') {
    codes = REMOVE_CODE;
  } else if (action === 'reparse_pending' || action === 'reparse_sign'
          || action === 'reparse_save_bulk') {
    /* El permiso sale del TIPO pedido, no fijo en rif.                v6.261

       Antes estas tres acciones pedian siempre WRITE_CODE.rif mientras el
       handler aceptaba body.doc_type sin validar. Con rif.upload -un permiso
       normal, asignable por rol- se podia pedir la lista de CEDULAS y despues
       sus URLs firmadas: dos requests para bajar documentos cuyo permiso
       propio (cedula.upload) el rol podia no tener. Ahora el tipo se valida
       una vez, decide el permiso, y viaja al handler que filtra por el. */
    const dt = safeDocType(body.doc_type) || 'rif';
    if (!WRITE_CODE[dt]) return json({ ok: false, error: 'Tipo de documento no valido.' }, 400);
    body.doc_type = dt;
    codes = WRITE_CODE[dt];
  } else if (action === 'fiscal_pending' || action === 'fiscal_set_bulk') {
    // Relleno masivo de Dirección Fiscal desde los RIF ya cargados (v6.128).
    codes = WRITE_CODE.rif;
  } else {
    codes = READ_CODE;
  }
  if (!codes.some(c => can(actor, c))) return json({ ok: false, error: 'No tienes permiso para esta accion.' }, 403);

  try {
    if (action === 'save')  return await saveDoc(env, actor, body);
    if (action === 'list')  return await listDocs(env, body);
    if (action === 'sign')  return await signDoc(env, body);
    if (action === 'annul') return await annulDoc(env, body);
    if (action === 'fiscal_pending')  return await fiscalPending(env, body);
    if (action === 'fiscal_set_bulk') return await fiscalSetBulk(env, body);
    if (action === 'reparse_pending')   return await reparsePending(env, body);
    if (action === 'reparse_sign')      return await reparseSign(env, body);
    if (action === 'reparse_save_bulk') return await reparseSaveBulk(env, body);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
  return json({ ok: false, error: 'Accion no valida.' }, 400);
}

/* ---------- save: guarda PDF + fila (estado pendiente) ---------- */
async function saveDoc(env, actor, body) {
  const idNumber = cleanDigits(body.id_number);
  const docType = safeDocType(body.doc_type);
  if (!idNumber) return json({ ok: false, error: 'Falta la cedula del trabajador.' }, 400);
  if (!docType)  return json({ ok: false, error: 'Tipo de documento no valido.' }, 400);
  if (!body.pdf_base64) return json({ ok: false, error: 'Falta el PDF.' }, 400);

  const bytes = b64ToBytes(body.pdf_base64);
  if (!bytes.length) return json({ ok: false, error: 'El PDF llego vacio.' }, 400);
  if (bytes.length > MAX_BYTES) return json({ ok: false, error: 'El PDF supera 10 MB.' }, 400);

  const { mime, ext } = resolveMime(docType, body.mime);
  const storagePath = `${docType}/${idNumber}/${Date.now()}.${ext}`;
  await storageUpload(env, storagePath, bytes, mime);

  const row = {
    id_number: idNumber,
    doc_type: docType,
    estado: 'pendiente',
    datos: (body.datos && typeof body.datos === 'object') ? body.datos : {},
    validaciones: (body.validaciones && typeof body.validaciones === 'object') ? body.validaciones : {},
    storage_path: storagePath,
    uploaded_by: String(actor.actor || ''),
  };

  const ins = await sb(env, 'personal_documents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const saved = Array.isArray(ins) ? ins[0] : ins;

  // v6.126: si es un RIF con domicilio, se guarda en workers_master.fiscal_address
  // (campo "Dirección Fiscal", NO editable). NO toca la Dirección Personal
  // (address): eso lo decide el usuario con el botón "Copiar de la fiscal".
  // Best-effort: un fallo aquí no debe romper el guardado del RIF.
  if (docType === 'rif') {
    const fiscal = (row.datos && typeof row.datos.domicilio_fiscal === 'string')
      ? row.datos.domicilio_fiscal.trim() : '';
    if (fiscal) {
      try {
        await sb(env, `workers_master?id_number=eq.${encodeURIComponent(idNumber)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ fiscal_address: fiscal }),
        });
      } catch (_) { /* no romper el guardado del RIF */ }
    }
  }

  const signed = await storageSignedUrl(env, storagePath);
  return json({ ok: true, document: saved, signed_url: signed });
}

/* ---------- fiscal_pending: RIF activos SIN dirección fiscal (v6.128) ----------
   Para el relleno masivo. Devuelve, por persona con RIF no anulado cuyo
   workers_master.fiscal_address está vacío, el id del RIF MÁS RECIENTE.

   v6.261: ya NO firma nada. Las URLs se piden despues por reparse_sign, de a
   bloques de 40, porque firmar aca era lo que reventaba el techo de 50
   subrequests del plan Free. */
/* =====================================================================
   reparse_pending / reparse_save_bulk  (v6.235)

   Vuelve a leer PDF ya guardados con el parser actual. Existe porque el
   parser mejora y las filas viejas se quedan con lo que se supo el dia que
   se subieron: 89 RIF cargados entre el 23 y el 26 de julio quedaron sin
   nombre y sin domicilio, y sus PDF se leen perfecto hoy. No es un problema
   de esos documentos: es que nadie los volvio a mirar.

   Mismo patron que fiscal_pending (v6.128): el servidor manda URLs firmadas
   y el navegador parsea con pdf.js -el mismo lector que uso al subirlos, asi
   que el resultado es identico al de volver a cargarlos a mano-.

   MERGE, NO REEMPLAZO: se conservan las claves viejas que el parser nuevo no
   devuelva. Un re-proceso nunca debe borrar informacion que ya estaba.
   ===================================================================== */
async function reparsePending(env, body) {
  /* safeDocType, no norm(): el gate ya eligio el permiso a partir de este
     mismo tipo, asi que si aca se aceptara cualquier cosa el permiso de un
     tipo serviria para listar otro. */
  const tipo = safeDocType(body.doc_type) || 'rif';
  const rows = await sbTodo(env,
    `personal_documents?doc_type=eq.${encodeURIComponent(tipo)}&estado=neq.anulada`
    + '&select=id,id_number,storage_path,datos,created_at&order=created_at.desc,id.desc');

  /* Solo los que les FALTA algo. Re-leer los 585 para arreglar 89 seria
     media hora de descargas para el navegador de alguien. */
  const faltan = rows.filter(r => {
    if (!r.storage_path) return false;
    const d = r.datos || {};
    const vacio = (k) => !d[k] || !String(d[k]).trim();
    return vacio('nombre_pdf') || vacio('domicilio_fiscal');
  });

  /* Devuelve la LISTA, no las URLs. Firmar aca era lo que reventaba el techo.
     Cuesta 1 subrequest para cualquier cantidad de pendientes, asi que el
     total que informa es el total de verdad. Las URLs se piden despues, de a
     bloques, con reparse_sign.

     Van solo id e id_number: el storage_path no tiene por que viajar al
     navegador, y sin el no se puede pedir un archivo que no corresponda. */
  return json({
    ok: true,
    items: faltan.map(r => ({ id: r.id, id_number: r.id_number })),
    total: faltan.length,
    bloque: BLOQUE_FIRMAS,
  });
}

/* ---------- reparse_sign: URLs firmadas para UN bloque         (v6.261) ----
   Recibe hasta 40 ids y devuelve sus URLs firmadas. Presupuesto:
   ~4 de resolveActor + 1 consulta + 40 firmas = 45, contra el techo de 50.

   Un solo intento por firma, a proposito. Con los 3 reintentos que usa el
   firmador cuando se lo llama suelto, 40 rutas fallando costarian 120
   subrequests y volveriamos al problema. Lo que no se pudo firmar se informa
   en sin_archivo y se reintenta en la proxima corrida, que es gratis. */
async function reparseSign(env, body) {
  const tipo = safeDocType(body.doc_type) || 'rif';
  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .map(x => parseInt(x, 10)).filter(Boolean).slice(0, BLOQUE_FIRMAS);
  if (!ids.length) return json({ ok: true, items: [], sin_archivo: 0, no_hallados: 0 });

  /* El filtro por doc_type NO es decorativo: es lo que impide que el permiso
     de un tipo de documento sirva para bajar otro. Los id son enteros
     correlativos, asi que sin esto alcanzaba con iterarlos. */
  const rows = await sb(env,
    `personal_documents?id=in.(${ids.join(',')})`
    + `&doc_type=eq.${encodeURIComponent(tipo)}&estado=neq.anulada`
    + `&select=id,id_number,storage_path&limit=${ids.length}`) || [];

  const items = [];
  const sinArchivo = [];
  for (const r of rows) {
    const url = r.storage_path ? await storageSignedUrl(env, r.storage_path, 1) : null;
    if (url) items.push({ id: r.id, id_number: r.id_number, signed_url: url });
    else sinArchivo.push(r.id_number);
  }
  return json({
    ok: true, items,
    sin_archivo: sinArchivo.length,
    /* Ids que no volvieron de la consulta: anulados o borrados entre que se
       pidio la lista y se pidieron las URLs. Sin este numero se veian como
       una resta inexplicable en "revisados". */
    no_hallados: ids.length - rows.length,
    sin_archivo_cedulas: sinArchivo.slice(0, BLOQUE_FIRMAS),
  });
}

async function reparseSaveBulk(env, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ ok: true, updated: 0 });

  /* Tope de 40 por llamada. Cada item cuesta 1 PATCH, mas 1 lectura para
     todos juntos y hasta 4 de resolveActor (admin_users + roles +
     role_permissions + permissions con cache frio; superadmin gasta 2): 45
     subrequests contra el techo de 50 del plan Free. El margen es 5, no 7 —
     no subir este numero. Con los 50 de antes -y una lectura POR item, o sea 100
     subrequests- la tanda moria a mitad de camino: las primeras ~24 filas ya
     escritas, excepcion despues, y el cliente contando 0 guardados para una
     tanda que si habia escrito. Contar de menos algo que se guardo es peor
     que no guardarlo. */
  const tipo = safeDocType(body.doc_type) || 'rif';
  const tanda = items.slice(0, BLOQUE_FIRMAS);

  const ids = tanda.map(it => parseInt(it.id, 10)).filter(Boolean);
  if (!ids.length) return json({ ok: true, updated: 0, recibidos: items.length });

  /* Una sola lectura para toda la tanda, no una por fila. Filtrada por tipo:
     esta accion escribe `datos` y no puede alcanzar documentos de un tipo
     cuyo permiso el actor no tiene. */
  const cur = await sb(env,
    `personal_documents?id=in.(${ids.join(',')})`
    + `&doc_type=eq.${encodeURIComponent(tipo)}&estado=neq.anulada`
    + `&select=id,datos&limit=${ids.length}`) || [];
  const previos = new Map(cur.map(r => [r.id, r.datos || {}]));

  let updated = 0, fallidos = 0;
  for (const it of tanda) {
    const id = parseInt(it.id, 10);
    /* Solo los que la consulta filtrada devolvio. Un id de otro tipo de
       documento no esta en `previos` y no se toca. */
    if (!id || !previos.has(id) || !it.datos || typeof it.datos !== 'object') continue;
    const viejo = previos.get(id) || {};

    // Merge: lo nuevo pisa, pero solo si trae valor. Nunca se borra.
    const nuevo = { ...viejo };
    for (const [k, v] of Object.entries(it.datos)) {
      if (v !== null && v !== undefined && String(v).trim() !== '') nuevo[k] = v;
    }
    /* Cada PATCH en su propio try. sb() lanza ante cualquier respuesta que no
       sea 2xx, y sin esto UN solo PATCH fallido abortaba el for entero: hasta
       39 filas ya escritas, 500 al cliente, y el cliente sumando 0. Es el
       mismo modo de falla que veniamos persiguiendo, con otra causa.

       return=representation para contar filas REALMENTE tocadas: PostgREST
       responde 204 sin error cuando el filtro no matchea nada, asi que un
       `updated++` incondicional contaba ids inexistentes como recuperados. */
    try {
      const res = await sb(env, `personal_documents?id=eq.${id}&select=id`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ datos: nuevo, updated_at: new Date().toISOString() }),
      });
      if (Array.isArray(res) && res.length) updated++; else fallidos++;
    } catch (_) { fallidos++; }
  }
  return json({ ok: true, updated, fallidos, recibidos: items.length, procesados: tanda.length });
}

async function fiscalPending(env, body) {
  const rifs = await sbTodo(env,
    'personal_documents?doc_type=eq.rif&estado=neq.anulada'
    + '&select=id,id_number,storage_path,created_at&order=created_at.desc,id.desc');
  const latest = new Map();   // id_number -> RIF más reciente con path
  for (const r of rifs) {
    if (!r.id_number || !r.storage_path) continue;
    if (!latest.has(r.id_number)) latest.set(r.id_number, r);
  }
  const ids = [...latest.keys()];
  if (!ids.length) return json({ ok: true, items: [], total: 0 });

  const inList = ids.map(c => `"${c}"`).join(',');
  /* Tambien paginado: si esta lista viniera cortada, las personas que SI
     tienen direccion fiscal caerian del lado de "les falta" y el backfill
     volveria a escribir encima de una direccion ya corregida a mano. */
  const masters = await sbTodo(env,
    `workers_master?id_number=in.(${inList})&select=id_number,fiscal_address`
    + '&order=id_number.asc');
  const hasFiscal = new Set((masters || [])
    .filter(m => m.fiscal_address && String(m.fiscal_address).trim())
    .map(m => m.id_number));

  /* Igual que reparse_pending: la lista, sin firmar. Las URLs salen despues
     por reparse_sign, que es el mismo endpoint para las dos herramientas. */
  const picks = ids.filter(id => !hasFiscal.has(id)).map(id => latest.get(id));
  return json({
    ok: true,
    items: picks.map(p => ({ id: p.id, id_number: p.id_number })),
    total: picks.length,
    bloque: BLOQUE_FIRMAS,
  });
}

/* ---------- fiscal_set_bulk: guarda las direcciones fiscales leídas (v6.128) ----
   { items: [{ id_number, fiscal_address }] } -> workers_master.fiscal_address.
   Solo escribe fiscal_address; NO toca la Dirección Personal (address). */
async function fiscalSetBulk(env, body) {
  const items = Array.isArray(body.items) ? body.items : [];

  /* Tope de 40, igual que reparse_save_bulk. Antes no habia ninguno y el
     cliente mandaba las 250 de una: 250 PATCH contra un techo de 50
     subrequests. A partir del #50 cada fetch tiraba, la excepcion la comia el
     catch de "seguir con los demas", y devolvia {ok:true, updated:46}. El
     usuario leia "46 completadas de 250" y las otras 204 no se escribian.
     Sin error, sin rastro, con el numero mal. */
  const tanda = items.slice(0, BLOQUE_FIRMAS);

  let updated = 0, fallidos = 0, noEncontrados = 0;
  for (const it of tanda) {
    const ced = cleanDigits(it && it.id_number);
    const fiscal = norm(it && it.fiscal_address);
    if (!ced || !fiscal) continue;
    try {
      // return=representation: cuenta filas tocadas, no requests sin excepcion.
      const res = await sb(env, `workers_master?id_number=eq.${encodeURIComponent(ced)}&select=id_number`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ fiscal_address: fiscal }),
      });
      if (Array.isArray(res) && res.length) updated++;
      /* 0 filas = esa cedula no esta en workers_master. Antes no sumaba a
         nada: el PDF se bajaba y parseaba en cada corrida, para siempre, y el
         mensaje final no lo mencionaba. Un hueco entre "completadas" y
         "revisadas" que nadie podia explicar. */
      else noEncontrados++;
    } catch (_) { fallidos++; }
  }
  return json({ ok: true, updated, fallidos, no_encontrados: noEncontrados,
                recibidos: items.length, procesados: tanda.length });
}

/* ---------- list: documentos de un trabajador (por tipo si se indica) ---------- */
async function listDocs(env, body) {
  const idNumber = cleanDigits(body.id_number);
  if (!idNumber) return json({ ok: false, error: 'Falta la cedula.' }, 400);
  const dt = norm(body.doc_type);
  const typeFilter = (dt && DOC_TYPES.has(dt)) ? `&doc_type=eq.${encodeURIComponent(dt)}` : '';
  const rows = await sb(env,
    `personal_documents?id_number=eq.${encodeURIComponent(idNumber)}${typeFilter}`
    + `&order=created_at.desc&select=*`);
  return json({ ok: true, documents: rows || [] });
}

/* ---------- sign: firma la URL del PDF ---------- */
async function signDoc(env, body) {
  const path = norm(body.storage_path);
  if (!path) return json({ ok: false, error: 'Falta la ruta del PDF.' }, 400);
  const url = await storageSignedUrl(env, path);
  if (!url) return json({ ok: false, error: 'No se pudo firmar la URL del PDF.' }, 502);
  return json({ ok: true, signed_url: url });
}

/* ---------- annul: marca un documento como anulado (al reemplazar) ---------- */
async function annulDoc(env, body) {
  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: 'Falta el id del documento.' }, 400);
  await sb(env, `personal_documents?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ estado: 'anulada', updated_at: new Date().toISOString() }),
  });
  return json({ ok: true });
}
