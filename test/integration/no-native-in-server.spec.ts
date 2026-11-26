import { execFileSync } from 'child_process'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '../..')

const LIST_NATIVE_MODULES_SCRIPT = `
require('./src/components')
const pattern = /node_modules\\/(@livekit\\/rtc-node|@napi-rs\\/canvas|pdfjs-dist)[/-]/
const loaded = new Set()
for (const file of Object.keys(require.cache)) {
  const match = pattern.exec(file)
  if (match) loaded.add(match[1])
}
process.stdout.write(JSON.stringify([...loaded].sort()))
`

describe('when the server components module is loaded', () => {
  let loadedNativeModules: string[]

  beforeEach(() => {
    const stdout = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', LIST_NATIVE_MODULES_SCRIPT],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    loadedNativeModules = JSON.parse(stdout)
  }, 60_000)

  it('should not load the LiveKit, canvas or pdfjs native modules', () => {
    expect(loadedNativeModules).toEqual([])
  })
})
