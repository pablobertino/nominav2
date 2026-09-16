/* =====================================================================
   functions/pasaporte/aviso.js  →  POST /pasaporte/aviso
   EL PASAPORTE NOS AVISA: "esta identidad ya existe / ya se activo".

   PARA QUE SIRVE, EN CRIOLLO. Sin esto, el vinculo solo se arma cuando
   la persona toca el boton — y ahi es tarde para descubrir que su ancla
   no cuadra con ninguna cuenta. Con esto, el Pasaporte avisa en el mismo
   momento en que emite o activa la identidad, y la persona entra a
   Nomina en ese mismo minuto, sin un primer intento fallido.

   QUIEN PUEDE LLAMARLA. Solo quien traiga PASAPORTE_CRUCE_SECRET en la
   cabecera x-cruce-secreto. Cualquier otro se lleva un 401 pelado, sin
   pistas. Es el mismo secreto del cruce: un secreto por relacion, no uno
   por endpoint.

   ⚠ NO CREA CUENTAS. Igual que el login: si el ancla no corresponde a
   nadie, se cuenta en sin_usuario y no pasa nada mas. El Pasaporte dice
   quien es alguien; no dice quien puede entrar aca.

   IDEMPOTENTE. El mismo aviso repetido cae en ya_estaban y no toca la
   base. El Pasaporte puede reintentar sin miedo, que es justo lo que va
   a hacer si alguna vez no le contestamos a tiempo.

   MENOS DE 8 SEGUNDOS. Por eso vincular() agrupa por tipo y consulta en
   dos viajes, no en uno por fila.

   Contrato:
     entra  { motivo, identidades: [ {ancla, tipo, sub, alias, estado} ] }
     sale   { vinculadas, ya_estaban, sin_usuario, conflicto: [] }
   ===================================================================== */

import { vincular } from '../api/_pasaporte.js';

/* ⚠ A PROPOSITO NO MIRA pasaporte_enabled. El interruptor apaga el BOTON
   -que la gente entre por ahi-, no el mantenimiento de los vinculos. Si
   el aviso se apagara junto con el boton, el dia que se prenda tendriamos
   meses de identidades sin atar y la primera tanda de gente rebotaria. */

export async function onRequestPost({ request, env }) {
  const secreto = request.headers.get('x-cruce-secreto') || '';
  if (!env.PASAPORTE_CRUCE_SECRET || secreto !== env.PASAPORTE_CRUCE_SECRET) {
    return json({ error: 'no autorizado' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return json({ error: 'cuerpo invalido' }, 400); }

  const ids = Array.isArray(body && body.identidades) ? body.identidades : [];
  if (!ids.length) {
    /* Sin identidades no hay nada que hacer, pero se responde 200 con los
       contadores en cero: un 400 haria que el Pasaporte reintente para
       siempre un aviso que nunca va a mejorar. */
    return json({ vinculadas: 0, ya_estaban: 0, sin_usuario: 0, conflicto: [] });
  }

  let r;
  try { r = await vincular(env, ids, 'aviso'); }
  catch (_) { return json({ error: 'error interno' }, 500); }

  return json({
    vinculadas: r.vinculadas, ya_estaban: r.ya_estaban,
    sin_usuario: r.sin_usuario, conflicto: r.conflicto,
    omitidas: r.omitidas, motivo: (body && body.motivo) || null,
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
