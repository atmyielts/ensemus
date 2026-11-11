// A bounded XML tokenizer for the parts of an Office file (ADR-029 D4 addendum). Not a general XML parser
// on purpose: a document type declaration is refused outright, so no entity can be defined, expanded or
// fetched (no billion laughs, no external entities), nesting has a ceiling, and nothing is ever resolved
// against a network or a disk. Only the five predefined entities and character references are decoded.

export class XmlRefused extends Error {
  readonly code: 'MALFORMED_DOCUMENT' | 'TOO_LARGE';
  constructor(code: 'MALFORMED_DOCUMENT' | 'TOO_LARGE') {
    super(code);
    this.code = code;
    this.name = 'XmlRefused';
  }
}

export type XmlVisitor = {
  /** `name` keeps its prefix, as written, such as `w:t`. Attributes are read only when asked for. */
  open?(name: string, attribute: (name: string) => string | undefined, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
};

/** Deep enough for any real Office part, and far short of what would exhaust a stack or a heap. */
export const MAX_XML_DEPTH = 256;

export function walkXml(xml: string, visitor: XmlVisitor, maxDepth = MAX_XML_DEPTH): void {
  const malformed = () => new XmlRefused('MALFORMED_DOCUMENT');
  const stack: string[] = [];
  let position = 0;
  while (position < xml.length) {
    const tag = xml.indexOf('<', position);
    if (tag < 0) {
      emitText(xml.slice(position));
      break;
    }
    if (tag > position) emitText(xml.slice(position, tag));
    if (xml.startsWith('<!--', tag)) {
      const close = xml.indexOf('-->', tag + 4);
      if (close < 0) throw malformed();
      position = close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', tag)) {
      const close = xml.indexOf(']]>', tag + 9);
      if (close < 0) throw malformed();
      if (stack.length) visitor.text?.(xml.slice(tag + 9, close));
      position = close + 3;
      continue;
    }
    if (xml.startsWith('<?', tag)) {
      const close = xml.indexOf('?>', tag + 2);
      if (close < 0) throw malformed();
      position = close + 2;
      continue;
    }
    // A DTD is the only way to define an entity. Office never writes one, so anything with one is refused.
    if (xml.startsWith('<!', tag)) throw malformed();
    let end = tag + 1;
    let quote = '';
    for (; end < xml.length; end += 1) {
      const char = xml[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') throw malformed();
    }
    if (end >= xml.length) throw malformed();
    const body = xml.slice(tag + 1, end);
    position = end + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (stack.pop() !== name) throw malformed();
      visitor.close?.(name);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const match = /^([A-Za-z_][\w.:-]*)/.exec(inner);
    if (!match?.[1]) throw malformed();
    const name = match[1];
    const rest = inner.slice(name.length);
    let attributes: Map<string, string> | null = null;
    const attribute = (wanted: string) => {
      if (!attributes) {
        attributes = new Map();
        for (const found of rest.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
          if (found[1]) attributes.set(found[1], decodeEntities(found[3] ?? found[4] ?? ''));
        }
      }
      return attributes.get(wanted);
    };
    if (!selfClosing) {
      stack.push(name);
      if (stack.length > maxDepth) throw malformed();
    }
    visitor.open?.(name, attribute, selfClosing);
    if (selfClosing) visitor.close?.(name);
  }
  if (stack.length) throw malformed();

  function emitText(raw: string) {
    if (!stack.length) {
      if (raw.trim()) throw malformed();
      return;
    }
    visitor.text?.(decodeEntities(raw));
  }
}

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The five predefined entities and character references. Any other name is left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g,
    (whole, entity: string) => {
      if (entity[0] !== '#') return PREDEFINED[entity] ?? whole;
      const value =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value)
        : '�';
    },
  );
}

/** The name after its prefix: `w:t` is `t`. */
export const localName = (name: string) => name.slice(name.indexOf(':') + 1);
