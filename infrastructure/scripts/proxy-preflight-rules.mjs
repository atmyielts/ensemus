// What the proxy preflight decides, apart from the file it reads, so that a unit test can check each
// decision. See tests/unit/proxy-preflight-rules.test.ts and ADR-037 D9. A finding names a setting and
// never quotes its value, so its output is safe to paste anywhere.

const SETTING = 'ENSEMUS_TRUSTED_PROXIES';
const WIDEST_ACCEPTED_PREFIX = 8;
const TRUSTS_ALL = new Set(['private_ranges', '0.0.0.0/0', '::/0']);

const isLoopbackIpv4 = (value) => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);

/** Whether a host name or address can only be reached from this machine. */
function isLoopback(host) {
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    isLoopbackIpv4(name) ||
    name === '::1' ||
    name === '[::1]'
  );
}

/** The host in a URL, or nothing if it cannot be read. A bad URL stops the app in its own way. */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const proxyList = (env) => (env[SETTING] ?? '').split(/[\s,]+/).filter(Boolean);

function trustsTooMuch(entry) {
  if (TRUSTS_ALL.has(entry.toLowerCase())) return true;
  const prefix = /\/(\d+)$/.exec(entry)?.[1];
  return prefix !== undefined && Number(prefix) < WIDEST_ACCEPTED_PREFIX;
}

/** What cannot be right about these settings, as `{ code, setting }`. An empty list says nothing is. */
export function proxyFindings(env) {
  const findings = [];
  const list = proxyList(env);
  const publicHost = hostOf(env.ENSEMUS_PUBLIC_URL ?? '');
  // An empty setting counts as unset, as it does for Compose's `${ENSEMUS_BIND_ADDRESS:-127.0.0.1}`.
  const bindAddress = env.ENSEMUS_BIND_ADDRESS?.trim() ?? '';
  if (
    publicHost !== '' &&
    !isLoopback(publicHost) &&
    (bindAddress === '' || isLoopback(bindAddress)) &&
    list.length === 0
  ) {
    findings.push({ code: 'PUBLIC_NAME_ON_LOOPBACK_WITH_NO_PROXY_LISTED', setting: SETTING });
  }
  if (list.some(trustsTooMuch)) {
    findings.push({ code: 'PROXY_LIST_TRUSTS_TOO_MUCH', setting: SETTING });
  }
  return findings;
}

function unquoted(raw) {
  const value = raw.trim();
  const quote = value[0];
  if (quote === "'") {
    const end = value.indexOf("'", 1);
    if (end > 0) return value.slice(1, end);
  } else if (quote === '"') {
    const closed = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (closed) return closed[1].replace(/\\(.)/g, '$1');
  }
  // Unquoted, where a comment needs a space before it, so `a#b` stays whole.
  return value.split(/\s#/, 1)[0].replace(/^#.*/, '').trim();
}

/** Reads an env file. A later line wins over an earlier one. */
export function parseEnvFile(text) {
  const entries = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (assignment) entries.push([assignment[1], unquoted(assignment[2])]);
  }
  return Object.fromEntries(entries);
}

const EXPLANATIONS = {
  PUBLIC_NAME_ON_LOOPBACK_WITH_NO_PROXY_LISTED:
    'The public address is a real name and the port is bound to loopback, so something on this host must be forwarding to it, and no proxy is listed. Everyone would share one sign-in allowance.',
  PROXY_LIST_TRUSTS_TOO_MUCH:
    'The list of trusted proxies is very wide, and anyone connecting from inside it can state any client address.',
};

/** One line for a finding: fixed text, naming the setting and never its value. */
export const describeFinding = ({ code, setting }) =>
  `WARNING ${code} (${setting}): ${EXPLANATIONS[code]}`;
