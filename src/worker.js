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

    if (url.pathname === '/api/data' || url.pathname.startsWith('/api/data/')) {
      return handleData(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Cloud storage dei dataset (KV binding "DATA") ────────────────────────────
// Per attivarlo: `wrangler kv namespace create DATA` e incollare l'id
// generato nel blocco [[kv_namespaces]] di wrangler.toml.
//
// Ogni dataset (mag/vend/acq/cli/cliAnag) vive sotto una propria chiave KV,
// più una chiave "meta" coi metadati (nomi file, data salvataggio). Questo
// tiene ogni singolo valore ben sotto il limite di 25MB di Cloudflare KV, e
// permette di sincronizzare solo il dataset appena caricato invece di
// rispedire ogni volta l'intero export (che con tutti i file reali caricati
// può superare facilmente i 25MB in un unico blob).
const DATASET_KEYS = ['meta', 'mag', 'vend', 'acq', 'cli', 'cliAnag'];
const kvKey = k => `ob-data-${k}`;
const MAX_VALUE_BYTES = 24 * 1024 * 1024;

async function handleData(request, env, url) {
  if (!env.DATA) {
    return json({ error: 'kv_not_configured', hint: 'Crea il namespace KV "DATA" (wrangler kv namespace create DATA) e aggiungilo a wrangler.toml' }, 501);
  }

  const parts = url.pathname.split('/').filter(Boolean); // ['api','data', maybe key]
  const key = parts[2];

  if (key && !DATASET_KEYS.includes(key)) {
    return json({ error: 'unknown_dataset', hint: `Dataset validi: ${DATASET_KEYS.join(', ')}` }, 400);
  }

  if (request.method === 'GET') {
    if (key) {
      const value = await env.DATA.get(kvKey(key));
      if (!value) return json({ error: 'not_found' }, 404);
      return new Response(value, { headers: { ...cors(), 'Content-Type': 'application/json' } });
    }
    // Nessuna chiave: riassunto di cosa è presente in cloud.
    const meta = await env.DATA.get(kvKey('meta'));
    const present = {};
    await Promise.all(DATASET_KEYS.filter(k => k !== 'meta').map(async k => {
      present[k] = (await env.DATA.get(kvKey(k), { type: 'text', cacheTtl: 0 })) != null;
    }));
    if (!meta && !Object.values(present).some(Boolean)) return json({ error: 'not_found' }, 404);
    return json({ meta: meta ? JSON.parse(meta) : null, present });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    if (!key) return json({ error: 'dataset_required', hint: 'PUT /api/data/<mag|vend|acq|cli|cliAnag|meta>' }, 400);
    const body = await request.text();
    if (!body || body.length < 2) return json({ error: 'empty_body' }, 400);
    if (body.length > MAX_VALUE_BYTES) return json({ error: 'too_large', hint: 'Max 24MB per dataset' }, 413);
    try { JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400); }
    await env.DATA.put(kvKey(key), body);
    return json({ ok: true, key, bytes: body.length, savedAt: new Date().toISOString() });
  }

  if (request.method === 'DELETE') {
    if (key) await env.DATA.delete(kvKey(key));
    else await Promise.all(DATASET_KEYS.map(k => env.DATA.delete(kvKey(k))));
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

  // Default al modello "smart": con un contesto dati ricco (vendite, magazzino,
  // acquisti, storico clienti, retention, età) il modello 8B fatica a restare
  // aderente ai numeri forniti — il 70B è più affidabile come default.
  const { messages, model = 'smart' } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages[] required' }, 400);
  }

  const modelId = MODELS[model] || MODELS.smart;

  try {
    const stream = await env.AI.run(modelId, {
      messages,
      stream: true,
      max_tokens: 1536,
      temperature: 0.35,
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
