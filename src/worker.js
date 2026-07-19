const MODELS = {
  fast:  '@cf/meta/llama-3.1-8b-instruct',
  smart: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    if (url.pathname === '/api/ai' && request.method === 'POST') {
      return handleAI(request, env);
    }

    if (url.pathname === '/api/data') {
      return handleData(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Cloud storage dei dataset (KV binding "DATA") ────────────────────────────
// Per attivarlo: `wrangler kv namespace create DATA` e incollare l'id
// generato nel blocco [[kv_namespaces]] di wrangler.toml.
const DATA_KEY = 'ob-datasets-v1';

async function handleData(request, env) {
  if (!env.DATA) {
    return json({ error: 'kv_not_configured', hint: 'Crea il namespace KV "DATA" (wrangler kv namespace create DATA) e aggiungilo a wrangler.toml' }, 501);
  }

  if (request.method === 'GET') {
    const value = await env.DATA.get(DATA_KEY);
    if (!value) return json({ error: 'not_found' }, 404);
    return new Response(value, {
      headers: { ...cors(), 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    if (!body || body.length < 2) return json({ error: 'empty_body' }, 400);
    if (body.length > 24 * 1024 * 1024) return json({ error: 'too_large', hint: 'Max 24MB' }, 413);
    try { JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400); }
    await env.DATA.put(DATA_KEY, body);
    return json({ ok: true, bytes: body.length, savedAt: new Date().toISOString() });
  }

  if (request.method === 'DELETE') {
    await env.DATA.delete(DATA_KEY);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

async function handleAI(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { messages, model = 'fast' } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages[] required' }, 400);
  }

  const modelId = MODELS[model] || MODELS.fast;

  try {
    const stream = await env.AI.run(modelId, {
      messages,
      stream: true,
      max_tokens: 1024,
      temperature: 0.65,
    });

    return new Response(stream, {
      headers: {
        ...cors(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Model': modelId,
      },
    });
  } catch (err) {
    return json({ error: err.message || 'AI error' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
