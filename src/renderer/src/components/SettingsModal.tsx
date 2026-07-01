import React from 'react'
import { Settings } from '../../../shared/types'

interface Props {
  settings: Settings
  onChange: (partial: Partial<Settings>) => void
  onClose: () => void
}

const Toggle: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => (
  <div className={`switch${on ? ' on' : ''}`} onClick={onClick}>
    <div className="knob" />
  </div>
)

export const SettingsModal: React.FC<Props> = ({ settings, onChange, onClose }) => (
  <div className="overlay" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>Settings</h3>
      <div className="sub">Preferences are saved automatically.</div>

      <div className="setting-row">
        <div>
          <div className="label">Auto-start shells</div>
          <div className="desc">Open a ready terminal in each workspace on launch.</div>
        </div>
        <Toggle
          on={settings.autoStartShells}
          onClick={() => onChange({ autoStartShells: !settings.autoStartShells })}
        />
      </div>

      <div className="setting-row">
        <div>
          <div className="label">Confirm before quitting</div>
          <div className="desc">Ask before stopping running terminals and agents.</div>
        </div>
        <Toggle
          on={settings.confirmOnExit}
          onClick={() => onChange({ confirmOnExit: !settings.confirmOnExit })}
        />
      </div>

      <div className="modal-actions">
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  </div>
)
