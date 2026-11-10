// The shared web shell's accessibility rules that hold without a browser: one live region for the
// navigation, control names that start with their visible words, links on a line of their own that are
// real targets, and badges that wrap rather than push a 320px page sideways. The browser specs check the
// same pages with axe and a real layout (mfa, sso, pulse and interface-system).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  pendingDestination,
  pendingDestinationText,
} from '../../apps/web/src/components/navigation-model';
import { labelInName } from '../../apps/web/src/lib/label-in-name';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../apps/web/src/${path}`, import.meta.url)), 'utf8');
/** The declarations of one exact selector in the global stylesheet, without comments. */
const rule = (selector: string) => {
  const css = source('app/globals.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!found) throw new Error(`No rule for ${selector}`);
  return found[1]!;
};

describe('the navigation says which page is on its way, in one place', () => {
  it('names the latest destination on its way, and clears it once that one arrives', () => {
    expect(pendingDestination(null, 'Work', true)).toBe('Work');
    expect(pendingDestination('Work', 'Approvals', true)).toBe('Approvals');
    expect(pendingDestination('Work', 'Work', false)).toBeNull();
    expect(pendingDestinationText('Work')).toBe('Loading Work');
    expect(pendingDestinationText(null)).toBe('');
  });

  it('never lets a link that settles clear another that is still on its way', () => {
    expect(pendingDestination('Approvals', 'Work', false)).toBe('Approvals');
    expect(pendingDestination(null, 'Work', false)).toBeNull();
  });

  it('has one status region, and none inside a link', () => {
    const nav = source('components/main-nav.tsx');
    expect(nav.match(/role="status"/g)).toHaveLength(1);
    const pending = /function Pending\([\s\S]*?\n}\n/.exec(nav)?.[0] ?? '';
    expect(pending).toContain('aria-hidden="true"');
    expect(pending).not.toContain('role=');
    expect(source('app/o/[organizationId]/layout.tsx')).toContain('<NavigationPendingRegion>');
  });
});

describe('a control name starts with the words on it (WCAG 2.5.3)', () => {
  it('starts with exactly the visible words, then says what it acts on', () => {
    expect(labelInName('Dismiss for me', 'The due date has passed', 'Plan the offsite')).toBe(
      'Dismiss for me: The due date has passed, Plan the offsite',
    );
    expect(labelInName(' Save ', '')).toBe('Save');
  });

  it('refuses a control with no visible words to start from', () => {
    expect(() => labelInName('  ', 'Plan the offsite')).toThrow();
  });

  it('gives every Pulse control a name that starts with its visible words', () => {
    const view = source('components/pulse/view.tsx');
    const controls = [
      ...view.matchAll(/<SubmitButton[\s\S]*?label=\{([^}]*)\}[^>]*>\s*([^<]+?)\s*</g),
    ];
    expect(controls).toHaveLength(3);
    for (const [, label, words] of controls) expect(label).toContain(`controlName('${words}'`);
  });
});

describe('the shared styles keep targets and text on the page', () => {
  it('makes a link on a line of its own at least 24px tall (WCAG 2.5.8)', () => {
    const declarations = rule('.link-line > a');
    expect(declarations).toMatch(/display:\s*inline-flex/);
    expect(declarations).toMatch(/min-height:\s*1\.5rem/);
    for (const page of ['security/confirm/page.tsx', 'security/sso/page.tsx'])
      expect(source(`app/o/[organizationId]/${page}`)).toContain('className="link-line"');
  });

  it('lets a badge wrap inside a container narrower than it, instead of overflowing it', () => {
    const declarations = rule('.badge');
    expect(declarations).toMatch(/max-width:\s*100%/);
    expect(declarations).toMatch(/white-space:\s*normal/);
    expect(declarations).not.toMatch(/nowrap/);
  });
});
