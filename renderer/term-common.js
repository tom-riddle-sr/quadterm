/* global Terminal, FitAddon, WebLinksAddon, SerializeAddon, qt */
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
