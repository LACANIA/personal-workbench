import type { NativeInputSelection } from '../../shared/contracts/index.ts'

declare global {
  interface Window {
    personalWorkbenchDesktop?: {
      readonly isDesktop: true
      selectFile(): Promise<NativeInputSelection>
      selectFiles(): Promise<NativeInputSelection[]>
      selectDirectory(): Promise<NativeInputSelection>
      openPath(path: string): Promise<string>
      showItemInFolder(path: string): Promise<boolean>
      openExternal(url: string): Promise<void>
      getInfo(): Promise<{ product: string; version: string; build_id: string; data_root: string; log_root: string; desktop: true }>
      getCloseBehavior(): Promise<'tray' | 'exit'>
      setCloseBehavior(value: 'tray' | 'exit'): Promise<'tray' | 'exit'>
      installModel(model: string): Promise<{ model: string; completed: boolean; code: number | null }>
      cancelModelInstall(): Promise<boolean>
      exportDiagnostics(): Promise<{ canceled: boolean; path?: string }>
      onModelProgress(callback: (payload: Record<string, unknown>) => void): () => void
      onNavigate(callback: (page: string) => void): () => void
    }
  }
}

export {}
