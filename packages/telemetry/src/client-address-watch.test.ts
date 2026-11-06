// ADR-037 D9. The warning has to appear for the one pattern it describes, stay quiet for everything that
// only looks like it, and leave no address or ID behind, in what it says or in what it holds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientAddressWatch, isNonPublicAddress } from './client-address-watch';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PRIVATE = '10.1.2.3';
const PUBLIC = '203.0.113.9';

function aWatch() {
  let time = 1_000_000;
  const onSuspected = vi.fn();
  const watch = createClientAddressWatch({ onSuspected, now: () => time });
  const people = (count: number, address: string | null, from = 0) => {
    for (let person = from; person < from + count; person += 1) {
      watch.observe(address, `user-${person}`);
    }
  };
  return { watch, onSuspected, people, pass: (ms: number) => (time += ms) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('watching client addresses', () => {
  it('says nothing about four people', () => {
    const { onSuspected, people } = aWatch();
    people(4, PRIVATE);
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('warns once when five people arrive from one private address', () => {
    const { onSuspected, people } = aWatch();
    people(5, PRIVATE);
    expect(onSuspected).toHaveBeenCalledTimes(1);
    expect(onSuspected).toHaveBeenCalledWith({ identities: 5 });
  });

  it('does not repeat itself for more people in the same window', () => {
    const { onSuspected, people } = aWatch();
    people(10, PRIVATE);
    expect(onSuspected).toHaveBeenCalledTimes(1);
  });

  it('does not repeat itself in a later window within the hour', () => {
    const { onSuspected, people, pass } = aWatch();
    people(5, PRIVATE);
    pass(HOUR - 1 - 10 * MINUTE);
    people(5, PRIVATE);
    pass(10 * MINUTE);
    people(5, PRIVATE);
    expect(onSuspected).toHaveBeenCalledTimes(1);
  });

  it('can warn again once the hour has passed', () => {
    const { onSuspected, people, pass } = aWatch();
    people(5, PRIVATE);
    pass(HOUR);
    people(4, PRIVATE);
    expect(onSuspected).toHaveBeenCalledTimes(1);
    people(1, PRIVATE, 4);
    expect(onSuspected).toHaveBeenCalledTimes(2);
  });

  it('honours the settings it is given', () => {
    let time = 0;
    const onSuspected = vi.fn();
    const watch = createClientAddressWatch({
      onSuspected,
      now: () => time,
      windowMs: 100,
      minIdentities: 2,
      repeatEveryMs: 1_000,
    });
    watch.observe(PRIVATE, 'a');
    expect(onSuspected).not.toHaveBeenCalled();
    watch.observe(PRIVATE, 'b');
    expect(onSuspected).toHaveBeenCalledWith({ identities: 2 });
    time = 999;
    watch.observe(PRIVATE, 'a');
    watch.observe(PRIVATE, 'b');
    expect(onSuspected).toHaveBeenCalledTimes(1);
    time = 1_000;
    watch.observe(PRIVATE, 'a');
    watch.observe(PRIVATE, 'b');
    expect(onSuspected).toHaveBeenCalledTimes(2);
  });

  it('says nothing about many people behind one public address, which is an ordinary office', () => {
    const { onSuspected, people } = aWatch();
    people(50, PUBLIC);
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('says nothing about an address it cannot read', () => {
    const { onSuspected, people } = aWatch();
    people(50, 'not-an-address');
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('clears the suspicion for the window when a second address appears', () => {
    const { watch, onSuspected, people } = aWatch();
    people(4, PRIVATE);
    watch.observe('10.1.2.4', 'someone-else');
    people(20, PRIVATE);
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('counts a public address as the second address', () => {
    const { watch, onSuspected, people } = aWatch();
    people(4, PRIVATE);
    watch.observe(PUBLIC, 'someone-else');
    people(20, PRIVATE);
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('does not suspect a private address that follows a public one in the window', () => {
    const { watch, onSuspected, people } = aWatch();
    watch.observe(PUBLIC, 'someone-else');
    people(20, PRIVATE);
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('looks again in the next window after a second address cleared this one', () => {
    const { watch, onSuspected, people, pass } = aWatch();
    people(4, PRIVATE);
    watch.observe('10.1.2.4', 'someone-else');
    pass(10 * MINUTE);
    people(5, PRIVATE);
    expect(onSuspected).toHaveBeenCalledTimes(1);
  });

  it('forgets who it saw when the window passes', () => {
    const { onSuspected, people, pass } = aWatch();
    people(4, PRIVATE);
    pass(10 * MINUTE);
    people(4, PRIVATE, 100);
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('still counts within the last moment of a window', () => {
    const { onSuspected, people, pass } = aWatch();
    people(4, PRIVATE);
    pass(10 * MINUTE - 1);
    people(1, PRIVATE, 100);
    expect(onSuspected).toHaveBeenCalledTimes(1);
  });

  it('forgets the window even if nobody ever arrives again', () => {
    // The clock here never moves, so only the end of the window itself can have emptied it.
    vi.useFakeTimers();
    const onSuspected = vi.fn();
    const watch = createClientAddressWatch({ onSuspected, now: () => 1_000 });
    for (const person of ['a', 'b', 'c', 'd']) watch.observe(PRIVATE, person);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(10 * MINUTE - 1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);

    watch.observe(PRIVATE, 'e');
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('counts one person seen a hundred times as one person', () => {
    const { watch, onSuspected } = aWatch();
    for (let visit = 0; visit < 100; visit += 1) watch.observe(PRIVATE, 'the-same-person');
    expect(onSuspected).not.toHaveBeenCalled();
  });

  it('ignores a missing address', () => {
    const { watch, onSuspected, people } = aWatch();
    people(20, null);
    expect(onSuspected).not.toHaveBeenCalled();

    // Neither does it count as a second address.
    people(4, PRIVATE);
    watch.observe(null, 'someone-else');
    people(1, PRIVATE, 4);
    expect(onSuspected).toHaveBeenCalledTimes(1);
  });

  describe('what it holds', () => {
    /** Runs `work` and reports the largest any Set became while it ran, and how often one grew. */
    function measuringSets(work: () => void) {
      const add = Set.prototype.add;
      let largest = 0;
      let added = 0;
      vi.spyOn(Set.prototype, 'add').mockImplementation(function (
        this: Set<unknown>,
        value: unknown,
      ) {
        const result = add.call(this, value);
        added += 1;
        largest = Math.max(largest, this.size);
        return result;
      });
      work();
      vi.restoreAllMocks();
      return { largest, added };
    }

    it('stays bounded through ten thousand people from one private address', () => {
      const { people, onSuspected } = aWatch();
      const held = measuringSets(() => people(10_000, PRIVATE));
      // `added` proves this measured something: if the watch stopped using a Set, this test has to change.
      expect(held.added).toBeGreaterThan(0);
      expect(held.largest).toBeLessThanOrEqual(5);
      expect(onSuspected).toHaveBeenCalledTimes(1);
    });

    it('holds no identity at all for a public address', () => {
      const { people } = aWatch();
      expect(measuringSets(() => people(10_000, PUBLIC)).added).toBe(0);
    });

    it('stops holding identities once a second address has appeared', () => {
      const { watch, people } = aWatch();
      people(4, PRIVATE);
      watch.observe('10.1.2.4', 'someone-else');
      expect(measuringSets(() => people(10_000, PRIVATE, 100)).added).toBe(0);
    });

    it('stays bounded across many windows', () => {
      const { people, pass } = aWatch();
      const held = measuringSets(() => {
        for (let window = 0; window < 100; window += 1) {
          people(100, PRIVATE, window * 100);
          pass(10 * MINUTE);
        }
      });
      expect(held.largest).toBeLessThanOrEqual(5);
    });

    it('leaves no timer behind while it holds nothing', () => {
      vi.useFakeTimers();
      const watch = createClientAddressWatch({ onSuspected: vi.fn() });
      expect(vi.getTimerCount()).toBe(0);
      watch.observe(null, 'someone');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps only one timer however many people arrive and windows pass', () => {
      vi.useFakeTimers();
      let time = 0;
      const watch = createClientAddressWatch({ onSuspected: vi.fn(), now: () => time });
      for (let person = 0; person < 50; person += 1) watch.observe(PRIVATE, `user-${person}`);
      expect(vi.getTimerCount()).toBe(1);
      time += 10 * MINUTE;
      watch.observe(PRIVATE, 'someone');
      expect(vi.getTimerCount()).toBe(1);
    });
  });

  it('tells the listener only the count, and writes nothing anywhere', () => {
    const canaryAddress = '10.99.88.77';
    const canaryIdentity = 'canary-identity-4f1d';
    const written: string[] = [];
    const record = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(record);
    vi.spyOn(process.stderr, 'write').mockImplementation(record);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        record(parts.join(' '));
      });
    }

    const received: unknown[][] = [];
    const watch = createClientAddressWatch({
      onSuspected: (...facts: unknown[]) => {
        received.push(facts);
      },
      now: () => 0,
    });
    watch.observe(canaryAddress, canaryIdentity);
    for (const person of ['b', 'c', 'd', 'e']) watch.observe(canaryAddress, person);

    expect(received).toEqual([[{ identities: 5 }]]);
    expect(written).toEqual([]);
    expect(JSON.stringify(received)).not.toContain(canaryAddress);
    expect(JSON.stringify(received)).not.toContain(canaryIdentity);
  });
});

describe('which addresses are not public', () => {
  const BLOCK_EDGES: [string, string[], string[]][] = [
    ['10/8', ['10.0.0.0', '10.255.255.255'], ['9.255.255.255', '11.0.0.0']],
    ['172.16/12', ['172.16.0.0', '172.31.255.255'], ['172.15.255.255', '172.32.0.0']],
    ['192.168/16', ['192.168.0.0', '192.168.255.255'], ['192.167.255.255', '192.169.0.0']],
    ['127/8', ['127.0.0.0', '127.255.255.255'], ['126.255.255.255', '128.0.0.0']],
    ['169.254/16', ['169.254.0.0', '169.254.255.255'], ['169.253.255.255', '169.255.0.0']],
    ['100.64/10', ['100.64.0.0', '100.127.255.255'], ['100.63.255.255', '100.128.0.0']],
  ];

  describe.each(BLOCK_EDGES)('%s', (_block, inside, outside) => {
    it.each(inside)('%s is inside', (address) => {
      expect(isNonPublicAddress(address)).toBe(true);
    });
    it.each(outside)('%s is outside', (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    });
    it.each(inside)('::ffff:%s, the mapped form, is inside', (address) => {
      expect(isNonPublicAddress(`::ffff:${address}`)).toBe(true);
    });
    it.each(outside)('::ffff:%s, the mapped form, is outside', (address) => {
      expect(isNonPublicAddress(`::ffff:${address}`)).toBe(false);
    });
  });

  it.each(['8.8.8.8', '203.0.113.9', '0.0.0.0', '255.255.255.255', '192.0.2.1'])(
    '%s is not one of the listed blocks',
    (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    },
  );

  it.each([
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    'fc00::',
    'FC00::1',
    'fd12:3456:789a::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::',
    'fe80::1',
    'FE80::1',
    'fe80::1%eth0',
    'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('%s is not public', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    '::',
    '::2',
    '::0',
    '1::1',
    '2001:db8::1',
    'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe00::',
    'fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fec0::',
    'ff02::1',
  ])('%s is public', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });

  it.each([
    '::FFFF:10.0.0.1',
    '0:0:0:0:0:ffff:10.0.0.1',
    '0000:0000:0000:0000:0000:ffff:192.168.1.1',
    '::ffff:a00:1', // 10.0.0.1, in hexadecimal.
    '::ffff:ac10:0', // 172.16.0.0
    '::ffff:ac1f:ffff', // 172.31.255.255
    '::ffff:7f00:1', // 127.0.0.1
    '::ffff:6440:0', // 100.64.0.0
  ])('%s is a mapped form of a listed block', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    '::ffff:8.8.8.8',
    '::ffff:ac0f:ffff', // 172.15.255.255
    '::ffff:ac20:0', // 172.32.0.0
    '::ffff:643f:ffff', // 100.63.255.255
    '::fffe:10.0.0.1', // Not the mapped prefix.
    '::10.0.0.1', // The old compatible form, which is not mapped.
    '1::ffff:10.0.0.1',
    '64:ff9b::10.0.0.1',
  ])('%s is not', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });

  it.each([
    'not-an-address',
    '',
    ' ',
    '1.2.3',
    '1.2.3.4.5',
    '999.1.1.1',
    '10.0.0.256',
    '010.0.0.1',
    ' 10.0.0.1',
    '10.0.0.1 ',
    '10.0.0.1:8080',
    '10.0.0.1/8',
    '10.0.0.1, 10.0.0.2',
    '[::1]',
    '::1/128',
    '::ffff:999.0.0.1',
    '1:2:3:4:5:6:7:8:9',
    'fc00::1::2',
    'gggg::1',
    'fe80::1%',
    'localhost',
  ])('"%s" cannot be read, so it does not count', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});
