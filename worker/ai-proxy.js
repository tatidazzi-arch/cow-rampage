/**
 * Proxy de IA para o CowAI (Cloudflare Worker — plano grátis).
 *
 * POR QUE: a chave da API não pode ficar no navegador (qualquer um lê no
 * devtools e abusa da sua conta). Aqui a chave é um SEGREDO do worker.
 *
 * COMO USAR (5 min):
 *  1) Crie uma conta em dash.cloudflare.com
 *  2) Dashboard > Workers & Pages > Create > Worker > nome: "cowai"
 *  3) Cole este arquivo (Edit code > Deploy)
 *  4) Settings > Variables and Secrets > Add:  AI_KEY (secret) e  AI_MODEL
 *     - AI_KEY: sua chave (Groq: console.groq.com/keys  |  OpenAI: platform.openai.com)
 *     - AI_MODEL: "llama-3.1-8b-instant" (Groq, grátis e rápido) ou "gpt-4o-mini" (OpenAI)
 *  5) Copie a URL (https://cowai.seu-usuario.workers.dev) e cole no jogo:
 *     Configurações > "IA (proxy URL)"
 *
 * Sem chave: o jogo usa o cérebro local (regras) — nunca quebra.
 */

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('cowai proxy: POST only', { status: 405 });
    }
    const env = request.env || {};
    const key = env.AI_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: 'sem AI_KEY no worker' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'json invalido' }), { status: 400 });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const model = body.model || env.AI_MODEL || 'llama-3.1-8b-instant';
    const isGroq = model.includes('llama') || model.includes('mixtral') || model.includes('gemma');

    const payload = {
      model,
      messages,
      temperature: 0.85,
      max_tokens: 220,
      response_format: { type: 'json_object' },
    };
    const url = isGroq
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
      });
      const txt = await res.text();
      return new Response(txt, {
        status: res.status,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502, headers: { 'content-type': 'application/json' },
      });
    }
  },
};
