import React, { useCallback, useState } from 'react'
import { ConfirmOptions } from '../../../shared/types'
import { ConfirmModal } from '../components/ConfirmModal'

interface Pending extends ConfirmOptions {
  key: number
  /** Correlation id for confirmations driven by the main process. */
  externalId?: string
  resolve: (ok: boolean) => void
}

interface UseConfirm {
  /** Show the custom modal; resolves to the user's choice. */
  confirm: (opts: ConfirmOptions, externalId?: string) => Promise<boolean>
  /** Dismiss a main-process confirmation whose request expired (resolves false). */
  cancel: (externalId: string) => void
  /** Render this near the app root to display queued confirmations. */
  confirmNode: React.ReactNode
}

// Promise-based access to the app's custom ConfirmModal. Requests queue, so an
// overlapping ask (e.g. a main-process quit prompt landing mid-action) never
// drops a pending resolver — they show one at a time in order.
export function useConfirm(): UseConfirm {
  const [queue, setQueue] = useState<Pending[]>([])

  const confirm = useCallback(
    (opts: ConfirmOptions, externalId?: string) =>
      new Promise<boolean>((resolve) => {
        setQueue((q) => [
          ...q,
          { ...opts, key: Date.now() + Math.random(), externalId, resolve }
        ])
      }),
    []
  )

  const cancel = useCallback((externalId: string) => {
    setQueue((q) => {
      const hit = q.find((p) => p.externalId === externalId)
      if (!hit) return q
      hit.resolve(false)
      return q.filter((p) => p !== hit)
    })
  }, [])

  const current = queue[0] ?? null
  let confirmNode: React.ReactNode = null
  if (current) {
    const { key, resolve, externalId: _externalId, ...opts } = current
    confirmNode = (
      <ConfirmModal
        key={key}
        {...opts}
        onResolve={(ok) => {
          resolve(ok)
          setQueue((q) => q.slice(1))
        }}
      />
    )
  }

  return { confirm, cancel, confirmNode }
}
