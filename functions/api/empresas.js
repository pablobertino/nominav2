/* =====================================================================
   functions/api/empresas.js  →  GET /api/empresas
   Proxy server-side a la API de AX. La api-key vive como Secret en
   Cloudflare (canaima_apikey) y NUNCA se expone al navegador.
   Excluye siempre la company plantilla 'DAT'.

   Secret:
     - canaima_apikey
   ===================================================================== */

const AX_API = 'https://api.grupocanaima.com/empresas/status/v1';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet({ env }) {
  try {
    const res = await fetch(AX_API, {
      headers: { Accept: 'application/json', 'X-API-Key': env.canaima_apikey },
    });
    if (!res.ok) {
      return json({ ok: false, error: `API AX respondió ${res.status}` }, 502);
    }
    let data = await res.json();
    if (!Array.isArray(data)) data = data.empresas || data.data || data.items || [];

    // Excluir SIEMPRE la company plantilla DAT
    const companies = data.filter(c => {
      const id = String(c.companyId || c.alias || '').toUpperCase();
      return id !== 'DAT';
    });

    return json({ ok: true, count: companies.length, companies });
  } catch (err) {
    return json({ ok: false, error: 'Error del servidor: ' + err.message }, 500);
  }
}
