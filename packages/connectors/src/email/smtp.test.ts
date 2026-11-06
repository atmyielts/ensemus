import { duplexPair } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ReplyReader } from './smtp';

function readerPair() {
  const [client, relay] = duplexPair();
  const reader = new ReplyReader(new AbortController().signal);
  reader.attach(client);
  return {
    reader,
    relay,
    close() {
      reader.dispose();
      client.destroy();
      relay.destroy();
    },
  };
}

const delivered = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SMTP unread reply limits', () => {
  it('reads fragmented multiline replies within the limit', async () => {
    const pair = readerPair();
    try {
      pair.relay.write('220-first\r');
      pair.relay.write('\n220 ready\r\n');
      expect(await pair.reader.next()).toBe(220);
      expect(pair.reader.offered()).toEqual(['FIRST', 'READY']);
      expect(pair.reader.hasUnread()).toBe(false);
    } finally {
      pair.close();
    }
  });

  it('refuses oversized multiline replies split across small chunks', async () => {
    const pair = readerPair();
    try {
      for (let index = 0; index < 200; index += 1) {
        pair.relay.write(`220-${'x'.repeat(1000)}\r\n`);
      }
      pair.relay.write('220 done\r\n');
      await delivered();
      await expect(pair.reader.next()).rejects.toThrow('CONNECTION_ENDED');
      expect(pair.reader.hasUnread()).toBe(false);
    } finally {
      pair.close();
    }
  });

  it('refuses a flood of completed replies that nobody has consumed', async () => {
    const pair = readerPair();
    try {
      for (let index = 0; index < 200; index += 1) {
        pair.relay.write(`250 ${'x'.repeat(1000)}\r\n`);
      }
      await delivered();
      await expect(pair.reader.next()).rejects.toThrow('CONNECTION_ENDED');
      expect(pair.reader.hasUnread()).toBe(false);
    } finally {
      pair.close();
    }
  });

  it('releases the budget as replies are consumed', async () => {
    const pair = readerPair();
    try {
      for (let index = 0; index < 100; index += 1) {
        pair.relay.write(`250 ${'x'.repeat(1000)}\r\n`);
        expect(await pair.reader.next()).toBe(250);
      }
      expect(pair.reader.hasUnread()).toBe(false);
    } finally {
      pair.close();
    }
  });
});
