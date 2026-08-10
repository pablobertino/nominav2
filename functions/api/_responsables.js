/* =====================================================================
   functions/api/_responsables.js  —  MODULO COMPARTIDO (no es una ruta)
   Mantiene store_contacts (los RESPONSABLES que firman los reportes de una
   tienda) alineado con el roster real.

   POR QUE EXISTE (v6.205):
   el sync cierra el empleo en store_workers cuando alguien egresa o se muda
   de tienda, pero NADIE tocaba store_contacts. Medido el 10/08/2026:

       19 de 255 responsables (7,5%) ya no trabajaban donde figuraban
          12 se habian mudado a otra tienda del grupo
           7 habian salido del grupo
       9 TIENDAS habian quedado sin un solo responsable valido

   Consecuencia: esas tiendas reportaban firmando con el nombre de alguien
   que ya no trabaja ahi, y ese nombre viajaba al ticket de osTicket y al
   aviso de Naima en el grupo. Nadie lo notaba porque el dato se veia bien.

   El caso que lo destapo: ROBERTH MARIN GIL cerro en BG04 el 31/07 y abrio
   en BB02 el 05/08, y seguia siendo responsable de las DOS.

   SE DA DE BAJA, NO SE BORRA: is_active=false es la misma baja logica que ya
   usa la pantalla de responsables, asi que queda el rastro de quien firmaba
   antes y los reportes viejos se siguen entendiendo.

   NO SE REASIGNA SOLO. Si la persona se mudo a otra tienda, este modulo la
   saca de la vieja y NO la agrega a la nueva: quien manda en una tienda es
   una decision de negocio, no algo que se deduzca de un cambio de nomina.

   Vive en un modulo aparte y no suelto en cada sync por la leccion de la
   v6.184 y la v6.198: el mismo conocimiento escrito en dos caminos termina
   actualizado en uno solo.
   ===================================================================== */

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

const soloDigitos = v => String(v == null ? '' : v).replace(/\D/g, '');

/* Da de baja a los responsables de `companyCode` cuyo empleo EN ESA TIENDA
   ya no esta vigente.

   `cedulas` acota a quienes acaba de tocar el sync (mas barato y mas seguro
   que revisar la tienda entera). Si viene vacio o null, revisa todos los
   responsables activos de la tienda — util para una pasada de limpieza.

   Devuelve { bajas:[{id_number,full_name}], quedan, sin_responsables }.
   NUNCA LANZA: si esto falla, el sync ya hizo lo importante. Un responsable
   viejo de mas es molesto; un sync abortado a la mitad es peor. */
export async function bajarResponsablesSinEmpleo(env, companyCode, cedulas) {
  const vacio = { bajas: [], quedan: null, sin_responsables: false };
  try {
    const cc = String(companyCode || '').trim();
    if (!cc || !env || !env.supabase_url) return vacio;

    const contactos = await sb(env,
      `store_contacts?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true`
      + `&select=id,id_number,full_name`) || [];
    if (!contactos.length) return vacio;

    // Acotar a las cedulas que el sync toco, si vinieron.
    const foco = new Set((cedulas || []).map(soloDigitos).filter(Boolean));
    const candidatos = foco.size
      ? contactos.filter(c => foco.has(soloDigitos(c.id_number)))
      : contactos;
    if (!candidatos.length) return { ...vacio, quedan: contactos.length };

    /* Un responsable sin cedula no se puede verificar contra el roster: se
       deja en paz. Se cargo a mano y no hay con que contradecirlo. */
    const conCed = candidatos.filter(c => soloDigitos(c.id_number));
    if (!conCed.length) return { ...vacio, quedan: contactos.length };

    const inList = [...new Set(conCed.map(c => soloDigitos(c.id_number)))]
      .map(c => `"${c}"`).join(',');
    const vigentes = await sb(env,
      `store_workers?company_code=eq.${encodeURIComponent(cc)}&is_active=eq.true`
      + `&id_number=in.(${inList})&select=id_number`) || [];
    const ok = new Set(vigentes.map(w => soloDigitos(w.id_number)));

    const caidos = conCed.filter(c => !ok.has(soloDigitos(c.id_number)));
    if (!caidos.length) return { ...vacio, quedan: contactos.length };

    await sb(env, `store_contacts?id=in.(${caidos.map(c => c.id).join(',')})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
    });

    const quedan = contactos.length - caidos.length;
    return {
      bajas: caidos.map(c => ({ id_number: c.id_number, full_name: c.full_name })),
      quedan,
      /* Que la tienda quede en CERO no se arregla solo: sin responsable no
         puede reportar. Se devuelve para que el sync lo deje anotado y
         alguien cargue el nuevo, en vez de descubrirlo el dia que necesiten
         reportar y no puedan. */
      sin_responsables: quedan === 0,
    };
  } catch (_) {
    return vacio;
  }
}
