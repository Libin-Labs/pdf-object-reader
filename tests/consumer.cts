import { inspectPdf, type PdfDictionary } from '@lp-labs/pdf-object-reader';
const dict: PdfDictionary = { kind: 'dictionary', entries: { X: 2 } };
const fn: (bytes: Uint8Array) => number = (bytes) => inspectPdf(bytes).pages.length;
void dict;
void fn;
// @ts-expect-error Options must be numeric
inspectPdf(new Uint8Array(), { maxBytes: '1' });
