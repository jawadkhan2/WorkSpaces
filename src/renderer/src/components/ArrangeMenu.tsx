import React from 'react'
import { LayoutMode } from '../../../shared/types'

interface Props {
  current: LayoutMode
  onPick: (layout: LayoutMode) => void
}

const OPTIONS: { layout: LayoutMode; label: string; thumb: string; cells: number }[] = [
  { layout: 'auto', label: 'Auto', thumb: '', cells: 4 },
  { layout: 'single', label: 'Single', thumb: 'one', cells: 1 },
  { layout: 'cols', label: 'Side by side', thumb: 'cols', cells: 2 },
  { layout: 'grid', label: 'Grid', thumb: '', cells: 4 }
]

export const ArrangeMenu: React.FC<Props> = ({ current, onPick }) => (
  <div className="pop arrange-menu" onClick={(e) => e.stopPropagation()}>
    <div className="pop-title">Terminal layout</div>
    <div className="am-grid">
      {OPTIONS.map((o) => (
        <div
          key={o.layout}
          className={`am-opt${current === o.layout ? ' active' : ''}`}
          onClick={() => onPick(o.layout)}
        >
          <div className={`thumb ${o.thumb}`}>
            {Array.from({ length: o.cells }).map((_, i) => (
              <span key={i} />
            ))}
          </div>
          <span>{o.label}</span>
        </div>
      ))}
    </div>
  </div>
)
