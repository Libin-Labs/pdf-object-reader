# @lp-labs/pdf-object-reader

Original bounded classic-xref PDF object and unfiltered-stream inspection with page-tree validation.

Independent MIT TypeScript, **zero runtime or peer dependencies**. ESM/CommonJS with separate declarations. Node 18+ and compatible browsers with TextEncoder/TextDecoder; no DOM, globals or file access at import. TypeScript/Prettier are development-only.

## Install

```sh
npm install @lp-labs/pdf-object-reader
```

## Working example

```js
import { inspectPdf, PdfReadError } from '@lp-labs/pdf-object-reader';
// An actual minimal PDF generated here without another package.
const chunks = ['%PDF-1.7\n'];
const offsets = [0];
const values = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
];
for (let i = 0; i < values.length; i++) {
  offsets.push(chunks.join('').length);
  chunks.push(`${i + 1} 0 obj\n${values[i]}\nendobj\n`);
}
const start = chunks.join('').length;
chunks.push('xref\n0 4\n0000000000 65535 f \n');
for (const offset of offsets.slice(1))
  chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
chunks.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
const pdf = inspectPdf(new TextEncoder().encode(chunks.join('')));
if (pdf.pages.length !== 1 || pdf.pages[0].mediaBox[2] !== 612) throw new Error('Wrong page');
if (!(new PdfReadError('invalid', 'example') instanceof Error)) throw new Error('Error API');
```

CommonJS: `const api = require('@lp-labs/pdf-object-reader')`.

## Behavior, customization, limits, errors and performance

This parses actual PDF bytes using original lexical/object parsing and classic cross-reference offsets. It is an inspection subset, not a general PDF renderer/editor/text extractor. Supports PDF 1.0..1.7 headers at byte zero, one full classic xref subsection starting at zero, free/used entries, indirect object headers, names with #hex escapes, finite PDF numbers, booleans/null, arrays, dictionaries, nested literal strings with escapes and octal, hex strings (odd final nibble padded), comments and whitespace. Duplicate dictionary keys, overlapping objects, invalid xref offsets/generations, page cycles/duplicate page references, mismatched Count and invalid MediaBox are rejected.

Only unfiltered streams with direct integer Length are supported. Encrypted PDFs, incremental updates (Prev), hybrid references, object/xref streams, compression filters and indirect stream Length are rejected explicitly. PDF 2.0 is unsupported. Files produced by many real-world PDF applications therefore require a more capable backend. This is not a security sanitizer, complete ISO conformance validator, repair engine, certificate verifier, font/annotation/image decoder or parser for untrusted arbitrary PDF actions. Never execute embedded content from returned objects.

Output includes version, trailer, used objects in object-number order, and depth-first pages with inherited MediaBox and indirect stream content IDs. Literal strings return byte-preserving JS characters U+0000..00FF, not decoded Unicode/WinAnsi text; hex strings return Uint8Array. Dictionaries use explicit kind and own entries, including safe **proto** names. Names/references use discriminants. Streams are copied exactly by Length (no scanning for binary endstream text), so changing returned arrays cannot mutate the input. References required for page traversal and contents are checked; arbitrary non-page references are returned without universal reachability validation. Page Parent consistency is not validated. Nonzero generations are supported when xref/object/ref match.

Customize maxBytes (default16MiB, cap64MiB), maxObjects (default10,000 used/free slots excluding zero, cap100,000), maxTokens (default1,000,000, cap10,000,000), maxDepth (default64, cap128). All are positive safe integers. Individual decoded literal/hex strings are bounded to 1MiB; names to 4,096 encoded characters. Parsing is synchronous and buffers a one-byte-per-character source plus copies. Work is bounded by bytes/tokens/objects/depth; object sorting O(objects log objects). Streams are not decompressed and no background workers start. Lower limits for hostile workloads; isolate parsing in your own worker if latency matters.

PdfReadError.code distinguishes invalid malformed/inconsistent input, unsupported features and limit resource failures. Never treat unsupported as an empty successful document. Public output is detached from the source bytes and ordinary mutable data. Inputs are ordinary Uint8Array plus plain options; hostile proxies/getters are outside scope. Zero runtime/peer dependencies, no sibling package imports, no copied third-party implementation.

## Complete public API

Use the following exported interfaces/functions to configure the implementation; no private internals or source changes are necessary. Type-only imports work with both entry points.

```ts
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
  pages: {
    id: number;
    mediaBox: readonly [number, number, number, number];
    contents: number[];
  }[];
}
export declare class PdfReadError extends Error {
  readonly code: 'invalid' | 'unsupported' | 'limit';
  constructor(code: 'invalid' | 'unsupported' | 'limit', message: string);
}
export declare function inspectPdf(input: Uint8Array, options?: PdfReaderOptions): PdfInspection;
```

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
