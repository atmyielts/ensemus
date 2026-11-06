// Reads what a test collector wrote (ADR-037 D3). The sink is a small service in the test overlay, which
// appends the body of each OTLP request to one file, as it arrived, followed by a newline. The exporter
// sends JSON with no line breaks in it, so that is one export per line. Tests search the raw text as well
// as the parsed spans: a value in a field nobody thought of is still in the text.
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

type OtlpAttribute = { key: string; value?: Record<string, unknown> };

type OtlpSpan = {
  name: string;
  attributes?: OtlpAttribute[];
  status?: { message?: string };
  events?: unknown[];
  links?: Array<{ attributes?: unknown[] }>;
};

type OtlpExport = {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
};

export type SinkSpan = {
  service: string | undefined;
  name: string;
  attributes: Record<string, unknown>;
  statusMessage: string;
  eventCount: number;
  linkAttributeCount: number;
};

const NEWLINE = 0x0a;
const POLL_MS = 250;

const contents = (file: string) => (existsSync(file) ? readFileSync(file) : Buffer.alloc(0));

/** What the sink has written, from a point in the file. A file not there yet is nothing yet. */
export const readSink = (file: string, from = 0) => contents(file).subarray(from).toString('utf8');

/** The point after the last whole line, so that what is read from here starts at a line's beginning. */
export const sinkEnd = (file: string) => contents(file).lastIndexOf(NEWLINE) + 1;

/** OTLP wraps each value in its type: `{ stringValue: 'x' }`. An integer may arrive as a string. */
const flatten = (attributes: OtlpAttribute[] = []) =>
  Object.fromEntries(
    attributes.map(({ key, value }) => [key, value ? Object.values(value)[0] : undefined]),
  );

/**
 * Every span in the text. A last line with no newline is still being written, so it waits for the next
 * read. A whole line that does not parse is an error, not a line to skip: skipping it could turn a sink
 * that writes the wrong thing into a pass.
 */
export function spansIn(text: string): SinkSpan[] {
  const lines = text.split('\n').slice(0, -1).filter(Boolean);
  return lines.flatMap((line) => {
    let parsed: OtlpExport;
    try {
      parsed = JSON.parse(line) as OtlpExport;
    } catch {
      throw new Error('A line in the sink file is not an OTLP JSON export');
    }
    return (parsed.resourceSpans ?? []).flatMap(({ resource, scopeSpans }) => {
      const service = flatten(resource?.attributes)['service.name'] as string | undefined;
      return (scopeSpans ?? []).flatMap(({ spans }) =>
        (spans ?? []).map((span) => ({
          service,
          name: span.name,
          attributes: flatten(span.attributes),
          statusMessage: span.status?.message ?? '',
          eventCount: span.events?.length ?? 0,
          linkAttributeCount: (span.links ?? []).flatMap((link) => link.attributes ?? []).length,
        })),
      );
    });
  });
}

/**
 * Waits until the spans written since `from` satisfy `enough`, and returns them. The batch processor
 * sends every few seconds, so a span is never there at once, and a check that did not wait would pass
 * on nothing.
 */
export async function waitForSpans(
  file: string,
  from: number,
  enough: (spans: SinkSpan[]) => boolean,
  timeoutMs = 30_000,
): Promise<SinkSpan[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spans = spansIn(readSink(file, from));
    if (enough(spans)) return spans;
    if (Date.now() >= deadline) {
      throw new Error(`The spans expected did not arrive, among the ${spans.length} that did`);
    }
    await sleep(POLL_MS);
  }
}

/** Which of these values appear in the text. */
export const leaksIn = (text: string, values: string[]) =>
  values.filter((value) => text.includes(value));

/** Anything shaped like an email address. Nothing in an allowlisted span should be. */
export const emailsIn = (text: string) => [
  ...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)),
];

/**
 * Anything shaped like an IPv4 address in a span's name or attributes. Not in the raw text, which holds
 * version numbers and a release name that are allowed to look like one.
 */
export const addressesIn = (spans: SinkSpan[]) => [
  ...new Set(
    spans
      .flatMap((span) => [span.name, ...Object.values(span.attributes).map(String)])
      .flatMap((value) => value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []),
  ),
];
