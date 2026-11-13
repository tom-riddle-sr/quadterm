/* global Terminal, FitAddon, WebLinksAddon, SerializeAddon, WebglAddon, qt */
// 主視窗和獨立視窗共用：建立一個 xterm 並接好鍵盤／連結等
window.QT_THEME = {
  background: '#1b1e25',
  foreground: '#c9d1d9',
  cursor: '#d97757',
  cursorAccent: '#1b1e25',
  selectionBackground: '#3b4252',
  black: '#1b1e25', red: '#f47067', green: '#8ddb8c', yellow: '#f0c674',
  blue: '#6cb6ff', magenta: '#dcbdfb', cyan: '#76e3ea', white: '#c9d1d9',
  brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#b4f1b4', brightYellow: '#f8e3a1',
  brightBlue: '#96d0ff', brightMagenta: '#eedcff', brightCyan: '#b3f0ff', brightWhite: '#ffffff'
};

window.SHELL_NAMES = /^(zsh|bash|fish|sh|login|tcsh|ksh|nu|)$/;

window.makeTerm = function (config, fontSize, session) {
  window.QT_GPU = config.gpuRendering !== false;
  const term = new Terminal({
    fontSize,
    fontFamily: config.fontFamily,
    theme: window.QT_THEME,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    scrollback: 10000
  });
  const fit = new FitAddon.FitAddon();
  const serializer = new SerializeAddon.SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(serializer);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => qt.openUrl(uri)));

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const id = session.id;
    // Shift+Enter → 換行（Claude Code 多行輸入）
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      qt.write(id, '\x1b\r');
      return false;
    }
    if (e.metaKey && e.key === 'ArrowLeft') { qt.write(id, '\x01'); return false; }
    if (e.metaKey && e.key === 'ArrowRight') { qt.write(id, '\x05'); return false; }
    if (e.metaKey && e.key === 'Backspace') { qt.write(id, '\x15'); return false; }
    return true;
  });

  return { term, fit, serializer };
};

window.safeFit = function (fit, el) {
  try {
    if (el && el.clientWidth > 20 && el.clientHeight > 20) fit.fit();
  } catch (_) {}
};

// GPU（WebGL）繪製：比預設的 DOM 繪製快很多。
// 瀏覽器同時能開的 WebGL context 有限，所以只給「看得到的」終端用，移出畫面就釋放。
window.enableGL = function (s) {
  if (s.gl || !s.term || !window.QT_GPU || typeof WebglAddon === 'undefined') return;
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => { try { gl.dispose(); } catch (_) {} s.gl = null; });
    s.term.loadAddon(gl);
    s.gl = gl;
  } catch (_) {
    s.gl = null; // 不支援 WebGL 就退回 DOM 繪製
  }
};
window.disableGL = function (s) {
  if (!s.gl) return;
  try { s.gl.dispose(); } catch (_) {}
  s.gl = null;
};

// 通知 shell「視窗大小變了」要節流：claude 每收到一次就會整個畫面重畫
window.makePtyResizer = function (id, delay = 120) {
  let t = null;
  let last = '';
  return (cols, rows) => {
    clearTimeout(t);
    t = setTimeout(() => {
      const key = cols + 'x' + rows;
      if (key === last) return;
      last = key;
      qt.resize(id, cols, rows);
    }, delay);
  };
};
