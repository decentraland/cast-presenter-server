import JSZip from 'jszip'

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Contents of one slide: its shape markup and, optionally, the slide's relationships. */
export interface PptxSlide {
  shapesXml: string
  relationshipsXml?: string
}

/**
 * Builds a PPTX with one slide per entry.
 *
 * @param slides - Each slide's raw shape markup (placed inside its `p:spTree`) and relationships
 * @param files - Extra package parts keyed by their path inside the archive
 * @returns The PPTX file bytes
 */
export async function buildPptx(slides: PptxSlide[], files: Record<string, string | Buffer> = {}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  )
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${DOC_REL}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}">${slides.map((_, i) => `<Relationship Id="rIdSlide${i + 1}" Type="${DOC_REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`
  )
  slides.forEach(({ shapesXml, relationshipsXml }, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${DOC_REL}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapesXml}</p:spTree></p:cSld></p:sld>`
    )
    if (relationshipsXml) zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationshipsXml)
  })
  for (const [filePath, contents] of Object.entries(files)) zip.file(filePath, contents)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * Builds a slide holding a filled ellipse.
 *
 * @param x - The `a:off` x attribute, verbatim
 * @returns The slide
 */
export function ellipseSlide(x: string): PptxSlide {
  return {
    shapesXml: `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Ellipse"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>`
  }
}

/**
 * Builds a slide holding a video embedded from `ppt/media/<mediaName>`; the caller adds that part.
 *
 * @param mediaName - File name of the embedded media part
 * @returns The slide
 */
export function embeddedVideoSlide(mediaName: string): PptxSlide {
  return {
    shapesXml: `<p:pic><p:nvPicPr><p:cNvPr id="3" name="${mediaName}"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rIdVideo"/></p:nvPr></p:nvPicPr><p:blipFill/><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2571750"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`,
    relationshipsXml: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rIdVideo" Type="${DOC_REL}/video" Target="../media/${mediaName}"/></Relationships>`
  }
}
