import assert from 'node:assert/strict'
import test from 'node:test'
import { compactShellResult } from '../src/compact.js'

const progress = 'Downloading package 7 of 12 (50%)'
const accept = { kind: 'accept' }

function shellResult(text) {
  return { content: [{ type: 'text', text }], value: { exitCode: 0, stdout: { text } } }
}

test('fold repeated carriage-return updates without touching raw output or the final status', () => {
  const body = (progress + '\r').repeat(80) + 'Download complete\r\n[exit code: 0]'
  const result = shellResult(body)
  const folded = compactShellResult('pwsh', result, accept)
  assert.equal(folded.content?.[0].text,
    progress + '\r[previous line repeated 79 more times]\rDownload complete\r\n[exit code: 0]')
  assert.equal(result.content[0].text, body)
  assert.equal(result.value.stdout.text, body)
})

test('preserve LF and CRLF boundaries surrounding a run of carriage-return updates', () => {
  const prefix = 'started\r\n\n'
  const suffix = progress + '\r\nverifying\n\r\nDONE'
  const body = prefix + (progress + '\r').repeat(80) + suffix
  const folded = compactShellResult('bash', shellResult(body), accept)
  assert.equal(folded.content?.[0].text,
    prefix + progress + '\r[previous line repeated 79 more times]\r' + suffix)
})

test('keep distinct progress updates and cheap separators verbatim', () => {
  const changing = Array.from({ length: 80 }, (_, n) => 'Downloaded chunk ' + n + ' of 80\r').join('')
  const separator = ('.'.repeat(128) + '\r').repeat(4) + 'END'
  for (const text of [changing, separator])
    assert.equal(compactShellResult('pwsh', shellResult(text), accept), accept)
})

test('leave failed and rejected progress output intact', () => {
  const result = shellResult((progress + '\r').repeat(80) + 'Download failed')
  const reject = { kind: 'block', feedback: [] }
  assert.equal(compactShellResult('pwsh', result, reject), reject)
  assert.equal(compactShellResult('pwsh', { ...result, isError: true }, accept), accept)
  assert.equal(compactShellResult('pwsh', { ...result, value: { ...result.value, exitCode: 1 } }, accept), accept)
})

test('fold repeated multiline log blocks while retaining every distinct line and exact repetition count', () => {
  const block = '编译 compile source files\r\n检查 check assets and references\r\n'
  const body = 'START\r\n' + block.repeat(80) + 'warning: review optional asset\r\nBUILD OK\r\n[exit code: 0]'
  const result = shellResult(body)
  const folded = compactShellResult('bash', result, accept)
  assert.match(folded.content?.[0].text ?? '', /previous 2 lines repeated 79 more times/)
  assert.ok(folded.content[0].text.includes(block))
  assert.ok(folded.content[0].text.endsWith('warning: review optional asset\r\nBUILD OK\r\n[exit code: 0]'))
  assert.equal(result.value.stdout.text, body)
})
