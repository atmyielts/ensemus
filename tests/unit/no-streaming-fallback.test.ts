// Every native page has to work with JavaScript disabled (docs/01-product/07-interface-system.md). A
// route-level loading file wraps its page in a Suspense boundary. When the page is slower than the shell,
// React sends the fallback and then the real page inside `<div hidden id="S:0">`, which only an inline
// script reveals (next/dist/docs/01-app/02-guides/streaming.md). Without JavaScript the person is left on
// the fallback. That is how "Start an approved workflow" went missing for a no-JavaScript browser, behind
// studio/runs/loading.tsx, whenever the server was slow.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Route files that turn a whole page into streamed content behind a fallback. */
const LOADING = /(^|\/)loading\.(tsx|ts|jsx|js)$/;

function loadingBoundaries(paths: readonly string[]): string[] {
  return paths.filter((path) => LOADING.test(path));
}

function filesUnder(folder: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(join(root, folder));
  return found;
}

describe('pages render whole without JavaScript', () => {
  it('has no route-level loading fallback in the web app', () => {
    const files = filesUnder('apps/web/src/app');
    expect(files).toContain('apps/web/src/app/o/[organizationId]/studio/runs/new/page.tsx');
    expect(loadingBoundaries(files)).toEqual([]);
  });

  it('would find one wherever it is planted', () => {
    expect(
      loadingBoundaries([
        'apps/web/src/app/o/[organizationId]/studio/runs/loading.tsx',
        'apps/web/src/app/loading.js',
        'apps/web/src/app/o/[organizationId]/work/page.tsx',
        'apps/web/src/app/o/[organizationId]/reloading.tsx',
      ]),
    ).toEqual([
      'apps/web/src/app/o/[organizationId]/studio/runs/loading.tsx',
      'apps/web/src/app/loading.js',
    ]);
  });
});
