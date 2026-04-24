export interface GradientStop {
  color: string
  position: number
}

export interface Fill {
  color: string
  opacity?: number
  /** Linear gradient; angle in degrees (0 = left-to-right). */
  gradient?: {
    type: 'linear'
    angle?: number
    stops: GradientStop[]
  }
}

export interface Stroke {
  color: string
  width: number
  opacity?: number
}

export interface Shadow {
  blur: number
  offsetX: number
  offsetY: number
  color: string
  opacity?: number
}

export interface Background {
  color?: string
  imageRef?: string
  gradientStops?: GradientStop[]
  gradientAngle?: number
}

export interface TextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontSize?: number
  fontFamily?: string
  color?: string
  /** True when this run represents an `<a:br>` line-break element. */
  lineBreak?: boolean
  /** Hyperlink URL from `<a:hlinkClick>` in run properties. */
  hyperlink?: string
  /** Background highlight color from `<a:highlight>` (drawn as a rect behind the text). */
  highlight?: string
}

export interface TextParagraph {
  runs: TextRun[]
  align?: 'left' | 'center' | 'right' | 'justify'
  indent?: number
  spaceBefore?: number
  spaceAfter?: number
  marL?: number
  bullet?: {
    char?: string
    autoNum?: string
    none?: boolean
  }
}
