// DOC-01, DOC-02: what makes a guide acceptable, apart from any file system, so a unit test can check
// each rule (tests/unit/guide-rules.test.ts). Dependency-free, like the other tools here.
//
// Guides describe real behaviour. So this refuses the things a confident writer adds by accident: a
// certification, a service level, a price, a recovery number, a legal term, a real address or an outside
// link. It cannot tell whether a sentence is true. A person checks that, and DOC-02 says who.

export const GUIDE_STATUSES = [
  'not_written', // A stub. Nothing to read yet.
  'not_in_product', // The feature is not on any branch yet, and the page says only that.
  'written_untested', // Written from the code. Nobody has followed it on a running system.
  'tested', // Each behaviour it describes has a named test that ran in CI.
  'walked_through', // Someone who did not write it followed it, and said so. Only a person sets this.
];
export const VISIBLE_STATUSES = ['written_untested', 'tested', 'walked_through'];
export const AUDIENCES = ['user', 'operator'];
export const MODES = ['cloud', 'byom', 'sovereign'];

export const STUB_LINE = 'This page has not been written yet.';
export const NOT_IN_PRODUCT_LINE = 'This is not in the product yet.';
export const UNTESTED_BANNER =
  '> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.';
export const NOT_A_CLAIM = '<!-- not-a-claim -->';

const NEGATION = /\b(not|no|never|without|none|cannot|isn't|doesn't|won't)\b/i;

/** Each is a claim only evidence or a person's decision could support. See ADR-036 D5. */
export const CLAIM_PATTERNS = [
  ['a certification', /\b(soc\s?[123]|iso([\s/-]?iec)?[\s-]?27\d{3}|hipaa|fedramp|pci[\s-]?dss|hitrust|fips\s?140)\b/i],
  ['a certification', /\bcertifi(ed|cation|cations)\b/i],
  ['a compliance claim', /\bcomplian(t|ce)\b/i],
  ['a service level', /\bSLAs?\b/],
  ['a service level', /\b(service[- ]level|uptime)\b/i],
  ['a service level', /\b\d+(\.\d+)?\s?%\s*(availability|uptime|of the time)\b/i],
  ['a recovery number', /\b(RTO|RPO)\b/],
  ['a recovery number', /\brecovery (time|point) objective\b/i],
  ['a price', /[$€£]\s?\d/],
  ['a price', /\b\d+(\.\d+)?\s?(usd|eur|gbp)\b/i],
  ['an air-gap claim', /\bair[\s-]?gap/i],
  ['an absolute', /\bguarantee[ds]?\b/i],
  ['an absolute', /\b100\s?%/],
  ['an absolute', /\b(unbreakable|unhackable|bank[- ]grade|military[- ]grade|bulletproof)\b/i],
  ['an absolute', /\bunlimited\b/i],
  ['a confidentiality claim', /\bzero[- ]knowledge\b/i],
  ['a confidentiality claim', /\bend[- ]to[- ]end encrypt/i],
  ['a confidentiality claim', /\bnever leaves\b/i],
  ['a provider data claim', /\b(not|never) used (for|to) train/i],
  ['a legal term', /\b(warrant(y|ies)|indemnif|liabilit(y|ies)|governing law)\b/i],
];

/** Each is refused everywhere, code blocks included. Guides use generated values and invalid addresses. */
const SECRET_PATTERNS = [
  ['an API key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bghp_[A-Za-z0-9]{20,}/],
  ['a Slack token', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// The last part is letters, so a pinned package such as next@16.4.5 is not an address.
const EMAIL = /[\w.+-]+@[a-z][\w-]*(?:\.[\w-]+)*\.[a-z]{2,}\b/gi;
const URL_HOST = /\bhttps?:\/\/([^\s/)>'"`:]+)/gi;
const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.invalid|.+\.example)$/i;

/** Returns the fields of a small YAML subset: `key: value` and `key: [a, b]`, and the rest of the text. */
export function parseFrontMatter(text) {
  const normal = text.replaceAll('\r\n', '\n');
  if (!normal.startsWith('---\n')) return { fields: null, body: normal };
  const end = normal.indexOf('\n---\n', 3);
  if (end < 0) return { fields: null, body: normal };
  const fields = {};
  for (const line of normal.slice(4, end).split('\n')) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim();
    fields[key] = /^\[.*\]$/.test(value)
      ? value
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value;
  }
  return { fields, body: normal.slice(end + 5) };
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Text with `code`, **strong** and [links]. Nothing else, so nothing has to be trusted as HTML. */
export function parseInline(raw) {
  const parts = [];
  let at = 0;
  for (const match of raw.matchAll(INLINE)) {
    if (match.index > at) parts.push({ t: 'text', v: raw.slice(at, match.index) });
    if (match[1] !== undefined) parts.push({ t: 'code', v: match[1] });
    else if (match[2] !== undefined) parts.push({ t: 'strong', v: match[2] });
    else parts.push({ t: 'link', v: match[3], href: match[4] });
    at = match.index + match[0].length;
  }
  if (at < raw.length) parts.push({ t: 'text', v: raw.slice(at) });
  return parts;
}

const stripMarker = (line) => line.replace(NOT_A_CLAIM, '').trimEnd();
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/**
 * The block structure of a guide. Anything outside the subset becomes a problem instead of being passed
 * through, because the same blocks are what the product renders for people (ADR-036 D4).
 */
export function parseBlocks(body) {
  const blocks = [];
  const problems = [];
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ b: 'p', inline: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const number = i + 1;
    if (line.startsWith('```')) {
      flush();
      const code = [];
      const lang = line.slice(3).trim();
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      if (i >= lines.length) problems.push(`line ${number}: a code block never closes`);
      blocks.push({ b: 'code', lang, text: code.join('\n') });
      continue;
    }
    const text = stripMarker(line);
    if (!text.trim()) {
      flush();
      continue;
    }
    const withoutCode = text.replace(/`[^`]*`/g, '');
    if (/<\/?[a-z!][^>]*>/i.test(withoutCode)) {
      problems.push(`line ${number}: raw HTML is not allowed in a guide`);
    }
    if (/!\[[^\]]*\]\(/.test(withoutCode)) {
      problems.push(`line ${number}: images are not supported in a guide yet`);
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      flush();
      const level = heading[1].length;
      if (level > 3) problems.push(`line ${number}: use headings of level 3 or above`);
      blocks.push({ b: 'h', level, inline: parseInline(heading[2]) });
      continue;
    }
    if (text.startsWith('>')) {
      flush();
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(stripMarker(lines[i]).replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      blocks.push({ b: 'quote', inline: parseInline(quoted.join(' ')) });
      continue;
    }
    const item = /^(-|\d+\.)\s+(.*)$/.exec(text);
    if (item) {
      flush();
      const ordered = item[1] !== '-';
      const items = [];
      while (i < lines.length) {
        const current = stripMarker(lines[i]);
        const next = /^(-|\d+\.)\s+(.*)$/.exec(current);
        if (next && next[1] !== '-' === ordered) items.push(next[2]);
        else if (/^\s+(-|\d+\.)\s/.test(current)) {
          problems.push(`line ${i + 1}: nested lists are not supported in a guide`);
        } else if (/^\s+\S/.test(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`;
        } else break;
        i += 1;
      }
      i -= 1;
      blocks.push({ b: ordered ? 'ol' : 'ul', items: items.map(parseInline) });
      continue;
    }
    if (text.startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(cells(stripMarker(lines[i])));
        i += 1;
      }
      i -= 1;
      const [head, rule, ...data] = rows;
      if (!rule || !rule.every((cell) => /^:?-+:?$/.test(cell))) {
        problems.push(`line ${number}: a table needs a header row and a separator row`);
        continue;
      }
      if (data.some((row) => row.length !== head.length)) {
        problems.push(`line ${number}: every row of a table needs the same number of cells`);
      }
      blocks.push({
        b: 'table',
        head: head.map(parseInline),
        rows: data.map((row) => row.map(parseInline)),
      });
      continue;
    }
    paragraph.push(text.trim());
  }
  flush();
  return { blocks, problems };
}

/** The claims in the prose of a guide, by line. A code block is commands, not a statement to a reader. */
export function claimProblems(body) {
  const problems = [];
  let inCode = false;
  body
    .replaceAll('\r\n', '\n')
    .split('\n')
    .forEach((line, index) => {
      if (line.startsWith('```')) {
        inCode = !inCode;
        return;
      }
      if (inCode) return;
      const marked = line.includes(NOT_A_CLAIM);
      const text = stripMarker(line);
      const found = CLAIM_PATTERNS.filter(([, pattern]) => pattern.test(text));
      if (found.length === 0) {
        if (marked) problems.push(`line ${index + 1}: ${NOT_A_CLAIM} on a line with no claim`);
        return;
      }
      // A line may say what is not claimed, and has to say so on the line itself.
      if (marked && NEGATION.test(text)) return;
      const what = [...new Set(found.map(([name]) => name))].join(', ');
      problems.push(
        marked
          ? `line ${index + 1}: ${NOT_A_CLAIM} needs a negative statement, and this line makes ${what}`
          : `line ${index + 1}: this looks like ${what}. Remove it, or if it says what is not claimed, end the line with ${NOT_A_CLAIM}`,
      );
    });
  return problems;
}

/** Secrets, addresses and hosts, anywhere in a guide. */
export function valueProblems(body) {
  const problems = [];
  for (const [what, pattern] of SECRET_PATTERNS) {
    if (pattern.test(body)) problems.push(`it holds what looks like ${what}`);
  }
  for (const [address] of body.matchAll(EMAIL)) {
    if (!/\.invalid$/i.test(address)) {
      problems.push(`${address} is a real-looking address. Use an @example.invalid one`);
    }
  }
  for (const [, host] of body.matchAll(URL_HOST)) {
    if (!ALLOWED_HOST.test(host)) {
      problems.push(`${host} is an outside host. A guide has to work with no network`);
    }
  }
  return problems;
}

const inlineLinks = (blocks) => {
  const out = [];
  const walk = (inline) => {
    for (const part of inline) if (part.t === 'link') out.push(part.href);
  };
  for (const block of blocks) {
    if (block.inline) walk(block.inline);
    if (block.items) block.items.forEach(walk);
    if (block.head) block.head.forEach(walk);
    if (block.rows) block.rows.forEach((row) => row.forEach(walk));
  }
  return out;
};

const joinRelative = (from, href) => {
  const parts = from.split('/').slice(0, -1);
  for (const piece of href.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.') parts.push(piece);
  }
  return parts.join('/');
};

/**
 * Everything about one guide. `path` is relative to docs/guides, such as `user/approvals.md`.
 * `exists(path)` says whether a file exists, relative to docs/guides.
 * `sourceExists(entry)` says whether a `sources` or `tests` entry can be found.
 */
export function checkPage(path, text, { exists, sourceExists, knownTickets }) {
  const problems = [];
  const { fields, body } = parseFrontMatter(text);
  if (!fields) return { problems: ['it has no front matter'], fields: null, blocks: [] };
  const audience = path.split('/')[0];
  for (const key of ['title', 'audience', 'area', 'status']) {
    if (typeof fields[key] !== 'string' || !fields[key]) problems.push(`${key} is missing`);
  }
  for (const key of ['tickets', 'modes', 'sources', 'tests']) {
    if (!Array.isArray(fields[key])) problems.push(`${key} must be a list`);
  }
  if (fields.audience !== audience) problems.push(`audience must be ${audience} in this folder`);
  if (!GUIDE_STATUSES.includes(fields.status)) problems.push(`status "${fields.status}" is unknown`);
  for (const mode of fields.modes ?? []) {
    if (!MODES.includes(mode)) problems.push(`mode "${mode}" is unknown`);
  }
  if (Array.isArray(fields.modes) && fields.modes.length === 0) problems.push('modes is empty');
  for (const ticket of fields.tickets ?? []) {
    if (!knownTickets.has(ticket)) problems.push(`ticket ${ticket} is not in the backlog`);
  }

  const { blocks, problems: structure } = parseBlocks(body);
  problems.push(...structure, ...claimProblems(body), ...valueProblems(text));

  const trimmed = body.trim();
  const title = blocks[0]?.b === 'h' && blocks[0].level === 1 ? blocks[0].inline : null;
  const titleText = title?.map((part) => part.v).join('');
  if (titleText !== fields.title) problems.push('the first line must be a # heading of its title');
  if (blocks.filter((block) => block.b === 'h' && block.level === 1).length > 1) {
    problems.push('a guide has one # heading');
  }
  const afterTitle = trimmed.replace(/^#[^\n]*\n*/, '').trim();

  if (fields.status === 'not_written') {
    if (afterTitle !== STUB_LINE) problems.push(`a not_written page says only "${STUB_LINE}"`);
  }
  if (fields.status === 'not_in_product') {
    if (!afterTitle.startsWith(NOT_IN_PRODUCT_LINE)) {
      problems.push(`a not_in_product page starts with "${NOT_IN_PRODUCT_LINE}"`);
    }
    if (afterTitle.length > 600) {
      problems.push('a not_in_product page says what is missing, and does not describe it');
    }
  }
  if (fields.status === 'written_untested' && !afterTitle.startsWith(UNTESTED_BANNER)) {
    problems.push('a written_untested page starts with the exact banner in guide-rules.mjs');
  }
  if (['written_untested', 'tested', 'walked_through'].includes(fields.status)) {
    if (!fields.sources?.length) problems.push('a written page names the sources it was read from');
    for (const source of fields.sources ?? []) {
      if (!sourceExists(source)) problems.push(`source ${source} cannot be found`);
    }
  }
  if (fields.status === 'tested') {
    if (!fields.tests?.length) problems.push('a tested page names the tests that prove it');
    for (const test of fields.tests ?? []) {
      if (!sourceExists(test)) problems.push(`test ${test} cannot be found`);
    }
  }
  if (fields.status === 'walked_through') {
    if (!fields.walked_through_by || !fields.walked_through_on) {
      problems.push('a walked_through page names who followed it, and when');
    }
  } else if (fields.walked_through_by || fields.walked_through_on) {
    problems.push('only a walked_through page names who followed it');
  }

  for (const href of inlineLinks(blocks)) {
    if (/^https?:/i.test(href)) {
      problems.push(`link ${href} leaves the guides. A guide has to work with no network`);
      continue;
    }
    if (href.startsWith('#')) continue;
    const target = joinRelative(path, href.split('#')[0]);
    if (!exists(target)) problems.push(`link ${href} goes nowhere`);
    // What the product shows people can link only to what the product shows them.
    else if (audience === 'user' && !target.startsWith('user/')) {
      problems.push(`link ${href}: a user guide can only link to other user guides`);
    }
  }
  return { problems, fields, blocks };
}

/** Every ticket up to M8 is documented or has a stated reason not to be. */
export function coverageProblems(pages, exempt, tickets, inScope = /^M[1-8]$/) {
  const problems = [];
  const documented = new Set(pages.flatMap((page) => page.fields?.tickets ?? []));
  const known = new Set(tickets.map((ticket) => ticket.id));
  for (const ticket of tickets) {
    if (!inScope.test(ticket.milestone)) continue;
    const listed = exempt.has(ticket.id);
    if (!documented.has(ticket.id) && !listed) {
      problems.push(`${ticket.id} (${ticket.milestone}) has no guide and no stated reason`);
    }
    if (documented.has(ticket.id) && listed) {
      problems.push(`${ticket.id} has a guide, so it should not be exempt`);
    }
  }
  for (const [id, reason] of exempt) {
    if (!known.has(id)) problems.push(`exempt ticket ${id} is not in the backlog`);
    if (!reason?.trim()) problems.push(`exempt ticket ${id} gives no reason`);
  }
  return problems;
}

/** The guides on disk and the guides in the index are the same list, with no page twice. */
export function indexProblems(index, onDisk) {
  const problems = [];
  const listed = index.sections.flatMap((section) => section.pages);
  const seen = new Set();
  for (const page of listed) {
    if (seen.has(page)) problems.push(`${page} is in the index twice`);
    seen.add(page);
    if (!onDisk.includes(page)) problems.push(`${page} is in the index but not on disk`);
  }
  for (const page of onDisk) {
    if (!seen.has(page)) problems.push(`${page} is on disk but not in the index`);
  }
  return problems;
}

/** What a release needs beyond a clean check. A stub or an unfollowed install guide stops it. */
export function releaseProblems(pages) {
  const problems = [];
  for (const { path, fields } of pages) {
    if (!fields) continue;
    if (fields.status === 'not_written') problems.push(`${path} has not been written`);
    if (fields.status === 'not_in_product') problems.push(`${path}: the feature is not built`);
    if (fields.status === 'written_untested') problems.push(`${path} has not been tested`);
    if (fields.needs_walkthrough === 'true' && fields.status !== 'walked_through') {
      problems.push(`${path} has not been followed by someone who did not write it (DOC-02)`);
    }
  }
  return problems;
}

export const HELP_MODULE_PATH = 'apps/web/src/generated/guides.ts';

const HELP_HEADER = `// Generated by docs/specifications/tools/build-help.mjs from docs/guides/user. Do not edit: change the
// guide and run pnpm guides:build. docs/ does not reach the image, so what people read has to be here.
export type GuideInline =
  | { readonly t: 'text' | 'code' | 'strong'; readonly v: string }
  | { readonly t: 'link'; readonly v: string; readonly href: string };

export type GuideBlock =
  | { readonly b: 'h'; readonly level: number; readonly inline: readonly GuideInline[] }
  | { readonly b: 'p' | 'quote'; readonly inline: readonly GuideInline[] }
  | { readonly b: 'ul' | 'ol'; readonly items: readonly (readonly GuideInline[])[] }
  | { readonly b: 'code'; readonly lang: string; readonly text: string }
  | {
      readonly b: 'table';
      readonly head: readonly (readonly GuideInline[])[];
      readonly rows: readonly (readonly (readonly GuideInline[])[])[];
    };

export interface GuidePage {
  readonly slug: string;
  readonly title: string;
  readonly section: string;
  readonly modes: readonly ('cloud' | 'byom' | 'sovereign')[];
  readonly status: 'written_untested' | 'tested' | 'walked_through';
  readonly blocks: readonly GuideBlock[];
}

export interface GuideSection {
  readonly id: string;
  readonly title: string;
}
`;

/** Only what a person can read: written pages for users. A link to another guide becomes its slug. */
export function renderHelpModule(index, pages) {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const sections = index.sections.filter((section) => section.audience === 'user');
  const slugOf = (path) => path.replace(/^user\//, '').replace(/\.md$/, '');
  const visible = new Set(
    pages
      .filter((page) => VISIBLE_STATUSES.includes(page.fields?.status))
      .map((page) => page.path),
  );
  const relink = (inline) =>
    inline.map((part) => {
      if (part.t !== 'link' || part.href.startsWith('#')) return part;
      const [file, anchor] = part.href.split('#');
      const target = joinRelative('user/x.md', file);
      // A link to a page people cannot read yet is plain text, so nobody follows it to a dead end.
      if (!visible.has(target)) return { t: 'text', v: part.v };
      return { t: 'link', v: part.v, href: `${slugOf(target)}${anchor ? `#${anchor}` : ''}` };
    });
  const relinkBlock = (block) => {
    if (block.inline) return { ...block, inline: relink(block.inline) };
    if (block.items) return { ...block, items: block.items.map(relink) };
    if (block.head) {
      return {
        ...block,
        head: block.head.map(relink),
        rows: block.rows.map((row) => row.map(relink)),
      };
    }
    return block;
  };
  const output = sections.flatMap((section) =>
    section.pages
      .filter((path) => visible.has(path))
      .map((path) => {
        const page = byPath.get(path);
        return {
          slug: slugOf(path),
          title: page.fields.title,
          section: section.id,
          modes: page.fields.modes,
          status: page.fields.status,
          blocks: page.blocks.slice(1).map(relinkBlock),
        };
      }),
  );
  const sectionList = sections.map(({ id, title }) => ({ id, title }));
  return `${HELP_HEADER}
export const GUIDE_SECTIONS: readonly GuideSection[] = ${JSON.stringify(sectionList, null, 2)};

export const GUIDE_PAGES: readonly GuidePage[] = ${JSON.stringify(output, null, 2)};
`;
}
