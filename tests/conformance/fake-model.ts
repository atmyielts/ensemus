// Types for the fake model server, which is plain JavaScript so it can run as its own process.
// @ts-expect-error -- server.mjs has no declaration file, and this file is what gives it one.
import { startFakeModel as start } from '../fixtures/fake-model/server.mjs';

export type FakeScenario =
  | 'text'
  | 'structured'
  | 'structured_broken'
  | 'tool_call'
  | 'tool_unknown'
  | 'tool_bad_args'
  | 'tool_many'
  | 'malformed_json'
  | 'wrong_shape'
  | 'truncated'
  | 'content_filter'
  | 'context_too_long'
  | 'rate_limited'
  | 'server_error'
  | 'auth_echo'
  | 'partial'
  | 'usage_missing'
  | 'usage_garbage'
  | 'empty'
  | 'hang'
  | 'slow_headers_then_stall'
  | 'redirect';

export type FakeRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: Record<string, unknown> | null;
};

export type FakeModel = {
  port: number;
  host: string;
  url: string;
  baseUrl: string;
  requests: FakeRequest[];
  readonly hits: number;
  setScenario(scenario: FakeScenario): void;
  setRedirectTo(origin: string): void;
  reset(): void;
  close(): Promise<void>;
};

export const startFakeModel = start as (options?: {
  port?: number;
  host?: '127.0.0.1' | '0.0.0.0';
  scenario?: FakeScenario;
  redirectTo?: string;
  delayMs?: number;
}) => Promise<FakeModel>;

/** Only the private test fixture exposes these controls. Runtime profiles see /v1 alone. */
export type FakeReply =
  | { text: string }
  | { tool: { name: string; args: unknown } }
  | { error: { status: number; message: string } };

export async function scriptFakeModel(
  controlOrigin: string,
  model: string,
  replies: readonly FakeReply[],
) {
  const response = await fetch(`${controlOrigin}/__fake/scripts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, replies }),
  });
  if (response.status !== 201) throw new Error(`Fake script control refused: ${response.status}`);
}

export async function fakeModelRequests(
  controlOrigin: string,
  model: string,
): Promise<{
  requests: FakeRequest[];
  total: number;
  historyTruncated: boolean;
}> {
  const response = await fetch(
    `${controlOrigin}/__fake/requests?model=${encodeURIComponent(model)}`,
  );
  if (response.status !== 200) throw new Error(`Fake request capture failed: ${response.status}`);
  return (await response.json()) as {
    requests: FakeRequest[];
    total: number;
    historyTruncated: boolean;
  };
}
