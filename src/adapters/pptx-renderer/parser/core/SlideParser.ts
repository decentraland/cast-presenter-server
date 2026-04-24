import { LINE_BREAK_SENTINEL, getAttr, getAttrNumber, getNode, toArray } from './XMLUtils'
import { Geometry } from '../models/Geometry'
import { Shape } from '../models/Shape'
import { Slide } from '../models/Slide'
import { EMU_PER_PIXEL, IMAGE_EXTENSIONS, PT_TO_PX, VIDEO_EXTENSIONS } from '../utils/constants'
import type { RelationshipParser } from './RelationshipParser'
import type { ShapeType } from '../models/Shape'
import type { Background, Fill, GradientStop, Shadow, Stroke, TextParagraph, TextRun } from '../models/types'

export interface SlideParseOptions {
  width?: number
  height?: number
  slideNumber?: number
  themeColors?: Record<string, string>
  layoutXML?: Record<string, unknown>
  masterXML?: Record<string, unknown>
}

interface GroupTransform {
  offX: number
  offY: number
  extCX: number
  extCY: number
  chOffX: number
  chOffY: number
  chExtCX: number
  chExtCY: number
}

/** Convert '#rrggbb' (or 'rrggbb') + alpha in [0,1] into an rgba() string. */
function hexToRgba(hex: string, alpha: number): string {
  const s = hex.replace('#', '')
  if (s.length !== 6) return hex
  const r = parseInt(s.slice(0, 2), 16)
  const g = parseInt(s.slice(2, 4), 16)
  const b = parseInt(s.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

export class SlideParser {
  static parse(
    slideXML: Record<string, unknown>,
    relParser: RelationshipParser,
    slidePath: string,
    options?: SlideParseOptions
  ): Slide {
    // The root element is 'p:sld'
    const sld = slideXML['p:sld'] as Record<string, unknown>
    if (!sld) {
      throw new Error('Invalid slide XML: missing p:sld element')
    }

    const slideId = getAttr(sld, 'id') ?? ''
    const content = sld['p:cSld'] as Record<string, unknown> | undefined
    const themeColors = options?.themeColors
    const slideNumber = options?.slideNumber

    // Unpack layout and master content nodes
    const layoutCsld = (options?.layoutXML?.['p:sldLayout'] as Record<string, unknown> | undefined)?.['p:cSld'] as
      | Record<string, unknown>
      | undefined
    const masterEl = options?.masterXML?.['p:sldMaster'] as Record<string, unknown> | undefined
    const masterCsld = masterEl?.['p:cSld'] as Record<string, unknown> | undefined

    // Master text styles
    const masterTxStyles = masterEl?.['p:txStyles'] as Record<string, unknown> | undefined
    const masterBodyStyle = masterTxStyles?.['p:bodyStyle'] as Record<string, unknown> | undefined
    const masterOtherStyle = masterTxStyles?.['p:otherStyle'] as Record<string, unknown> | undefined

    // Resolve phClr from master before any other parsing
    const resolvedThemeColors = SlideParser.resolvePhClr(themeColors, masterOtherStyle ?? masterBodyStyle)

    // Parse background with layout/master fallback chain
    const slideBg = content
      ? this.parseBackground(content['p:bg'], relParser, slidePath, resolvedThemeColors)
      : undefined
    const layoutBg = layoutCsld
      ? this.parseBackground(layoutCsld['p:bg'], undefined, undefined, resolvedThemeColors)
      : undefined
    const masterBg = masterCsld
      ? this.parseBackground(masterCsld['p:bg'], undefined, undefined, resolvedThemeColors)
      : undefined
    const background = slideBg ?? layoutBg ?? masterBg

    // Build placeholder style maps from layout and master
    const layoutSld = options?.layoutXML?.['p:sldLayout'] as Record<string, unknown> | undefined
    const masterSld = options?.masterXML?.['p:sldMaster'] as Record<string, unknown> | undefined
    const layoutPhMap = this.buildPlaceholderStyleMap(layoutSld)
    const masterPhMap = this.buildPlaceholderStyleMap(masterSld)

    // Parse shapes from shape tree
    const shapes: Shape[] = []
    const shapeTree = getNode(content, ['p:spTree']) as Record<string, unknown> | undefined

    if (shapeTree) {
      shapes.push(
        ...this.parseShapes(
          shapeTree,
          relParser,
          slidePath,
          resolvedThemeColors,
          undefined,
          slideNumber,
          masterBodyStyle,
          masterOtherStyle,
          layoutPhMap,
          masterPhMap
        )
      )
    }

    return new Slide({
      id: slideId,
      shapes,
      background,
      width: options?.width,
      height: options?.height
    })
  }

  private static parseBackground(
    bg: unknown,
    relParser?: RelationshipParser,
    slidePath?: string,
    themeColors?: Record<string, string>
  ): Background | undefined {
    if (!bg || typeof bg !== 'object') return undefined

    const bgObj = bg as Record<string, unknown>
    const bgPr = bgObj['p:bgPr'] as Record<string, unknown> | undefined

    if (!bgPr) return undefined

    const solidFill = getNode(bgPr, ['a:solidFill']) as Record<string, unknown> | undefined
    if (solidFill) {
      const color = this.parseSolidFillColor(solidFill, themeColors)
      if (color) return { color }
    }

    const gradFill = bgPr['a:gradFill'] as Record<string, unknown> | undefined
    if (gradFill) {
      const stops = this.parseGradientStops(gradFill, themeColors)
      if (stops.length > 0) {
        const lin = getNode(gradFill, ['a:lin']) as Record<string, unknown> | undefined
        const ang = lin ? getAttrNumber(lin, 'ang') : undefined
        return { gradientStops: stops, gradientAngle: ang !== undefined ? ang / 60000 : 0 }
      }
    }

    const blipFill = getNode(bgPr, ['a:blipFill']) as Record<string, unknown> | undefined
    if (blipFill && relParser && slidePath) {
      const blip = getNode(blipFill, ['a:blip']) as Record<string, unknown> | undefined
      const rId = blip ? (getAttr(blip, 'r:embed') ?? getAttr(blip, 'r:link')) : undefined
      if (rId) {
        const resolved = relParser.resolveTarget(rId, slidePath)
        if (resolved) return { imageRef: resolved }
      }
    }

    return undefined
  }

  /**
   * Walks a slide master/layout's p:spTree and builds a map of placeholder type → lstStyle.
   * Keys are ph @_type values (e.g. "title", "ctrTitle", "body") or "idx:N" for body-by-index.
   */
  private static buildPlaceholderStyleMap(
    rootEl: Record<string, unknown> | undefined
  ): Record<string, Record<string, unknown>> {
    const map: Record<string, Record<string, unknown>> = {}
    if (!rootEl) return map

    const cSld = rootEl['p:cSld'] as Record<string, unknown> | undefined
    const spTree = getNode(cSld, ['p:spTree']) as Record<string, unknown> | undefined
    if (!spTree) return map

    for (const sp of toArray(spTree['p:sp'] as unknown)) {
      const spObj = sp as Record<string, unknown>
      const nvSpPr = spObj['p:nvSpPr'] as Record<string, unknown> | undefined
      const nvPr = getNode(nvSpPr, ['p:nvPr']) as Record<string, unknown> | undefined
      const phNode = getNode(nvPr, ['p:ph']) as Record<string, unknown> | undefined
      if (!phNode) continue

      const phType = getAttr(phNode as unknown, 'type')
      const phIdx = getAttr(phNode as unknown, 'idx')

      const txBody = spObj['p:txBody'] as Record<string, unknown> | undefined
      const lstStyle = txBody?.['a:lstStyle'] as Record<string, unknown> | undefined
      if (!lstStyle) continue

      if (phType) {
        map[phType] = lstStyle
      } else if (phIdx) {
        map[`idx:${phIdx}`] = lstStyle
      } else {
        // No type and no idx — treat as body (idx=0)
        map['body'] ??= lstStyle
      }
    }

    return map
  }

  private static parseShapes(
    shapeTree: Record<string, unknown>,
    relParser: RelationshipParser,
    slidePath: string,
    themeColors?: Record<string, string>,
    groupTransform?: GroupTransform,
    slideNumber?: number,
    masterBodyStyle?: Record<string, unknown>,
    masterOtherStyle?: Record<string, unknown>,
    layoutPhMap?: Record<string, Record<string, unknown>>,
    masterPhMap?: Record<string, Record<string, unknown>>,
    depth = 0
  ): Shape[] {
    // Depth cap prevents a crafted PPTX with deeply nested <p:grpSp> groups
    // from exhausting the call stack. 50 is well above any legitimate deck
    // (PowerPoint's UI doesn't nest beyond ~10 for manual grouping).
    const MAX_GROUP_NESTING_DEPTH = 50
    if (depth > MAX_GROUP_NESTING_DEPTH) {
      throw new Error(`PPTX shape nesting exceeds ${MAX_GROUP_NESTING_DEPTH} levels`)
    }

    const shapes: Shape[] = []

    // Parse regular shapes <p:sp>
    for (const sp of toArray(shapeTree['p:sp'] as unknown)) {
      const shape = this.parseShape(
        sp as Record<string, unknown>,
        relParser,
        themeColors,
        groupTransform,
        slideNumber,
        masterBodyStyle,
        masterOtherStyle,
        layoutPhMap,
        masterPhMap
      )
      if (shape) shapes.push(shape)
    }

    // Parse pictures/media <p:pic>
    for (const pic of toArray(shapeTree['p:pic'] as unknown)) {
      const shape = this.parsePicture(pic as Record<string, unknown>, relParser, slidePath, groupTransform)
      if (shape) shapes.push(shape)
    }

    // Parse grouped shapes <p:grpSp> (recursively)
    for (const grpSp of toArray(shapeTree['p:grpSp'] as unknown)) {
      const grp = grpSp as Record<string, unknown>
      const grpSpPr = grp['p:grpSpPr'] as Record<string, unknown> | undefined
      const childGroupTransform = grpSpPr ? this.parseGroupTransform(grpSpPr) : undefined
      const innerShapeTree = grp['p:spTree'] as Record<string, unknown> | undefined
      if (innerShapeTree) {
        shapes.push(
          ...this.parseShapes(
            innerShapeTree,
            relParser,
            slidePath,
            themeColors,
            childGroupTransform,
            slideNumber,
            masterBodyStyle,
            masterOtherStyle,
            layoutPhMap,
            masterPhMap,
            depth + 1
          )
        )
      } else {
        // Groups can also directly contain shape elements
        shapes.push(
          ...this.parseShapes(
            grp,
            relParser,
            slidePath,
            themeColors,
            childGroupTransform,
            slideNumber,
            masterBodyStyle,
            masterOtherStyle,
            layoutPhMap,
            masterPhMap,
            depth + 1
          )
        )
      }
    }

    // Parse graphic frames <p:graphicFrame> (charts, tables, etc.)
    for (const gf of toArray(shapeTree['p:graphicFrame'] as unknown)) {
      const shape = this.parseGraphicFrame(gf as Record<string, unknown>, relParser, slidePath)
      if (shape) shapes.push(shape)
    }

    return shapes
  }

  private static parseGroupTransform(grpSpPr: Record<string, unknown>): GroupTransform | undefined {
    const xfrm = getNode(grpSpPr, ['a:xfrm']) as Record<string, unknown> | undefined
    if (!xfrm) return undefined

    const off = xfrm['a:off'] as Record<string, unknown> | undefined
    const ext = xfrm['a:ext'] as Record<string, unknown> | undefined
    const chOff = xfrm['a:chOff'] as Record<string, unknown> | undefined
    const chExt = xfrm['a:chExt'] as Record<string, unknown> | undefined

    return {
      offX: getAttrNumber(off, 'x') ?? 0,
      offY: getAttrNumber(off, 'y') ?? 0,
      extCX: getAttrNumber(ext, 'cx') ?? 0,
      extCY: getAttrNumber(ext, 'cy') ?? 0,
      chOffX: getAttrNumber(chOff, 'x') ?? 0,
      chOffY: getAttrNumber(chOff, 'y') ?? 0,
      chExtCX: getAttrNumber(chExt, 'cx') ?? 1,
      chExtCY: getAttrNumber(chExt, 'cy') ?? 1
    }
  }

  private static parseShape(
    sp: Record<string, unknown>,
    relParser: RelationshipParser,
    themeColors?: Record<string, string>,
    groupTransform?: GroupTransform,
    slideNumber?: number,
    masterBodyStyle?: Record<string, unknown>,
    masterOtherStyle?: Record<string, unknown>,
    layoutPhMap?: Record<string, Record<string, unknown>>,
    masterPhMap?: Record<string, Record<string, unknown>>
  ): Shape | null {
    const nvSpPr = sp['p:nvSpPr'] as Record<string, unknown> | undefined
    const spPr = sp['p:spPr'] as Record<string, unknown> | undefined
    const txBody = sp['p:txBody'] as Record<string, unknown> | undefined

    const geometry = spPr
      ? this.parseGeometry(spPr['a:xfrm'], groupTransform)
      : new Geometry({ x: 0, y: 0, width: 0, height: 0 })
    const fill = spPr ? this.parseFill(spPr, themeColors) : undefined
    const stroke = spPr ? this.parseStroke(spPr, themeColors) : undefined
    const shadow = spPr ? this.parseShadow(spPr, themeColors) : undefined

    const name = getNode(nvSpPr, ['p:cNvPr']) ? getAttr(getNode(nvSpPr, ['p:cNvPr']) as unknown, 'name') : undefined

    // Detect shape type from preset geometry
    const prstGeom = getNode(spPr, ['a:prstGeom'])
    const prst = getAttr(prstGeom as unknown, 'prst') ?? ''
    const type = this.detectShapeType(prst, !!txBody)

    // Parse text
    let text: string | undefined
    let paragraphs: TextParagraph[] | undefined
    let textInsets: Shape['textInsets'] | undefined
    let textAnchor: Shape['textAnchor'] | undefined

    if (txBody) {
      // Detect placeholder type to resolve master/layout lstStyle cascade
      const phNode = getNode(getNode(nvSpPr, ['p:nvPr']) as unknown, ['p:ph']) as Record<string, unknown> | undefined
      const phType = phNode ? (getAttr(phNode as unknown, 'type') ?? 'body') : undefined
      const phIdx = phNode ? getAttr(phNode as unknown, 'idx') : undefined

      const layoutPhLstStyle =
        phType && layoutPhMap ? (layoutPhMap[phType] ?? (phIdx ? layoutPhMap[`idx:${phIdx}`] : undefined)) : undefined
      const masterPhLstStyle =
        phType && masterPhMap
          ? (masterPhMap[phType] ??
            (phType === 'ctrTitle' ? masterPhMap['title'] : undefined) ??
            (phIdx ? masterPhMap[`idx:${phIdx}`] : undefined))
          : undefined

      const parsed = this.parseTextBody(
        txBody,
        relParser,
        themeColors,
        slideNumber,
        masterBodyStyle,
        masterOtherStyle,
        layoutPhLstStyle,
        masterPhLstStyle
      )
      text = parsed.text
      paragraphs = parsed.paragraphs

      const bodyPr = txBody['a:bodyPr'] as Record<string, unknown> | undefined
      textInsets = {
        left: (getAttrNumber(bodyPr as unknown, 'lIns') ?? 91440) / EMU_PER_PIXEL,
        right: (getAttrNumber(bodyPr as unknown, 'rIns') ?? 91440) / EMU_PER_PIXEL,
        top: (getAttrNumber(bodyPr as unknown, 'tIns') ?? 45720) / EMU_PER_PIXEL,
        bottom: (getAttrNumber(bodyPr as unknown, 'bIns') ?? 45720) / EMU_PER_PIXEL
      }

      const anchorAttr = getAttr(bodyPr as unknown, 'anchor')
      if (anchorAttr === 'ctr') textAnchor = 'middle'
      else if (anchorAttr === 'b') textAnchor = 'bottom'
      else textAnchor = 'top'
    }

    return new Shape({
      type,
      geometry,
      fill,
      stroke,
      shadow,
      text,
      paragraphs,
      name,
      textInsets,
      textAnchor
    })
  }

  private static parseShadow(spPr: Record<string, unknown>, themeColors?: Record<string, string>): Shadow | undefined {
    const effectLst = getNode(spPr, ['a:effectLst']) as Record<string, unknown> | undefined
    if (!effectLst) return undefined
    const outerShdw = effectLst['a:outerShdw'] as Record<string, unknown> | undefined
    if (!outerShdw) return undefined
    const blurRad = getAttrNumber(outerShdw, 'blurRad') ?? 0
    const dist = getAttrNumber(outerShdw, 'dist') ?? 0
    const dir = getAttrNumber(outerShdw, 'dir') ?? 0
    // OOXML `blurRad` and Canvas 2D `shadowBlur` don't share a definition:
    // OOXML blurRad is the radius of the shadow in EMU; Canvas shadowBlur is
    // a "blur level" (implementation-defined, but usually ≈ 2× std-deviation).
    // Empirically, 3× matches PowerPoint/Google Slides' rendered density
    // against backgrounds with contrast (measured from slide 7, 17 PLACES/EVENTS).
    const blur = (blurRad / EMU_PER_PIXEL) * 3
    const distPx = dist / EMU_PER_PIXEL
    // OOXML direction: degrees (in 60000ths) clockwise from East. Screen Y
    // grows downward, so the sin term is NOT negated (dir=5400000 ≈ South ≈
    // shadow rendered below the element, matching PowerPoint/Google Slides).
    const angleRad = (dir / 60000) * (Math.PI / 180)
    const offsetX = distPx * Math.cos(angleRad)
    const offsetY = distPx * Math.sin(angleRad)
    const baseColor = this.parseSolidFillColor(outerShdw, themeColors) ?? '#000000'
    // Shadows often carry an <a:alpha val="50000"/> child (percent × 1000).
    // parseSolidFillColor returns a hex string only, so apply alpha here.
    const srgb = outerShdw['a:srgbClr'] as Record<string, unknown> | undefined
    const schm = outerShdw['a:schemeClr'] as Record<string, unknown> | undefined
    const alphaHost = srgb ?? schm
    const alphaEl = alphaHost?.['a:alpha'] as Record<string, unknown> | undefined
    const alphaPct = alphaEl ? getAttrNumber(alphaEl, 'val') : undefined
    const color = alphaPct !== undefined ? hexToRgba(baseColor, alphaPct / 100000) : baseColor
    return { blur, offsetX, offsetY, color }
  }

  private static parsePicture(
    pic: Record<string, unknown>,
    relParser: RelationshipParser,
    slidePath: string,
    groupTransform?: GroupTransform
  ): Shape | null {
    const nvPicPr = pic['p:nvPicPr'] as Record<string, unknown> | undefined
    const spPr = pic['p:spPr'] as Record<string, unknown> | undefined
    const blipFill = pic['p:blipFill'] as Record<string, unknown> | undefined

    const geometry = spPr
      ? this.parseGeometry(spPr['a:xfrm'], groupTransform)
      : new Geometry({ x: 0, y: 0, width: 0, height: 0 })

    const prstGeom = getNode(spPr, ['a:prstGeom']) as Record<string, unknown> | undefined
    const clipShapeVal = getAttr(prstGeom as unknown, 'prst')
    const clipShape = clipShapeVal && clipShapeVal !== 'rect' ? clipShapeVal : undefined
    const clipAdjustValues = prstGeom ? this.parseAdjustValues(prstGeom) : undefined

    // Detect placeholder references — geometry may be inherited from the slide layout/master
    const nvPr = getNode(nvPicPr, ['p:nvPr']) as Record<string, unknown> | undefined
    const cNvPr = getNode(nvPicPr, ['p:cNvPr']) as Record<string, unknown> | undefined
    const name = getAttr(cNvPr as unknown, 'name')
    const title = getAttr(cNvPr as unknown, 'title') ?? ''

    // ── Detect externally-linked video (Google Slides export pattern) ──────────
    // Google Slides embeds a thumbnail image + a hlinkClick pointing to the real
    // video URL (e.g. Google Drive). The title attribute holds the original file
    // name, so we use its extension to identify video links.
    const hlinkClick = cNvPr?.['a:hlinkClick'] as Record<string, unknown> | undefined
    const hlinkRId = getAttr(hlinkClick as unknown, 'r:id')
    let externalUrl: string | undefined
    if (hlinkRId) {
      const hlinkRel = relParser.getById(hlinkRId)
      if (hlinkRel?.targetMode === 'External') {
        externalUrl = hlinkRel.target
      }
    }

    const titleExt = title.split('.').pop()?.toLowerCase() ?? ''
    const isExternalVideo = !!externalUrl && !!VIDEO_EXTENSIONS[titleExt]

    // ── Detect embedded video (p:videoFile or p14:media / p15:media) ──────────
    let isEmbeddedVideo = false
    if (nvPr?.['p:videoFile']) isEmbeddedVideo = true

    // ── Resolve blip (thumbnail / embedded image or video file) ──────────────
    const blip = getNode(blipFill, ['a:blip']) as Record<string, unknown> | undefined
    const rId = blip ? (getAttr(blip, 'r:embed') ?? getAttr(blip, 'r:link')) : undefined

    let mediaRef: string | undefined
    let mediaType: 'image' | 'video' | undefined

    if (rId) {
      const resolvedPath = relParser.resolveTarget(rId, slidePath)
      if (resolvedPath) {
        mediaRef = resolvedPath
        const ext = resolvedPath.split('.').pop()?.toLowerCase() ?? ''
        if (isEmbeddedVideo || VIDEO_EXTENSIONS[ext]) {
          mediaType = 'video'
        } else if (IMAGE_EXTENSIONS[ext]) {
          mediaType = 'image'
        }
      }
    }

    // Also look for video relationship via nvPicPr extLst (p14:media / p15:media)
    if (!mediaRef && nvPr) {
      const extLst = nvPr['p:extLst'] as Record<string, unknown> | undefined
      if (extLst) {
        const exts = toArray(extLst['p:ext'] as unknown)
        for (const ext of exts) {
          const extObj = ext as Record<string, unknown>
          const mediaEl = extObj['p14:media'] ?? extObj['p15:media']
          if (mediaEl) {
            const mediaRId = getAttr(mediaEl as unknown, 'r:embed') ?? getAttr(mediaEl as unknown, 'r:link')
            if (mediaRId) {
              const resolvedPath = relParser.resolveTarget(mediaRId, slidePath)
              if (resolvedPath) {
                mediaRef = resolvedPath
                const fileExt = resolvedPath.split('.').pop()?.toLowerCase() ?? ''
                mediaType = VIDEO_EXTENSIONS[fileExt] ? 'video' : 'image'
              }
            }
          }
        }
      }
    }

    // External video overrides the blip image: render as video, keep mediaRef
    // only as a poster hint (VideoRenderer may use it).
    if (isExternalVideo) {
      mediaType = 'video'
    }

    return new Shape({
      type: 'picture',
      geometry,
      mediaRef,
      mediaType,
      externalUrl: isExternalVideo ? externalUrl : undefined,
      name,
      clipShape,
      clipAdjustValues
    })
  }

  private static parseGraphicFrame(
    gf: Record<string, unknown>,
    relParser: RelationshipParser,
    slidePath: string
  ): Shape | null {
    const xfrm = getNode(gf, ['p:xfrm']) as Record<string, unknown> | undefined
    const geometry = this.parseGeometry(xfrm)

    // Look for video in graphic frame (OLE objects, etc.)
    const graphic = getNode(gf, ['a:graphic', 'a:graphicData']) as Record<string, unknown> | undefined

    // Check for media/video in graphic data
    let mediaRef: string | undefined
    let mediaType: 'image' | 'video' | undefined

    if (graphic) {
      const uri = getAttr(graphic, 'uri') ?? ''
      if (uri.includes('video') || uri.includes('media')) {
        // Try to find media relationship
        const nvPr = getNode(gf, ['p:nvGraphicFramePr', 'p:nvPr']) as Record<string, unknown> | undefined
        if (nvPr?.['p:videoFile']) {
          const rId = getAttr(nvPr['p:videoFile'] as unknown, 'r:link')
          if (rId) {
            const resolvedPath = relParser.resolveTarget(rId, slidePath)
            if (resolvedPath) {
              mediaRef = resolvedPath
              mediaType = 'video'
            }
          }
        }
      }
    }

    return new Shape({
      type: mediaType === 'video' ? 'picture' : 'unknown',
      geometry,
      mediaRef,
      mediaType
    })
  }

  private static parseGeometry(xfrm: unknown, groupTransform?: GroupTransform): Geometry {
    if (!xfrm || typeof xfrm !== 'object') {
      return new Geometry({ x: 0, y: 0, width: 0, height: 0 })
    }

    const xfrmObj = xfrm as Record<string, unknown>
    const off = xfrmObj['a:off'] as Record<string, unknown> | undefined
    const ext = xfrmObj['a:ext'] as Record<string, unknown> | undefined

    let x = getAttrNumber(off, 'x') ?? 0
    let y = getAttrNumber(off, 'y') ?? 0
    let cx = getAttrNumber(ext, 'cx') ?? 0
    let cy = getAttrNumber(ext, 'cy') ?? 0

    // Apply group coordinate transform if active
    if (groupTransform && groupTransform.chExtCX > 0 && groupTransform.chExtCY > 0) {
      const scaleX = groupTransform.extCX / groupTransform.chExtCX
      const scaleY = groupTransform.extCY / groupTransform.chExtCY
      x = groupTransform.offX + (x - groupTransform.chOffX) * scaleX
      y = groupTransform.offY + (y - groupTransform.chOffY) * scaleY
      cx = cx * scaleX
      cy = cy * scaleY
    }

    // Rotation in OOXML is stored in 1/60000 degrees
    const rotRaw = getAttrNumber(xfrmObj, 'rot')
    const rotation = rotRaw !== undefined ? rotRaw / 60000 : 0

    return new Geometry({
      x: x / EMU_PER_PIXEL,
      y: y / EMU_PER_PIXEL,
      width: cx / EMU_PER_PIXEL,
      height: cy / EMU_PER_PIXEL,
      rotation
    })
  }

  private static parseFill(spPr: Record<string, unknown>, themeColors?: Record<string, string>): Fill | undefined {
    const solidFill = spPr['a:solidFill'] as Record<string, unknown> | undefined
    if (solidFill) {
      const color = this.parseSolidFillColor(solidFill, themeColors)
      if (color) return { color }
    }

    const gradFill = spPr['a:gradFill'] as Record<string, unknown> | undefined
    if (gradFill) {
      const stops = this.parseGradientStops(gradFill, themeColors)
      if (stops.length > 0) {
        const lin = getNode(gradFill, ['a:lin']) as Record<string, unknown> | undefined
        const ang = lin ? getAttrNumber(lin, 'ang') : undefined
        return {
          color: stops[0]?.color ?? '#808080',
          gradient: { type: 'linear', angle: ang !== undefined ? ang / 60000 : 0, stops }
        }
      }
      return { color: '#808080' }
    }

    return undefined
  }

  /** Parse a:gsLst/a:gs into GradientStop[]; pos is in 1/1000 of a percent (0-100000). */
  private static parseGradientStops(
    gradFill: Record<string, unknown>,
    themeColors?: Record<string, string>
  ): GradientStop[] {
    const gsLst = getNode(gradFill, ['a:gsLst']) as Record<string, unknown> | undefined
    if (!gsLst) return []
    const gsArray = toArray(gsLst['a:gs'] as unknown)
    const stops: GradientStop[] = []
    for (const gs of gsArray) {
      const gsObj = gs as Record<string, unknown>
      const posRaw = getAttrNumber(gsObj, 'pos')
      const pos = posRaw !== undefined ? posRaw / 100000 : 0
      const color = this.parseSolidFillColor(gsObj, themeColors)
      if (color) stops.push({ color, position: pos })
    }
    return stops.sort((a, b) => a.position - b.position)
  }

  private static parseStroke(spPr: Record<string, unknown>, themeColors?: Record<string, string>): Stroke | undefined {
    const ln = spPr['a:ln'] as Record<string, unknown> | undefined
    if (!ln) return undefined
    if (ln['a:noFill'] !== undefined) return undefined

    const solidFill = ln['a:solidFill'] as Record<string, unknown> | undefined
    const color = solidFill ? this.parseSolidFillColor(solidFill, themeColors) : '#000000'
    const width = (getAttrNumber(ln, 'w') ?? 12700) / EMU_PER_PIXEL

    return { color: color ?? '#000000', width }
  }

  private static parseSolidFillColor(
    solidFill: Record<string, unknown> | undefined,
    themeColors?: Record<string, string>
  ): string | undefined {
    if (!solidFill) return undefined
    // srgbClr - RGB hex color
    const srgbClr = solidFill['a:srgbClr'] as Record<string, unknown> | undefined
    if (srgbClr) {
      const val = getAttr(srgbClr, 'val')
      if (val) return `#${val}`
    }

    // prstClr - preset color name
    const prstClr = solidFill['a:prstClr'] as Record<string, unknown> | undefined
    if (prstClr) {
      const val = getAttr(prstClr, 'val')
      if (val) return PRESET_COLORS[val] ?? val
    }

    // schemeClr - theme color
    const schemeClr = solidFill['a:schemeClr'] as Record<string, unknown> | undefined
    if (schemeClr) {
      const val = getAttr(schemeClr, 'val')
      if (val) {
        const baseColor = themeColors?.[val] ?? SCHEME_COLORS[val] ?? '#808080'
        return this.applyColorModifiers(baseColor, schemeClr)
      }
    }

    // sysClr - system color
    const sysClr = solidFill['a:sysClr'] as Record<string, unknown> | undefined
    if (sysClr) {
      const lastClr = getAttr(sysClr, 'lastClr')
      if (lastClr) return `#${lastClr}`
    }

    return undefined
  }

  /**
   * Apply OOXML color modifiers (lumMod, lumOff, shade, tint) to a hex color.
   * Modifiers are child elements of the color element (e.g. a:schemeClr).
   */
  private static applyColorModifiers(hexColor: string, modifiers: Record<string, unknown>): string {
    const hex = hexColor.replace('#', '')
    if (hex.length !== 6) return hexColor

    let r = parseInt(hex.slice(0, 2), 16) / 255
    let g = parseInt(hex.slice(2, 4), 16) / 255
    let b = parseInt(hex.slice(4, 6), 16) / 255

    // shade: multiply each RGB channel by val/100000 (blend toward black)
    const shadeEl = modifiers['a:shade'] as Record<string, unknown> | undefined
    if (shadeEl) {
      const factor = (getAttrNumber(shadeEl, 'val') ?? 100000) / 100000
      r *= factor
      g *= factor
      b *= factor
    }

    // tint: blend each RGB channel toward white by val/100000
    const tintEl = modifiers['a:tint'] as Record<string, unknown> | undefined
    if (tintEl) {
      const factor = (getAttrNumber(tintEl, 'val') ?? 100000) / 100000
      r = r + (1 - r) * factor
      g = g + (1 - g) * factor
      b = b + (1 - b) * factor
    }

    // lumMod / lumOff: modify luminance in HSL space
    const lumModEl = modifiers['a:lumMod'] as Record<string, unknown> | undefined
    const lumOffEl = modifiers['a:lumOff'] as Record<string, unknown> | undefined
    if (lumModEl || lumOffEl) {
      const [h, s, l] = rgbToHsl(r, g, b)
      const lumMod = lumModEl ? (getAttrNumber(lumModEl, 'val') ?? 100000) / 100000 : 1
      const lumOff = lumOffEl ? (getAttrNumber(lumOffEl, 'val') ?? 0) / 100000 : 0
      const newL = Math.max(0, Math.min(1, l * lumMod + lumOff))
      ;[r, g, b] = hslToRgb(h, s, newL)
    }

    const toHex = (v: number): string =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }

  private static parseTextBody(
    txBody: Record<string, unknown>,
    relParser?: RelationshipParser,
    themeColors?: Record<string, string>,
    slideNumber?: number,
    masterBodyStyle?: Record<string, unknown>,
    masterOtherStyle?: Record<string, unknown>,
    layoutPhLstStyle?: Record<string, unknown>,
    masterPhLstStyle?: Record<string, unknown>
  ): {
    text: string
    paragraphs: TextParagraph[]
  } {
    const paragraphs: TextParagraph[] = []
    const paras = toArray(txBody['a:p'] as unknown)

    // Parse a:lstStyle — shape-level text formatting defaults per outline level
    const lstStyle = txBody['a:lstStyle'] as Record<string, unknown> | undefined
    const lstDefPPr = lstStyle?.['a:defPPr'] as Record<string, unknown> | undefined

    for (const para of paras) {
      const paraObj = para as Record<string, unknown>
      const runs: TextRun[] = []
      const textRuns = toArray(paraObj['a:r'] as unknown)

      // Parse paragraph properties
      const pPr = paraObj['a:pPr'] as Record<string, unknown> | undefined

      // Outline level (a:pPr/@lvl is 0-indexed; a:lstStyle uses a:lvl1pPr–a:lvl9pPr)
      const lvlRaw = pPr ? (getAttrNumber(pPr as unknown, 'lvl') ?? 0) : 0
      const lvl = lvlRaw + 1 // 1-indexed
      const lstLvlPPr = (lstStyle?.[`a:lvl${lvl}pPr`] as Record<string, unknown> | undefined) ?? lstDefPPr // fallback to global default

      // List-style default run properties for this level
      const lstLvlDefRPr = lstLvlPPr?.['a:defRPr'] as Record<string, unknown> | undefined
      const lstDefDefRPr = lstDefPPr?.['a:defRPr'] as Record<string, unknown> | undefined

      // Master-level cascade (lowest priority): otherStyle preferred, bodyStyle as fallback
      const mOtherLvlPPr = (masterOtherStyle?.[`a:lvl${lvl}pPr`] ?? masterOtherStyle?.['a:defPPr']) as
        | Record<string, unknown>
        | undefined
      const mBodyLvlPPr = (masterBodyStyle?.[`a:lvl${lvl}pPr`] ?? masterBodyStyle?.['a:defPPr']) as
        | Record<string, unknown>
        | undefined
      const mOtherDefRPr = mOtherLvlPPr?.['a:defRPr'] as Record<string, unknown> | undefined
      const mBodyDefRPr = mBodyLvlPPr?.['a:defRPr'] as Record<string, unknown> | undefined

      // Placeholder shape lstStyle cascade: layout placeholder → master placeholder
      const layoutPhLvlDefRPr = layoutPhLstStyle
        ? ((
            (layoutPhLstStyle[`a:lvl${lvl}pPr`] ?? layoutPhLstStyle['a:defPPr']) as Record<string, unknown> | undefined
          )?.['a:defRPr'] as Record<string, unknown> | undefined)
        : undefined
      const masterPhLvlDefRPr = masterPhLstStyle
        ? ((
            (masterPhLstStyle[`a:lvl${lvl}pPr`] ?? masterPhLstStyle['a:defPPr']) as Record<string, unknown> | undefined
          )?.['a:defRPr'] as Record<string, unknown> | undefined)
        : undefined

      const alignAttr =
        getAttr(pPr as unknown, 'algn') ??
        getAttr(lstLvlPPr as unknown, 'algn') ??
        getAttr(lstDefPPr as unknown, 'algn') ??
        getAttr(mOtherLvlPPr as unknown, 'algn') ??
        getAttr(mBodyLvlPPr as unknown, 'algn')
      const align = this.parseAlignment(alignAttr)

      // Paragraph spacing (a:spcBef / a:spcAft use a:spcPts val in pts×100)
      const spcBefEl = pPr?.['a:spcBef'] as Record<string, unknown> | undefined
      const spcAftEl = pPr?.['a:spcAft'] as Record<string, unknown> | undefined
      const spcBefPts = spcBefEl ? getAttrNumber(spcBefEl['a:spcPts'] as unknown, 'val') : undefined
      const spcAftPts = spcAftEl ? getAttrNumber(spcAftEl['a:spcPts'] as unknown, 'val') : undefined
      const spaceBefore = spcBefPts !== undefined ? (spcBefPts / 100) * (96 / 72) : undefined
      const spaceAfter = spcAftPts !== undefined ? (spcAftPts / 100) * (96 / 72) : undefined

      // Left margin for bulleted text (EMU → px)
      const marLRaw = pPr ? getAttrNumber(pPr as unknown, 'marL') : undefined
      const marL = marLRaw !== undefined ? marLRaw / EMU_PER_PIXEL : undefined

      // First-line indent (negative = hanging bullet indent, EMU → px)
      const indentRaw = pPr ? getAttrNumber(pPr as unknown, 'indent') : undefined
      const indent = indentRaw !== undefined ? indentRaw / EMU_PER_PIXEL : undefined

      // Bullet detection
      let bullet: TextParagraph['bullet'] | undefined
      if (pPr) {
        if (pPr['a:buNone'] !== undefined) {
          bullet = { none: true }
        } else if (pPr['a:buChar'] !== undefined) {
          const buChar = pPr['a:buChar'] as Record<string, unknown>
          bullet = { char: getAttr(buChar, 'char') ?? '•' }
        } else if (pPr['a:buAutoNum'] !== undefined) {
          const buAutoNum = pPr['a:buAutoNum'] as Record<string, unknown>
          bullet = { autoNum: getAttr(buAutoNum, 'type') ?? 'arabicPeriod' }
        }
      }

      // Paragraph-level default run properties (fallback when a:r has no a:rPr)
      const defRPr = pPr?.['a:defRPr'] as Record<string, unknown> | undefined

      for (const run of textRuns) {
        const runObj = run as Record<string, unknown>
        const rPr = runObj['a:rPr'] as Record<string, unknown> | undefined
        const tNode = runObj['a:t']
        const text = typeof tNode === 'string' ? tNode : typeof tNode === 'number' ? String(tNode) : ''

        // A run whose text is the LINE_BREAK_SENTINEL is an <a:br> that was
        // rewritten by parseXML so its position survives fast-xml-parser's
        // tag-grouping. Emit it as a lineBreak entry and skip the rest of
        // the run-property parsing.
        if (text === LINE_BREAK_SENTINEL) {
          runs.push({ text: '', lineBreak: true })
          continue
        }

        const textRun: TextRun = { text }

        // Property-level cascade: rPr → defRPr → lstLvlDefRPr → lstDefDefRPr → layoutPhLvlDefRPr → masterPhLvlDefRPr → mOtherDefRPr → mBodyDefRPr
        const rprSources = [
          rPr,
          defRPr,
          lstLvlDefRPr,
          lstDefDefRPr,
          layoutPhLvlDefRPr,
          masterPhLvlDefRPr,
          mOtherDefRPr,
          mBodyDefRPr
        ]

        textRun.bold = this.getCascadedBool('b', ...rprSources)
        textRun.italic = this.getCascadedBool('i', ...rprSources)

        // underline: first source that defines 'u', then check it's not 'none'
        const uVal = rprSources.reduce<string | undefined>((v, src) => v ?? getAttr(src as unknown, 'u'), undefined)
        textRun.underline = uVal !== undefined && uVal !== 'none'

        // fontSize: first source that defines sz
        const szAttr = rprSources.reduce<number | undefined>(
          (v, src) => v ?? getAttrNumber(src as unknown, 'sz'),
          undefined
        )
        if (szAttr !== undefined) textRun.fontSize = (szAttr / 100) * PT_TO_PX

        // color and fontFamily: first source with the relevant child element
        for (const src of rprSources) {
          const solidFill = src?.['a:solidFill'] as Record<string, unknown> | undefined
          if (solidFill) {
            textRun.color = this.parseSolidFillColor(solidFill, themeColors)
            break
          }
        }
        for (const src of rprSources) {
          const latin = src?.['a:latin'] as Record<string, unknown> | undefined
          if (latin) {
            const tf = getAttr(latin as unknown, 'typeface')
            if (tf) {
              textRun.fontFamily = tf
              break
            }
          }
        }

        // Hyperlink (only from rPr — not cascaded)
        const hlinkClick = rPr?.['a:hlinkClick'] as Record<string, unknown> | undefined
        if (hlinkClick && relParser) {
          const rId = getAttr(hlinkClick, 'r:id')
          if (rId) {
            const rel = relParser.getById(rId)
            if (rel?.target) textRun.hyperlink = rel.target
          }
        }

        // Highlight background (a:highlight — run-specific, not cascaded)
        const highlightEl = rPr?.['a:highlight'] as Record<string, unknown> | undefined
        if (highlightEl) {
          textRun.highlight = this.parseSolidFillColor(highlightEl, themeColors)
        }

        runs.push(textRun)
      }

      // Note: <a:br> elements are handled upstream in parseXML (XMLUtils.ts),
      // which replaces each `<a:br/>` with a sentinel-text run so that
      // fast-xml-parser preserves its position among the other `<a:r>` runs.
      // The sentinel is detected in the loop above and emitted as a
      // lineBreak entry in document order.

      // Handle field elements <a:fld> (slide number, date, etc.)
      // Apply the same run-style cascade as regular a:r elements.
      const fields = toArray(paraObj['a:fld'] as unknown)
      for (const fld of fields) {
        const fldObj = fld as Record<string, unknown>
        const fieldType = getAttr(fldObj, 'type')
        let text: string
        if (fieldType === 'slidenum' && slideNumber !== undefined) {
          text = String(slideNumber)
        } else {
          const tNode = fldObj['a:t']
          text = typeof tNode === 'string' ? tNode : ''
        }
        if (!text) continue

        const fldRPr = fldObj['a:rPr'] as Record<string, unknown> | undefined
        const fldRprSources = [
          fldRPr,
          defRPr,
          lstLvlDefRPr,
          lstDefDefRPr,
          layoutPhLvlDefRPr,
          masterPhLvlDefRPr,
          mOtherDefRPr,
          mBodyDefRPr
        ]
        const textRun: TextRun = { text }

        textRun.bold = this.getCascadedBool('b', ...fldRprSources)
        textRun.italic = this.getCascadedBool('i', ...fldRprSources)

        const uVal = fldRprSources.reduce<string | undefined>((v, src) => v ?? getAttr(src as unknown, 'u'), undefined)
        textRun.underline = uVal !== undefined && uVal !== 'none'

        const szAttr = fldRprSources.reduce<number | undefined>(
          (v, src) => v ?? getAttrNumber(src as unknown, 'sz'),
          undefined
        )
        if (szAttr !== undefined) textRun.fontSize = (szAttr / 100) * PT_TO_PX

        for (const src of fldRprSources) {
          const solidFill = src?.['a:solidFill'] as Record<string, unknown> | undefined
          if (solidFill) {
            textRun.color = this.parseSolidFillColor(solidFill, themeColors)
            break
          }
        }
        for (const src of fldRprSources) {
          const latin = src?.['a:latin'] as Record<string, unknown> | undefined
          if (latin) {
            const tf = getAttr(latin as unknown, 'typeface')
            if (tf) {
              textRun.fontFamily = tf
              break
            }
          }
        }

        runs.push(textRun)
      }

      paragraphs.push({ runs, align, bullet, marL, indent, spaceBefore, spaceAfter })
    }

    const text = paragraphs
      .map((p) => p.runs.map((r) => r.text).join(''))
      .filter((t) => t.length > 0)
      .join('\n')

    return { text, paragraphs }
  }

  /** Returns the value of a boolean attribute from the first source that defines it (highest priority first). */
  private static getCascadedBool(attr: string, ...sources: Array<Record<string, unknown> | undefined>): boolean {
    for (const src of sources) {
      if (!src) continue
      const val = (src as Record<string, unknown>)[`@_${attr}`]
      if (val !== undefined) {
        return val === 1 || val === '1' || val === true || val === 'true'
      }
    }
    return false
  }

  /**
   * Inject a resolved `phClr` into a copy of themeColors, derived from the master style's
   * default text run color. phClr ("placeholder color") should inherit from the master placeholder.
   */
  private static resolvePhClr(
    themeColors: Record<string, string> | undefined,
    masterStyle: Record<string, unknown> | undefined
  ): Record<string, string> | undefined {
    if (!masterStyle) return themeColors

    const pprs = [
      masterStyle['a:defPPr'] as Record<string, unknown> | undefined,
      masterStyle['a:lvl1pPr'] as Record<string, unknown> | undefined
    ]
    for (const ppr of pprs) {
      const defRPr = ppr?.['a:defRPr'] as Record<string, unknown> | undefined
      const solidFill = defRPr?.['a:solidFill'] as Record<string, unknown> | undefined
      if (solidFill) {
        const color = this.parseSolidFillColor(solidFill, themeColors)
        if (color) return { ...themeColors, phClr: color }
      }
    }
    return themeColors
  }

  private static parseAlignment(val: string | undefined): TextParagraph['align'] {
    switch (val) {
      case 'ctr':
        return 'center'
      case 'r':
        return 'right'
      case 'just':
        return 'justify'
      default:
        return 'left'
    }
  }

  /**
   * Parse a:avLst (adjust value list) from a:prstGeom.
   * Returns a map of guide names to their numeric values (in 1/100_000 units),
   * or undefined if no adjust values are present.
   */
  private static parseAdjustValues(prstGeom: Record<string, unknown>): Record<string, number> | undefined {
    const avLst = prstGeom['a:avLst'] as Record<string, unknown> | undefined
    if (!avLst) return undefined

    const guides = toArray(avLst['a:gd'] as unknown)
    if (guides.length === 0) return undefined

    const result: Record<string, number> = {}
    for (const gd of guides) {
      const gdObj = gd as Record<string, unknown>
      const name = getAttr(gdObj as unknown, 'name')
      const fmla = getAttr(gdObj as unknown, 'fmla')
      if (!name || !fmla) continue

      // fmla is typically "val NNNNN" where NNNNN is a number in 1/100_000 units
      const match = fmla.match(/^val\s+(\d+)$/)
      if (match) {
        result[name] = parseInt(match[1], 10)
      }
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  private static detectShapeType(prst: string, hasText: boolean): ShapeType {
    if (hasText && !prst) return 'text'

    switch (prst) {
      case 'rect':
      case 'snip1Rect':
      case 'snip2SameRect':
        return 'rectangle'
      case 'roundRect':
        return 'roundRect'
      case 'ellipse':
      case 'circle':
        return 'ellipse'
      case 'line':
      case 'straightConnector1':
        return 'line'
      default:
        return hasText ? 'text' : 'rectangle'
    }
  }
}

// ── Color helpers ──────────────────────────────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) return [0, 0, l]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h /= 6

  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)]
}

// Common preset colors (CSS color names)
const PRESET_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  darkGray: '#404040',
  lightGray: '#d3d3d3'
}

// Common theme color mappings (simplified fallbacks when theme1.xml is unavailable)
const SCHEME_COLORS: Record<string, string> = {
  dk1: '#000000',
  lt1: '#ffffff',
  dk2: '#44546a',
  lt2: '#e7e6e6',
  accent1: '#4472c4',
  accent2: '#ed7d31',
  accent3: '#a9d18e',
  accent4: '#ffc000',
  accent5: '#5b9bd5',
  accent6: '#70ad47',
  hlink: '#0563c1',
  folHlink: '#954f72',
  bg1: '#ffffff',
  bg2: '#e7e6e6',
  tx1: '#000000',
  tx2: '#44546a',
  phClr: '#000000'
}
