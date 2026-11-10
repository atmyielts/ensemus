// A test relay. Never shipped: only compose.test.yaml runs it, and tests/helpers/smtp-sink.ts starts it
// inside a test. It speaks enough SMTP for the client, in modes that misbehave at the moments that matter,
// and it uses only Node's own modules because the stack mounts this one file into a stock image.
//
// Run as a program, it listens for SMTP on 2525 and for control on 8025:
//   GET  /messages   every message it took, as JSON
//   GET  /stats      { received, connections }, which only ever go up
//   POST /mode       { "mode": "accept_then_silent" }
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODES = new Set([
  'accept',
  'accept_then_silent',
  'refuse_recipient',
  'refuse_after_data',
  'busy',
  'silent_on_connect',
  'drop_after_data',
]);

export async function createSmtpSink({ mode, host = '127.0.0.1', port = 0, tls, noAuth = false }) {
  let currentMode = mode;
  let connections = 0;
  let authAttempts = 0;
  const messages = [];
  const open = new Set();
  const context = tls ? createSecureContext(tls) : null;

  function serve(initial) {
    let socket = initial;
    let buffer = '';
    let inData = false;
    let secured = false;
    let mailFrom = null;
    let rcptTo = [];
    let authenticatedAs = null;
    let loginStep = null;
    let silent = false;

    const say = (text) => {
      if (!silent && !socket.destroyed) socket.write(text);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (silent) return;
        if (inData) {
          // The first line of the body may be the terminator on its own, for an empty message.
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buffer.slice(0, end).replace(/(^|\r\n)\.\./g, '$1.');
          buffer = buffer.slice(end + 5);
          inData = false;
          finishData(raw);
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        handle(line);
      }
    };

    const record = (raw) =>
      messages.push({ mailFrom, rcptTo: [...rcptTo], raw, authenticatedAs, tls: secured });

    function finishData(raw) {
      if (currentMode === 'accept_then_silent') {
        record(raw);
        silent = true;
      } else if (currentMode === 'drop_after_data') {
        record(raw);
        socket.destroy();
      } else if (currentMode === 'refuse_after_data') {
        say('554 5.7.1 refused after data\r\n');
      } else {
        record(raw);
        say('250 2.0.0 queued\r\n');
      }
      mailFrom = null;
      rcptTo = [];
    }

    function greetCapabilities() {
      const lines = ['sink.example.invalid'];
      if (context && !secured) lines.push('STARTTLS');
      if (!noAuth) lines.push('AUTH PLAIN LOGIN');
      lines.push('8BITMIME');
      return lines.map((text, i) => `250${i === lines.length - 1 ? ' ' : '-'}${text}\r\n`).join('');
    }

    function handle(line) {
      if (loginStep === 'username') {
        authenticatedAs = Buffer.from(line, 'base64').toString('utf8');
        loginStep = 'password';
        say('334 UGFzc3dvcmQ6\r\n');
        return;
      }
      if (loginStep === 'password') {
        loginStep = null;
        say('235 2.7.0 ok\r\n');
        return;
      }
      const verb = line.split(/[ :]/)[0].toUpperCase();
      if (verb === 'EHLO') {
        say(greetCapabilities());
      } else if (verb === 'STARTTLS' && context) {
        say('220 2.0.0 go\r\n');
        socket.off('data', onData);
        buffer = '';
        const upgraded = new TLSSocket(socket, { isServer: true, secureContext: context });
        upgraded.on('error', () => socket.destroy());
        open.add(upgraded);
        upgraded.on('close', () => open.delete(upgraded));
        upgraded.on('data', onData);
        socket = upgraded;
        secured = true;
        // A new session starts with what it knew forgotten, as RFC 3207 says.
        authenticatedAs = null;
      } else if (verb === 'AUTH' && !noAuth) {
        authAttempts += 1;
        const [, mechanism, initial] = line.split(' ');
        if (mechanism === 'PLAIN') {
          // Keeps who logged in. The password is dropped here and is in nothing this returns.
          authenticatedAs = Buffer.from(initial ?? '', 'base64')
            .toString('utf8')
            .split('\0')[1];
          say('235 2.7.0 ok\r\n');
        } else {
          loginStep = 'username';
          say('334 VXNlcm5hbWU6\r\n');
        }
      } else if (verb === 'MAIL') {
        mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? '';
        say('250 2.1.0 ok\r\n');
      } else if (verb === 'RCPT') {
        if (currentMode === 'refuse_recipient') {
          say('550 5.1.1 no such user\r\n');
        } else {
          rcptTo.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say('250 2.1.5 ok\r\n');
        }
      } else if (verb === 'DATA') {
        inData = true;
        say('354 go ahead\r\n');
      } else if (verb === 'QUIT') {
        say('221 2.0.0 bye\r\n');
        socket.end();
      } else if (verb === 'RSET') {
        mailFrom = null;
        rcptTo = [];
        say('250 2.0.0 ok\r\n');
      } else {
        say('502 5.5.1 not implemented\r\n');
      }
    }

    socket.on('data', onData);
    if (currentMode === 'busy') {
      socket.write('421 4.3.2 busy\r\n');
      socket.end();
    } else if (currentMode !== 'silent_on_connect') {
      say('220 sink.example.invalid ready\r\n');
    }
  }

  const server = createNetServer((socket) => {
    connections += 1;
    open.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => open.delete(socket));
    serve(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    port: server.address().port,
    messages: () => messages.map((message) => ({ ...message, rcptTo: [...message.rcptTo] })),
    connections: () => connections,
    authAttempts: () => authAttempts,
    setMode(next) {
      if (!MODES.has(next)) throw new Error('UNKNOWN_MODE');
      currentMode = next;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function main() {
  const sink = await createSmtpSink({ mode: 'accept', host: '0.0.0.0', port: 2525 });
  const control = createHttpServer((request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/messages') {
      reply(200, sink.messages());
    } else if (request.method === 'GET' && request.url === '/stats') {
      reply(200, { received: sink.messages().length, connections: sink.connections() });
    } else if (request.method === 'POST' && request.url === '/mode') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        try {
          sink.setMode(JSON.parse(body).mode);
          reply(200, { ok: true });
        } catch {
          reply(400, { ok: false });
        }
      });
    } else {
      reply(404, {});
    }
  });
  control.listen(8025, '0.0.0.0');
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
