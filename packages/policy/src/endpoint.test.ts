// TR-022 and the check half of FAULT-10: what an endpoint may look like, before any DNS or socket. A tenant
// supplies `endpointUrl` and an operator supplies `settings`, so every case here is a tenant trying it on.
import { describe, expect, it } from 'vitest';
import { checkEndpoint, classifyAddress, sameAddress, type EndpointSettings } from './endpoint';

const NO_LIST: EndpointSettings = { privateEndpoints: [] };
const refused = { ok: false, code: 'MODEL_ENDPOINT_NOT_ALLOWED' };

describe('hosted kinds have a fixed host list', () => {
  it('accepts the two hosted addresses, over HTTPS, with no allowlist flag', () => {
    expect(checkEndpoint('openai_hosted', 'https://api.openai.com/v1', NO_LIST)).toEqual({
      ok: true,
      host: 'api.openai.com',
      port: 443,
      viaPrivateAllowlist: false,
    });
    expect(checkEndpoint('anthropic_hosted', 'https://api.anthropic.com/v1/', NO_LIST)).toEqual({
      ok: true,
      host: 'api.anthropic.com',
      port: 443,
      viaPrivateAllowlist: false,
    });
  });

  it.each([
    ['openai_hosted', 'https://api.anthropic.com/v1'],
    ['anthropic_hosted', 'https://api.openai.com/v1'],
    ['openai_hosted', 'http://api.openai.com/v1'],
    ['openai_hosted', 'https://api.openai.com:8443/v1'],
    ['openai_hosted', 'https://api.openai.com.evil.example/v1'],
    ['openai_hosted', 'https://evil.example/api.openai.com/v1'],
    ['openai_hosted', 'https://api.openai.com@evil.example/v1'],
    ['openai_hosted', 'https://user:pass@api.openai.com/v1'],
    ['openai_hosted', 'https://api.openai.com./v1'],
    ['openai_hosted', 'https://api.openai.com/other'],
    ['openai_hosted', 'https://api.openai.com'],
    ['openai_hosted', 'https://api.openai.com/v1?x=1'],
    ['openai_hosted', 'https://api.openai.com/v1#x'],
    ['openai_hosted', 'https://api.openai.com/v1?'],
    ['anthropic_hosted', 'https://evil.example/v1'],
  ] as const)('%s refuses %s', (kind, url) => {
    expect(checkEndpoint(kind, url, NO_LIST)).toEqual(refused);
  });

  it('never takes a hosted kind from the operator list, even an origin the list names', () => {
    const settings = { privateEndpoints: ['https://evil.example'] };
    expect(checkEndpoint('openai_hosted', 'https://evil.example/v1', settings)).toEqual(refused);
  });
});

describe('openai_compatible needs an HTTPS public address', () => {
  it('accepts a public name over HTTPS', () => {
    expect(
      checkEndpoint('openai_compatible', 'https://models.example.com/openai/v1', NO_LIST),
    ).toEqual({ ok: true, host: 'models.example.com', port: 443, viaPrivateAllowlist: false });
    expect(checkEndpoint('openai_compatible', 'https://models.example.com:8443', NO_LIST)).toEqual({
      ok: true,
      host: 'models.example.com',
      port: 8443,
      viaPrivateAllowlist: false,
    });
  });

  it.each([
    'http://models.example.com/v1',
    // Cloud metadata, in every spelling the URL parser normalizes to it.
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:169.254.169.254]/',
    'https://2852039166/',
    'https://0xa9fea9fe/',
    'https://0251.0376.0251.0376/',
    'https://metadata.google.internal/',
    'https://100.100.100.200/',
    'https://[fd00:ec2::254]/',
    // RFC1918.
    'https://10.0.0.1/v1',
    'https://172.16.0.1/v1',
    'https://172.31.255.255/v1',
    'https://192.168.1.1/v1',
    // Loopback, by address and by name.
    'https://127.0.0.1/v1',
    'https://127.1/v1',
    'https://2130706433/v1',
    'https://[::1]/v1',
    'https://localhost/v1',
    'https://LOCALHOST./v1',
    'https://anything.localhost/v1',
    // IPv6 forms that carry a private IPv4 address.
    'https://[::ffff:127.0.0.1]/v1',
    'https://[::ffff:10.0.0.1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[::127.0.0.1]/v1',
    'https://[64:ff9b::7f00:1]/v1',
    'https://[2002:7f00:1::]/v1',
    // Link-local and other non-global IPv6.
    'https://[fe80::1]/v1',
    'https://[fc00::1]/v1',
    'https://[fd12:3456::1]/v1',
    'https://[ff02::1]/v1',
    'https://[::]/v1',
    // Other reserved IPv4.
    'https://0.0.0.0/v1',
    'https://100.64.0.1/v1',
    'https://198.18.0.1/v1',
    'https://224.0.0.1/v1',
    'https://255.255.255.255/v1',
    // Names that only mean something inside a network.
    'https://ollama/v1',
    'https://ollama.local/v1',
    'https://ollama.internal/v1',
    'https://ollama.corp/v1',
    'https://router.lan/v1',
    'https://printer.home.arpa/v1',
    // URLs that do not mean what they appear to.
    'https://user@models.example.com/v1',
    'https://models.example.com/v1?key=1',
    'https://models.example.com/v1#x',
    'https://models.example.com\\@evil.example/v1',
    'https://models.example.com/\tv1',
    ' https://models.example.com/v1',
    'ftp://models.example.com/v1',
    'file:///etc/passwd',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(checkEndpoint('openai_compatible', url, NO_LIST)).toEqual(refused);
  });
});

describe('private and plain HTTP addresses come only from the operator', () => {
  const operator = {
    privateEndpoints: ['http://10.0.0.5:11434', 'http://127.0.0.1:8080/ignored-path'],
  };

  it('lets the operator list a private endpoint for both self-hosted kinds', () => {
    expect(checkEndpoint('local_openai_compatible', 'http://10.0.0.5:11434/v1', operator)).toEqual({
      ok: true,
      host: '10.0.0.5',
      port: 11434,
      viaPrivateAllowlist: true,
    });
    expect(checkEndpoint('openai_compatible', 'http://127.0.0.1:8080/v1', operator)).toEqual({
      ok: true,
      host: '127.0.0.1',
      port: 8080,
      viaPrivateAllowlist: true,
    });
  });

  it('matches the whole origin, so another port or scheme on that host is not listed', () => {
    for (const url of [
      'http://10.0.0.5:11435/v1',
      'https://10.0.0.5:11434/v1',
      'http://10.0.0.5/v1',
      'http://10.0.0.6:11434/v1',
    ]) {
      expect(checkEndpoint('local_openai_compatible', url, operator)).toEqual(refused);
      expect(checkEndpoint('openai_compatible', url, operator)).toEqual(refused);
    }
  });

  it('refuses a local kind with no operator list at all, whatever the address', () => {
    for (const url of ['http://127.0.0.1:8080/v1', 'https://models.example.com/v1']) {
      expect(checkEndpoint('local_openai_compatible', url, NO_LIST)).toEqual(refused);
    }
  });

  it('gives a tenant no way to add an address: nothing in the URL reaches the list', () => {
    const tricks = [
      'http://10.0.0.5:11434@evil.example/v1',
      'http://evil.example/?http://10.0.0.5:11434',
      'http://evil.example/http://10.0.0.5:11434',
      'http://evil.example#http://10.0.0.5:11434',
    ];
    for (const url of tricks) {
      expect(checkEndpoint('local_openai_compatible', url, operator)).toEqual(refused);
      expect(checkEndpoint('openai_compatible', url, operator)).toEqual(refused);
    }
  });

  it('ignores a list entry that is not an origin, so a typo can never allow everything', () => {
    const settings = { privateEndpoints: ['*', 'null', '', 'ftp://10.0.0.5', '10.0.0.5:11434'] };
    for (const url of ['http://10.0.0.5:11434/v1', 'ftp://10.0.0.5/v1', 'file:///x']) {
      expect(checkEndpoint('local_openai_compatible', url, settings)).toEqual(refused);
    }
  });

  it('refuses cloud metadata even if the operator lists it, because no model lives there', () => {
    const settings = {
      privateEndpoints: [
        'http://169.254.169.254',
        'http://[fe80::1]',
        'http://0.0.0.0',
        'http://100.100.100.200',
        'http://[fd00:ec2::254]',
      ],
    };
    for (const url of settings.privateEndpoints) {
      expect(checkEndpoint('local_openai_compatible', `${url}/v1`, settings)).toEqual(refused);
      expect(checkEndpoint('openai_compatible', `${url}/v1`, settings)).toEqual(refused);
    }
  });
});

describe('classifyAddress', () => {
  it.each([
    ['93.184.216.34', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'private'],
    ['127.255.255.254', 'private'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['100.64.0.1', 'private'],
    ['::1', 'private'],
    ['fc00::1', 'private'],
    ['fdff::1', 'private'],
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:93.184.216.34', 'public'],
    ['169.254.169.254', 'forbidden'],
    ['169.254.0.1', 'forbidden'],
    ['::ffff:169.254.169.254', 'forbidden'],
    ['100.100.100.200', 'forbidden'],
    ['168.63.129.16', 'forbidden'],
    ['fd00:ec2::254', 'forbidden'],
    ['fe80::1', 'forbidden'],
    ['febf::1', 'forbidden'],
    ['ff02::1', 'forbidden'],
    ['::', 'forbidden'],
    ['0.0.0.0', 'forbidden'],
    ['0.1.2.3', 'forbidden'],
    ['192.0.0.192', 'forbidden'],
    ['192.0.2.1', 'forbidden'],
    ['198.18.0.1', 'forbidden'],
    ['198.51.100.1', 'forbidden'],
    ['203.0.113.1', 'forbidden'],
    ['224.0.0.1', 'forbidden'],
    ['240.0.0.1', 'forbidden'],
    ['255.255.255.255', 'forbidden'],
    ['2001:db8::1', 'forbidden'],
    ['2001:0:4136::1', 'forbidden'],
    ['2002:7f00:1::', 'forbidden'],
    ['64:ff9b::7f00:1', 'forbidden'],
    ['::127.0.0.1', 'forbidden'],
    ['not-an-address', 'forbidden'],
    ['1.2.3', 'forbidden'],
    ['1.2.3.256', 'forbidden'],
    ['01.2.3.4', 'forbidden'],
    ['1:2:3', 'forbidden'],
    ['1::2::3', 'forbidden'],
    ['', 'forbidden'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('never treats a numeric host the URL parser would rewrite as anything but its address', () => {
    expect(classifyAddress(new URL('http://0x7f.1/').hostname)).toBe('private');
    expect(classifyAddress(new URL('http://2130706433/').hostname)).toBe('private');
  });
});

describe('sameAddress', () => {
  it('compares by value, however it was written', () => {
    expect(sameAddress('127.0.0.1', '::ffff:127.0.0.1')).toBe(true);
    expect(sameAddress('::1', '0:0:0:0:0:0:0:1')).toBe(true);
    expect(sameAddress('127.0.0.1', '127.0.0.2')).toBe(false);
    expect(sameAddress('127.0.0.1', '::1')).toBe(false);
    expect(sameAddress('garbage', 'garbage')).toBe(false);
  });
});
