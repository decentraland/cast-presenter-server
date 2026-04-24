import * as JSZip from 'jszip'
import { RelationshipParser } from './RelationshipParser'
import { SlideParser } from './SlideParser'
import { getAttr, getAttrNumber, getNode, parseXML, toArray } from './XMLUtils'
import { DEFAULT_SLIDE_HEIGHT_PX, DEFAULT_SLIDE_WIDTH_PX, EMU_PER_PIXEL } from '../utils/constants'
import { LRUCache } from '../utils/memory'
import type { Slide } from '../models/Slide'

// Guard against ZIP bombs: a small compressed PPTX could decompress into many
// GBs of XML/media and exhaust memory. JSZip doesn't validate this on its own,
// so we sum the declared uncompressed sizes of every entry after loadAsync and
// reject before reading any content. 500 MB is generous for legitimate decks
// (image-heavy 200-slide deck) and well below single-session disk/RAM limits.
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
/** Per-embedded-media cap written to disk in extractEmbeddedVideo. */
export const MAX_EMBEDDED_MEDIA_BYTES = 200 * 1024 * 1024

export class PPTXParser {
  private zip: JSZip | null = null
  private slideFiles: string[] = []
  private slideCache: LRUCache<number, Slide>
  private relsCache: LRUCache<string, RelationshipParser>
  private layoutXMLCache = new Map<string, Record<string, unknown>>()
  private masterXMLCache = new Map<string, Record<string, unknown>>()
  /** Slide dimensions in pixels from p:sldSz (used for coordinate scaling). */
  private slideWidthPx: number = DEFAULT_SLIDE_WIDTH_PX
  private slideHeightPx: number = DEFAULT_SLIDE_HEIGHT_PX
  /** Theme colors parsed from theme1.xml. */
  private themeColors: Record<string, string> = {}

  constructor() {
    this.slideCache = new LRUCache<number, Slide>(20)
    this.relsCache = new LRUCache<string, RelationshipParser>(30)
  }

  async parse(file: ArrayBuffer | Uint8Array): Promise<void> {
    // Load the ZIP archive
    // eslint-disable-next-line import/namespace
    this.zip = await JSZip.loadAsync(file)

    // ZIP-bomb guard: reject before reading any content if the declared
    // uncompressed size exceeds the cap. Using _data.uncompressedSize reads
    // JSZip's internal header value — authoritative for zip entries. Summing
    // across all entries avoids the split-across-many-small-files trick.
    let totalUncompressed = 0
    for (const entry of Object.values(this.zip.files)) {
      if (entry.dir) continue
      const entryWithData = entry as unknown as { _data?: { uncompressedSize?: number } }
      const size = entryWithData._data?.uncompressedSize ?? 0
      totalUncompressed += size
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error(
          `PPTX uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB limit (possible ZIP bomb)`
        )
      }
    }

    // Parse the package relationships to find presentation.xml
    const pkgRelsText = await this.readText('_rels/.rels')
    const pkgRels = RelationshipParser.parse(pkgRelsText)

    // Find presentation.xml path
    const presTarget =
      pkgRels.getAll().find((r) => r.type.includes('officeDocument') || r.target.includes('presentation'))?.target ??
      'ppt/presentation.xml'

    // Parse presentation.xml to get slide order and dimensions
    const presentationText = await this.readText(presTarget)
    const presentationXML = parseXML(presentationText)

    this.parseSlideDimensions(presentationXML)

    // Parse presentation relationships
    const presDir = presTarget.substring(0, presTarget.lastIndexOf('/'))
    const presRelsText = await this.readText(`${presDir}/_rels/${presTarget.split('/').pop()}.rels`)
    const presRels = RelationshipParser.parse(presRelsText)

    // Parse theme colors from theme1.xml
    this.themeColors = await this.parseThemeColors(presDir)

    // Extract slide order from sldIdLst
    this.slideFiles = this.extractSlideOrder(presentationXML, presRels, presDir)
  }

  /** Read p:presentation > p:sldSz (cx, cy in EMU) and set slide dimensions in pixels. */
  private parseSlideDimensions(presentationXML: Record<string, unknown>): void {
    const pres = presentationXML['p:presentation'] as Record<string, unknown> | undefined
    if (!pres) return
    const sldSz = getNode(pres, ['p:sldSz']) as Record<string, unknown> | undefined
    if (!sldSz) return
    const cx = getAttrNumber(sldSz, 'cx')
    const cy = getAttrNumber(sldSz, 'cy')
    if (cx !== undefined && cy !== undefined && cx > 0 && cy > 0) {
      this.slideWidthPx = Math.round(cx / EMU_PER_PIXEL)
      this.slideHeightPx = Math.round(cy / EMU_PER_PIXEL)
    }
  }

  getSlideCount(): number {
    return this.slideFiles.length
  }

  async getSlide(index: number): Promise<Slide> {
    if (index < 0 || index >= this.slideFiles.length) {
      throw new Error(`Slide index ${index} out of range (0-${this.slideFiles.length - 1})`)
    }

    // Return cached slide if available
    const cached = this.slideCache.get(index)
    if (cached) return cached

    const slidePath = this.slideFiles[index]
    const slideText = await this.readText(slidePath)
    const slideXML = parseXML(slideText)

    // Parse slide relationships
    const relParser = await this.getSlideRels(slidePath)

    // Resolve slide layout and master XML (cached)
    const layoutRel = relParser.getAll().find((r) => r.type.includes('slideLayout'))
    let layoutXML: Record<string, unknown> | undefined
    let masterXML: Record<string, unknown> | undefined

    if (layoutRel) {
      const layoutPath = relParser.resolveTarget(layoutRel.id, slidePath)
      if (layoutPath) {
        if (!this.layoutXMLCache.has(layoutPath)) {
          try {
            this.layoutXMLCache.set(layoutPath, parseXML(await this.readText(layoutPath)))
          } catch {
            // Layout/master XML may not exist — silently skip
          }
        }
        layoutXML = this.layoutXMLCache.get(layoutPath)

        const layoutRelParser = await this.getSlideRels(layoutPath)
        const masterRel = layoutRelParser.getAll().find((r) => r.type.includes('slideMaster'))
        if (masterRel) {
          const masterPath = layoutRelParser.resolveTarget(masterRel.id, layoutPath)
          if (masterPath) {
            if (!this.masterXMLCache.has(masterPath)) {
              try {
                this.masterXMLCache.set(masterPath, parseXML(await this.readText(masterPath)))
              } catch {
                // Layout/master XML may not exist — silently skip
              }
            }
            masterXML = this.masterXMLCache.get(masterPath)
          }
        }
      }
    }

    const slide = SlideParser.parse(slideXML, relParser, slidePath, {
      width: this.slideWidthPx,
      height: this.slideHeightPx,
      slideNumber: index + 1,
      themeColors: this.themeColors,
      layoutXML,
      masterXML
    })
    slide.index = index

    this.slideCache.set(index, slide)
    return slide
  }

  async getMedia(path: string): Promise<ArrayBuffer> {
    if (!this.zip) throw new Error('PPTX not loaded. Call parse() first.')
    const file = this.zip.file(path)
    if (!file) throw new Error(`Media file not found in PPTX: ${path}`)
    return file.async('arraybuffer')
  }

  private async getSlideRels(slidePath: string): Promise<RelationshipParser> {
    const cached = this.relsCache.get(slidePath)
    if (cached) return cached

    const dir = slidePath.substring(0, slidePath.lastIndexOf('/'))
    const fileName = slidePath.split('/').pop()
    const relsPath = `${dir}/_rels/${fileName}.rels`

    let relParser: RelationshipParser
    try {
      const relsText = await this.readText(relsPath)
      relParser = RelationshipParser.parse(relsText)
    } catch {
      // No relationships file - return empty parser
      relParser = RelationshipParser.parse(
        '<?xml version="1.0" ?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
      )
    }

    this.relsCache.set(slidePath, relParser)
    return relParser
  }

  /** Parse theme colors from ppt/theme/theme1.xml into a {colorName: '#rrggbb'} map. */
  private async parseThemeColors(presDir: string): Promise<Record<string, string>> {
    const colors: Record<string, string> = {}
    try {
      const themeText = await this.readText(`${presDir}/theme/theme1.xml`)
      const themeXML = parseXML(themeText)
      const clrScheme = getNode(themeXML, ['a:theme', 'a:themeElements', 'a:clrScheme']) as
        | Record<string, unknown>
        | undefined
      if (!clrScheme) return colors

      const colorKeys = [
        'dk1',
        'lt1',
        'dk2',
        'lt2',
        'accent1',
        'accent2',
        'accent3',
        'accent4',
        'accent5',
        'accent6',
        'hlink',
        'folHlink'
      ]
      for (const key of colorKeys) {
        const el = clrScheme[`a:${key}`] as Record<string, unknown> | undefined
        if (!el) continue

        const srgbClr = el['a:srgbClr'] as Record<string, unknown> | undefined
        if (srgbClr) {
          const val = getAttr(srgbClr, 'val')
          if (val) {
            colors[key] = `#${val.toLowerCase()}`
            continue
          }
        }

        const sysClr = el['a:sysClr'] as Record<string, unknown> | undefined
        if (sysClr) {
          const lastClr = getAttr(sysClr, 'lastClr')
          if (lastClr) colors[key] = `#${lastClr.toLowerCase()}`
        }
      }
    } catch {
      // Theme file missing or malformed — fall back to hardcoded SCHEME_COLORS in SlideParser
    }
    return colors
  }

  private async readText(path: string): Promise<string> {
    if (!this.zip) throw new Error('PPTX not loaded. Call parse() first.')
    const file = this.zip.file(path)
    if (!file) throw new Error(`File not found in PPTX: ${path}`)
    return file.async('text')
  }

  private extractSlideOrder(
    presentationXML: Record<string, unknown>,
    presRels: RelationshipParser,
    presDir: string
  ): string[] {
    // Navigate: presentation > sldIdLst > sldId
    const pres = presentationXML['p:presentation'] as Record<string, unknown>
    if (!pres) return []

    const sldIdLst = pres['p:sldIdLst'] as Record<string, unknown> | undefined
    if (!sldIdLst) return []

    const sldIds = toArray(sldIdLst['p:sldId'] as unknown)
    const slideFiles: string[] = []

    for (const sldId of sldIds) {
      const rId = getAttr(sldId as unknown, 'r:id')
      if (!rId) continue

      const target = presRels.resolveTarget(rId, `${presDir}/presentation.xml`)
      if (target) {
        slideFiles.push(target)
      }
    }

    return slideFiles
  }

  /**
   * List all media files in the PPTX archive.
   */
  listMedia(): string[] {
    if (!this.zip) return []
    return Object.keys(this.zip.files).filter((path) => path.startsWith('ppt/media/') && !path.endsWith('/'))
  }
}
