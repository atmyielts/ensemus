// DOC-01, DOC-02: what makes a guide acceptable. The tool's job is to refuse what a confident writer adds
// by accident, so most of this is refusals.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkPage,
  claimProblems,
  coverageProblems,
  indexProblems,
  NOT_A_CLAIM,
  NOT_IN_PRODUCT_LINE,
  parseBlocks,
  parseFrontMatter,
  parseInline,
  releaseProblems,
  renderHelpModule,
  STUB_LINE,
  UNTESTED_BANNER,
  valueProblems,
} from '../../docs/specifications/tools/guide-rules.mjs';

const context = {
  exists: (path: string) => ['user/other.md', 'operator/run.md'].includes(path),
  sourceExists: (entry: string) => entry === 'apps/web/src/app/page.tsx',
  knownTickets: new Set(['WORK-05', 'UX-14']),
};

const page = (body: string, over: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    title: 'Approvals',
    audience: 'user',
    area: 'work',
    tickets: '[WORK-05]',
    modes: '[cloud, byom, sovereign]',
    status: 'written_untested',
    sources: '[apps/web/src/app/page.tsx]',
    tests: '[]',
    ...over,
  };
  const head = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return `---\n${head}\n---\n\n# ${fields.title}\n\n${body}\n`;
};
const written = (body: string) => page(`${UNTESTED_BANNER}\n\n${body}`);
const problemsIn = (text: string, path = 'user/approvals.md') =>
  checkPage(path, text, context).problems;

describe('a well-formed page', () => {
  it('passes', () => {
    expect(problemsIn(written('Open **Approvals** and read `the action`.'))).toEqual([]);
  });

  it('can be a stub that says only that', () => {
    const stub = page(STUB_LINE, { status: 'not_written', sources: '[]' });
    expect(problemsIn(stub)).toEqual([]);
  });

  it('can say a feature is not built', () => {
    const missing = page(NOT_IN_PRODUCT_LINE, { status: 'not_in_product', sources: '[]' });
    expect(problemsIn(missing)).toEqual([]);
  });
});

describe('a page is refused when', () => {
  it.each([
    ['it has no front matter', '# Approvals\n', /no front matter/],
    [
      'its audience is not its folder',
      page(STUB_LINE, { status: 'not_written', audience: 'operator' }),
      /audience/,
    ],
    ['its status is unknown', page(STUB_LINE, { status: 'done' }), /status/],
    [
      'it names an unknown ticket',
      page(STUB_LINE, { status: 'not_written', tickets: '[NOPE-1]' }),
      /NOPE-1/,
    ],
    [
      'it names an unknown mode',
      page(STUB_LINE, { status: 'not_written', modes: '[moon]' }),
      /moon/,
    ],
    ['it applies to no mode', page(STUB_LINE, { status: 'not_written', modes: '[]' }), /modes/],
    ['a stub says more than a stub', page('Some text.', { status: 'not_written' }), /not_written/],
    [
      'it describes something not built',
      page(`${NOT_IN_PRODUCT_LINE}\n\n${'And more. '.repeat(70)}`, { status: 'not_in_product' }),
      /does not describe/,
    ],
    ['a written page has no banner', page('Text.'), /banner/],
    ['a written page names no source', page(`${UNTESTED_BANNER}`, { sources: '[]' }), /sources/],
    [
      'a source cannot be found',
      page(`${UNTESTED_BANNER}`, { sources: '[nowhere.ts]' }),
      /nowhere\.ts/,
    ],
    ['a tested page names no test', page('Text.', { status: 'tested' }), /tests/],
    [
      'a test cannot be found',
      page('Text.', { status: 'tested', tests: '[gone.test.ts]' }),
      /gone\.test\.ts/,
    ],
    [
      'a walked_through page does not say who',
      page('Text.', { status: 'walked_through' }),
      /who followed/,
    ],
    [
      'someone who followed it is named on any other status',
      page(`${UNTESTED_BANNER}`, { walked_through_by: 'A Person' }),
      /only a walked_through/,
    ],
    [
      'its first heading is not its title',
      page(STUB_LINE, { status: 'not_written' }).replace('# Approvals', '# Else'),
      /heading/,
    ],
  ])('%s', (_, text, expected) => {
    expect(problemsIn(text).join('\n')).toMatch(expected);
  });
});

describe('the small format', () => {
  it('reads the blocks a person can be shown', () => {
    const { blocks, problems } = parseBlocks(
      [
        '## A heading',
        '',
        'A paragraph',
        'over two lines.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '> A quote.',
        '',
        '| Head | Other |',
        '|---|---|',
        '| a | b |',
        '',
        '```bash',
        'pnpm check:guides',
        '```',
      ].join('\n'),
    );
    expect(problems).toEqual([]);
    expect(blocks.map((block: { b: string }) => block.b)).toEqual([
      'h',
      'p',
      'ul',
      'ol',
      'quote',
      'table',
      'code',
    ]);
  });

  it.each([
    ['raw HTML', '<script>alert(1)</script>', /raw HTML/],
    ['an HTML tag inside a sentence', 'Press <b>here</b>.', /raw HTML/],
    ['an image', '![a picture](x.png)', /images/],
    ['a deep heading', '#### Too deep', /level 3/],
    ['a nested list', '- one\n  - two', /nested/],
    ['a table with no separator', '| a |\n| b |', /separator/],
    ['a table with uneven rows', '| a | b |\n|---|---|\n| c |', /same number/],
    ['a code block that never closes', '```\nfoo', /never closes/],
  ])('refuses %s', (_, text, expected) => {
    expect(parseBlocks(text).problems.join('\n')).toMatch(expected);
  });

  it('allows a tag inside inline code, where it is only text', () => {
    expect(parseBlocks('Use `<title>` here.').problems).toEqual([]);
  });

  it('gives no way for text to become markup', () => {
    expect(parseInline('a <img src=x> [b](user.md) `c` **d**')).toEqual([
      { t: 'text', v: 'a <img src=x> ' },
      { t: 'link', v: 'b', href: 'user.md' },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'c' },
      { t: 'text', v: ' ' },
      { t: 'strong', v: 'd' },
    ]);
  });
});

describe('claims', () => {
  it.each([
    ['Ensemus is SOC 2 certified.'],
    ['Ensemus is SOC2 Type II.'],
    ['We are ISO 27001 aligned.'],
    ['This meets HIPAA.'],
    ['Ready for FedRAMP.'],
    ['We hold a certification.'],
    ['Fully compliant with the rules.'],
    ['Backed by our SLA.'],
    ['We have 99.9% availability.'],
    ['Uptime is high.'],
    ['Our RTO is four hours.'],
    ['Our RPO is one hour.'],
    ['It costs $20.'],
    ['It costs 20 USD.'],
    ['Sovereign is air-gap ready.'],
    ['Works fully airgapped.'],
    ['We guarantee delivery.'],
    ['It is 100% safe.'],
    ['Bank-grade security.'],
    ['Unlimited usage.'],
    ['This is zero-knowledge.'],
    ['Messages are end-to-end encrypted.'],
    ['Your data never leaves the deployment.'],
    ['Your content is not used for training.'],
    ['Our warranty covers this.'],
    ['Our liability is limited.'],
  ])('refuses "%s"', (line) => {
    expect(claimProblems(line)).toHaveLength(1);
  });

  it('allows saying what is not claimed, on the line, with the marker', () => {
    expect(claimProblems(`Ensemus holds no certification. ${NOT_A_CLAIM}`)).toEqual([]);
    expect(claimProblems(`Do not rely on this as an air-gap claim. ${NOT_A_CLAIM}`)).toEqual([]);
  });

  it('does not let the marker excuse a positive claim', () => {
    const [problem] = claimProblems(`Ensemus is SOC 2 certified. ${NOT_A_CLAIM}`);
    expect(problem).toContain('needs a negative statement');
  });

  it('refuses a marker with nothing to excuse', () => {
    expect(claimProblems(`An ordinary sentence. ${NOT_A_CLAIM}`)[0]).toContain('no claim');
  });

  it('ignores commands in a code block', () => {
    expect(claimProblems('```bash\nnode infrastructure/scripts/air-gap-gate.mjs\n```')).toEqual([]);
  });

  it('allows ordinary words near a forbidden one', () => {
    expect(claimProblems('The price of nothing, a slab and an upset.')).toEqual([]);
  });
});

describe('values', () => {
  it.each([
    ['an API key', `sk-${'a'.repeat(24)}`],
    ['an AWS key', `AKIA${'A'.repeat(16)}`],
    ['a GitHub token', `ghp_${'a'.repeat(24)}`],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['a real-looking address', 'someone@company.com'],
    ['an outside host', 'https://docs.example.com/page'],
  ])('refuses %s, in a code block as well', (_, value) => {
    expect(valueProblems(`\`\`\`\n${value}\n\`\`\``)).not.toEqual([]);
  });

  it('allows invalid addresses and local hosts', () => {
    expect(
      valueProblems(
        'a@example.invalid https://localhost:8443 http://127.0.0.1 https://x.invalid/a',
      ),
    ).toEqual([]);
  });
});

describe('links', () => {
  it('finds a link to a page that exists', () => {
    expect(problemsIn(written('[Other](other.md) [here](#a)'))).toEqual([]);
  });

  it('refuses one that goes nowhere', () => {
    expect(problemsIn(written('[Gone](gone.md)')).join()).toContain('goes nowhere');
  });

  it('refuses one that leaves the guides', () => {
    expect(problemsIn(written('[Out](https://x.invalid/a)')).join()).toContain('leaves the guides');
  });

  it('keeps a user guide from sending people to a page the product cannot show', () => {
    expect(problemsIn(written('[Run](../operator/run.md)')).join()).toContain(
      'only link to other user guides',
    );
  });

  it('lets an operator guide link where it likes inside the guides', () => {
    const text = page(`${UNTESTED_BANNER}\n\n[Other](../user/other.md)`, { audience: 'operator' });
    expect(problemsIn(text, 'operator/x.md')).toEqual([]);
  });
});

describe('coverage', () => {
  const pages = [{ fields: { tickets: ['A-1'] } }];
  const tickets = [
    { id: 'A-1', milestone: 'M2' },
    { id: 'B-1', milestone: 'M8' },
    { id: 'C-1', milestone: 'M11' },
  ];

  it('needs a guide or a reason for every ticket up to M8', () => {
    expect(coverageProblems(pages, new Map(), tickets)).toEqual([
      'B-1 (M8) has no guide and no stated reason',
    ]);
    expect(coverageProblems(pages, new Map([['B-1', 'Internal.']]), tickets)).toEqual([]);
  });

  it('refuses a reason with no words in it', () => {
    expect(coverageProblems(pages, new Map([['B-1', ' ']]), tickets).join()).toContain('no reason');
  });

  it('refuses an exemption for a ticket that has a guide', () => {
    expect(
      coverageProblems(
        pages,
        new Map([
          ['A-1', 'x'],
          ['B-1', 'x'],
        ]),
        tickets,
      ),
    ).toEqual(['A-1 has a guide, so it should not be exempt']);
  });
});

describe('the index', () => {
  const index = { sections: [{ pages: ['user/a.md', 'user/b.md'] }] };

  it('matches the pages on disk', () => {
    expect(indexProblems(index, ['user/a.md', 'user/b.md'])).toEqual([]);
  });

  it('finds what is only in one of them', () => {
    expect(indexProblems(index, ['user/a.md', 'user/c.md'])).toEqual([
      'user/b.md is in the index but not on disk',
      'user/c.md is on disk but not in the index',
    ]);
  });
});

describe('a release', () => {
  const at = (status: string, extra = {}) => [{ path: 'p.md', fields: { status, ...extra } }];

  it.each(['not_written', 'not_in_product', 'written_untested'])('refuses a %s page', (status) => {
    expect(releaseProblems(at(status))).toHaveLength(1);
  });

  it('accepts a tested page', () => {
    expect(releaseProblems(at('tested'))).toEqual([]);
  });

  it('needs an install guide to have been followed by someone else (DOC-02)', () => {
    expect(releaseProblems(at('tested', { needs_walkthrough: 'true' }))[0]).toContain('DOC-02');
    expect(releaseProblems(at('walked_through', { needs_walkthrough: 'true' }))).toEqual([]);
  });
});

describe('the help module', () => {
  const load = (path: string, status: string, body: string, modes = '[cloud]') => {
    const text = `---\ntitle: T\naudience: user\narea: a\ntickets: []\nmodes: ${modes}\nstatus: ${status}\nsources: []\ntests: []\n---\n\n# T\n\n${body}\n`;
    const { fields, body: rest } = parseFrontMatter(text);
    return { path, fields, blocks: parseBlocks(rest).blocks, problems: [] };
  };
  const index = {
    sections: [
      { id: 'one', title: 'One', audience: 'user', pages: ['user/a.md', 'user/b.md', 'user/c.md'] },
      { id: 'ops', title: 'Ops', audience: 'operator', pages: ['operator/d.md'] },
    ],
  };
  const pages = [
    load('user/a.md', 'written_untested', '[to b](b.md) [to c](c.md)'),
    load('user/b.md', 'tested', 'Text.'),
    load('user/c.md', 'not_written', STUB_LINE),
    load('operator/d.md', 'written_untested', 'Operator text.'),
  ];
  const rendered = renderHelpModule(index, pages);

  it('holds only written pages for people', () => {
    expect(rendered).toContain('"slug": "a"');
    expect(rendered).toContain('"slug": "b"');
    expect(rendered).not.toContain('"slug": "c"');
    expect(rendered).not.toContain('Operator text');
  });

  it('makes a link to a page nobody can read yet into plain text', () => {
    expect(rendered).toContain('"href": "b"');
    expect(rendered).not.toContain('"href": "c"');
    expect(rendered).toContain('"v": "to c"');
  });

  it('keeps each page to its modes', () => {
    expect(rendered).toContain('    "modes": [\n      "cloud"\n    ]');
  });
});

describe('the guides in this repository', () => {
  it('pass the check', () => {
    const output = execFileSync('node', ['docs/specifications/tools/check-guides.mjs'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      encoding: 'utf8',
    });
    expect(output).toContain('OK: the guides are well formed');
  });
});
