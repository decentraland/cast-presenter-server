import JSZip from 'jszip'

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/**
 * Builds a one-slide PPTX whose shape tree holds the given `p:sp` elements.
 *
 * @param shapesXml - Raw `p:sp` markup placed inside the slide's `p:spTree`
 * @returns The PPTX file bytes
 */
export async function buildPptx(shapesXml: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  )
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${DOC_REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId2" Type="${DOC_REL}/slide" Target="slides/slide1.xml"/></Relationships>`
  )
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${DOC_REL}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapesXml}</p:spTree></p:cSld></p:sld>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * Builds the `p:sp` markup for a filled ellipse.
 *
 * @param x - The `a:off` x attribute, verbatim
 * @returns The shape markup
 */
export function ellipseShapeXml(x: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Ellipse"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>`
}
