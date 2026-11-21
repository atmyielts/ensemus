// DOC-01: which guides this deployment shows, and where a guide may link (ADR-036 D5). Kept apart from
// the routes, with the pages injectable, because the compiled list is empty until the guides are written
// and each refusal still has to be tested. The relative import is so that a unit test can load this.
import type { CommercialMode } from '@ensemus/config';
import {
  GUIDE_PAGES,
  GUIDE_SECTIONS,
  type GuideBlock,
  type GuideInline,
  type GuidePage,
  type GuideSection,
} from '../generated/guides';

const HELP_HOME = '/help';

// The two shapes build-help.mjs writes. Spelled out whole, so that a scheme, another host, a dot segment
// or an encoded character cannot match, rather than listing the bad ones and missing one.
const SAME_PAGE = /^#[A-Za-z0-9_-]+$/;
const OTHER_GUIDE = /^([a-z0-9][a-z0-9-]*)(#[A-Za-z0-9_-]+)?$/;

/** What this mode offers. A page for another mode is not hidden from view: it does not exist here. */
export function pagesFor(
  mode: CommercialMode,
  pages: readonly GuidePage[] = GUIDE_PAGES,
): readonly GuidePage[] {
  return pages.filter((page) => page.modes.includes(mode));
}

/**
 * The page at a slug from the address bar, which is untrusted. It is only ever compared with the list,
 * never decoded, joined to a path or used as a key, so `../` and `__proto__` are simply not in the list.
 */
export function pageFor(
  slug: string,
  mode: CommercialMode,
  pages: readonly GuidePage[] = GUIDE_PAGES,
): GuidePage | undefined {
  return pagesFor(mode, pages).find((page) => page.slug === slug);
}

/** The index, in the order of the guides' sections. A section with nothing to read is not offered. */
export function sectionsFor(
  mode: CommercialMode,
  sections: readonly GuideSection[] = GUIDE_SECTIONS,
  pages: readonly GuidePage[] = GUIDE_PAGES,
): readonly { section: GuideSection; pages: readonly GuidePage[] }[] {
  const shown = pagesFor(mode, pages);
  return sections
    .map((section) => ({
      section,
      pages: shown.filter((page) => page.section === section.id),
    }))
    .filter((entry) => entry.pages.length > 0);
}

/**
 * Where a guide's link goes. The only places a guide can link are other guides and its own headings.
 * check-guides.mjs refuses anything else, and this holds even if something got past it.
 */
export function hrefOf(link: string): string {
  if (SAME_PAGE.test(link)) return link;
  const match = OTHER_GUIDE.exec(link);
  return match ? `${HELP_HOME}/${match[1]}${match[2] ?? ''}` : HELP_HOME;
}

/**
 * A page's blocks as this mode should read them. build-help.mjs turns a link to an unwritten page into
 * text, but it compiles one list for all three modes, so only here can a link in a shared page to a page
 * this mode does not have, such as billing in Sovereign, get the same treatment.
 */
export function blocksFor(
  page: GuidePage,
  mode: CommercialMode,
  pages: readonly GuidePage[] = GUIDE_PAGES,
): readonly GuideBlock[] {
  const here = new Set(pagesFor(mode, pages).map((one) => one.slug));
  const reachable = (href: string) => {
    const slug = OTHER_GUIDE.exec(href)?.[1];
    return SAME_PAGE.test(href) || (slug !== undefined && here.has(slug));
  };
  const inline = (parts: readonly GuideInline[]): readonly GuideInline[] =>
    parts.map((part) =>
      part.t === 'link' && !reachable(part.href) ? { t: 'text', v: part.v } : part,
    );
  return page.blocks.map((block): GuideBlock => {
    switch (block.b) {
      case 'h':
      case 'p':
      case 'quote':
        return { ...block, inline: inline(block.inline) };
      case 'ul':
      case 'ol':
        return { ...block, items: block.items.map(inline) };
      case 'table':
        return {
          ...block,
          head: block.head.map(inline),
          rows: block.rows.map((row) => row.map(inline)),
        };
      case 'code':
        return block;
    }
  });
}

export type GuideHeading = { readonly level: 2 | 3; readonly id: string | undefined };

/** The same address a Markdown link to this heading already uses: lower case, words joined by `-`. */
const anchorOf = (inline: readonly GuideInline[]) =>
  inline
    .map((part) => part.v)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

/**
 * The element and address of each heading, by the index of its block, and undefined for anything else.
 * The title of the page is its one h1, and a screen reader's outline should have no gaps, so a level is
 * held to 2 or 3 and to no deeper than one below the last. Repeats get a number, so an ID stays unique.
 */
export function headingsOf(blocks: readonly GuideBlock[]): readonly (GuideHeading | undefined)[] {
  const used = new Set<string>();
  let previous = 1;
  return blocks.map((block) => {
    if (block.b !== 'h') return undefined;
    const level = block.level <= 2 || previous < 2 ? 2 : 3;
    previous = level;
    const anchor = anchorOf(block.inline);
    if (!anchor) return { level, id: undefined };
    let id = anchor;
    for (let repeat = 1; used.has(id); repeat += 1) id = `${anchor}-${repeat}`;
    used.add(id);
    return { level, id };
  });
}
