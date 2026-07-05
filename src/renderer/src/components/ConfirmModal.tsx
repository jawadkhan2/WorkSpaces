import React, { useEffect, useRef } from 'react'
import { ConfirmOptions } from '../../../shared/types'

interface Props extends ConfirmOptions {
  onResolve: (ok: boolean) => void
}

// The app's single custom confirmation dialog — replaces every native
// window.confirm / dialog.showMessageBox. Themed to match the app; used both
// by the renderer directly and by the main process via the confirm bridge.
export const ConfirmModal: React.FC<Props> = ({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger,
  icon,
  onResolve
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Enter confirms, Escape cancels; focus the confirm button on open.
  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onResolve(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onResolve(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onResolve])

  return (
    <div className="overlay" onMouseDown={() => onResolve(false)}>
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          {icon && (
            <span className={`confirm-icon${danger ? ' danger' : ''}`} aria-hidden="true">
              {icon}
            </span>
          )}
          <h3>{title}</h3>
        </div>
        {message && (
          <div className="confirm-body">
            {message.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={() => onResolve(false)}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={danger ? 'danger' : 'primary'}
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
