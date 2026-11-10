import { createWorkerRunner } from './runtime.js'
import { renderBatchResult } from './compact.js'

const batchRunners = new WeakSet()
export const batchDependency = definition => batchRunners.has(definition?.execute) ? 'load_workspace_dependencies' : undefined

const text = { type: 'string' }
const replacement = { type: 'object', required: ['oldText', 'newText', 'count'], additionalProperties: false,
  properties: { oldText: text, newText: text, count: { type: 'integer', minimum: 1 } } }
const parameters = { type: 'object', properties: {
  fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Replace {{field}} placeholders.' },
  replacements: { type: 'array', items: replacement },
  cells: { type: 'array', items: { type: 'object', required: ['sheet', 'cell', 'value'], properties: {
    sheet: text, cell: text, value: { type: ['string', 'number', 'boolean', 'null'] } } } },
  tables: { type: 'array', items: { type: 'object', required: ['table', 'row', 'column', 'value'], properties: {
    table: { type: 'integer', minimum: 1 }, row: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 }, value: text } } },
  pictures: { type: 'array', items: { type: 'object', required: ['slide', 'shape', 'image'], properties: {
    slide: { type: 'integer', minimum: 1 }, shape: { type: 'integer', minimum: 1 }, image: text } } },
  sheet: text, key: text, duplicate: { type: 'string', enum: ['error', 'first', 'last'] },
  pages: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '1-based PDF pages, in output order.' },
  offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
}, additionalProperties: false }

export function mountBatchTools(ctx, config = {}) {
  ctx.inject(['subprocess', 'workingDirectory', 'sandboxPolicy'], inner => {
    const run = createWorkerRunner(inner)
    const output = { schema: { type: 'object', additionalProperties: true },
      render: (args, value) => renderBatchResult(args, value, config.compactOutput !== false) }
    function register(name, description, properties, family) {
      const execute = (args, exec) => run(exec, family, args)
      batchRunners.add(execute)
      inner.tools.register({ name, description, parameters: { type: 'object', required: ['action'], additionalProperties: false, properties },
        output, execute,
        presentCall: args => ({ card: 'generic', title: family === 'files' ? '批量处理文件' : '批量处理办公文档',
          kind: ['read', 'inspect', 'list', 'status'].includes(args.action) ? 'read' : 'edit', rawInput: args }),
      })
    }
    register('guard_file_batch', 'Process explicit regular files in the session directory: copy, move, rename or exact UTF-8 replacement. ' +
      'All items are checked before edits; new destinations never overwrite and replace_text updates the source only. Stop on failure. Inspect status/counts/items; partial is not success. ' +
      'After interruption use list/status then resume by id; never replay completed or uncertain operations. Uses DSH permissions and bundled runtime.', {
      action: { type: 'string', enum: ['run', 'resume', 'list', 'status'] }, id: text,
      offset: { type: 'integer', minimum: 0, description: 'Batch list pagination offset.' },
      onError: { type: 'string', enum: ['stop', 'continue'], default: 'stop' },
      operations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object',
        required: ['kind', 'source'], additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['copy', 'move', 'rename', 'replace_text'] }, source: text, destination: text,
          edits: { type: 'array', items: replacement },
        } } },
    }, 'files')
    register('guard_office_batch', 'Read, inspect or batch edit xlsx/docx/pptx/pdf using DSH Office libraries. ' +
      'edit supports xlsx cells/fields, docx fields/replacements/tables, pptx fields/replacements/pictures. ' +
      'merge supports xlsx (sheet,key,duplicate) or PDF. split selects PDF pages into each explicit output. ' +
      'export_pdf and recalculate use the installed Office engine. Outputs default to guard-output; overwrite requires explicit true and user intent. ' +
      'Formula writing is not recalculation; successful saving is not visual inspection. Follow Office skills for appearance checks. ' +
      'Check each result; list/status/resume recover batches without replaying completed work.', {
      action: { type: 'string', enum: ['inspect', 'read', 'edit', 'merge', 'split', 'export_pdf', 'recalculate', 'resume', 'list', 'status'] },
      id: text, output: text, overwrite: { type: 'boolean', default: false }, parameters,
      offset: { type: 'integer', minimum: 0, description: 'Batch list pagination offset.' },
      onError: { type: 'string', enum: ['stop', 'continue'], default: 'stop' },
      files: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['path'], additionalProperties: false,
        properties: { path: text, output: text, parameters } } },
    }, 'office')
  })
}
