import {
  inspectPdf,
  PdfReadError,
  type PdfValue,
  type PdfInspection,
} from '@lp-labs/pdf-object-reader';
const read = (bytes: Uint8Array): PdfInspection => inspectPdf(bytes, { maxDepth: 12 });
const value: PdfValue = { kind: 'reference', object: 1, generation: 0 };
const code: 'invalid' | 'unsupported' | 'limit' = new PdfReadError('invalid', 'x').code;
void read;
void value;
void code;
// @ts-expect-error Uint8Array input required
inspectPdf('x');
