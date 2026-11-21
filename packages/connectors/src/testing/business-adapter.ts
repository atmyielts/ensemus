// A local fake of the adapter protocol (ADR-033 D2), for tests. It lives here and lint keeps it out of every
// worker and web entry point, so none of it can reach a shipped image. It answers over an in-memory stream, so
// nothing opens a socket, and it can be told to misbehave in each way the connector has to survive. Generated
// test values only: no vendor's API is imitated, because none is involved.
import { Duplex } from 'node:stream';
import type { ConnectorNetwork, CredentialLease } from '../index';

export type FakeAdapterRecord = {
  id: string;
  version: string | null;
  classification?: 'public' | 'internal' | 'confidential' | 'restricted';
  fields: Record<string, unknown>;
  acl: readonly {
    principal_kind: 'user' | 'group' | 'domain' | 'anyone';
    principal_external_id: string;
    access: 'read' | 'write' | 'owner';
  }[];
};

export type FakeAdapterRequest = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
};

/** What the fake does with the next request, on top of answering normally. */
export type FakeAdapterBehaviour =
  /** Takes the request and never answers. If it was an operation, the effect still happened. */
  | 'silent_after_effect'
  /** Takes the request, does nothing and never answers. */
  | 'silent_without_effect'
  /** Applies the effect, then drops the connection. */
  | 'drop_after_effect'
  /** Refuses to open at all. */
  | 'refuse_connection'
  /** Opens and never reads. Nothing was written as far as anyone can tell. */
  | 'stall_before_answer'
  /** Answers with this status and no body, and does nothing. */
  | { status: number }
  /** Answers 200 with these exact bytes. */
  | { raw: string };

export type FakeAdapterOptions = {
  /** Records per stream. A stream not listed has no records. */
  streams?: Readonly<Record<string, readonly FakeAdapterRecord[]>>;
  /** Removed at the source, per stream. */
  deleted?: Readonly<Record<string, readonly string[]>>;
  /** Text per note, by external ID. */
  notes?: Readonly<Record<string, string>>;
  /** Only this credential is accepted. */
  credential?: string;
  /** What each operation does. Defaults to applying it. */
  decideOperation?: (body: Record<string, unknown>) => 'applied' | 'rejected' | { status: number };
};

export type FakeAdapter = {
  network: ConnectorNetwork;
  credentials: CredentialLease;
  /** Every request that reached it, in order, for proving what went out and what did not. */
  requests(): readonly FakeAdapterRequest[];
  /** Effects that really happened, once per key however many times they were asked for. */
  effects(): readonly { key: string; tool: string; payload: unknown }[];
  /** Applies `behaviour` to the next request, or to the next `times` of them. */
  next(behaviour: FakeAdapterBehaviour, times?: number): void;
  opened(): number;
};

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  401: 'Unauthorized',
  404: 'Not Found',
  410: 'Gone',
};

function respond(status: number, body?: unknown): string {
  const text = body === undefined ? '' : JSON.stringify(body);
  return [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Status'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(text)}`,
    'Connection: close',
    '',
    text,
  ].join('\r\n');
}

const OPERATIONS = /^\/ensemus-adapter\/v1\/operations$/;
const LOOKUP = /^\/ensemus-adapter\/v1\/operations\/([^/?]+)$/;
const RECORDS = /^\/ensemus-adapter\/v1\/streams\/([^/?]+)\/records(?:\?(.*))?$/;
const NOTE = /^\/ensemus-adapter\/v1\/notes\/([^/?]+)$/;

export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const credential = options.credential ?? 'generated-test-credential';
  const seen: FakeAdapterRequest[] = [];
  const effects = new Map<string, { key: string; tool: string; payload: unknown; id: string }>();
  const refusals = new Set<string>();
  const queue: FakeAdapterBehaviour[] = [];
  let opened = 0;

  const applyEffect = (body: Record<string, unknown>) => {
    const key = String(body.idempotency_key);
    if (effects.has(key)) return;
    effects.set(key, {
      key,
      tool: String(body.tool),
      payload: body.payload,
      id: `operation-${effects.size + 1}`,
    });
  };

  const answerOf = (request: FakeAdapterRequest): string => {
    if (request.headers.authorization !== `Bearer ${credential}`) return respond(401);
    const operation = OPERATIONS.exec(request.path);
    if (operation && request.method === 'POST') {
      const body = request.body as Record<string, unknown>;
      const decision = options.decideOperation?.(body) ?? 'applied';
      if (typeof decision === 'object') return respond(decision.status);
      if (decision === 'rejected') {
        refusals.add(String(body.idempotency_key));
        return respond(200, { status: 'rejected' });
      }
      applyEffect(body);
      return respond(201, {
        status: 'applied',
        operation_id: effects.get(String(body.idempotency_key))?.id,
      });
    }
    const lookup = LOOKUP.exec(request.path);
    if (lookup && request.method === 'GET') {
      const key = decodeURIComponent(lookup[1] as string);
      const effect = effects.get(key);
      if (effect) return respond(200, { status: 'applied', operation_id: effect.id });
      if (refusals.has(key)) return respond(200, { status: 'rejected' });
      return respond(404);
    }
    const records = RECORDS.exec(request.path);
    if (records && request.method === 'GET') {
      const stream = decodeURIComponent(records[1] as string);
      const query = new URLSearchParams(records[2] ?? '');
      const all = options.streams?.[stream] ?? [];
      const start = Number(query.get('cursor') ?? 0);
      const limit = Number(query.get('limit') ?? 100);
      const page = all.slice(start, start + limit);
      const end = start + page.length;
      return respond(200, {
        records: page,
        deleted: start === 0 ? (options.deleted?.[stream] ?? []) : [],
        next_cursor: String(end),
        has_more: end < all.length,
      });
    }
    const note = NOTE.exec(request.path);
    if (note && request.method === 'GET') {
      const text = options.notes?.[decodeURIComponent(note[1] as string)];
      return text === undefined ? respond(404) : respond(200, { version: '1', text });
    }
    return respond(404);
  };

  /** One connection: takes one request, and does what it was told. */
  const connection = (): Duplex => {
    let received = Buffer.alloc(0);
    let handled = false;
    const finish = (stream: Duplex, text: string) => {
      stream.push(text);
      stream.push(null);
    };
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        received = Buffer.concat([received, chunk]);
        done();
        if (handled) return;
        const headerEnd = received.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const lines = received.subarray(0, headerEnd).toString('latin1').split('\r\n');
        const [method, path] = (lines[0] as string).split(' ') as [string, string];
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
        }
        const length = Number(headers['content-length'] ?? 0);
        const bodyBytes = received.subarray(headerEnd + 4);
        if (bodyBytes.length < length) return;
        handled = true;
        const body = length > 0 ? JSON.parse(bodyBytes.toString('utf8')) : undefined;
        const request = { method, path, headers, body };
        seen.push(request);
        const behaviour = queue.shift();
        if (behaviour === 'silent_after_effect') {
          if (OPERATIONS.test(path)) applyEffect(body as Record<string, unknown>);
          return;
        }
        if (behaviour === 'silent_without_effect' || behaviour === 'stall_before_answer') return;
        if (behaviour === 'drop_after_effect') {
          if (OPERATIONS.test(path)) applyEffect(body as Record<string, unknown>);
          stream.destroy();
          return;
        }
        if (behaviour && typeof behaviour === 'object') {
          if ('status' in behaviour) finish(stream, respond(behaviour.status));
          else {
            finish(
              stream,
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(behaviour.raw)}\r\n\r\n${behaviour.raw}`,
            );
          }
          return;
        }
        finish(stream, answerOf(request));
      },
    });
    return stream;
  };

  return {
    network: {
      openRelay: async () => {
        if (queue[0] === 'refuse_connection') {
          queue.shift();
          throw new Error('REFUSED');
        }
        opened += 1;
        return connection();
      },
    },
    credentials: {
      withCredential: (use) => use(Buffer.from(credential)),
    },
    requests: () => seen,
    effects: () => [...effects.values()].map(({ key, tool, payload }) => ({ key, tool, payload })),
    next: (behaviour, times = 1) => {
      for (let index = 0; index < times; index += 1) queue.push(behaviour);
    },
    opened: () => opened,
  };
}
