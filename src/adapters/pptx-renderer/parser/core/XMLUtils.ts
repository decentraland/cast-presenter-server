import { XMLParser } from 'fast-xml-parser'

const defaultParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  trimValues: false,
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
    return (obj as Record<string, unknown>)[`@_${attr}`] as string | undefined
  }
  return undefined
}

export function getAttrNumber(obj: unknown, attr: string): number | undefined {
  const val = getAttr(obj, attr)
  if (val === undefined) return undefined
  const num = Number(val)
  return isNaN(num) ? undefined : num
}

export function getAttrBool(obj: unknown, attr: string): boolean {
  const val = (obj as Record<string, unknown> | null | undefined)?.[`@_${attr}`]
  return val === 1 || val === '1' || val === true || val === 'true'
}

export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function getText(obj: unknown, path: string[]): string | undefined {
  let current: unknown = obj
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  if (typeof current === 'string') return current
  if (typeof current === 'number') return String(current)
  return undefined
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
