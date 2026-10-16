const METRIC_COMPATIBLE_SUBSTITUTES: Record<string, string> = {
  Arial: 'Liberation Sans',
  Helvetica: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  Courier: 'Liberation Mono',
  'Courier New': 'Liberation Mono'
}

/**
 * Picks an installed font family for the one a slide asks for: the family itself, then its
 * metric-compatible Liberation substitute, then Arial, then Liberation Sans.
 *
 * @param family - Family name from the slide, already stripped of weight and style keywords.
 * @param isInstalled - Whether the canvas has the family registered.
 * @returns The first installed candidate, or `'Arial'` when none is installed.
 */
export function resolveFontFamily(family: string, isInstalled: (family: string) => boolean): string {
  const candidates = [family, METRIC_COMPATIBLE_SUBSTITUTES[family], 'Arial', 'Liberation Sans']
  return candidates.find((candidate) => candidate !== undefined && isInstalled(candidate)) ?? 'Arial'
}
