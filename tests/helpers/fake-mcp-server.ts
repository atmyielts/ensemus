import { fakeJson, fakeProvider } from './fake-provider';

/** Generated local tool metadata only. A handler can change descriptions or return a tool error. */
export async function fakeMcpServer(initial: readonly Record<string, unknown>[]) {
  let tools = initial,
    calls = 0;
  const provider = await fakeProvider((request, socket) => {
    if (request.method === 'DELETE') {
      socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let rpc: Record<string, unknown>;
    try {
      rpc = JSON.parse(request.body.toString()) as Record<string, unknown>;
    } catch {
      fakeJson(socket, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Generated parse error' },
      });
      return;
    }
    const result =
      rpc.method === 'tools/list'
        ? { resultType: 'complete', tools }
        : rpc.method === 'tools/call'
          ? (calls++,
            { resultType: 'complete', content: [{ type: 'text', text: 'Generated tool result' }] })
          : { resultType: 'complete', capabilities: { tools: {} } };
    fakeJson(socket, 200, { jsonrpc: '2.0', id: rpc.id, result });
  });
  return {
    ...provider,
    setTools(next: readonly Record<string, unknown>[]) {
      tools = next;
    },
    get calls() {
      return calls;
    },
  };
}
