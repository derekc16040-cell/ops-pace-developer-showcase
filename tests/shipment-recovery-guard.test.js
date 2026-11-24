const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateShipmentRecovery } = require('../shipment-recovery-guard');

test('allows a new shipment when neither system records one', () => {
  assert.equal(evaluateShipmentRecovery({paceJobNumber:'7000',writeRequested:true}).action,'clear');
});

test('blocks a duplicate shipment write when Pace already has a shipment', () => {
  assert.equal(evaluateShipmentRecovery({paceJobNumber:'7000',existingShipmentIds:['9000'],writeRequested:true}).action,'recovery_required');
});

test('allows read-only inspection when Pace already has a shipment', () => {
  assert.equal(evaluateShipmentRecovery({paceJobNumber:'7000',existingShipmentIds:['9000'],writeRequested:false}).action,'inspect_existing');
});

test('requires manual review for a local state belonging to another job', () => {
  assert.equal(evaluateShipmentRecovery({
    paceJobNumber:'7000',
    localShipmentState:{status:'shipment_created',record:{paceJobNumber:'7001',shipmentNumber:'9000'}},
    writeRequested:true,
  }).action,'manual_review');
});

test('rejects an invalid Pace job number', () => {
  assert.throws(() => evaluateShipmentRecovery({paceJobNumber:'bad!'}),/Invalid Pace Job Number/);
});
