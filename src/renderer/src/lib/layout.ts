import { LayoutMode } from '../../../shared/types'

export interface GridStyle {
  gridTemplateColumns: string
  gridTemplateRows: string
}

/**
 * Compute CSS grid template for a given layout + tile count.
 * `count` is the number of visible tiles (terminals, or the lone add tile
 * when the workspace is empty) so open terminals always fill the area.
 * Auto = balanced near-square grid: cols = ceil(sqrt(n)), rows = ceil(n/cols).
 */
export function gridStyle(layout: LayoutMode, count: number): GridStyle {
  const n = Math.max(1, count)

  switch (layout) {
    case 'single':
      return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
    case 'cols':
      return { gridTemplateColumns: `repeat(${n}, 1fr)`, gridTemplateRows: '1fr' }
    case 'rows':
      return { gridTemplateColumns: '1fr', gridTemplateRows: `repeat(${n}, 1fr)` }
    case 'grid': {
      const cols = Math.min(2, n)
      const rows = Math.ceil(n / cols)
      return {
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }
    }
    case 'auto':
    default: {
      const cols = Math.ceil(Math.sqrt(n))
      const rows = Math.ceil(n / cols)
      return {
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }
    }
  }
}
