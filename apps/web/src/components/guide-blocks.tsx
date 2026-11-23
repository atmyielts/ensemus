import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from './ui/table';
// DOC-01: a guide's blocks as React elements and text nodes, so no guide can put markup in the page, and
// the route has no raw HTML to get wrong (ADR-036 D5). Every link goes through hrefOf. Relative imports,
// so that a unit test can load this: that runner does not know the app's `@/` paths.
import Link from 'next/link';
import type { GuideBlock, GuideInline } from '../generated/guides';
import { type GuideHeading, headingsOf, hrefOf } from '../lib/guides';

function Inline({ parts }: { parts: readonly GuideInline[] }) {
  return parts.map((part, index) => {
    switch (part.t) {
      case 'link':
        return (
          <Link key={index} href={hrefOf(part.href)}>
            {part.v}
          </Link>
        );
      case 'code':
        return <code key={index}>{part.v}</code>;
      case 'strong':
        return <strong key={index}>{part.v}</strong>;
      case 'text':
        return part.v;
    }
  });
}

function Block({ block, heading }: { block: GuideBlock; heading: GuideHeading | undefined }) {
  switch (block.b) {
    case 'h': {
      const Tag = heading?.level === 3 ? 'h3' : 'h2';
      return (
        <Tag id={heading?.id}>
          <Inline parts={block.inline} />
        </Tag>
      );
    }
    case 'p':
      return (
        <p>
          <Inline parts={block.inline} />
        </p>
      );
    case 'quote':
      return (
        <blockquote>
          <Inline parts={block.inline} />
        </blockquote>
      );
    case 'ul':
    case 'ol': {
      const List = block.b;
      return (
        <List>
          {block.items.map((item, index) => (
            <li key={index}>
              <Inline parts={item} />
            </li>
          ))}
        </List>
      );
    }
    case 'code':
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case 'table':
      return (
        <Table>
          <TableHeader>
            <TableRow>
              {block.head.map((cell, index) => (
                <TableHead key={index} scope="col">
                  <Inline parts={cell} />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {block.rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {row.map((cell, index) => (
                  <TableCell key={index}>
                    <Inline parts={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
  }
}

/** Renders everything it is given, in order, so the banner on an untested page always comes first. */
export function GuideBlocks({ blocks }: { blocks: readonly GuideBlock[] }) {
  const headings = headingsOf(blocks);
  return (
    <div className="guide">
      {blocks.map((block, index) => (
        <Block key={index} block={block} heading={headings[index]} />
      ))}
    </div>
  );
}
