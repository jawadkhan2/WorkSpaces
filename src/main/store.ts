import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { DEFAULT_SETTINGS, Settings, Workspace } from '../shared/types'

interface StoreData {
  workspaces: Workspace[]
  settings: Settings
}

const DEFAULTS: StoreData = { workspaces: [], settings: { ...DEFAULT_SETTINGS } }

/** Tiny synchronous JSON store in userData. Avoids extra ESM deps. */
class Store {
  private file: string
  private data: StoreData

  constructor() {
    this.file = join(app.getPath('userData'), 'config.json')
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
      }
    } catch {
      return { ...DEFAULTS, workspaces: [], settings: { ...DEFAULT_SETTINGS } }
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to persist store:', err)
    }
  }

  getWorkspaces(): Workspace[] {
    return this.data.workspaces
  }

  setWorkspaces(ws: Workspace[]): void {
    this.data.workspaces = ws
    this.persist()
  }

  getSettings(): Settings {
    return this.data.settings
  }

  setSettings(partial: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...partial }
    this.persist()
    return this.data.settings
  }
}

let store: Store | null = null
export function getStore(): Store {
  if (!store) store = new Store()
  return store
}
