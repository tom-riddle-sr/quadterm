/* global qt, makeTerm, safeFit, SHELL_NAMES, enableGL, makePtyResizer */
// 拉出來的獨立終端視窗
(async function () {
  const id = Number(new URLSearchParams(location.search).get('id'));
  const config = await qt.getConfig();
  const data = await qt.popData(id);
  const wrap = document.getElementById('single-wrap');
  const titleEl = document.getElementById('single-title');
  const cwdEl = document.getElementById('single-cwd');
  const homeDir = config.homeDir || '';
  const tilde = (p) => (homeDir && p && p.startsWith(homeDir) ? '~' + p.slice(homeDir.length) : p || '');

  let fontSize = data.fontSize || config.fontSize;
  let exited = !data.alive || !!data.exited;
  let cwd = data.cwd || '';
  const name = data.name || `終端 ${id}`;
  let docked = false;

  const s = { id };
  const { term, fit, serializer } = makeTerm(config, fontSize, s);
  s.term = term;
  if (data.cols && data.rows) term.resize(data.cols, data.rows);
  term.open(wrap);
  enableGL(s);
  if (data.serialized) term.write(data.serialized);
  if (data.queued) term.write(data.queued);

  const refit = () => safeFit(fit, wrap);
  requestAnimationFrame(() => { refit(); qt.resize(id, term.cols, term.rows); term.focus(); });
  new ResizeObserver(() => { clearTimeout(refit.t); refit.t = setTimeout(refit, 40); }).observe(wrap);

  const setExited = (v) => { exited = v; document.body.classList.toggle('exited', v); };
  setExited(exited);

  const updateTitle = (proc) => {
    const p = proc && !SHELL_NAMES.test(proc) ? ` · ${proc}` : '';
    titleEl.textContent = name + p;
    cwdEl.textContent = tilde(cwd);
    document.title = name + p;
  };
  updateTitle('');

  const restart = () => {
    setExited(false);
    term.reset();
    qt.spawn(id, term.cols, term.rows, { cwd });
    term.focus();
  };

  term.onData((d) => {
    if (exited) { if (d === '\r') restart(); return; }
    qt.write(id, d);
  });
  const ptyResize = makePtyResizer(id);
  term.onResize(({ cols, rows }) => ptyResize(cols, rows));

  qt.onData((i, d) => { if (i === id) term.write(d); });
  qt.onExit((i) => { if (i === id) setExited(true); });
  qt.onInfo((info) => {
    const v = info[id];
    if (!v) return;
    if (v.cwd) cwd = v.cwd;
    updateTitle(v.proc);
  });

  const dock = () => {
    if (docked) return;
    docked = true;
    qt.dock(id, serializer.serialize({ scrollback: 5000 }));
  };
  qt.onRequestDock(dock);
  document.getElementById('dock-btn').addEventListener('click', dock);
  document.getElementById('single-claude').addEventListener('click', () => { qt.write(id, 'claude\r'); term.focus(); });
  document.querySelector('#single-exit button').addEventListener('click', restart);

  // 拖檔案進來 → 貼路徑
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const q = (p) => (/[\s'"()&;$`\\]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p);
    const paths = [...e.dataTransfer.files].map((f) => qt.pathForFile(f)).filter(Boolean);
    if (paths.length) { qt.write(id, paths.map(q).join(' ') + ' '); term.focus(); }
  });

  qt.onMenu(async (action) => {
    switch (action) {
      case 'copy': { const sel = term.getSelection(); if (sel) qt.copy(sel); break; }
      case 'paste': { const t = await qt.paste(); if (t && !exited) term.paste(t); break; }
      case 'selectAll': term.selectAll(); break;
      case 'clear': term.clear(); break;
      case 'restart': restart(); break;
      case 'popout':
      case 'close': dock(); break; // ⌘W / ⌘⇧D 在獨立視窗 = 收回主視窗
      case 'fontUp':
      case 'fontDown':
        fontSize = Math.min(28, Math.max(8, fontSize + (action === 'fontUp' ? 1 : -1)));
        term.options.fontSize = fontSize;
        refit();
        break;
    }
  });

  window.__single = { term, id, dock };
})();
