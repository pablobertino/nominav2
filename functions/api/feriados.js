/* =====================================================================
   functions/api/feriados.js  →  GET /api/feriados
   Consulta PUBLICA de feriados NACIONALES para otros portales del grupo
   (OMS, Extranet, etc.). Solo lectura, sin sesion: los feriados
   nacionales son informacion publica. Los bancarios NO se exponen aqui
   (para eso esta /api/holidays, de uso interno).

   Formas de uso (una por llamada):
     ?anio=2027                          → feriados del anio
     ?desde=2026-10-01&hasta=2027-03-31  → feriados del rango (max 3 anios)
     ?fecha=2026-12-24                   → si ese dia es feriado / domingo

   Respuesta:
     { ok, fuente, feriados: [{ fecha, nombre, movil }] }
     { ok, fecha, es_feriado, es_domingo, nombre }       (con ?fecha=)
   fuente: 'nominav2'  → todo salio de nomina_v2.feriado (es_nacional)
           'calculado' → ningun anio pedido estaba cargado; se calculo
           'mixto'     → algunos anios cargados y otros calculados
   Un anio sin filas en la tabla se completa con el calculo local (fijos
   LOTTT 184 + Ley de Fiestas Nacionales, y moviles via Pascua con el
   algoritmo Meeus/Jones/Butcher), asi el consumidor nunca recibe un anio
   vacio porque nadie apreto "Sugerir feriados".

   CORS: solo https://*.grupocanaima.com y nominav2.pages.dev. Llamadas
   servidor a servidor (sin Origin) se aceptan igual.
   Cache: 1 hora en el navegador/CDN.

   Secrets: supabase_url, supabase_service_role
   ===================================================================== */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*grupocanaima\.com$|^https:\/\/([a-z0-9-]+\.)?nominav2\.pages\.dev$/;
const MAX_ANIOS = 3;

// AAAA-MM-DD y ademas una fecha que exista (rechaza 2026-13-40, 2027-02-29).
function fechaValida(s) {
  if (!ISO_RE.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (origin && ORIGIN_RE.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(request, body, status = 200) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(request) };
  if (status === 200) headers['Cache-Control'] = 'public, max-age=3600';
  return new Response(JSON.stringify(body), { status, headers });
}

/* ---- Calculo local (mismo criterio que FERIADOS_VENEZUELA.md) ---- */
function pascua(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(anio, mes - 1, dia));
}
const FIJOS = [
  ['01-01', 'Año Nuevo'], ['04-19', 'Declaración de la Independencia'],
  ['05-01', 'Día del Trabajador'], ['06-24', 'Batalla de Carabobo'],
  ['07-05', 'Día de la Independencia'], ['07-24', 'Natalicio del Libertador'],
  ['10-12', 'Día de la Resistencia Indígena'], ['12-24', 'Nochebuena'],
  ['12-25', 'Navidad'], ['12-31', 'Fin de Año'],
];
const MOVILES = [[-48, 'Lunes de Carnaval'], [-47, 'Martes de Carnaval'], [-3, 'Jueves Santo'], [-2, 'Viernes Santo']];

function calcular(anio) {
  const p = pascua(anio);
  const out = FIJOS.map(([md, nombre]) => ({ fecha: `${anio}-${md}`, nombre, movil: false }));
  for (const [off, nombre] of MOVILES) {
    const x = new Date(p); x.setUTCDate(x.getUTCDate() + off);
    out.push({ fecha: x.toISOString().slice(0, 10), nombre, movil: true });
  }
  return out;
}

async function deTabla(env, anioDesde, anioHasta) {
  const res = await fetch(
    `${env.supabase_url}/rest/v1/feriado?es_nacional=eq.true&anio=gte.${anioDesde}&anio=lte.${anioHasta}` +
    '&select=fecha,nombre,movil,anio&order=fecha',
    {
      headers: {
        apikey: env.supabase_service_role,
        Authorization: `Bearer ${env.supabase_service_role}`,
        'Accept-Profile': 'nomina_v2',
      },
    });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

// Feriados de [anioDesde..anioHasta]: tabla si el anio esta cargado, si no calculo.
async function feriadosAnios(env, anioDesde, anioHasta) {
  const filas = await deTabla(env, anioDesde, anioHasta);
  const cargados = new Set(filas.map(r => r.anio));
  const out = filas.map(r => ({ fecha: r.fecha, nombre: r.nombre, movil: !!r.movil }));
  let calculados = 0;
  for (let y = anioDesde; y <= anioHasta; y++) {
    if (!cargados.has(y)) { out.push(...calcular(y)); calculados++; }
  }
  const total = anioHasta - anioDesde + 1;
  const fuente = calculados === 0 ? 'nominav2' : calculados === total ? 'calculado' : 'mixto';
  out.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
  return { fuente, feriados: out };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  try {
    // ---- ?fecha=AAAA-MM-DD ----
    if (q.has('fecha')) {
      const fecha = q.get('fecha');
      if (!fechaValida(fecha)) return json(request, { ok: false, error: 'fecha invalida (AAAA-MM-DD).' }, 400);
      const anio = parseInt(fecha.slice(0, 4), 10);
      const { fuente, feriados } = await feriadosAnios(env, anio, anio);
      const hits = feriados.filter(f => f.fecha === fecha);
      const [y, m, d] = fecha.split('-').map(Number);
      return json(request, {
        ok: true, fuente, fecha,
        es_feriado: hits.length > 0,
        es_domingo: new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0,
        nombre: hits.map(h => h.nombre).join(' / ') || null,
      });
    }

    // ---- ?desde=&hasta= ----
    if (q.has('desde') || q.has('hasta')) {
      const desde = q.get('desde'), hasta = q.get('hasta');
      if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) {
        return json(request, { ok: false, error: 'desde/hasta invalidos (AAAA-MM-DD, desde <= hasta).' }, 400);
      }
      const y1 = parseInt(desde.slice(0, 4), 10), y2 = parseInt(hasta.slice(0, 4), 10);
      if (y2 - y1 + 1 > MAX_ANIOS) return json(request, { ok: false, error: `Rango maximo: ${MAX_ANIOS} anios.` }, 400);
      const { fuente, feriados } = await feriadosAnios(env, y1, y2);
      return json(request, { ok: true, fuente, desde, hasta, feriados: feriados.filter(f => f.fecha >= desde && f.fecha <= hasta) });
    }

    // ---- ?anio= (por defecto el actual) ----
    const anio = q.has('anio') ? parseInt(q.get('anio'), 10) : new Date().getUTCFullYear();
    if (!Number.isInteger(anio) || anio < 1583 || anio > 9999) {
      return json(request, { ok: false, error: 'anio invalido.' }, 400);
    }
    const { fuente, feriados } = await feriadosAnios(env, anio, anio);
    return json(request, { ok: true, fuente, anio, feriados });
  } catch (err) {
    return json(request, { ok: false, error: err.message }, 500);
  }
}
