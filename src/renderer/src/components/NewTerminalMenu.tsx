import React from 'react'
import { AGENT_PRESETS, AgentPreset } from '../../../shared/types'

interface Props {
  onPick: (preset: AgentPreset) => void
}

export const NewTerminalMenu: React.FC<Props> = ({ onPick }) => (
  <div className="pop new-menu" onClick={(e) => e.stopPropagation()}>
    <div className="pop-title">New terminal</div>
    {AGENT_PRESETS.map((p) => (
      <div key={p.kind} className="nm-opt" onClick={() => onPick(p)}>
        <span className="glyph" style={{ background: p.color }}>
          {p.glyph}
        </span>
        {p.title}
      </div>
    ))}
  </div>
)
