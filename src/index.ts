export interface PdfName {
  kind: 'name';
  value: string;
}
export interface PdfReference {
  kind: 'reference';
  object: number;
  generation: number;
}
export interface PdfDictionary {
  kind: 'dictionary';
  entries: Record<string, PdfValue>;
}
export type PdfValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | PdfName
  | PdfReference
  | PdfDictionary
  | PdfValue[];
export interface PdfIndirectObject {
  id: number;
  generation: number;
  value: PdfValue;
  stream?: Uint8Array;
}
export interface PdfReaderOptions {
  maxBytes?: number;
  maxObjects?: number;
  maxTokens?: number;
  maxDepth?: number;
}
export interface PdfInspection {
  version: string;
  trailer: PdfDictionary;
  objects: PdfIndirectObject[];
  pages: { id: number; mediaBox: readonly [number, number, number, number]; contents: number[] }[];
}
export class PdfReadError extends Error {
  constructor(
    readonly code: 'invalid' | 'unsupported' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'PdfReadError';
  }
}
const white = (code: number): boolean => [0, 9, 10, 12, 13, 32].includes(code);
const delimiter = (char: string): boolean => /[\x00\s()[\]<>/{%}]/.test(char) || char === '';
function fail(code: PdfReadError['code'], message: string): never {
  throw new PdfReadError(code, message);
}
class SyntaxReader {
  position: number;
  tokens = 0;
  constructor(
    readonly source: string,
    start: number,
    readonly maxTokens: number,
    readonly maxDepth: number,
  ) {
    this.position = start;
  }
  skip(): void {
    while (this.position < this.source.length) {
      if (white(this.source.charCodeAt(this.position))) {
        this.position++;
        continue;
      }
      if (this.source[this.position] === '%') {
        while (
          this.position < this.source.length &&
          !['\r', '\n'].includes(this.source[this.position]!)
        )
          this.position++;
        continue;
      }
      break;
    }
  }
  word(): string {
    this.skip();
    const start = this.position;
    while (this.position < this.source.length && !delimiter(this.source[this.position]!))
      this.position++;
    if (start === this.position) fail('invalid', 'Expected PDF token.');
    return this.source.slice(start, this.position);
  }
  keyword(word: string): void {
    if (this.word() !== word) fail('invalid', `Expected ${word}.`);
  }
  value(depth = 0): PdfValue {
    if (++this.tokens > this.maxTokens || depth > this.maxDepth)
      fail('limit', 'PDF syntax token/depth limit exceeded.');
    this.skip();
    const char = this.source[this.position];
    if (char === '/') {
      this.position++;
      const start = this.position;
      while (this.position < this.source.length && !delimiter(this.source[this.position]!))
        this.position++;
      const encoded = this.source.slice(start, this.position);
      if (encoded.length > 4096 || /#(?![0-9a-f]{2})/i.test(encoded))
        fail('invalid', 'Invalid/oversized PDF name.');
      return {
        kind: 'name',
        value: encoded.replace(/#([0-9a-f]{2})/gi, (_, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        ),
      };
    }
    if (this.source.startsWith('<<', this.position)) {
      this.position += 2;
      const entries: Record<string, PdfValue> = {};
      while (true) {
        this.skip();
        if (this.source.startsWith('>>', this.position)) {
          this.position += 2;
          break;
        }
        const key = this.value(depth + 1);
        if (!isName(key) || Object.hasOwn(entries, key.value))
          fail('invalid', 'Dictionary keys must be unique names.');
        Object.defineProperty(entries, key.value, {
          value: this.value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return { kind: 'dictionary', entries };
    }
    if (char === '[') {
      this.position++;
      const result: PdfValue[] = [];
      while (true) {
        this.skip();
        if (this.source[this.position] === ']') {
          this.position++;
          break;
        }
        result.push(this.value(depth + 1));
      }
      return result;
    }
    if (char === '(') {
      this.position++;
      let nested = 1,
        result = '';
      while (this.position < this.source.length && nested) {
        const next = this.source[this.position++]!;
        if (next === '\\') {
          if (this.position >= this.source.length) fail('invalid', 'Truncated literal escape.');
          const escaped = this.source[this.position++]!;
          if (escaped === '\r' || escaped === '\n') {
            if (escaped === '\r' && this.source[this.position] === '\n') this.position++;
          } else if (/[0-7]/.test(escaped)) {
            let octal = escaped;
            for (
              let index = 0;
              index < 2 && /[0-7]/.test(this.source[this.position] ?? '');
              index++
            )
              octal += this.source[this.position++]!;
            result += String.fromCharCode(parseInt(octal, 8) & 255);
          } else {
            const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
            result += escapes[escaped] ?? escaped;
          }
        } else if (next === '(') {
          if (++nested > this.maxDepth) fail('limit', 'Literal nesting exceeded.');
          result += next;
        } else if (next === ')') {
          if (--nested) result += next;
        } else if (next === '\r') {
          if (this.source[this.position] === '\n') this.position++;
          result += '\n';
        } else result += next;
        if (result.length > 1048576) fail('limit', 'String size exceeded.');
      }
      if (nested) fail('invalid', 'Unterminated literal string.');
      return result;
    }
    if (char === '<') {
      this.position++;
      let hex = '';
      while (this.position < this.source.length && this.source[this.position] !== '>') {
        const next = this.source[this.position++]!;
        if (white(next.charCodeAt(0))) continue;
        if (!/[0-9a-f]/i.test(next)) fail('invalid', 'Invalid hexadecimal string.');
        hex += next;
        if (hex.length > 2097152) fail('limit', 'Hex string too large.');
      }
      if (this.source[this.position++] !== '>') fail('invalid', 'Truncated hex string.');
      if (hex.length % 2) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < bytes.length; index++)
        bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      return bytes;
    }
    const word = this.word();
    if (word === 'null') return null;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word))
      fail('unsupported', `Unsupported PDF value token: ${word.slice(0, 40)}.`);
    const number = Number(word);
    if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)
      fail('invalid', 'Numeric precision exceeded.');
    if (/^\d+$/.test(word)) {
      const saved = this.position;
      this.skip();
      const match = /^(\d+)\s+R(?=$|[\s()[\]<>/{%}])/.exec(this.source.slice(this.position));
      if (match) {
        const generation = Number(match[1]);
        if (!Number.isSafeInteger(generation) || generation > 65535)
          fail('invalid', 'Invalid reference generation.');
        this.position += match[0].length;
        return { kind: 'reference', object: number, generation };
      }
      this.position = saved;
    }
    return number;
  }
}
function isName(value: PdfValue | undefined): value is PdfName {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'name';
}
function isReference(value: PdfValue | undefined): value is PdfReference {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'reference';
}
function isDictionary(value: PdfValue | undefined): value is PdfDictionary {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'dictionary';
}
export function inspectPdf(input: Uint8Array, options: PdfReaderOptions = {}): PdfInspection {
  const maxBytes = options.maxBytes ?? 16777216,
    maxObjects = options.maxObjects ?? 10000;
  const maxTokens = options.maxTokens ?? 1000000,
    maxDepth = options.maxDepth ?? 64;
  for (const [limit, cap] of [
    [maxBytes, 67108864],
    [maxObjects, 100000],
    [maxTokens, 10000000],
    [maxDepth, 128],
  ] as const)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap)
      fail('invalid', 'Invalid reader limits.');
  if (!(input instanceof Uint8Array)) fail('invalid', 'Expected Uint8Array.');
  if (input.length > maxBytes) fail('limit', 'Input byte bound exceeded.');
  const parts: string[] = [];
  for (let at = 0; at < input.length; at += 8192)
    parts.push(String.fromCharCode(...input.subarray(at, at + 8192)));
  const source = parts.join('');
  const header = /^%PDF-(1\.[0-7])(?:\r\n|\r|\n)/.exec(source);
  if (!header) fail('unsupported', 'Only PDF 1.0..1.7 with header at byte zero supported.');
  const tail = /startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/.exec(source);
  if (!tail || tail.index < header[0].length) fail('invalid', 'Missing final startxref/EOF.');
  const xrefOffset = Number(tail[1]);
  if (
    !Number.isSafeInteger(xrefOffset) ||
    xrefOffset < header[0].length ||
    xrefOffset >= tail.index
  )
    fail('invalid', 'Invalid xref offset.');
  const syntax = new SyntaxReader(source, xrefOffset, maxTokens, maxDepth);
  if (syntax.word() !== 'xref')
    fail('unsupported', 'Cross-reference streams/object streams unsupported.');
  const first = syntax.word(),
    countText = syntax.word();
  if (first !== '0' || !/^\d+$/.test(countText))
    fail('unsupported', 'Only one full xref subsection starting at zero supported.');
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 1 || count > maxObjects + 1)
    fail('limit', 'Object count bound exceeded.');
  const entries: { offset: number; generation: number; used: boolean }[] = [];
  const offsets = new Set<number>();
  for (let index = 0; index < count; index++) {
    syntax.skip();
    const match = /^(\d{10}) (\d{5}) ([nf])(?: |\r)(?:\r\n|\n|\r)/.exec(
      source.slice(syntax.position),
    );
    if (!match) fail('invalid', 'Malformed classic xref entry.');
    syntax.position += match[0].length;
    const offset = Number(match[1]),
      generation = Number(match[2]),
      used = match[3] === 'n';
    if (generation > 65535 || (index === 0 && (used || generation !== 65535 || offset !== 0)))
      fail('invalid', 'Invalid free object entry.');
    if (used && (offset < header[0].length || offset >= xrefOffset || offsets.has(offset)))
      fail('invalid', 'Object offsets invalid or duplicated.');
    if (used) offsets.add(offset);
    entries.push({ offset, generation, used });
  }
  syntax.keyword('trailer');
  const trailer = syntax.value();
  if (!isDictionary(trailer)) fail('invalid', 'Trailer must be a dictionary.');
  for (const key of ['Encrypt', 'Prev', 'XRefStm'])
    if (Object.hasOwn(trailer.entries, key))
      fail('unsupported', 'Encrypted, incremental and hybrid PDFs unsupported.');
  if (trailer.entries.Size !== count || !isReference(trailer.entries.Root))
    fail('invalid', 'Trailer size/root invalid.');
  syntax.skip();
  if (syntax.position !== tail.index)
    fail('invalid', 'Unexpected content between trailer and startxref.');
  const objects: PdfIndirectObject[] = [];
  const endPositions: { start: number; end: number }[] = [];
  let totalTokens = syntax.tokens;
  for (let id = 1; id < entries.length; id++) {
    const entry = entries[id]!;
    if (!entry.used) continue;
    if (!/^[0-9]/.test(source[entry.offset]!))
      fail('invalid', 'Cross-reference offset must point exactly to an object header.');
    const reader = new SyntaxReader(source, entry.offset, maxTokens - totalTokens, maxDepth);
    if (reader.word() !== String(id) || reader.word() !== String(entry.generation))
      fail('invalid', 'Object header/xref mismatch.');
    reader.keyword('obj');
    const value = reader.value();
    reader.skip();
    let stream: Uint8Array | undefined;
    if (source.startsWith('stream', reader.position)) {
      if (
        !isDictionary(value) ||
        typeof value.entries.Length !== 'number' ||
        !Number.isSafeInteger(value.entries.Length) ||
        value.entries.Length < 0
      )
        fail('unsupported', 'Stream requires a direct nonnegative integer Length.');
      if (Object.hasOwn(value.entries, 'Filter'))
        fail('unsupported', 'Filtered/compressed streams unsupported.');
      reader.position += 6;
      if (source.startsWith('\r\n', reader.position)) reader.position += 2;
      else if (source[reader.position] === '\n') reader.position++;
      else fail('invalid', 'stream must be followed by LF or CRLF.');
      const end = reader.position + value.entries.Length;
      if (end > xrefOffset) fail('invalid', 'Stream exceeds object region.');
      stream = input.slice(reader.position, end);
      reader.position = end;
      reader.skip();
      reader.keyword('endstream');
      reader.skip();
    }
    reader.keyword('endobj');
    if (reader.position > xrefOffset) fail('invalid', 'Object exceeds object region.');
    totalTokens += reader.tokens;
    if (totalTokens > maxTokens) fail('limit', 'Aggregate syntax token bound exceeded.');
    endPositions.push({ start: entry.offset, end: reader.position });
    objects.push({
      id,
      generation: entry.generation,
      value,
      ...(stream === undefined ? {} : { stream }),
    });
  }
  endPositions.sort((a, b) => a.start - b.start);
  for (let index = 1; index < endPositions.length; index++)
    if (endPositions[index]!.start < endPositions[index - 1]!.end)
      fail('invalid', 'Overlapping indirect objects.');
  const byId = new Map(objects.map((object) => [object.id, object]));
  const dictionary = (ref: PdfValue | undefined): PdfDictionary => {
    if (!isReference(ref)) fail('invalid', 'Expected indirect object reference.');
    const object = byId.get(ref.object);
    if (!object || object.generation !== ref.generation || !isDictionary(object.value))
      fail('invalid', 'Reference does not resolve to a dictionary.');
    return object.value;
  };
  const catalog = dictionary(trailer.entries.Root);
  if (!isName(catalog.entries.Type) || catalog.entries.Type.value !== 'Catalog')
    fail('invalid', 'Root is not a Catalog.');
  const pages: PdfInspection['pages'] = [];
  const visited = new Set<number>();
  const walk = (
    ref: PdfValue | undefined,
    inherited: PdfValue | undefined,
    depth: number,
  ): number => {
    if (!isReference(ref) || visited.has(ref.object))
      fail('invalid', 'Page tree cycle/duplicate reference.');
    if (depth > maxDepth) fail('limit', 'Page tree depth exceeded.');
    visited.add(ref.object);
    const node = dictionary(ref),
      type = node.entries.Type;
    const mediaBox = Object.hasOwn(node.entries, 'MediaBox') ? node.entries.MediaBox : inherited;
    if (!isName(type)) fail('invalid', 'Page node requires Type.');
    if (type.value === 'Pages') {
      if (!Array.isArray(node.entries.Kids)) fail('invalid', 'Pages requires Kids array.');
      let descendants = 0;
      for (const child of node.entries.Kids) descendants += walk(child, mediaBox, depth + 1);
      if (node.entries.Count !== descendants) fail('invalid', 'Page tree Count mismatch.');
      return descendants;
    }
    if (
      type.value !== 'Page' ||
      !Array.isArray(mediaBox) ||
      mediaBox.length !== 4 ||
      mediaBox.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    )
      fail('invalid', 'Invalid page type/MediaBox.');
    const [x0, y0, x1, y1] = mediaBox as [number, number, number, number];
    if (x1 <= x0 || y1 <= y0) fail('invalid', 'Page MediaBox must have positive dimensions.');
    const contents = node.entries.Contents;
    const references =
      contents === undefined ? [] : Array.isArray(contents) ? contents : [contents];
    const ids = references.map((value) => {
      if (!isReference(value)) fail('invalid', 'Content must use indirect references.');
      const object = byId.get(value.object);
      if (!object || object.generation !== value.generation || object.stream === undefined)
        fail('invalid', 'Content reference must resolve to a stream.');
      return value.object;
    });
    pages.push({ id: ref.object, mediaBox: [x0, y0, x1, y1], contents: ids });
    return 1;
  };
  walk(catalog.entries.Pages, undefined, 0);
  return { version: header[1]!, trailer, objects, pages };
}
