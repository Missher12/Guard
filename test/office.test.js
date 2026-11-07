import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { python, runWorker, workspace } from './worker.js'

const exec = promisify(execFile)
const create = fileURLToPath(new URL('./office-fixtures.py', import.meta.url))
const office = (root, request, runtime = {}) => runWorker(root, request, { family: 'office', runtime })
async function fixture(t) {
  const root = await workspace(t)
  await exec(python, ['-B', create, root])
  return root
}
const okay = result => assert.equal(result.status, 'completed', JSON.stringify(result))

test('Office edits Excel values, Word runs/tables and PowerPoint text/pictures without changing originals', async t => {
  const root = await fixture(t)
  const originals = await Promise.all(['book1.xlsx', 'letter.docx', 'slides.pptx'].map(p => readFile(path.join(root, p))))
  okay(await office(root, { action: 'edit', files: [{ path: 'book1.xlsx', parameters: {
    cells: [{ sheet: '数据', cell: 'B2', value: 9 }],
  } }, { path: 'letter.docx', parameters: { fields: { name: '张三' }, tables: [{ table: 1, row: 1, column: 1, value: 'new' }] } },
  { path: 'slides.pptx', parameters: { fields: { name: '张三' }, pictures: [{ slide: 1, shape: 2, image: 'pixel.png' }] } }] }))
  await exec(python, ['-B', '-c', `from pathlib import Path
import sys
from openpyxl import load_workbook
from docx import Document
from pptx import Presentation
p=Path(sys.argv[1])/'guard-output'
b=load_workbook(p/'book1.xlsx'); assert b['数据']['B2'].value==9; assert b['数据']['B2'].font.bold; assert b['数据']['C2'].value=='=B2*2'
d=Document(p/'letter.docx'); assert d.paragraphs[0].text=='Hello 张三!'; assert d.paragraphs[0].runs[0].bold; assert d.paragraphs[0].runs[1].italic; assert d.tables[0].cell(0,0).text=='new'
r=Presentation(p/'slides.pptx'); assert len(r.slides)==1; assert r.slides[0].shapes[0].text=='Hello 张三'; assert r.slides[0].shapes[1].width==914400`, root])
  for (const [i, file] of ['book1.xlsx', 'letter.docx', 'slides.pptx'].entries()) assert.deepEqual(await readFile(path.join(root, file)), originals[i])
})

test('Office merges keyed spreadsheets and PDF pages, splits in requested order and extracts text', async t => {
  const root = await fixture(t)
  okay(await office(root, { action: 'merge', files: [{ path: 'book1.xlsx' }, { path: 'book2.xlsx' }], output: 'merged.xlsx', parameters: { sheet: '数据', key: 'id' } }))
  const sheet = await office(root, { action: 'read', files: [{ path: 'merged.xlsx' }], parameters: { sheet: '数据' } })
  okay(sheet)
  assert.deepEqual(sheet.items[0].result.rows, [['id', 'value', 'double'], [1, 3, '=B2*2'], [2, 6, '=B3*2']])
  okay(await office(root, { action: 'merge', files: [{ path: 'page1.pdf' }, { path: 'page2.pdf' }], output: 'merged.pdf' }))
  okay(await office(root, { action: 'split', files: [{ path: 'merged.pdf', output: 'selected.pdf' }], parameters: { pages: [2, 1] } }))
  const pdf = await office(root, { action: 'read', files: [{ path: 'selected.pdf' }] })
  okay(pdf)
  assert.equal(pdf.items[0].result.pages.length, 2)
  assert.match(pdf.items[0].result.pages[0].text, /Page 2/)
  assert.match(pdf.items[0].result.pages[1].text, /Page 1/)
})

test('Excel merge preserves styles from different workbooks and literal formula-like strings', async t => {
  const root = await fixture(t)
  await exec(python, ['-B', '-c', `import sys
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill
b=load_workbook(sys.argv[1]); s=b.active
s['B2'].font=Font(name='Courier New', italic=True, color='FF0055AA')
s['B2'].fill=PatternFill('solid', fgColor='FFFFFF00')
s['C2']='=literal'; s['C2'].data_type='s'
b.save(sys.argv[1])`, path.join(root, 'book2.xlsx')])
  okay(await office(root, { action: 'merge', files: [{ path: 'book1.xlsx' }, { path: 'book2.xlsx' }], parameters: { key: 'id' } }))
  await exec(python, ['-B', '-c', `import sys
from openpyxl import load_workbook
s=load_workbook(sys.argv[1]).active
assert s['B3'].font.name=='Courier New' and s['B3'].font.italic
assert s['B3'].font.color.rgb=='FF0055AA' and s['B3'].fill.fgColor.rgb=='FFFFFF00'
assert s['C3'].value=='=literal' and s['C3'].data_type=='s'
assert s['C2'].value=='=B2*2' and s['C2'].data_type=='f'`, path.join(root, 'guard-output/merged.xlsx')])
})

test('Excel merge refuses formulas that depend on other data rows', async t => {
  const root = await fixture(t)
  await exec(python, ['-B', '-c', "import sys; from openpyxl import load_workbook; b=load_workbook(sys.argv[1]); b.active['C2']='=B3*2'; b.save(sys.argv[1])", path.join(root, 'book2.xlsx')])
  assert.equal((await office(root, { action: 'merge', files: [{ path: 'book1.xlsx' }, { path: 'book2.xlsx' }], parameters: { key: 'id' } })).status, 'failed')
})

test('Office resume refuses a replacement image changed after the original batch', async t => {
  const root = await fixture(t)
  const result = await office(root, { action: 'edit', files: [{ path: 'slides.pptx' }], parameters: {
    pictures: [{ slide: 1, shape: 2, image: 'pixel.png' }],
  } })
  okay(result)
  const receiptPath = path.join(root, '.dsh-guard', `${result.id}.json`)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.items[0].status = 'pending'
  await writeFile(receiptPath, JSON.stringify(receipt))
  await rm(path.join(root, 'guard-output/slides.pptx'))
  await writeFile(path.join(root, 'pixel.png'), 'changed input')
  const resumed = await office(root, { action: 'resume', id: result.id })
  assert.equal(resumed.status, 'partial')
  assert.match(resumed.items[0].error, /发生变化/)
})

test('Office refuses missing targets, invalid formats and pre-existing outputs before overwriting documents', async t => {
  const root = await fixture(t)
  const before = await readFile(path.join(root, 'letter.docx'))
  const result = await office(root, { action: 'edit', overwrite: true, files: [{ path: 'letter.docx' }], parameters: {
    replacements: [{ oldText: 'missing', newText: 'X', count: 1 }],
  } })
  assert.notEqual(result.status, 'completed')
  assert.deepEqual(await readFile(path.join(root, 'letter.docx')), before)
  await writeFile(path.join(root, 'broken.xlsx'), 'not an office archive')
  assert.equal((await office(root, { action: 'inspect', files: [{ path: 'broken.xlsx' }] })).status, 'partial')
  assert.equal((await office(root, { action: 'edit', files: [{ path: 'letter.docx', output: 'letter.docx' }], parameters: { fields: { name: 'X' } } })).status, 'failed')
  assert.equal((await office(root, { action: 'edit', files: [{ path: 'letter.docx' }], parameters: {
    cells: [{ sheet: '数据', cell: 'A1', value: 'must-not-ignore' }],
  } })).status, 'failed', 'inapplicable parameters must never be silently ignored')
  assert.equal((await office(root, { action: 'merge', files: [{ path: 'page1.pdf' }, { path: 'page2.pdf' }], parameters: { pages: [1] } })).status, 'failed')
})

const runtime = process.env.DSH_TEST_OFFICE_CLI ? { node: process.execPath, officeCli: process.env.DSH_TEST_OFFICE_CLI }
  : process.platform === 'darwin' ? { node: process.execPath,
      officeCli: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js' } : undefined
test('installed Office engine exports real PDF and recalculates formula values', { skip: !runtime }, async t => {
  const root = await fixture(t)
  okay(await office(root, { action: 'export_pdf', files: [{ path: 'letter.docx' }] }, runtime))
  assert.equal((await readFile(path.join(root, 'guard-output/letter.pdf'))).subarray(0, 5).toString(), '%PDF-')
  okay(await office(root, { action: 'recalculate', files: [{ path: 'book1.xlsx' }] }, runtime))
  await exec(python, ['-B', '-c', "from openpyxl import load_workbook; import sys; b=load_workbook(sys.argv[1],data_only=True); assert b['数据']['C2'].value==6", path.join(root, 'guard-output/book1.xlsx')])
})
