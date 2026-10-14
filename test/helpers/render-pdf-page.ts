import { readFileSync } from 'fs'
import { createPdfRendererComponent } from '../../src/adapters/pdf-renderer'

async function main(): Promise<void> {
  const renderer = createPdfRendererComponent().createRenderer()
  await renderer.initialize(readFileSync(process.argv[2]))
  const { buffer } = await renderer.renderSlide(0)
  let luminance = 0
  for (let i = 0; i < buffer.length; i += 4) luminance += (buffer[i] + buffer[i + 1] + buffer[i + 2]) / 3
  process.stdout.write(JSON.stringify({ meanLuminance: luminance / (buffer.length / 4) }))
  await renderer.destroy()
}

main().catch((error: unknown) => {
  process.stderr.write(String(error))
  process.exit(1)
})
