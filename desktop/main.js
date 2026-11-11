const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { spawn } = require('child_process')
const net = require('net')
const path = require('path')
const fs = require('fs')

const APP_NAME = 'PicoScope Impedance Analyzer'
app.setName(APP_NAME)

let win = null
let backend = null
let port = 0
const logRing = []

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

/** The frozen backend: Resources/backend/pico-backend/pico-backend when packaged. */
function backendPath() {
  const exe = process.platform === 'win32' ? 'pico-backend.exe' : 'pico-backend'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'backend', 'pico-backend', exe)]
    : [path.join(__dirname, '..', 'backend-dist', 'pico-backend', exe)]
  // isFile(), not exists(): extraResources nesting can yield a directory
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch { /* next */ }
  }
  return null
}

function log(line) {
  const text = String(line).trimEnd()
  logRing.push(text)
  if (logRing.length > 300) logRing.shift()
  console.log('[backend] ' + text)
}

async function startBackend() {
  const exe = backendPath()
  if (!exe) throw new Error('bundled backend not found next to the app')
  port = await freePort()
  backend = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      PORT: String(port),
      APP_NO_BROWSER: '1',
      APP_DATA_DIR: app.getPath('userData'),
      PICO_MODE: 'auto',
      PARENT_PID: String(process.pid),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  backend.stdout.on('data', (d) => log(d))
  backend.stderr.on('data', (d) => log(d))
  backend.on('exit', (code) => {
    log('exited with ' + code)
    backend = null
  })
  await waitReady()
}

async function waitReady() {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (!backend) throw new Error('backend exited during startup:\n' + logRing.slice(-20).join('\n'))
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('backend did not answer within 45 s:\n' + logRing.slice(-20).join('\n'))
}

function stopBackend() {
  if (!backend) return
  try { backend.kill('SIGTERM') } catch { /* already gone */ }
  const child = backend
  setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 4000)
  backend = null
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: APP_NAME,
    backgroundColor: '#070b0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'splash.html'))

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) e.preventDefault()
  })
  win.on('closed', () => { win = null })
  return win
}

async function boot() {
  const w = createWindow()
  try {
    await startBackend()
    await w.loadURL(`http://127.0.0.1:${port}/`)
  } catch (err) {
    dialog.showErrorBox(APP_NAME + ' could not start',
      String(err && err.message ? err.message : err))
    app.quit()
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/lucaricciatl/pico-impedance-analyzer'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    boot()
  })

  app.on('before-quit', stopBackend)
  app.on('will-quit', stopBackend)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })
  app.on('window-all-closed', () => {
    stopBackend()
    if (process.platform !== 'darwin') app.quit()
  })
}
