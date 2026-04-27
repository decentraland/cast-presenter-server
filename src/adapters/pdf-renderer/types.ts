// The renderer interface lives under ../renderer/ so it isn't owned by any
// single format adapter. Re-exported here for backwards compatibility with
// existing imports; new code should import from ../renderer.
export type { IRenderer, IRendererComponent, RenderResult } from '../renderer/types'
