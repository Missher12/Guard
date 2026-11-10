import assert from 'node:assert/strict'
import test from 'node:test'
import { renderBatchResult } from '../src/compact.js'

const receipt = () => ({ id: 'batch-123', status: 'completed',
  counts: { completed: 20, skipped: 0, failed: 0, pending: 0, uncertain: 0 },
  items: Array.from({ length: 20 }, (_, index) => ({ index, status: 'completed', target: `out/${index}.xlsx`,
    result: { format: 'xlsx', formulaRecalculated: false, visualChecked: false } })) })

test('compact Office receipts keep common verification limits and every target in order', () => {
  const value = receipt(), original = structuredClone(value)
  const output = JSON.parse(renderBatchResult({ action: 'edit' }, value)[0].text)
  assert.equal(output.result.visualChecked, false)
  assert.equal(output.result.formulaRecalculated, false)
  assert.deepEqual(output.targets, value.items.map(row => row.target))
  assert.deepEqual(value, original)
})

test('partial, failed, varied, short and explicitly requested receipts remain complete', () => {
  for (const change of [value => { value.status = 'partial'; value.items[0].status = 'uncertain'; value.items[0].error = 'check target' },
    value => { value.status = 'failed' }, value => { value.items[1].result.formulaRecalculated = true },
    value => { value.items.length = 2 }, value => { value.items[1].newDiagnostic = 'preserve me' }]) {
    const value = receipt(); change(value)
    assert.equal(renderBatchResult({ action: 'edit' }, value)[0].text, JSON.stringify(value))
  }
  for (const action of ['status', 'list', 'read', 'inspect']) {
    const value = receipt()
    assert.equal(renderBatchResult({ action }, value)[0].text, JSON.stringify(value))
  }
  const value = receipt()
  assert.equal(renderBatchResult({ action: 'edit' }, value, false)[0].text, JSON.stringify(value))
})
