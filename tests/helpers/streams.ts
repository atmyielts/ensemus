// Follows a status stream the way a browser's EventSource does, through the proxy, so stack tests can
// see every frame a person's browser would get and when the server ended it.
import { BASE, type Jar } from './forms';

export type StatusEvent = { event: string; id: string | undefined; data: string };

export type Stream = {
  status: number;
  servedBy: string | null;
  contentType: string | null;
  received: StatusEvent[];
  /** When each version arrived here, in milliseconds since the epoch. */
  arrivals: Map<string, number>;
  /** Everything the server sent, comments included, so nothing can hide outside an event. */
  raw: () => string;
  ended: () => boolean;
  close: () => void;
};

export const eventsPath = (organization: string, workUnit: string) =>
  `/api/v1/organizations/${organization}/work-units/${workUnit}/events`;

export const lastIdOf = (stream: Stream) => stream.received.at(-1)?.id;

export const openStreams = () => {
  const open: Stream[] = [];

  async function follow(
    jar: Jar,
    path: string,
    options: { lastEventId?: string; replica?: 'web' | 'web-2' } = {},
  ): Promise<Stream> {
    const abort = new AbortController();
    const response = await fetch(`${BASE}${path}`, {
      headers: {
        cookie: jar.cookie,
        accept: 'text/event-stream',
        ...(options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }),
        ...(options.replica === 'web-2' ? { 'x-ensemus-test-replica': '2' } : {}),
      },
      redirect: 'manual',
      signal: abort.signal,
    });
    const received: StatusEvent[] = [];
    const arrivals = new Map<string, number>();
    let text = '';
    let ended = false;
    const pump = async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const piece = decoder.decode(chunk, { stream: true });
        text += piece;
        buffer += piece;
        for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
          const fields = new Map(
            buffer
              .slice(0, at)
              .split('\n')
              .filter((line) => line && !line.startsWith(':'))
              .map((line) => {
                const colon = line.indexOf(':');
                return [line.slice(0, colon), line.slice(colon + 1).trimStart()] as const;
              }),
          );
          buffer = buffer.slice(at + 2);
          if (fields.has('data')) {
            received.push({
              event: fields.get('event') ?? 'message',
              id: fields.get('id'),
              data: fields.get('data') as string,
            });
            arrivals.set(fields.get('id') ?? '', Date.now());
          }
        }
      }
    };
    void pump()
      .catch(() => undefined)
      .finally(() => {
        ended = true;
      });
    const stream: Stream = {
      status: response.status,
      servedBy: response.headers.get('x-ensemus-served-by'),
      contentType: response.headers.get('content-type'),
      received,
      arrivals,
      raw: () => text,
      ended: () => ended,
      close: () => abort.abort(),
    };
    open.push(stream);
    return stream;
  }

  return { follow, closeAll: () => open.splice(0).forEach((stream) => stream.close()) };
};
