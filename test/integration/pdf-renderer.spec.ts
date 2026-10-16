import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const ROOT = path.join(__dirname, '../..')
const RENDER_TIMEOUT_MS = 60_000

async function renderMeanLuminance(fixture: string): Promise<number> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', 'test/helpers/render-pdf-page.ts', `test/fixtures/pdf/${fixture}`],
    { cwd: ROOT, env: { ...process.env, TS_NODE_PROJECT: 'test/tsconfig.json' }, timeout: RENDER_TIMEOUT_MS }
  )
  return (JSON.parse(stdout) as { meanLuminance: number }).meanLuminance
}

describe.each([
  ['a CCITT fax image', 'ccitt-black.pdf'],
  ['a JPEG2000 image', 'jpx-black.pdf']
])('when rendering a PDF page that is entirely %s of black pixels with real pdfjs', (_label, fixture) => {
  let meanLuminance: number

  beforeEach(async () => {
    meanLuminance = await renderMeanLuminance(fixture)
  }, RENDER_TIMEOUT_MS)

  it('should draw the decoded image instead of a blank page', () => {
    expect(meanLuminance).toBeLessThan(10)
  })
})
