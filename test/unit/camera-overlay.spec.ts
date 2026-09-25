import { VideoStream } from '@livekit/rtc-node'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { blendPatch, createCameraOverlayComponent, overlayRect } from '../../src/adapters/camera-overlay/component'
import type { ICameraOverlay, OverlayPatch } from '../../src/adapters/camera-overlay/types'
import type { RemoteVideoTrack } from '@livekit/rtc-node'

jest.mock('@livekit/rtc-node', () => ({
  VideoStream: jest.fn(),
  VideoBufferType: { RGBA: 0, I420: 5 }
}))

const VideoStreamMock = VideoStream as unknown as jest.Mock

function createLogger(): ILoggerComponent.ILogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
  }
}

interface FakeReader {
  read: jest.Mock
  cancel: jest.Mock
  push(value: unknown): void
}

function createFakeReader(): FakeReader {
  const queue: unknown[] = []
  let waiting: ((value: unknown) => void) | null = null
  return {
    read: jest.fn(
      () =>
        new Promise((resolve) => {
          if (queue.length > 0) resolve(queue.shift())
          else waiting = resolve
        })
    ),
    cancel: jest.fn().mockResolvedValue(undefined),
    push(value: unknown) {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve(value)
      } else {
        queue.push(value)
      }
    }
  }
}

function solidRgba(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let p = 0; p < data.length; p += 4) data.set(rgba, p)
  return data
}

function cameraFrame(width = 64, height = 48, data = solidRgba(64, 48, [255, 0, 0, 255])) {
  return { done: false, value: { frame: { convert: jest.fn(() => ({ width, height, data })) } } }
}

function i420Frame(width: number, height: number, y: number, u: number, v: number): Buffer {
  const ySize = width * height
  const uvSize = ((width + 1) >> 1) * ((height + 1) >> 1)
  const buf = Buffer.alloc(ySize + uvSize * 2)
  buf.fill(y, 0, ySize)
  buf.fill(u, ySize, ySize + uvSize)
  buf.fill(v, ySize + uvSize)
  return buf
}

function uniformPatch(d: number, y: number, u: number, v: number, alpha: number): OverlayPatch {
  const uvSize = (d / 2) * (d / 2)
  return {
    d,
    y: new Uint8Array(d * d).fill(y),
    u: new Uint8Array(uvSize).fill(u),
    v: new Uint8Array(uvSize).fill(v),
    alpha: new Uint8Array(d * d).fill(alpha)
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

const track = (name: string) => ({ name }) as unknown as RemoteVideoTrack

describe('when computing the overlay rect', () => {
  describe('and the layout is small at the bottom-left of a 960x540 frame', () => {
    it('should clamp the centre inside the margin', () => {
      expect(overlayRect({ x: 0, y: 1, size: 'small' }, 960, 540)).toEqual({ left: 18, top: 376, d: 144 })
    })
  })

  describe('and the layout is large at the top-right of a 960x540 frame', () => {
    it('should clamp the centre inside the margin', () => {
      expect(overlayRect({ x: 1, y: 0, size: 'large' }, 960, 540)).toEqual({ left: 700, top: 18, d: 240 })
    })
  })

  describe('and x is out of range', () => {
    it('should clamp it like x = 1', () => {
      expect(overlayRect({ x: 5, y: 0.5, size: 'small' }, 960, 540)).toEqual(
        overlayRect({ x: 1, y: 0.5, size: 'small' }, 960, 540)
      )
    })
  })

  describe('and the frame is short', () => {
    it('should cap the diameter to the height minus both margins', () => {
      expect(overlayRect({ x: 0, y: 1, size: 'small' }, 960, 100).d).toBe(62)
    })
  })

  describe('and the layout and dimensions vary', () => {
    it('should keep left, top and d even', () => {
      for (const [w, h] of [
        [960, 540],
        [1281, 721],
        [640, 363],
        [1917, 1079]
      ]) {
        for (const size of ['small', 'large'] as const) {
          for (const x of [0, 0.33, 0.5, 0.77, 1]) {
            for (const y of [0, 0.41, 1]) {
              const rect = overlayRect({ x, y, size }, w, h)
              expect([rect.left % 2, rect.top % 2, rect.d % 2]).toEqual([0, 0, 0])
            }
          }
        }
      }
    })
  })
})

describe('when blending a patch', () => {
  const width = 8
  const height = 8
  const ySize = width * height
  const uvW = width / 2
  const uvSize = uvW * (height / 2)
  let frame: Buffer

  beforeEach(() => {
    frame = i420Frame(width, height, 10, 20, 30)
  })

  describe('and the patch is fully opaque', () => {
    beforeEach(() => {
      blendPatch(frame, width, height, uniformPatch(4, 200, 100, 150, 255), { left: 2, top: 2, d: 4 })
    })

    it('should overwrite Y inside the rect only', () => {
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const inside = i >= 2 && i < 6 && j >= 2 && j < 6
          expect(frame[j * width + i]).toBe(inside ? 200 : 10)
        }
      }
    })

    it('should overwrite U and V inside the rect only', () => {
      for (let j = 0; j < height / 2; j++) {
        for (let i = 0; i < uvW; i++) {
          const inside = i >= 1 && i < 3 && j >= 1 && j < 3
          expect(frame[ySize + j * uvW + i]).toBe(inside ? 100 : 20)
          expect(frame[ySize + uvSize + j * uvW + i]).toBe(inside ? 150 : 30)
        }
      }
    })
  })

  describe('and the patch is fully transparent', () => {
    it('should leave the frame untouched', () => {
      const before = Buffer.from(frame)
      blendPatch(frame, width, height, uniformPatch(4, 200, 100, 150, 0), { left: 2, top: 2, d: 4 })
      expect(frame.equals(before)).toBe(true)
    })
  })

  describe('and the patch alpha is 128', () => {
    beforeEach(() => {
      blendPatch(frame, width, height, uniformPatch(4, 200, 100, 150, 128), { left: 2, top: 2, d: 4 })
    })

    it('should land Y between the two values', () => {
      const value = frame[2 * width + 2]
      expect(value).toBeGreaterThan(10)
      expect(value).toBeLessThan(200)
    })

    it('should land U and V between the two values', () => {
      const u = frame[ySize + uvW + 1]
      const v = frame[ySize + uvSize + uvW + 1]
      expect(u).toBeGreaterThan(20)
      expect(u).toBeLessThan(100)
      expect(v).toBeGreaterThan(30)
      expect(v).toBeLessThan(150)
    })
  })

  describe('and the rect is partly outside the frame', () => {
    it('should write only the in-bounds pixels', () => {
      const expected = i420Frame(width, height, 10, 20, 30)
      for (let j = 6; j < 8; j++) for (let i = 6; i < 8; i++) expected[j * width + i] = 200
      expected[ySize + 3 * uvW + 3] = 100
      expected[ySize + uvSize + 3 * uvW + 3] = 150

      expect(() =>
        blendPatch(frame, width, height, uniformPatch(4, 200, 100, 150, 255), { left: 6, top: 6, d: 4 })
      ).not.toThrow()
      expect(frame.equals(expected)).toBe(true)
    })
  })

  describe('and the rect diameter is 0', () => {
    it('should leave the frame untouched', () => {
      const before = Buffer.from(frame)
      blendPatch(frame, width, height, uniformPatch(4, 200, 100, 150, 255), { left: 0, top: 0, d: 0 })
      expect(frame.equals(before)).toBe(true)
    })
  })
})

describe('when running a camera overlay', () => {
  const width = 960
  const height = 540
  let logger: ILoggerComponent.ILogger
  let overlay: ICameraOverlay
  let readerA: FakeReader
  let readerB: FakeReader
  let trackA: RemoteVideoTrack
  let trackB: RemoteVideoTrack

  beforeEach(() => {
    logger = createLogger()
    trackA = track('a')
    trackB = track('b')
    readerA = createFakeReader()
    readerB = createFakeReader()
    VideoStreamMock.mockImplementation((t: RemoteVideoTrack) => ({
      getReader: () => (t === trackA ? readerA : readerB)
    }))
    overlay = createCameraOverlayComponent().createOverlay(logger)
  })

  afterEach(async () => {
    await overlay.stop()
    jest.restoreAllMocks()
    VideoStreamMock.mockReset()
  })

  describe('and the first camera frame has not arrived', () => {
    beforeEach(() => {
      overlay.start(trackA)
    })

    it('should not be active', () => {
      expect(overlay.isActive()).toBe(false)
    })

    it('should leave a stamped frame untouched', () => {
      const frame = i420Frame(width, height, 16, 128, 128)
      const before = Buffer.from(frame)
      overlay.stamp(frame, width, height)
      expect(frame.equals(before)).toBe(true)
    })
  })

  describe('and a camera frame arrives', () => {
    let callback: jest.Mock

    beforeEach(async () => {
      callback = jest.fn()
      overlay.onCameraFrame(callback)
      overlay.start(trackA)
      readerA.push(cameraFrame())
      await flush()
    })

    it('should be active', () => {
      expect(overlay.isActive()).toBe(true)
    })

    it('should fire the camera frame callbacks', () => {
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('should change Y at the bubble centre and leave the corners unchanged', () => {
      const frame = i420Frame(width, height, 16, 128, 128)
      overlay.stamp(frame, width, height)
      const rect = overlayRect(overlay.getLayout(), width, height)
      const cx = rect.left + rect.d / 2
      const cy = rect.top + rect.d / 2
      expect(frame[cy * width + cx]).not.toBe(16)
      for (const [x, y] of [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1]
      ]) {
        expect(frame[y * width + x]).toBe(16)
      }
    })

    describe('and the overlay is stopped', () => {
      beforeEach(async () => {
        await overlay.stop()
      })

      it('should not be active', () => {
        expect(overlay.isActive()).toBe(false)
      })

      it('should make stamp a no-op', () => {
        const frame = i420Frame(width, height, 16, 128, 128)
        const before = Buffer.from(frame)
        overlay.stamp(frame, width, height)
        expect(frame.equals(before)).toBe(true)
      })
    })
  })

  describe('and the overlay is restarted on another track while stopping', () => {
    let frameA: ReturnType<typeof cameraFrame>
    let frameB: ReturnType<typeof cameraFrame>

    beforeEach(async () => {
      frameA = cameraFrame()
      frameB = cameraFrame()
      overlay.start(trackA)
      void overlay.stop()
      overlay.start(trackB)
      readerA.push(frameA)
      readerB.push(frameB)
      await flush()
    })

    it('should be active from the new track frames', () => {
      expect(overlay.isActive()).toBe(true)
      expect(frameB.value.frame.convert).toHaveBeenCalled()
      expect(frameA.value.frame.convert).not.toHaveBeenCalled()
    })

    it('should cancel the old track reader', () => {
      expect(readerA.cancel).toHaveBeenCalled()
    })
  })

  describe('and a camera frame callback throws', () => {
    let throwing: jest.Mock
    let healthy: jest.Mock

    beforeEach(async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000)
      throwing = jest.fn(() => {
        throw new Error('boom')
      })
      healthy = jest.fn()
      overlay.onCameraFrame(throwing)
      overlay.onCameraFrame(healthy)
      overlay.start(trackA)
      readerA.push(cameraFrame())
      await flush()
      now.mockReturnValue(1100)
      readerA.push(cameraFrame())
      await flush()
    })

    it('should log a warning', () => {
      expect(logger.warn).toHaveBeenCalled()
    })

    it('should keep delivering frames to the other callbacks', () => {
      expect(throwing).toHaveBeenCalledTimes(2)
      expect(healthy).toHaveBeenCalledTimes(2)
    })
  })

  describe('and two identical camera frames arrive past the throttle', () => {
    let callback: jest.Mock
    let first: Buffer
    let second: Buffer

    beforeEach(async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000)
      callback = jest.fn()
      overlay.onCameraFrame(callback)
      overlay.start(trackA)
      readerA.push(cameraFrame())
      await flush()
      first = i420Frame(width, height, 16, 128, 128)
      overlay.stamp(first, width, height)
      now.mockReturnValue(1100)
      readerA.push(cameraFrame())
      await flush()
      second = i420Frame(width, height, 16, 128, 128)
      overlay.stamp(second, width, height)
    })

    it('should rebuild the patch for each frame', () => {
      expect(callback).toHaveBeenCalledTimes(2)
    })

    it('should stamp byte-identical results', () => {
      expect(first.equals(i420Frame(width, height, 16, 128, 128))).toBe(false)
      expect(second.equals(first)).toBe(true)
    })
  })

  describe('and a camera frame has invalid dimensions', () => {
    let callback: jest.Mock

    beforeEach(async () => {
      callback = jest.fn()
      overlay.onCameraFrame(callback)
      overlay.start(trackA)
      readerA.push(cameraFrame(99999, 48, new Uint8Array(16)))
      await flush()
    })

    it('should drop the frame', () => {
      expect(overlay.isActive()).toBe(false)
      expect(callback).not.toHaveBeenCalled()
    })

    it('should log a warning', () => {
      expect(logger.warn).toHaveBeenCalled()
    })
  })
})
