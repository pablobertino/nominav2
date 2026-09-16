/* =====================================================================
   functions/pasaporte/siembra.js  →  POST /pasaporte/siembra
   LA RED DE ABAJO: atar de una vez todo lo que ya existe.

   POR QUE HACE FALTA, SI YA ESTA EL AVISO. El aviso llega cuando el
   Pasaporte emite o activa una identidad. Pero las identidades que ya
   existian antes de que esto se prendiera nunca van a generar un aviso, y
   un aviso perdido -un timeout, un despliegue en el minuto justo- tampoco
   se repite solo. Esta corrida no espera a que nadie avise: le pide al
   cruce la lista completa y ata lo que falte.

   Es la diferencia entre enterarse de los cambios y saber el estado. Lo
   primero se pierde una vez y queda mal para siempre; lo segundo se
   corrige solo a la vuelta siguiente.

   IDEMPOTENTE Y BARATA EN REPOSO. Lo que ya esta atado no gasta nada: dos
   consultas por tipo y listo. Recien cuando aparece algo sin atar hay
   escritura. Por eso puede correr todos los dias sin pensarlo.

   POR TANDAS. La primera corrida puede tener ~200 sin atar y Cloudflare
   limita las subpeticiones por request. Se atan hasta 'tope' por vuelta y
   se responde cuantas quedaron; la corrida siguiente sigue por ahi.
   Mientras 'pendientes' no sea 0, falta una vuelta.

   Contrato:
     entra  { }  o  { tope }        cabecera x-cruce-secreto
     sale   { vinculadas, ya_estaban, sin_usuario, conflicto, pendientes }
   ===================================================================== */

import { cruceIdentidades, vincular } from '../api/_pasaporte.js';

export async function onRequestPost({ request, env }) {
  const secreto = request.headers.get('x-cruce-secreto') || '';
  if (!env.PASAPORTE_CRUCE_SECRET || secreto !== env.PASAPORTE_CRUCE_SECRET) {
    return json({ error: 'no autorizado' }, 401);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { /* cuerpo vacio es valido */ }
  const tope = Math.min(Math.max(parseInt(body && body.tope, 10) || 40, 1), 100);

  /* Cuerpo vacio = "dame todas las que pueden entrar". */
  const ids = await cruceIdentidades(env, null);
  if (ids === null) return json({ error: 'cruce-caido' }, 502);

  let r;
  try { r = await vincular(env, ids, 'siembra', tope); }
  catch (_) { return json({ error: 'error interno' }, 500); }

  return json({
    recibidas: ids.length,
    vinculadas: r.vinculadas, ya_estaban: r.ya_estaban,
    sin_usuario: r.sin_usuario, conflicto: r.conflicto,
    omitidas: r.omitidas, pendientes: r.pendientes,
  });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest({ request }) {
  if (request.method === 'POST') return;
  return new Response('Method Not Allowed', { status: 405 });
}
