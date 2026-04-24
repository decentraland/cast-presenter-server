export interface GeometryOptions {
  x: number
  y: number
  width: number
  height: number
  rotation?: number
}

export class Geometry {
  public readonly x: number
  public readonly y: number
  public readonly width: number
  public readonly height: number
  public readonly rotation: number

  constructor(options: GeometryOptions) {
    this.x = options.x
    this.y = options.y
    this.width = options.width
    this.height = options.height
    this.rotation = options.rotation ?? 0
  }
}
