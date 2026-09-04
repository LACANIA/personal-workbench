import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import {
  appendRotatingLog, backupBeforeMigration, clearStaleServerState, createDiagnosticsZip, modelIsAllowed,
  parseServerReadyLine, prepareDataRoot, restoreMigrationBackup, validateExternalUrl,
} from './runtime.mjs'

const PRODUCT = 'Personal Workbench'
const localAppData = process.env.LOCALAPPDATA || path.resolve(app.getPath('appData'), '..', 'Local')
const defaultDataRoot = path.join(localAppData, 'PersonalWorkbench')
const dataRoot = path.resolve(process.env.PERSONAL_WORKBENCH_DATA_ROOT || defaultDataRoot)
app.setPath('userData', path.join(dataRoot, 'config', 'electron'))
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let mainWindow = null
let tray = null
let serverProcess = null
let serverReady = null
let modelProcess = null
let quitting = false
let closeNoticeShown = false
let closeBehavior = 'tray'

const resourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'app-runtime') : path.join(app.getAppPath(), 'desktop-release', 'app-runtime')
const runtimeStatePath = path.join(dataRoot, 'runtime', 'server-state.json')
const desktopSettingsPath = path.join(dataRoot, 'config', 'desktop-settings.json')
const logPath = path.join(dataRoot, 'logs', 'desktop.log')
const bridgeToken = randomBytes(32).toString('base64url')

async function log(event) {
  await appendRotatingLog(logPath, event).catch(() => undefined)
}

async function readDesktopSettings() {
  try {
    const value = JSON.parse(await readFile(desktopSettingsPath, 'utf8'))
    closeBehavior = value.close_window === 'exit' ? 'exit' : 'tray'
  } catch { closeBehavior = 'tray' }
}

async function writeDesktopSettings() {
  await mkdir(path.dirname(desktopSettingsPath), { recursive: true })
  await writeFile(desktopSettingsPath, `${JSON.stringify({ close_window: closeBehavior }, null, 2)}\n`, 'utf8')
}

function serverEnvironment() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PERSONAL_WORKBENCH_DESKTOP: '1',
    PERSONAL_WORKBENCH_RESOURCE_ROOT: resourceRoot,
    PERSONAL_WORKBENCH_DATA_ROOT: dataRoot,
    PERSONAL_WORKBENCH_RUNTIME_STATE: runtimeStatePath,
    PERSONAL_WORKBENCH_DESKTOP_BRIDGE_TOKEN: bridgeToken,
    PERSONAL_WORKBENCH_APP_VERSION: app.getVersion(),
    PERSONAL_WORKBENCH_BUILD_ID: process.env.PERSONAL_WORKBENCH_BUILD_ID || 'release',
    PERSONAL_WORKBENCH_APP_NODE_MODULES: path.join(app.getAppPath(), 'node_modules'),
    NODE_PATH: path.join(app.getAppPath(), 'node_modules'),
  }
}

async function startServer() {
  const entry = path.join(resourceRoot, 'server', 'src', 'index.js')
  await clearStaleServerState(runtimeStatePath)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: resourceRoot,
      env: serverEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProcess = child
    let output = ''
    let errors = ''
    const timer = setTimeout(() => reject(new Error(`WORKBENCH_SERVER_START_TIMEOUT: ${errors.slice(-800)}`)), 45_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      let split = output.indexOf('\n')
      while (split >= 0) {
        const line = output.slice(0, split).trim(); output = output.slice(split + 1)
        const ready = parseServerReadyLine(line)
        if (ready) {
          clearTimeout(timer); serverReady = ready; void log(`server-ready:${ready.port}`); resolve(ready); return
        }
        split = output.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { errors = `${errors}${chunk}`.slice(-4000); void log(`server-stderr:${chunk}`) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (!quitting && serverReady === null) reject(new Error(`WORKBENCH_SERVER_EXIT_${code}: ${errors.slice(-800)}`))
      if (!quitting && serverReady !== null) {
        void log(`server-unexpected-exit:${code}`)
        mainWindow?.webContents.send('desktop:server-exited', { code })
      }
      serverProcess = null
    })
  })
}

async function stopServer() {
  const child = serverProcess
  serverProcess = null
  serverReady = null
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const ended = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
  if (!ended && child.pid) {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', resolve); killer.once('error', resolve)
    })
  }
  await rm(runtimeStatePath, { force: true })
  await log('server-stopped')
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus()
}

async function requestQuit() {
  if (quitting) return
  quitting = true
  if (modelProcess) modelProcess.kill('SIGTERM')
  await stopServer()
  app.exit(0)
}

async function createWindow(ready) {
  mainWindow = new BrowserWindow({
    width: 1360, height: 900, minWidth: 980, minHeight: 680, show: false,
    title: PRODUCT,
    icon: path.join(resourceRoot, 'assets', 'app-icon.ico'),
    backgroundColor: '#f4f6fa',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(validateExternalUrl(url)) } catch { /* denied */ }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`http://127.0.0.1:${ready.port}/`)) return
    event.preventDefault()
    try { void shell.openExternal(validateExternalUrl(url)) } catch { /* denied */ }
  })
  mainWindow.on('close', event => {
    if (quitting || closeBehavior === 'exit') return
    event.preventDefault(); mainWindow.hide()
    if (!closeNoticeShown) {
      closeNoticeShown = true
      void dialog.showMessageBox({ type: 'info', title: PRODUCT, message: 'Personal Workbench仍在后台运行，可从托盘重新打开。' })
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  await mainWindow.loadURL(ready.url)
  if (!mainWindow.isVisible()) mainWindow.show()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(resourceRoot, 'assets', 'app-icon.ico'))
  tray = new Tray(icon)
  tray.setToolTip(PRODUCT)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Personal Workbench', click: showWindow },
    { label: '运行诊断', click: () => { showWindow(); mainWindow?.webContents.send('desktop:navigate', 'settings') } },
    { type: 'separator' },
    { label: '退出', click: () => void requestQuit() },
  ]))
  tray.on('double-click', showWindow)
}

async function registerSelectedPath(kind, selectedPath) {
  const response = await fetch(`http://127.0.0.1:${serverReady.port}/api/input/register-desktop-selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': serverReady.token, 'X-Desktop-Bridge-Token': bridgeToken },
    body: JSON.stringify({ kind, path: selectedPath }),
  })
  const value = await response.json()
  if (!response.ok || !value.ok) throw new Error(value.error?.message || `HTTP ${response.status}`)
  return value.data
}

function registerIpc() {
  ipcMain.handle('desktop:pick-input', async (_event, input) => {
    if (!mainWindow || !serverReady) throw new Error('DESKTOP_NOT_READY')
    const kind = input?.kind === 'directory' ? 'directory' : 'file'
    const multiple = kind === 'file' && input?.multiple === true
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'directory' ? '选择一个文件夹' : '选择文件',
      properties: kind === 'directory' ? ['openDirectory'] : multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return multiple ? [] : { canceled: true, path: null, kind, asset: null }
    const rows = []
    for (const selectedPath of result.filePaths) rows.push(await registerSelectedPath(kind, selectedPath))
    return multiple ? rows : rows[0]
  })
  ipcMain.handle('desktop:open-path', async (_event, value) => {
    if (typeof value !== 'string') throw new Error('PATH_REQUIRED')
    return shell.openPath(path.resolve(value))
  })
  ipcMain.handle('desktop:show-item-in-folder', (_event, value) => {
    if (typeof value !== 'string') throw new Error('PATH_REQUIRED')
    shell.showItemInFolder(path.resolve(value)); return true
  })
  ipcMain.handle('desktop:open-external', (_event, value) => shell.openExternal(validateExternalUrl(String(value))))
  ipcMain.handle('desktop:get-info', () => ({
    product: PRODUCT, version: app.getVersion(), build_id: process.env.PERSONAL_WORKBENCH_BUILD_ID || 'release',
    data_root: dataRoot, log_root: path.join(dataRoot, 'logs'), desktop: true,
  }))
  ipcMain.handle('desktop:get-close-behavior', () => closeBehavior)
  ipcMain.handle('desktop:set-close-behavior', async (_event, value) => {
    if (value !== 'tray' && value !== 'exit') throw new Error('CLOSE_BEHAVIOR_INVALID')
    closeBehavior = value; await writeDesktopSettings(); return closeBehavior
  })
  ipcMain.handle('desktop:install-model', async (_event, model) => {
    if (!modelIsAllowed(model) || modelProcess) throw new Error('MODEL_INSTALL_DENIED')
    const executable = process.env.PERSONAL_WORKBENCH_OLLAMA_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
    modelProcess = spawn(executable, ['pull', model], { windowsHide: true, shell: false })
    for (const stream of [modelProcess.stdout, modelProcess.stderr]) {
      stream?.setEncoding('utf8'); stream?.on('data', text => mainWindow?.webContents.send('desktop:model-progress', { model, message: String(text).slice(-500) }))
    }
    const code = await new Promise((resolve, reject) => { modelProcess.once('exit', resolve); modelProcess.once('error', reject) })
    modelProcess = null
    mainWindow?.webContents.send('desktop:model-progress', { model, completed: code === 0, code })
    return { model, completed: code === 0, code }
  })
  ipcMain.handle('desktop:cancel-model-install', () => { modelProcess?.kill('SIGTERM'); return true })
  ipcMain.handle('desktop:export-diagnostics', async () => {
    if (!mainWindow) throw new Error('DESKTOP_NOT_READY')
    const chosen = await dialog.showSaveDialog(mainWindow, { title: '导出诊断信息', defaultPath: `Personal-Workbench-Diagnostics-${Date.now()}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
    if (chosen.canceled || !chosen.filePath) return { canceled: true }
    const payload = { product: PRODUCT, version: app.getVersion(), platform: process.platform, arch: process.arch, generated_at: new Date().toISOString(), data_root: '[local-user-data]', server: serverReady ? 'running' : 'stopped' }
    await writeFile(chosen.filePath, createDiagnosticsZip([{ name: 'diagnostics.json', data: `${JSON.stringify(payload, null, 2)}\n` }]))
    return { canceled: false, path: chosen.filePath }
  })
}

app.on('second-instance', showWindow)
app.on('activate', showWindow)
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault(); void requestQuit()
})

async function bootstrap() {
  await prepareDataRoot(dataRoot)
  await readDesktopSettings()
  const migrationBackup = await backupBeforeMigration(dataRoot, app.getVersion())
  registerIpc()
  try {
    const ready = await startServer()
    await createWindow(ready)
    createTray()
    const acceptanceExitAfter = Number(process.env.PERSONAL_WORKBENCH_ACCEPTANCE_EXIT_AFTER_MS ?? 0)
    if (Number.isFinite(acceptanceExitAfter) && acceptanceExitAfter >= 1000) {
      setTimeout(() => void requestQuit(), acceptanceExitAfter)
    }
  } catch (error) {
    if (migrationBackup !== null) {
      await restoreMigrationBackup(dataRoot, migrationBackup).catch(restoreError => log(`migration-restore-failed:${restoreError instanceof Error ? restoreError.message : String(restoreError)}`))
    }
    await log(`startup-failed:${error instanceof Error ? error.message : String(error)}`)
    await dialog.showMessageBox({ type: 'error', title: PRODUCT, message: 'Personal Workbench启动失败。', detail: error instanceof Error ? error.message : String(error) })
    await requestQuit()
  }
}

if (gotLock) void app.whenReady().then(bootstrap).catch(async error => {
  await log(`bootstrap-failed:${error instanceof Error ? error.message : String(error)}`)
  await requestQuit()
})
