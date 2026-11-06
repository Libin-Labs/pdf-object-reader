import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPdf, PdfReadError } from '../dist/esm/index.js';
const encoder = new TextEncoder();
function fixture(extra = '', { stream = false, pages = '', trailer = '', content = '' } = {}) {
  const values = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count 1 /Kids [3 0 R] ${pages} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${stream ? '/Contents 4 0 R' : ''} ${extra} >>`,
  ];
  if (stream) values.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const chunks = ['%PDF-1.7\n'],
    offsets = [0];
  for (let i = 0; i < values.length; i++) {
    offsets.push(chunks.join('').length);
    chunks.push(`${i + 1} 0 obj\n${values[i]}\nendobj\n`);
  }
  const start = chunks.join('').length;
  chunks.push(`xref\n0 ${values.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1))
    chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(
    `trailer\n<< /Size ${values.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${start}\n%%EOF\n`,
  );
  return encoder.encode(chunks.join(''));
}
const rewrite = (bytes, from, to) => {
  assert.equal(from.length, to.length);
  return encoder.encode(new TextDecoder().decode(bytes).replace(from, to));
};
test('inspects real object headers, trailer, page tree and copied stream', () => {
  const input = fixture('', { stream: true, content: 'BT (hello) Tj ET' }),
    result = inspectPdf(input);
  assert.equal(result.version, '1.7');
  assert.equal(result.objects.length, 4);
  assert.deepEqual(result.pages, [{ id: 3, mediaBox: [0, 0, 612, 792], contents: [4] }]);
  assert.equal(new TextDecoder().decode(result.objects[3].stream), 'BT (hello) Tj ET');
  input.fill(0);
  assert.equal(result.objects[3].stream[0], 66);
});
test('literal nesting, octal, newline escapes and name hex decoded exactly', () => {
  const result = inspectPdf(fixture('/Label (a\\050b\\051\\n(c)\\\nZ) /N /A#20B /Hex <0aF>'));
  const values = result.objects[2].value.entries;
  assert.equal(values.Label, 'a(b)\n(c)Z');
  assert.deepEqual(values.N, { kind: 'name', value: 'A B' });
  assert.deepEqual([...values.Hex], [10, 240]);
});
test('dictionary pollution keys are ordinary own entries', () => {
  const result = inspectPdf(fixture('/__proto__ (own) /constructor (safe)'));
  const entries = result.objects[2].value.entries;
  assert.equal(Object.getPrototypeOf(entries), Object.prototype);
  assert.equal(entries.__proto__, 'own');
  assert.equal({}.polluted, undefined);
  assert.equal(entries.constructor, 'safe');
});
test('binary stream markers are data; direct Length governs extraction', () => {
  const content = 'abc endstream endobj BT';
  assert.equal(
    new TextDecoder().decode(inspectPdf(fixture('', { stream: true, content })).objects[3].stream),
    content,
  );
});
test('inherited MediaBox and typed scalars parse', () => {
  const input = fixture('/V [true false null +1 -.5]', { pages: '/MediaBox [0 0 300 400]' });
  const result = inspectPdf(input);
  assert.deepEqual(result.objects[2].value.entries.V, [true, false, null, 1, -0.5]);
  const noBox = rewrite(
    input,
    '/MediaBox [0 0 612 792]',
    ' '.repeat('/MediaBox [0 0 612 792]'.length),
  );
  assert.deepEqual(inspectPdf(noBox).pages[0].mediaBox, [0, 0, 300, 400]);
});
test('invalid xref, object offset, size and EOF never produce partial success', () => {
  const input = fixture();
  for (const bytes of [
    rewrite(input, '/Size 4', '/Size 5'),
    rewrite(input, '3 0 obj', '8 0 obj'),
    rewrite(input, '%%EOF', '%%EOX'),
    input.subarray(0, input.length - 10),
    rewrite(input, '/Count 1', '/Count 2'),
  ])
    assert.throws(() => inspectPdf(bytes), PdfReadError);
});
test('cycles, duplicate keys and broken references rejected', () => {
  for (const bytes of [
    rewrite(fixture(), '/Kids [3 0 R]', '/Kids [2 0 R]'),
    fixture('/Type /Page'),
    fixture('/Bad << /X 1 /X 2 >>'),
    rewrite(fixture(), '/Root 1 0 R', '/Root 9 0 R'),
    fixture('/MediaBox [0 0 0 10]'),
  ])
    assert.throws(() => inspectPdf(bytes), { code: 'invalid' });
});
test('encrypted/incremental/filtered/indirect-length features fail explicitly', () => {
  for (const trailer of ['/Encrypt 1 0 R', '/Prev 10', '/XRefStm 20'])
    assert.throws(() => inspectPdf(fixture('', { trailer })), { code: 'unsupported' });
  const input = fixture('', { stream: true, content: 'test' });
  const source = new TextDecoder().decode(input);
  // Length replacement stays the same size, preserving classic xref positions.
  assert.throws(() => inspectPdf(encoder.encode(source.replace('/Length 4', '/Filter 4'))), {
    code: 'unsupported',
  });
});
test('malformed lexical tokens, name escapes and binary lengths rejected', () => {
  for (const extra of ['/Bad <xz>', '/Bad /x#ZZ', '/Bad 1e3', '/Bad (unterminated', '/Bad [ 1'])
    assert.throws(() => inspectPdf(fixture(extra)), PdfReadError);
  assert.throws(
    () =>
      inspectPdf(rewrite(fixture('', { stream: true, content: 'abc' }), '/Length 3', '/Length 9')),
    PdfReadError,
  );
});
test('input, object, aggregate syntax and depth budgets are enforced', () => {
  const input = fixture('/V [[[[[0]]]]]');
  assert.equal(inspectPdf(input, { maxBytes: input.length }).pages.length, 1);
  for (const options of [
    { maxBytes: input.length - 1 },
    { maxObjects: 2 },
    { maxTokens: 10 },
    { maxDepth: 3 },
  ])
    assert.throws(() => inspectPdf(input, options), { code: 'limit' });
  for (const options of [{ maxDepth: 129 }, { maxBytes: NaN }, { maxObjects: 0 }])
    assert.throws(() => inspectPdf(input, options), { code: 'invalid' });
  assert.throws(() => inspectPdf('not bytes'), { code: 'invalid' });
});
test('nonzero generations resolved exactly, mismatches are rejected', () => {
  let input = rewrite(fixture(), '3 0 obj', '3 1 obj');
  input = rewrite(input, '/Kids [3 0 R]', '/Kids [3 1 R]');
  const source = new TextDecoder().decode(input),
    lines = source.split('\n');
  const xrefIndex = lines.indexOf('xref');
  lines[xrefIndex + 5] = lines[xrefIndex + 5].replace('00000 n', '00001 n');
  input = encoder.encode(lines.join('\n'));
  assert.equal(inspectPdf(input).pages.length, 1);
  assert.throws(() => inspectPdf(rewrite(input, '/Kids [3 1 R]', '/Kids [3 0 R]')), {
    code: 'invalid',
  });
});
test('xref offsets must point to the exact header, not preceding whitespace', () => {
  const source = new TextDecoder().decode(fixture());
  const entry = /(\d{10}) 00000 n /.exec(source);
  const offset = Number(entry[1]);
  const wrong = `${String(offset - 1).padStart(10, '0')} 00000 n `;
  assert.throws(() => inspectPdf(encoder.encode(source.replace(entry[0], wrong))), {
    code: 'invalid',
  });
});
