// A fake model server, for tests only: deterministic, on a loopback port, and it reaches nothing. It speaks
// OpenAI's Chat Completions (also what an OpenAI-compatible server speaks) and Anthropic's Messages, in the
// shapes those providers document. It proves what our adapters do with those shapes, and it proves nothing
// about a live provider, so a hosted kind stays qualified=NO until a real run. `tests` is in .dockerignore,
// so this can never reach a shipped image.
//
// A scenario comes from setScenario, or else from a model ID of `fake:<scenario>`, which is what a stack
// test can use from another process. It counts every request, so "retry count exactly zero" is a number.
import { createServer } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

export const SCENARIOS = [
  'text',
  'structured',
  'structured_broken',
  'tool_call',
  'tool_unknown',
  'tool_bad_args',
  'tool_many',
  'malformed_json',
  'wrong_shape',
  'truncated',
  'content_filter',
  'context_too_long',
  'rate_limited',
  'server_error',
  'auth_echo',
  'partial',
  'usage_missing',
  'usage_garbage',
  'empty',
  'hang',
  'slow_headers_then_stall',
  'redirect',
];

const USAGE = { input: 11, output: 7 };
const MAX_BODY_BYTES = 262_144;
const MAX_REQUESTS = 128;
const MAX_MODELS = 64;
const MAX_REPLIES = 16;
const MAX_SCRIPT_BYTES = 1_048_576;

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
};

const toolNames = (body) =>
  (body?.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);

/** What the model "said", common to both wire formats. */
function modelReply(scenario, body, scripted) {
  if (scripted?.tool) {
    return { tools: [{ name: scripted.tool.name, args: JSON.stringify(scripted.tool.args) }] };
  }
  if (scripted && typeof scripted.text === 'string') return { text: scripted.text };
  switch (scenario) {
    case 'structured':
      return { text: JSON.stringify({ answer: 'yes', confidence: 1 }) };
    case 'structured_broken':
      return { text: '{"answer": "yes", ' };
    case 'tool_call':
      return { tools: [{ name: toolNames(body)[0] ?? 'missing_tool', args: '{"id":"abc"}' }] };
    case 'tool_unknown':
      return { tools: [{ name: 'secrets_read', args: '{"name":"everything"}' }] };
    case 'tool_bad_args':
      return { tools: [{ name: toolNames(body)[0] ?? 'missing_tool', args: '{"id": "abc", ' }] };
    case 'tool_many': {
      const name = toolNames(body)[0] ?? 'missing_tool';
      return {
        tools: [
          { name, args: '{"id":"one"}' },
          { name, args: '{"id":"two"}' },
        ],
      };
    }
    case 'empty':
      return { text: '' };
    default:
      return { text: 'A short deterministic answer.' };
  }
}

const quoted = (body) => JSON.stringify(body?.messages ?? []);

function replyOpenAI(res, scenario, body, seen, scripted) {
  const reply = modelReply(scenario, body, scripted);
  const message = reply.tools
    ? {
        role: 'assistant',
        content: null,
        tool_calls: reply.tools.map((tool, index) => ({
          id: `call_${index}`,
          type: 'function',
          function: { name: tool.name, arguments: tool.args },
        })),
      }
    : { role: 'assistant', content: reply.text };
  const finish =
    scenario === 'truncated'
      ? 'length'
      : scenario === 'content_filter'
        ? 'content_filter'
        : reply.tools
          ? 'tool_calls'
          : 'stop';
  const answer = {
    id: `chatcmpl-${seen}`,
    object: 'chat.completion',
    created: 1,
    model: body?.model ?? 'fake',
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
  };
  if (scenario === 'usage_garbage') {
    answer.usage = { prompt_tokens: -5, completion_tokens: 1.5, total_tokens: -3.5 };
  } else if (scenario !== 'usage_missing') {
    answer.usage = {
      prompt_tokens: USAGE.input,
      completion_tokens: USAGE.output,
      total_tokens: USAGE.input + USAGE.output,
    };
  }
  json(res, 200, answer);
}

function replyAnthropic(res, scenario, body, seen, scripted) {
  const reply = modelReply(scenario, body, scripted);
  // Without native structured output the provider package asks for this tool and reads its input back.
  const wantsJsonTool = toolNames(body).includes('json') && body?.tool_choice?.type === 'any';
  let content;
  if (reply.tools) {
    content = reply.tools.map((tool, index) => {
      let input;
      try {
        input = JSON.parse(tool.args);
      } catch {
        input = tool.args;
      }
      return { type: 'tool_use', id: `toolu_${index}`, name: tool.name, input };
    });
  } else if (wantsJsonTool && scenario !== 'structured_broken') {
    content = [{ type: 'tool_use', id: 'toolu_json', name: 'json', input: JSON.parse(reply.text) }];
  } else {
    content = reply.text ? [{ type: 'text', text: reply.text }] : [];
  }
  const stop =
    scenario === 'truncated'
      ? 'max_tokens'
      : scenario === 'content_filter'
        ? 'refusal'
        : reply.tools
          ? 'tool_use'
          : 'end_turn';
  const answer = {
    id: `msg_${seen}`,
    type: 'message',
    role: 'assistant',
    model: body?.model ?? 'fake',
    content,
    stop_reason: stop,
    stop_sequence: null,
  };
  if (scenario === 'usage_garbage') {
    answer.usage = { input_tokens: -5, output_tokens: 1.5 };
  } else if (scenario !== 'usage_missing') {
    answer.usage = { input_tokens: USAGE.input, output_tokens: USAGE.output };
  }
  json(res, 200, answer);
}

function errorBody(format, type, message, code) {
  return format === 'anthropic'
    ? { type: 'error', error: { type, message }, request_id: 'req_fake' }
    : { error: { message, type, param: null, code: code ?? null } };
}

async function respond(req, res, scenario, format, body, seen, state) {
  const reply = format === 'anthropic' ? replyAnthropic : replyOpenAI;
  switch (scenario) {
    case 'malformed_json':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices": [{"message": ');
      return;
    case 'wrong_shape':
      json(res, 200, { unexpected: true });
      return;
    case 'context_too_long':
      json(
        res,
        400,
        format === 'anthropic'
          ? errorBody(
              format,
              'invalid_request_error',
              'prompt is too long: 999 tokens > 10 maximum',
            )
          : errorBody(
              format,
              'invalid_request_error',
              "This model's maximum context length is 10 tokens.",
              'context_length_exceeded',
            ),
      );
      return;
    case 'rate_limited':
      // Says when to come back, which a client that retries would obey. The hit count catches it.
      json(res, 429, errorBody(format, 'rate_limit_error', `Slow down. ${quoted(body)}`), {
        'retry-after': '0',
      });
      return;
    case 'server_error':
      // Quotes the prompt back, as a real provider's error can.
      json(res, 500, errorBody(format, 'api_error', `Internal error on ${quoted(body)}`));
      return;
    case 'auth_echo': {
      // Echoes the key in the body, and in a header, as a badly behaved proxy would.
      const key = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
      json(
        res,
        401,
        errorBody(format, 'authentication_error', `Incorrect API key provided: ${key}`),
        { 'x-echoed-key': String(key) },
      );
      return;
    }
    case 'partial': {
      const whole = JSON.stringify({
        id: 'cut',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A long answer' } }],
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(whole),
      });
      res.write(whole.slice(0, Math.floor(whole.length / 2)), () => res.socket?.destroy());
      return;
    }
    case 'hang':
      // Holds the request open until the client goes away.
      state.hanging += 1;
      return;
    case 'slow_headers_then_stall':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
      state.hanging += 1;
      return;
    case 'redirect':
      res.writeHead(302, { location: `${state.redirectTo ?? ''}/v1/stolen` });
      res.end();
      return;
    default:
      reply(res, scenario, body, seen);
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('FAKE_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validReply(reply) {
  if (!reply || typeof reply !== 'object' || Object.keys(reply).length !== 1) return false;
  if (typeof reply.text === 'string') return reply.text.length > 0 && reply.text.length <= 100_000;
  if (reply.tool && typeof reply.tool === 'object') {
    return (
      Object.keys(reply.tool).length === 2 &&
      typeof reply.tool.name === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(reply.tool.name) &&
      Object.hasOwn(reply.tool, 'args')
    );
  }
  if (reply.error && typeof reply.error === 'object') {
    return (
      Object.keys(reply.error).length === 2 &&
      Number.isInteger(reply.error.status) &&
      reply.error.status >= 400 &&
      reply.error.status <= 599 &&
      typeof reply.error.message === 'string' &&
      reply.error.message.length <= 100_000
    );
  }
  return false;
}

/**
 * Starts on a loopback port. `requests` holds each request's path, headers and parsed body, so a test can
 * check what really went out. They hold a test's generated key and prompt, and live only in this process.
 */
export async function startFakeModel(options = {}) {
  const requests = [];
  const scripts = new Map();
  const state = {
    scenario: options.scenario ?? null,
    hanging: 0,
    hits: 0,
    scriptBytes: 0,
    redirectTo: options.redirectTo,
  };
  const server = createServer(async (req, res) => {
    const path = req.url ?? '';
    if (req.method === 'GET' && path === '/__fake/stats') {
      json(res, 200, {
        hits: state.hits,
        hanging: state.hanging,
        retained: requests.length,
        historyTruncated: state.hits > requests.length,
      });
      return;
    }
    if (req.method === 'GET' && path.split('?')[0] === '/__fake/requests') {
      const model = new URL(path, 'http://fixture.invalid').searchParams.get('model');
      const selected = model ? requests.filter((entry) => entry.body?.model === model) : requests;
      const scripted = model ? scripts.get(model) : undefined;
      const total = scripted ? scripted.hits : state.hits;
      json(res, 200, {
        requests: selected,
        total,
        // Another model filling the bounded history cannot make this model's complete capture
        // look truncated. Unknown/uncontrolled models conservatively retain the global warning.
        historyTruncated: scripted ? total > selected.length : state.hits > requests.length,
      });
      return;
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      json(res, 413, { code: 'FAKE_BODY_TOO_LARGE' });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (req.method === 'POST' && path === '/__fake/scripts') {
      if (
        !body ||
        Object.keys(body).length !== 2 ||
        typeof body.model !== 'string' ||
        !/^fake:[A-Za-z0-9_-]{1,100}$/.test(body.model) ||
        !Array.isArray(body.replies) ||
        body.replies.length < 1 ||
        body.replies.length > MAX_REPLIES ||
        !body.replies.every(validReply)
      ) {
        json(res, 400, { code: 'FAKE_SCRIPT_INVALID' });
        return;
      }
      const bytes = Buffer.byteLength(raw);
      const previous = scripts.get(body.model);
      if (
        (!previous && scripts.size >= MAX_MODELS) ||
        state.scriptBytes - (previous?.bytes ?? 0) + bytes > MAX_SCRIPT_BYTES
      ) {
        json(res, 429, { code: 'FAKE_SCRIPT_LIMIT' });
        return;
      }
      state.scriptBytes += bytes - (previous?.bytes ?? 0);
      scripts.set(body.model, { replies: body.replies, next: 0, bytes, hits: 0 });
      json(res, 201, { model: body.model, replies: body.replies.length });
      return;
    }
    requests.push({ method: req.method, path, headers: { ...req.headers }, raw, body });
    if (requests.length > MAX_REQUESTS) requests.shift();
    const seen = ++state.hits;
    const scripted = scripts.get(body?.model);
    if (scripted) scripted.hits += 1;

    const format = path.endsWith('/messages')
      ? 'anthropic'
      : path.endsWith('/chat/completions')
        ? 'openai'
        : null;
    if (req.method !== 'POST' || !format) {
      json(res, 404, errorBody('openai', 'not_found_error', 'No such route'));
      return;
    }
    const script = scripts.get(body?.model);
    if (script) {
      const scripted = script.replies[script.next++];
      if (!scripted) {
        json(res, 500, errorBody(format, 'script_exhausted', 'FAKE_SCRIPT_EXHAUSTED'));
      } else if (scripted.error) {
        json(res, scripted.error.status, errorBody(format, 'api_error', scripted.error.message));
      } else {
        (format === 'anthropic' ? replyAnthropic : replyOpenAI)(
          res,
          'scripted',
          body,
          seen,
          scripted,
        );
      }
      return;
    }
    const fromModel =
      typeof body?.model === 'string' && body.model.startsWith('fake:')
        ? body.model.slice('fake:'.length)
        : null;
    if (options.delayMs) await delay(options.delayMs);
    await respond(req, res, state.scenario ?? fromModel ?? 'text', format, body, seen, state);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    host: options.host ?? '127.0.0.1',
    url: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get hits() {
      return state.hits;
    },
    setScenario(scenario) {
      if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown fake scenario: ${scenario}`);
      state.scenario = scenario;
    },
    setRedirectTo(origin) {
      state.redirectTo = origin;
    },
    reset() {
      requests.length = 0;
      scripts.clear();
      state.hanging = 0;
      state.hits = 0;
      state.scriptBytes = 0;
      state.scenario = options.scenario ?? null;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

// As its own process, for a stack test: `node server.mjs`, on FAKE_MODEL_PORT or any free port.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fake = await startFakeModel({
    port: Number(process.env.FAKE_MODEL_PORT ?? 0),
    host: process.env.FAKE_MODEL_HOST ?? '127.0.0.1',
  });
  process.stdout.write(`${JSON.stringify({ port: fake.port })}\n`);
}
