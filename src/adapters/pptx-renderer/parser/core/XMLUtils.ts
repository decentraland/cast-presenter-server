import { XMLParser } from 'fast-xml-parser'

const defaultParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep attributes as strings. Auto-parsing coerces hex colour values like
  // "000000" into the number 0 and "123456" into 123456, which then round-trip
  // through `#${val}` as `#0` / `#123456` — broken or silently wrong. Callers
  // that need numbers go through getAttrNumber(), which does the Number()
  // conversion itself.
  parseAttributeValue: false,
  trimValues: false,
  // Disable DTD/entity expansion. fast-xml-parser processes entities by
  // default; OOXML doesn't use custom entities, so turning this off blocks
  // XXE / billion-laughs attacks without affecting legitimate decks.
  processEntities: false,
  isArray: (_name, _jpath, isLeafNode, _isAttribute) => {
    // Force these elements to always be arrays for consistent parsing
    const alwaysArray = [
      'p:sp',
      'p:pic',
      'p:grpSp',
      'p:graphicFrame',
      'p:cxnSp',
      'a:p',
      'a:r',
      'a:br',
      'a:fld',
      'a:gd',
      'Relationship',
      'Override',
      'Default'
    ]
    return !isLeafNode && alwaysArray.some((tag) => String(_jpath).endsWith(tag))
  }
})

/**
 * Sentinel character for line-break runs. fast-xml-parser groups siblings by
 * tag name, so `<a:r>...</a:r><a:br/><a:r>...</a:r>` loses the break's position
 * in its paragraph. We pre-process the XML string to replace `<a:br.../>` with
 * a regular `<a:r><a:t>SENTINEL</a:t></a:r>` — the parser then keeps it in
 * document order with the other runs, and SlideParser converts runs whose
 * text equals this sentinel into `{ lineBreak: true }` entries.
 *
 * U+001E (Record Separator) is picked deliberately: it's unlikely to appear
 * in authored text and won't be trimmed by fast-xml-parser.
 */
export const LINE_BREAK_SENTINEL = '\u001e'

const BR_RE = /<a:br\b[^>]*(?:\/>|>[\s\S]*?<\/a:br>)/g

export function parseXML(text: string): Record<string, unknown> {
  const preprocessed = text.replace(BR_RE, `<a:r><a:t>${LINE_BREAK_SENTINEL}</a:t></a:r>`)
  return defaultParser.parse(preprocessed) as Record<string, unknown>
}

export function getAttr(obj: unknown, attr: string): string | undefined {
  if (obj && typeof obj === 'object') {
    const val = (obj as Record<string, unknown>)[`@_${attr}`]
    return typeof val === 'string' ? val : undefined
  }
  return undefined
}

export function getAttrNumber(obj: unknown, attr: string): number | undefined {
  const val = getAttr(obj, attr)
  if (val === undefined) return undefined
  const num = Number(val)
  return isNaN(num) ? undefined : num
}

export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function getNode(obj: unknown, path: string[]): unknown {
  let current: unknown = obj
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
