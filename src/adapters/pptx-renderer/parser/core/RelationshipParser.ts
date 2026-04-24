import { getAttr, parseXML, toArray } from './XMLUtils'

export interface Relationship {
  id: string
  type: string
  target: string
  targetMode?: string
}

export class RelationshipParser {
  private relationships: Map<string, Relationship> = new Map()

  static parse(xmlText: string): RelationshipParser {
    const parser = new RelationshipParser()
    const data = parseXML(xmlText)
    const rels = data['Relationships'] as Record<string, unknown>

    if (!rels) return parser

    const relItems = toArray(rels['Relationship'] as Relationship | Relationship[])

    for (const rel of relItems) {
      const id = getAttr(rel, 'Id')
      const type = getAttr(rel, 'Type')
      const target = getAttr(rel, 'Target')
      const targetMode = getAttr(rel, 'TargetMode')

      if (id && type && target) {
        parser.relationships.set(id, { id, type, target, targetMode })
      }
    }

    return parser
  }

  getById(rId: string): Relationship | undefined {
    return this.relationships.get(rId)
  }

  getTarget(rId: string): string | undefined {
    return this.relationships.get(rId)?.target
  }

  getAll(): Relationship[] {
    return Array.from(this.relationships.values())
  }

  /**
   * Resolve a relationship target relative to a base path.
   * PPTX relationship targets are relative to the file containing the .rels file.
   */
  resolveTarget(rId: string, basePath: string): string | undefined {
    const rel = this.relationships.get(rId)
    if (!rel) return undefined

    const target = rel.target

    // If target is an external URL, return as-is
    if (rel.targetMode === 'External') return target

    // Resolve relative path
    // Base path: 'ppt/slides/slide1.xml' -> base dir: 'ppt/slides/'
    const baseDir = basePath.substring(0, basePath.lastIndexOf('/') + 1)
    return resolveRelativePath(baseDir, target)
  }
}

function resolveRelativePath(baseDir: string, relativePath: string): string {
  // Split into segments
  const baseParts = baseDir.split('/').filter((p) => p !== '')
  const relParts = relativePath.split('/')

  const result = [...baseParts]

  for (const part of relParts) {
    if (part === '..') {
      result.pop()
    } else if (part !== '.') {
      result.push(part)
    }
  }

  return result.join('/')
}
