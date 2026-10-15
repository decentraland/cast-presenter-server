import { type SpawnSyncReturns, spawnSync } from 'child_process'
import * as path from 'path'

const PROJECT_ROOT = path.join(__dirname, '..', '..')
const FIXTURE = path.join(__dirname, 'fixtures', 'render-oversized-slide.ts')
const PRODUCTION_NODE_FLAGS = ['--abort-on-uncaught-exception', '--unhandled-rejections=strict']
const OVERSIZED_HEIGHT = String(1_000_000_000)

function renderUnderProductionFlags(...fixtureArgs: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [...PRODUCTION_NODE_FLAGS, '-r', 'ts-node/register/transpile-only', FIXTURE, ...fixtureArgs],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: path.join(PROJECT_ROOT, 'tsconfig.json') }
    }
  )
}

describe('when rendering a slide under the production --abort-on-uncaught-exception flag', () => {
  describe('and the computed canvas dimensions exceed the render limit', () => {
    let result: SpawnSyncReturns<string>

    beforeEach(() => {
      result = renderUnderProductionFlags(OVERSIZED_HEIGHT)
    })

    it('should exit cleanly instead of aborting the process', () => {
      expect(result.status).toBe(0)
    }, 30000)

    it('should report the failure as a SlideRenderError', () => {
      expect(result.stdout).toBe('REJECTED:SlideRenderError')
    }, 30000)
  })

  describe('and the dimension guard is bypassed', () => {
    let result: SpawnSyncReturns<string>

    beforeEach(() => {
      result = renderUnderProductionFlags(OVERSIZED_HEIGHT, 'skip-guard')
    })

    it('should abort before the local try/catch runs, confirming the guard is load-bearing', () => {
      expect(result.stdout).toBe('')
    }, 30000)
  })
})
