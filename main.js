const { app, BrowserWindow, ipcMain, Menu, clipboard, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

// ---------- 設定檔 ~/.quadterm.json（可選） ----------
const CONFIG_PATH = path.join(os.homedir(), '.quadterm.json');
const DEFAULT_CONFIG = {
  cwd: '~',                 // 新終端的預設工作目錄
  shell: '',                // 空白 = 用 $SHELL
  fontSize: 13,
  fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
  zoomRatio: 0.66,          // 放大時，hover 那格佔的寬高比例（0.5 = 不放大）
  zoomMode: 'font',         // 'font' = 放大字（不重畫、不閃）；'resize' = 放大行列數（看得到更多內容）
  hoverDelay: 120,          // 滑鼠停多久（毫秒）才放大
  animationMs: 160,         // 放大動畫長度（毫秒），0 = 不要動畫、直接切換
  resetOnLeave: true,       // 滑鼠離開視窗時恢復平均
  // 程式開啟時自動建立的終端（可以少於或多於 4 個）
  startup: [
    { name: '', cwd: '', command: '' },
    { name: '', cwd: '', command: '' },
    { name: '', cwd: '', command: '' },
    { name: '', cwd: '', command: '' }
  ]
};

function expandHome(p) {
  if (!p) return p;
  return p === '~' ? os.homedir() : p.replace(/^~\//, os.homedir() + '/');
}

function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  const cfg = { ...DEFAULT_CONFIG, ...user };
  // 舊版設定檔用 "panes"，相容一下
  if (!user.startup && Array.isArray(user.panes)) {
    cfg.startup = user.panes.map((p) => ({ name: p.title || '', cwd: p.cwd || '', command: p.command || '' }));
  }
  cfg.homeDir = os.homedir();
  return cfg;
}

let config = loadConfig();
let mainWin = null;

// ---------- 終端（session） ----------
// id -> { pty, owner: 'main' | 'pending' | BrowserWindow(popout), queue: [] }
const sessions = new Map();
const popWins = new Map(); // id -> BrowserWindow
const popPayloads = new Map(); // id -> 交給彈出視窗的初始資料

function ownerContents(s) {
  if (s.owner === 'main') return mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null;
  if (s.owner && s.owner !== 'pending' && !s.owner.isDestroyed()) return s.owner.webContents;
  return null;
}

function spawnPty(id, cols, rows, opts = {}) {
  let s = sessions.get(id);
  if (!s) {
    s = { pty: null, owner: 'main', queue: [] };
    sessions.set(id, s);
  }
  killPtyOnly(s);

  const shellPath = config.shell || process.env.SHELL || '/bin/zsh';
  let cwd = expandHome(opts.cwd || config.cwd) || os.homedir();
  if (!fs.existsSync(cwd)) cwd = os.homedir();

  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'QuadTerm' };
  delete env.ELECTRON_RUN_AS_NODE;

  // -l 登入 shell：從 Finder 開啟時也能讀到 PATH（才找得到 claude）
  const p = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols: Math.max(cols || 80, 2),
    rows: Math.max(rows || 24, 2),
    cwd,
    env
  });
  s.pty = p;

  p.onData((data) => {
    if (s.pty !== p) return;
    if (s.owner === 'pending') { s.queue.push(data); return; }
    ownerContents(s)?.send('pty:data', id, data);
  });
  p.onExit(({ exitCode }) => {
    // 被主動關掉／重開的舊 shell 不通知
    if (s.pty !== p) return;
    s.pty = null;
    ownerContents(s)?.send('pty:exit', id, exitCode);
    if (s.owner !== 'main') mainWin?.webContents.send('pty:exit', id, exitCode);
  });

  if (opts.command) setTimeout(() => { if (s.pty === p) p.write(opts.command + '\r'); }, 400);
}

function killPtyOnly(s) {
  if (s && s.pty) {
    const p = s.pty;
    s.pty = null;
    try { p.kill(); } catch (_) {}
  }
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  killPtyOnly(s);
  sessions.delete(id);
  const w = popWins.get(id);
  if (w && !w.isDestroyed()) { w.__noDock = true; w.destroy(); }
  popWins.delete(id);
}

// ---------- 每 2 秒更新各終端的資料夾和正在跑的程式（給列表顯示用） ----------
function pollInfo() {
  const live = [...sessions.entries()].filter(([, s]) => s.pty);
  if (!live.length || !mainWin) return;
  const info = {};
  for (const [id, s] of live) {
    let proc = '';
    try { proc = s.pty.process || ''; } catch (_) {}
    info[id] = { proc: path.basename(proc).replace(/^-/, ''), cwd: '' };
  }
  const pidToId = new Map(live.map(([id, s]) => [String(s.pty.pid), id]));
  const finish = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('pty:info', info);
    for (const [id, w] of popWins) if (!w.isDestroyed() && info[id]) w.webContents.send('pty:info', { [id]: info[id] });
  };
  if (process.platform === 'linux') {
    for (const [pid, id] of pidToId) {
      try { info[id].cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) {}
    }
    return finish();
  }
  execFile('lsof', ['-a', '-d', 'cwd', '-p', [...pidToId.keys()].join(','), '-Fpn'], { timeout: 1500 }, (_err, out) => {
    let cur = null;
    for (const line of String(out || '').split('\n')) {
      if (line[0] === 'p') cur = pidToId.get(line.slice(1));
      else if (line[0] === 'n' && cur !== undefined && cur !== null) info[cur].cwd = line.slice(1);
    }
    finish();
  });
}
const pollTimer = setInterval(pollInfo, 2000);

// ---------- IPC ----------
ipcMain.handle('config:get', () => config);
ipcMain.on('pty:spawn', (_e, id, cols, rows, opts) => spawnPty(id, cols, rows, opts));
ipcMain.on('pty:write', (_e, id, data) => sessions.get(id)?.pty?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  const p = sessions.get(id)?.pty;
  if (p && cols > 1 && rows > 1) {
    try { p.resize(cols, rows); } catch (_) {}
  }
});
ipcMain.on('pty:kill', (_e, id) => killSession(id));
ipcMain.handle('fs:isDir', (_e, p) => {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
});
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('open:url', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// 拉出成獨立視窗
ipcMain.on('session:popout', (_e, id, payload) => {
  const s = sessions.get(id);
  if (!s) return;
  s.owner = 'pending';
  s.queue = [];
  popPayloads.set(id, payload);

  const cursor = screen.getCursorScreenPoint();
  const w = new BrowserWindow({
    width: payload.width || 900,
    height: payload.height || 600,
    x: payload.atCursor ? cursor.x - 120 : undefined,
    y: payload.atCursor ? cursor.y - 20 : undefined,
    minWidth: 400,
    minHeight: 250,
    backgroundColor: '#14161b',
    titleBarStyle: 'hiddenInset',
    title: payload.name || 'QuadTerm',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  popWins.set(id, w);
  w.loadFile(path.join(__dirname, 'renderer', 'single.html'), { query: { id: String(id) } });

  // 關掉獨立視窗 = 收回列表（不會砍掉程式）
  w.on('close', (ev) => {
    if (w.__noDock || w.__docking) return;
    ev.preventDefault();
    w.__docking = true;
    w.webContents.send('session:requestDock');
    setTimeout(() => { if (!w.isDestroyed()) dock(id, '', w); }, 1500); // 保險
  });
  w.on('closed', () => { if (popWins.get(id) === w) popWins.delete(id); });
});

ipcMain.handle('session:popdata', (e, id) => {
  const s = sessions.get(id);
  const payload = popPayloads.get(id) || {};
  popPayloads.delete(id);
  const w = BrowserWindow.fromWebContents(e.sender);
  let queued = '';
  if (s) {
    queued = s.queue.join('');
    s.queue = [];
    s.owner = w;
  }
  return { ...payload, queued, alive: !!(s && s.pty) };
});

function dock(id, serialized, w) {
  const s = sessions.get(id);
  if (w && !w.isDestroyed()) { w.__noDock = true; w.destroy(); }
  popWins.delete(id);
  if (!s) return;
  const queued = s.owner === 'pending' ? s.queue.join('') : '';
  s.queue = [];
  s.owner = 'main';
  mainWin?.webContents.send('session:docked', id, (serialized || '') + queued, !s.pty);
  mainWin?.focus();
}

ipcMain.on('session:dock', (_e, id, serialized) => {
  const s = sessions.get(id);
  if (s) { s.owner = 'pending'; s.queue = []; }
  dock(id, serialized, popWins.get(id));
});

// 主視窗要求收回某個獨立視窗 → 請那個視窗先把畫面內容送回來
ipcMain.on('session:requestDock', (_e, id) => {
  const w = popWins.get(id);
  if (!w || w.isDestroyed()) return;
  w.__docking = true;
  w.webContents.send('session:requestDock');
  setTimeout(() => { if (!w.isDestroyed()) dock(id, '', w); }, 1500);
});

ipcMain.on('session:focusPopout', (_e, id) => {
  const w = popWins.get(id);
  if (w && !w.isDestroyed()) { w.show(); w.focus(); }
});

ipcMain.on('session:title', (_e, id, title) => {
  const w = popWins.get(id);
  if (w && !w.isDestroyed()) w.setTitle(title);
});

// ---------- 選單 ----------
function send(channel, ...args) {
  const w = BrowserWindow.getFocusedWindow() || mainWin;
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: '終端',
      submenu: [
        { label: '開新終端', accelerator: 'CmdOrCtrl+T', click: () => send('menu', 'new') },
        { label: '關閉目前終端', accelerator: 'CmdOrCtrl+W', click: () => send('menu', 'close') },
        { label: '拉出成獨立視窗／收回', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('menu', 'popout') },
        { label: '重新啟動目前終端', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('menu', 'restart') },
        { type: 'separator' },
        { label: '上一個終端', accelerator: 'CmdOrCtrl+Shift+[', click: () => send('menu', 'prev') },
        { label: '下一個終端', accelerator: 'CmdOrCtrl+Shift+]', click: () => send('menu', 'next') }
      ]
    },
    {
      label: '編輯',
      submenu: [
        { label: '複製', accelerator: 'CmdOrCtrl+C', click: () => send('menu', 'copy') },
        { label: '貼上', accelerator: 'CmdOrCtrl+V', click: () => send('menu', 'paste') },
        { label: '全選', accelerator: 'CmdOrCtrl+A', click: () => send('menu', 'selectAll') },
        { type: 'separator' },
        { label: '清除畫面', accelerator: 'CmdOrCtrl+K', click: () => send('menu', 'clear') }
      ]
    },
    {
      label: '版面',
      submenu: [
        { label: '開關「滑鼠移過去自動放大」', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('menu', 'toggleAuto') },
        { label: '鎖定／解鎖目前這格的放大', accelerator: 'CmdOrCtrl+L', click: () => send('menu', 'lock') },
        { label: '恢復平均分配（也會解鎖）', accelerator: 'CmdOrCtrl+0', click: () => send('menu', 'equal') },
        { label: '全螢幕放大目前這格', accelerator: 'CmdOrCtrl+Shift+Return', click: () => send('menu', 'maximize') },
        { type: 'separator' },
        ...[1, 2, 3, 4].map((n) => ({
          label: `跳到第 ${n} 格`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => send('menu', 'focus', n - 1)
        })),
        { type: 'separator' },
        { label: '字放大', accelerator: 'CmdOrCtrl+=', click: () => send('menu', 'fontUp') },
        { label: '字縮小', accelerator: 'CmdOrCtrl+-', click: () => send('menu', 'fontDown') },
        { type: 'separator' },
        {
          label: '開啟設定檔 (~/.quadterm.json)',
          click: () => {
            if (!fs.existsSync(CONFIG_PATH)) {
              const { homeDir, ...plain } = DEFAULT_CONFIG;
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(plain, null, 2));
            }
            shell.openPath(CONFIG_PATH);
          }
        },
        { role: 'toggleDevTools', label: '開發者工具' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#14161b',
    titleBarStyle: 'hiddenInset',
    title: 'QuadTerm',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.webContents.on('did-start-loading', () => {
    for (const id of [...sessions.keys()]) killSession(id);
  });
  // 主視窗關掉就整個結束（包含拉出去的視窗）
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

let quitting = false;
app.on('before-quit', () => {
  quitting = true;
  clearInterval(pollTimer);
  for (const w of popWins.values()) if (!w.isDestroyed()) w.__noDock = true;
  for (const id of [...sessions.keys()]) killSession(id);
});

app.on('window-all-closed', () => {
  for (const id of [...sessions.keys()]) killSession(id);
  app.quit();
});
