/* =====================================================================
   functions/api/_greenapi.js  →  cliente Green-API (WhatsApp) server-side
   COPIA DEL ESTANDAR DEL GRUPO: GC_GREENAPI_INTEGRACION.md (seccion 4).
   (El estandar lo ubica en functions/_lib/; aqui vive como functions/api/
   _greenapi.js siguiendo el patron _auth.js del proyecto; el prefijo _
   lo excluye del enrutado de Pages Functions.)
   SOLO se importa desde Cloudflare Functions, nunca desde el frontend.
   El apiTokenInstance vive como secret de Cloudflare (GREENAPI_TOKEN):
   jamas en codigo, repo o front.
   Env vars requeridas (Cloudflare Pages > Settings > Environment vars):
     GREENAPI_HOST         https://7107.api.greenapi.com     (plain)
     GREENAPI_MEDIA_HOST   https://7107.api.greenapi.com     (plain)
     GREENAPI_ID_INSTANCE  710722679864                      (plain)
     GREENAPI_TOKEN        <apiTokenInstance>                (SECRET)
   ===================================================================== */

export function gaClient(env) {
  const base      = `${env.GREENAPI_HOST}/waInstance${env.GREENAPI_ID_INSTANCE}`;
  const mediaBase = `${env.GREENAPI_MEDIA_HOST || env.GREENAPI_HOST}/waInstance${env.GREENAPI_ID_INSTANCE}`;

  async function call(method, body, opts = {}) {
    const host = opts.media ? mediaBase : base;
    const url  = `${host}/${method}/${env.GREENAPI_TOKEN}`;
    const init = { method: 'POST' };
    if (opts.form) { init.body = body; }                    // FormData (upload)
    else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(`GreenAPI ${method} ${r.status}: ${text.slice(0, 300)}`);
    return data;
  }

  return {
    // Estado de la instancia (authorized / notAuthorized / blocked ...)
    state: () => fetch(`${base}/getStateInstance/${env.GREENAPI_TOKEN}`).then(r => r.json()),

    // Lista de chats de la cuenta (GET). Cada item: {archive, id, name,
    // type: 'user'|'group', ...}. Grupos: type='group' / id termina @g.us.
    // La info se actualiza en el proveedor ~1 vez por minuto.
    getChats: async () => {
      const r = await fetch(`${base}/getChats/${env.GREENAPI_TOKEN}`);
      const text = await r.text();
      if (!r.ok) throw new Error(`GreenAPI getChats ${r.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return []; }
    },

    // Texto simple. Limite: 20000 caracteres.
    sendMessage: (chatId, message, extra = {}) =>
      call('sendMessage', { chatId, message, ...extra }),

    // Archivo por URL publica o firmada
    sendFileByUrl: (chatId, urlFile, fileName, caption = '') =>
      call('sendFileByUrl', { chatId, urlFile, fileName, caption }),

    // Archivo subiendo el binario. Max 100 MB, caption <= 1024.
    sendFileByUpload: (chatId, blob, fileName, caption = '') => {
      const fd = new FormData();
      fd.append('chatId', chatId);
      fd.append('file', blob, fileName);
      fd.append('fileName', fileName);
      if (caption) fd.append('caption', caption);
      return call('sendFileByUpload', fd, { form: true, media: true });
    },

    // Encuesta. message <= 255; 2-12 opciones unicas; optionName <= 100.
    sendPoll: (chatId, message, options, multipleAnswers = false) =>
      call('sendPoll', {
        chatId, message, multipleAnswers,
        options: options.map(o => ({ optionName: o })),
      }),
  };
}

// Normaliza numeros venezolanos: '0412-123.45.67' / '+58412...' -> '58412...@c.us'
export function toChatId(raw) {
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('0'))   n = '58' + n.slice(1);   // 0412... -> 58412...
  if (!n.startsWith('58')) n = '58' + n;
  return `${n}@c.us`;
}
