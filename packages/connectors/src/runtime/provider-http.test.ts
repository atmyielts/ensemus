import { describe, expect, it } from 'vitest';
import { createProviderHttpClient } from './provider-http';
import { fakeProvider } from '../../../../tests/helpers/fake-provider';

describe('TLS HTTP through an injected gateway only', () => {
  const request = {
    route: 'google_api' as const,
    method: 'GET' as const,
    path: '/generated',
    timeoutMs: 1500,
    maxResponseBytes: 100,
    signal: new AbortController().signal,
  };
  it('checks the fixed TLS name and decodes chunked framing without exposing credentials', async () => {
    const fake = await fakeProvider((_request, socket) =>
      socket.end(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;safe=yes\r\nde\r\n0\r\n\r\n',
      ),
    );
    try {
      const http = createProviderHttpClient({
        routes: { google_api: fake.network },
        testCa: fake.ca,
      });
      expect(
        (
          await http.request({ ...request, headers: { authorization: 'Bearer generated-canary' } })
        ).body.toString(),
      ).toBe('abcde');
      expect(fake.requests[0]?.headers.authorization).toBe('Bearer generated-canary');
    } finally {
      await fake.close();
    }
  });
  it('refuses a wrong certificate name and a request header injection', async () => {
    const fake = await fakeProvider((_request, socket) =>
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'),
    );
    try {
      const http = createProviderHttpClient({
        routes: { mcp_server: fake.network, google_api: fake.network },
        mcpTlsName: 'wrong.example.invalid',
        testCa: fake.ca,
      });
      await expect(http.request({ ...request, route: 'mcp_server' })).rejects.toMatchObject({
        code: 'PROVIDER_TLS_FAILED',
      });
      await expect(
        http.request({ ...request, headers: { authorization: 'Bearer x\r\nHost: attacker' } }),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
  it('bounds bytes, rejects ambiguous framing and detects an incomplete response', async () => {
    for (const response of [
      'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nx',
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx',
      'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nx',
    ]) {
      const fake = await fakeProvider((_request, socket) => socket.end(response));
      try {
        const http = createProviderHttpClient({
          routes: { google_api: fake.network },
          testCa: fake.ca,
        });
        await expect(http.request(request)).rejects.toMatchObject({ name: 'ProviderHttpFailed' });
      } finally {
        await fake.close();
      }
    }
  });
  it('times out a silent peer and returns a redirect without following it', async () => {
    const silent = await fakeProvider(() => undefined);
    try {
      await expect(
        createProviderHttpClient({
          routes: { google_api: silent.network },
          testCa: silent.ca,
        }).request({ ...request, timeoutMs: 40 }),
      ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    } finally {
      await silent.close();
    }
    const redirect = await fakeProvider((_request, socket) =>
      socket.end(
        'HTTP/1.1 302 Found\r\nLocation: https://attacker.example.invalid/secret\r\nContent-Length: 0\r\n\r\n',
      ),
    );
    try {
      expect(
        (
          await createProviderHttpClient({
            routes: { google_api: redirect.network },
            testCa: redirect.ca,
          }).request(request)
        ).status,
      ).toBe(302);
      expect(redirect.requests).toHaveLength(1);
    } finally {
      await redirect.close();
    }
  });
  it('allows one separately judged CDN request, with no inherited bearer or cookies', async () => {
    const fake = await fakeProvider((_request, socket) =>
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'),
    );
    try {
      let judged = 0;
      const http = createProviderHttpClient({
        routes: {},
        testCa: fake.ca,
        downloadHosts: ['cdn.example.invalid'],
        publicDownloads: {
          forPublicHost: async (host) => {
            expect(host).toBe('cdn.example.invalid');
            judged++;
            return fake.network;
          },
        },
      });
      for (const url of [
        'http://cdn.example.invalid/x',
        'https://10.0.0.1/x',
        'https://metadata.google.internal/x',
        'https://unknown.example.invalid/x',
        'https://user:pass@cdn.example.invalid/x',
        'https://cdn.example.invalid:444/x',
      ])
        await expect(http.download!({ ...request, url })).rejects.toMatchObject({
          name: 'ProviderHttpFailed',
        });
      expect(judged).toBe(0);
      expect(
        (
          await http.download!({
            ...request,
            url: 'https://cdn.example.invalid/generated?temporary=canary',
          })
        ).body.toString(),
      ).toBe('abc');
      expect(judged).toBe(1);
      expect(fake.requests[0]?.headers.authorization).toBeUndefined();
      expect(fake.requests[0]?.headers.cookie).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});
