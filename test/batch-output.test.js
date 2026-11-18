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

test('partial receipts surface every failed, uncertain and pending path; canonical status stays complete', () => {
  const value = receipt()
  value.status = 'partial'
  value.counts = { completed: 16, skipped: 1, failed: 1, pending: 1, uncertain: 1 }
  value.items[16] = { index: 16, status: 'skipped', target: 'out/16.xlsx' }
  value.items[17] = { index: 17, status: 'failed', target: 'out/17.xlsx', error: 'target exists' }
  value.items[18] = { index: 18, status: 'uncertain', target: 'out/18.xlsx', error: 'check target' }
  value.items[19] = { index: 19, status: 'pending', target: 'out/19.xlsx' }
  const original = structuredClone(value)
  const output = JSON.parse(renderBatchResult({ action: 'resume' }, value)[0].text)
  assert.equal(output.status, 'partial')
  assert.deepEqual(output.counts, value.counts)
  assert.deepEqual(output.exceptions, value.items.slice(17))
  assert.equal(output.items, undefined)
  assert.equal(output.resumeAfterFix, undefined)
  assert.deepEqual(output.details, { action: 'status', id: value.id })
  assert.deepEqual(JSON.parse(renderBatchResult(output.details, value)[0].text), original)
  assert.deepEqual(value, original)
  value.items[18] = { index: 18, status: 'pending', target: 'out/18.xlsx' }
  value.counts.uncertain--
  value.counts.pending++
  assert.deepEqual(JSON.parse(renderBatchResult({ action: 'resume' }, value)[0].text).resumeAfterFix, { action: 'resume', id: value.id })
})

test('inconsistent, failed, varied, short and explicitly requested receipts remain complete', () => {
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
