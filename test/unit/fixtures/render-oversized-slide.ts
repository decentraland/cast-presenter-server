import { createCanvas } from '@napi-rs/canvas'
import { assertRenderableDimensions, toEvenDimension } from '../../../src/adapters/renderer/dimensions'
import { SlideRenderError } from '../../../src/adapters/renderer/errors'

const requestedHeight = Number(process.argv[2])
const skipGuard = process.argv[3] === 'skip-guard'

try {
  const width = toEvenDimension(960)
  const height = toEvenDimension(requestedHeight)
  if (!skipGuard) assertRenderableDimensions(width, height)
  createCanvas(width, height)
  process.stdout.write('RENDERED')
} catch (err) {
  process.stdout.write(`REJECTED:${new SlideRenderError(0, err).name}`)
}
