const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, Notification } = require('electron');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let tunnelProcess = null;
let isQuitting = false;

const PORT = 3000;
const SERVER_URL = `http://localhost:${PORT}`;

// -----------------------------------------------------------------------------
// 1. Server Health Check & Auto-Launcher
// -----------------------------------------------------------------------------
function isServerRunning(callback) {
  const req = http.get(`${SERVER_URL}/api/status`, (res) => {
    callback(res.statusCode === 200 || res.statusCode === 404);
  });
  req.on('error', () => callback(false));
  req.setTimeout(1500, () => {
    req.destroy();
    callback(false);
  });
}

function ensureBackendRunning(onReady) {
  isServerRunning((running) => {
    if (running) {
      console.log('[Desktop] Backend server is already running.');
      onReady();
    } else {
      console.log('[Desktop] Starting internal backend server...');
      const serverScript = path.resolve(__dirname, '..', 'admin', 'server.js');
      serverProcess = spawn(process.execPath, [serverScript], {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        stdio: 'pipe'
      });

      serverProcess.stdout.on('data', (d) => process.stdout.write(`[Server] ${d}`));
      serverProcess.stderr.on('data', (d) => process.stderr.write(`[Server ERR] ${d}`));

      // Poll until ready
      let retries = 0;
      const poll = setInterval(() => {
        retries++;
        isServerRunning((isUp) => {
          if (isUp || retries > 25) {
            clearInterval(poll);
            onReady();
          }
        });
      }, 500);
    }
  });
}

// -----------------------------------------------------------------------------
// 2. Window Creation
// -----------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'Sai Traders — Retail Operations & Inventory Management',
    backgroundColor: '#0b0f19',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Load Admin Web Application
  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Minimize to tray on close if user prefers background execution
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: 'Sai Traders Running in Background',
          body: 'The inventory agent and storefront sync are still active in the system tray.'
        }).show();
      }
    }
  });

  setupApplicationMenu();
  setupSystemTray();
}

// -----------------------------------------------------------------------------
// 3. Native Application Menu
// -----------------------------------------------------------------------------
function setupApplicationMenu() {
  const template = [
    {
      label: 'Sai Traders',
      submenu: [
        {
          label: 'About Sai Traders Desktop',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Sai Traders',
              message: 'Sai Traders — Enterprise Saree Retail Operations & Inventory Management',
              detail: 'Version 2.0.0 (Native Windows Desktop Edition)\nPowered by Google Gemini AI & TallyPrime Connector'
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Start on Windows Boot',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (menuItem) => {
            app.setLoginItemSettings({
              openAtLogin: menuItem.checked,
              path: process.execPath
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Operations',
      submenu: [
        {
          label: 'Refresh Live Inventory',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow.reload()
        },
        {
          label: 'Open Storefront API Simulator',
          click: () => shell.openExternal(`${SERVER_URL}/api-test`)
        },
        {
          label: 'View System Architecture Topology',
          click: () => shell.openExternal(`${SERVER_URL}/archify`)
        },
        { type: 'separator' },
        {
          label: 'Open TallyPrime Status',
          click: () => shell.openExternal('http://127.0.0.1:9000')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Developer Tools',
          accelerator: 'F12',
          click: () => mainWindow.webContents.toggleDevTools()
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'API Documentation (PDF)',
          click: () => {
            const pdfPath = path.resolve(__dirname, '..', 'SAI_TRADERS_STOREFRONT_API_DOCUMENTATION.pdf');
            shell.openPath(pdfPath);
          }
        },
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal('https://github.com/vasgenerativesolutions-collab/Sai')
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// -----------------------------------------------------------------------------
// 4. System Tray Integration
// -----------------------------------------------------------------------------
function setupSystemTray() {
  if (tray) return;

  // Create SVG buffer icon for tray
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b"><rect width="20" height="20" x="2" y="2" rx="4"/></svg>`;
  const icon = nativeImage.createFromBuffer(Buffer.from(iconSvg));

  tray = new Tray(icon);
  tray.setToolTip('Sai Traders — Retail Operations & Inventory Agent');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🥻 Open Sai Traders',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: '🧪 Open Storefront Simulator',
      click: () => shell.openExternal(`${SERVER_URL}/api-test`)
    },
    {
      label: '🌐 Public Cloudflare URL',
      click: () => shell.openExternal('https://tunes-incidence-minutes-examples.trycloudflare.com')
    },
    { type: 'separator' },
    {
      label: '❌ Exit Completely',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// -----------------------------------------------------------------------------
// 5. App Lifecycle
// -----------------------------------------------------------------------------
app.whenReady().then(() => {
  ensureBackendRunning(() => {
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    try { serverProcess.kill(); } catch (e) {}
  }
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch (e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
