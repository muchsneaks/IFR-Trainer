'use strict';

/**
 * IFR Trainer — Electron desktop app.
 *
 * Starts the IFR Trainer server in-process and shows the moving map in a
 * native window. The same server also feeds the in-sim MSFS toolbar panel
 * (which points an iframe at http://localhost:<port>), so the desktop window
 * and the in-game panel always show the same aircraft, track and navdata.
 *
 * Runs to the system tray so it can sit quietly in the background while you
 * fly, keeping the map available inside MSFS.
 */

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  nativeImage,
  dialog,
} = require('electron');
const { createIfrServer } = require('../server/createServer');

const DEMO = process.argv.includes('--demo');
const DEFAULT_PORT = Number(process.env.PORT) || 8642;

let mainWindow = null;
let tray = null;
let serverApp = null;
let serverPort = DEFAULT_PORT;
let isQuiting = false;

// Only allow a single instance so the server port isn't grabbed twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

/** Try to bind the server, walking forward a few ports if one is taken. */
async function startServer() {
  let lastErr;
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 10; p++) {
    const candidate = createIfrServer({ port: p, demo: DEMO });
    try {
      await candidate.listen();
      serverApp = candidate;
      serverPort = p;
      return;
    } catch (err) {
      lastErr = err;
      if (err && err.code !== 'EADDRINUSE') break;
    }
  }
  throw lastErr || new Error('Could not start server');
}

async function start() {
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox(
      'IFR Trainer',
      `Could not start the map server.\n\n${err && err.message ? err.message : err}`
    );
    app.quit();
    return;
  }
  createWindow();
  createTray();
}

function appIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  return icon.isEmpty() ? undefined : icon;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#10141a',
    title: `IFR Trainer for MSFS 2024${DEMO ? ' — DEMO' : ''}`,
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://localhost:${serverPort}/`);

  // Open external links (map tile attribution etc.) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  buildAppMenu();

  // Close to tray instead of quitting, so the map stays available in MSFS.
  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = appIcon();
  tray = new Tray(
    icon || nativeImage.createEmpty()
  );
  tray.setToolTip('IFR Trainer for MSFS 2024');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open map window', click: showWindow },
      {
        label: 'Copy map address',
        click: () => require('electron').clipboard.writeText(`http://localhost:${serverPort}`),
      },
      { type: 'separator' },
      {
        label: 'Quit IFR Trainer',
        click: () => {
          isQuiting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', showWindow);
}

function buildAppMenu() {
  const template = [
    {
      label: 'View',
      submenu: [
        { label: 'Reload map', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        {
          label: 'Always on top',
          type: 'checkbox',
          checked: false,
          click: (item) => mainWindow.setAlwaysOnTop(item.checked),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: 'Reset zoom', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Track',
      submenu: [
        {
          label: 'Export GeoJSON…',
          click: () => shell.openExternal(`http://localhost:${serverPort}/track.geojson`),
        },
        {
          label: 'Export KML…',
          click: () => shell.openExternal(`http://localhost:${serverPort}/track.kml`),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'MSFS toolbar panel — how to install',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Show the map inside MSFS',
              message: 'Add the IFR Trainer panel to the MSFS toolbar',
              detail:
                'Copy the folder\n\n    msfs-addon/joybuy-ifr-trainer\n\ninto your MSFS Community folder, then restart MSFS. ' +
                'Keep this app running while you fly — the in-sim panel shows this same map. ' +
                'Open it from the MSFS toolbar (move the mouse to the top of the screen).',
            }),
        },
        {
          label: 'About',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'IFR Trainer',
              message: 'IFR Trainer for MSFS 2024',
              detail: `Serving the moving map at http://localhost:${serverPort}\nMode: ${
                DEMO ? 'Demo (simulated flight)' : 'SimConnect (live MSFS data)'
              }`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('before-quit', () => {
  isQuiting = true;
});

app.on('window-all-closed', () => {
  // Stay alive in the tray (except on macOS where this is conventional anyway).
});

app.on('quit', async () => {
  if (serverApp) await serverApp.close();
});
