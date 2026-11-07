import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

if (process.platform !== 'darwin') throw Error('verify:macos 需要在 macOS 上执行。')
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(root, '.dsh-verify-'))
try {
  const bundle = path.join(root, `${pkg.name}-${pkg.version}.tgz`)
  execFileSync('/usr/bin/tar', ['-xzf', bundle, '-C', temporary])
  const extracted = path.join(temporary, 'package')
  console.log('验证安装包:', bundle)
  execFileSync(process.execPath, ['--test', 'test/macos.test.js', 'test/batch-host.test.js', 'test/batch.test.js', 'test/office.test.js'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DSH_GUARD_TEST_ROOT: extracted,
      DSH_GUARD_TEST_ENTRY: path.join(extracted, 'src/index.js') },
  })
} finally { await rm(temporary, { recursive: true, force: true }) }
