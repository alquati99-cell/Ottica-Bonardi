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

    return env.ASSETS.fetch(request);
  },
};

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
