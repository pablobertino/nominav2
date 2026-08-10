/* =====================================================================
   functions/api/_contacto.js  —  MODULO COMPARTIDO (no es una ruta)
   Validadores de TELEFONO y CORREO de los datos que llegan de AX.

   POR QUE EXISTE (v6.184):
   estas dos funciones vivian sueltas dentro de sync-roster.js, que es el
   camino de las TIENDAS. El camino de las EMPRESAS (ax-roster.js) no las
   tenia, y ademas arrastraba un comentario que decia "la API no trae
   telefono ni correo" — falso desde que se carga por API, pero nadie lo
   volvio a mirar. Resultado medido el 06/08/2026:

       TIENDAS  (pasan por el relleno)    73,0% con telefono · 51,5% con correo
       EMPRESAS (no pasaban)              18,1% con telefono ·  4,9% con correo

   O sea: el mismo dato llegaba y un camino lo guardaba y el otro lo tiraba.
   La causa de fondo no fue el comentario viejo sino que el MISMO
   CONOCIMIENTO estaba escrito en dos lados y solo uno se mantuvo al dia.
   Por eso ahora vive en un solo archivo y los dos lo importan.
   ===================================================================== */

/* Textos que AX manda como "vacio" y no hay que tomar por dato. */
const SENTINELS = new Set(['', '-', '--', 'n/a', 'na', 'null', 'none', 'sin', 'sin dato', 'sin datos', '.']);

export const clean = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s || SENTINELS.has(s.toLowerCase())) return null;
  return s;
};

/* Operadoras moviles de Venezuela. Un numero fuera de esta lista no es un
   movil valido y no se guarda. */
export const VE_PREFIXES = new Set(['0412', '0414', '0416', '0422', '0424', '0426']);

/* TELEFONO -> formato nacional de 11 digitos (04121234567) o null.
   Acepta las formas en que AX lo manda: con +58, sin el 0 inicial, con
   guiones o espacios. */
export const cleanPhone = (v) => {
  const s = clean(v);
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('58') && d.length === 12) d = '0' + d.slice(2);   // +584121234567
  if (d.length === 10) d = '0' + d;                                   // 4121234567 (sin el 0)
  if (d.length !== 11) return null;                                   // no es un movil VE
  if (!VE_PREFIXES.has(d.slice(0, 4))) return null;                   // operadora inexistente
  return d;
};

/* CORREO: tiene que parecer un correo. Nada mas que eso.
   El motivo real: AX estuvo devolviendo correos SIN la arroba ni los puntos
   ("erickmontanezgrupocanaimanet" en vez de "erick.montanez@grupocanaima.net").
   Un texto asi NO se guarda: quedaria como si fuera un correo valido y nadie
   lo notaria hasta que un envio falle. Se reporta y se arregla en AX.

   OJO CON LO QUE ESTO **NO** HACE: valida la FORMA, no la existencia. Un
   "mzabala436@gmail.co" (sin la m) pasa perfecto, porque .co es un dominio
   real. Si el dato esta mal escrito en AX, el portal lo copia bien escrito.
   Esa clase de error se corrige en el origen, no aca. */
export const cleanEmail = (v) => {
  const s = clean(v);
  if (!s) return null;
  const e = s.toLowerCase();
  // Minimo indispensable: algo@algo.algo, sin espacios.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
};

/* El portal guarda los telefonos en formato INTERNACIONAL (+584128585089) y
   cleanPhone devuelve el NACIONAL (04128585089). Comparar los dos strings
   crudos da siempre distinto aunque sea el mismo numero: de 117 "conflictos"
   detectados en la primera corrida de tiendas, 115 eran exactamente esto.
   Esta funcion lleva cualquiera de las dos formas a la nacional para poder
   comparar de igual a igual. */
export const toNacional = (v) => cleanPhone(v);

/* Formato con el que el portal PERSISTE el telefono: +58XXXXXXXXXX. */
export const toInternacional = (v) => {
  const n = cleanPhone(v);
  return n ? '+58' + n.slice(1) : null;
};

/* ---------------------------------------------------------------------------
   v6.198 — ¿DOS VALORES SON EL MISMO DATO?

   El maestro guarda telefonos en los dos formatos a la vez (medido el
   10/08/2026: 950 internacionales +58… y 1198 nacionales 04…). Comparar los
   strings crudos hace que "+584122450819" y "04122450819" parezcan distintos
   siendo el MISMO numero.

   Esto ya se sabia y estaba resuelto en DOS lados —sync-roster.js (cleanPhone)
   y ax-review.js (dPhoneNat)— pero el tercer camino, la EDICION de la ficha
   por la tienda (worker-photo.js), comparaba con un String().trim() pelado.
   Resultado: 35 de los 45 pendientes de telefono eran cambios que no cambiaban
   nada, y encima inmortales — publicarlos no los resolvia, porque el portal
   volvia a guardar internacional y AX seguia devolviendo nacional.

   Por eso el comparador vive ACA, con cleanPhone y cleanEmail, y no suelto en
   cada endpoint. Es la misma leccion que creo este archivo en la v6.184.

   OJO CON EL ALCANCE: normaliza solo telefono y correo, donde los formatos son
   demostrablemente equivalentes. Los nombres NO se tocan: cambiar "juan" por
   "JUAN" es una edicion real que alguien quiso hacer y debe viajar a AX.
--------------------------------------------------------------------------- */
export const mismoValorAx = (field, a, b) => {
  const plano = v => (v == null || v === '') ? '' : String(v).trim();
  if (field === 'phone') {
    const na = toNacional(a), nb = toNacional(b);
    // Si alguno no es un movil VE valido, cae a la comparacion literal: no
    // inventamos igualdad entre dos datos que no podemos normalizar.
    if (na && nb) return na === nb;
    return plano(a) === plano(b);
  }
  if (field === 'email') return plano(a).toLowerCase() === plano(b).toLowerCase();
  return plano(a) === plano(b);
};
