import { RelationshipParser } from '../../src/adapters/pptx-renderer/parser/core/RelationshipParser'
import { SlideParser } from '../../src/adapters/pptx-renderer/parser/core/SlideParser'
import { parseXML } from '../../src/adapters/pptx-renderer/parser/core/XMLUtils'
import type { Slide } from '../../src/adapters/pptx-renderer/parser/models/Slide'

const SLIDE_PATH = 'ppt/slides/slide1.xml'

function buildSlideXml(nvPr: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="3" name="clip.mp4"/>
        <p:cNvPicPr/>
        <p:nvPr>${nvPr}</p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId4"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`
}

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/media1.mp4"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/media1.mp4"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`

function parseSlide(nvPr: string): Slide {
  return SlideParser.parse(parseXML(buildSlideXml(nvPr)), RelationshipParser.parse(RELS_XML), SLIDE_PATH)
}

describe('when parsing a slide picture', () => {
  let slide: Slide

  describe('and it embeds a video with a:videoFile and p14:media', () => {
    beforeEach(() => {
      slide = parseSlide(
        '<a:videoFile r:link="rId3"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId2"/></p:ext></p:extLst>'
      )
    })

    it('should expose one video shape pointing at the embedded media file', () => {
      expect(slide.getVideos().map((shape) => shape.mediaRef)).toEqual(['ppt/media/media1.mp4'])
    })
  })

  describe('and it embeds a video with a:videoFile only', () => {
    beforeEach(() => {
      slide = parseSlide('<a:videoFile r:link="rId3"/>')
    })

    it('should expose one video shape pointing at the video file', () => {
      expect(slide.getVideos().map((shape) => shape.mediaRef)).toEqual(['ppt/media/media1.mp4'])
    })
  })

  describe('and it is a plain image', () => {
    beforeEach(() => {
      slide = parseSlide('')
    })

    it('should expose it as an image pointing at the blip', () => {
      expect(slide.getImages().map((shape) => shape.mediaRef)).toEqual(['ppt/media/image1.png'])
    })
  })
})
