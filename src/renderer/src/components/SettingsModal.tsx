import React from 'react'
import { Settings, UpdateState } from '../../../shared/types'

interface Props {
  settings: Settings
  appVersion: string
  updateState: UpdateState
  onCheckForUpdates: () => void
  onInstallUpdate: () => void
  onChange: (partial: Partial<Settings>) => void
  onClose: () => void
}

const Toggle: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => (
  <div className={`switch${on ? ' on' : ''}`} onClick={onClick}>
    <div className="knob" />
  </div>
)

const updateStatusText = (s: UpdateState): string => {
  switch (s.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading ${s.version ?? 'update'}… ${Math.round(s.percent ?? 0)}%`
    case 'downloaded':
      return `Version ${s.version} is ready to install.`
    case 'up-to-date':
      return "You're up to date."
    case 'error':
      return `Update check failed: ${s.error ?? 'unknown error'}`
    case 'unsupported':
      return 'Updates are unavailable in development builds.'
    default:
      return 'Updates are checked automatically in the background.'
  }
}

export const SettingsModal: React.FC<Props> = ({
  settings,
  appVersion,
  updateState,
  onCheckForUpdates,
  onInstallUpdate,
  onChange,
  onClose
}) => (
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

      <div className="setting-row">
        <div>
          <div className="label">
            Updates <span className="version-tag">v{appVersion}</span>
          </div>
          <div className={`desc${updateState.phase === 'error' ? ' error' : ''}`}>
            {updateStatusText(updateState)}
          </div>
          {updateState.phase === 'downloading' && (
            <div className="update-progress">
              <div
                className="update-progress-fill"
                style={{ width: `${Math.min(100, updateState.percent ?? 0)}%` }}
              />
            </div>
          )}
        </div>
        {updateState.phase === 'downloaded' ? (
          <button className="update-btn primary" onClick={onInstallUpdate}>
            Restart to update
          </button>
        ) : (
          <button
            className="update-btn"
            disabled={
              updateState.phase === 'checking' ||
              updateState.phase === 'downloading' ||
              updateState.phase === 'unsupported'
            }
            onClick={onCheckForUpdates}
          >
            Check for updates
          </button>
        )}
      </div>

      <div className="modal-actions">
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  </div>
)
