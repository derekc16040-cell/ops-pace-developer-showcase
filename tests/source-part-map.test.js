const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSourcePartMap, normalizeEstimatePart } = require('../source-part-map');

test('normalizes estimate part identifiers', () => {
  assert.equal(normalizeEstimatePart('1'), '01');
  assert.equal(normalizeEstimatePart(' 12 '), '12');
});

test('maps each unique estimate part exactly once', () => {
  const result = buildSourcePartMap({
    estimateNumber: '1000',
    estimateParts: ['1', '2', '1'],
    origins: [
      { estimateNumber: '1000', estimatePart: '1', jobPart: '7000:01' },
      { estimateNumber: '1000', estimatePart: '2', jobPart: '7000:02' },
    ],
  });
  assert.deepEqual(result, { '01': '7000:01', '02': '7000:02' });
});

test('rejects job parts from another estimate', () => {
  assert.throws(() => buildSourcePartMap({
    estimateNumber: '1000', estimateParts: ['1'],
    origins: [{ estimateNumber: '1001', estimatePart: '1', jobPart: '7000:01' }],
  }), /SOURCE ESTIMATE MISMATCH/);
});

test('rejects ambiguous source mappings', () => {
  assert.throws(() => buildSourcePartMap({
    estimateNumber: '1000', estimateParts: ['1'],
    origins: [
      { estimateNumber: '1000', estimatePart: '1', jobPart: '7000:01' },
      { estimateNumber: '1000', estimatePart: '1', jobPart: '7000:02' },
    ],
  }), /MAPPING AMBIGUOUS/);
});

test('rejects unexpected source parts', () => {
  assert.throws(() => buildSourcePartMap({
    estimateNumber: '1000', estimateParts: ['1'],
    origins: [
      { estimateNumber: '1000', estimatePart: '1', jobPart: '7000:01' },
      { estimateNumber: '1000', estimatePart: '3', jobPart: '7000:03' },
    ],
  }), /Unexpected Pace source JobParts/);
});
