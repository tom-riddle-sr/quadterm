/* global qt, makeTerm, safeFit, SHELL_NAMES, enableGL, disableGL, makePtyResizer */
(async function () {
  const config = await qt.getConfig();
  const grid = document.getElementById('grid');
  const tabsEl = document.getElementById('tabs');
  const offscreen = document.getElementById('offscreen');
  const badge = document.getElementById('auto-badge');

  let fontSize = config.fontSize;
  let autoZoom = true;
  let activeSlot = 0;
  let maximized = false;
  let hoverTimer = null;
  let nextId = 1;
  let clock = 0;
  let renaming = false;
  let animating = false;
  let lockedSlot = null; // 鎖定放大的格子（null = 沒鎖）
  let animTimer = null;
  const animMs = Math.max(0, Number(config.animationMs ?? 160));
  document.documentElement.style.setProperty('--dur', animMs + 'ms');

  const sessions = new Map(); // id -> session
  const order = [];           // 列表順序
  const slots = [null, null, null, null]; // 4 格各放哪個 session id
  const slotEls = [];

  const SCROLLBACK_TRANSFER = 5000;
  const toTerminal = config.popoutTarget !== 'window';
  const termApp = config.terminalApp || 'Terminal';
  const POP_TITLE = toTerminal ? `在 ${termApp} 開啟 (⌘⇧D)` : '拉出成獨立視窗 (⌘⇧D)';

  // ---------- 工具 ----------
  const homeDir = config.homeDir || '';
  const tilde = (p) => (homeDir && p && p.startsWith(homeDir) ? '~' + p.slice(homeDir.length) : p || '');
  const basename = (p) => (p ? (p === homeDir ? '~' : p.split('/').filter(Boolean).pop() || '/') : '');
  const label = (s) => s.name || (s.cwd && s.cwd !== homeDir ? basename(s.cwd) : `終端 ${s.id}`);
  const runningProc = (s) => (s.proc && !SHELL_NAMES.test(s.proc) ? s.proc : '');
  const touch = (s) => { s.lastUsed = ++clock; };
  const slotOf = (id) => slots.indexOf(id);
  const activeSession = () => sessions.get(slots[activeSlot]);
  const quote = (p) => (/[\s'"()&;$`\\]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p);

  // ---------- 4 格 ----------
  for (let i = 0; i < 4; i++) {
    const el = document.createElement('div');
    el.className = 'pane empty';
    el.innerHTML = `
      <div class="pane-header">
        <span class="pane-num">${i + 1}</span>
        <span class="pane-title"></span>
        <span class="pane-cwd"></span>
        <button class="pane-btn" data-act="claude" title="在這格執行 claude">▶ claude</button>
        <button class="pane-btn" data-act="pop" title="${POP_TITLE}">⧉</button>
        <button class="pane-btn lock-btn" data-act="lock" title="鎖定放大這格 (⌘L)">🔒</button>
        <button class="pane-btn" data-act="max" title="這格全螢幕 (⌘⇧↩)">⤢</button>
        <button class="pane-btn" data-act="restart" title="重新啟動 (⌘⇧R)">↻</button>
        <button class="pane-btn" data-act="close" title="關閉這個終端 (⌘W)">✕</button>
      </div>
      <div class="term-wrap"></div>
      <div class="empty-slot"><button>＋ 開新終端</button><div>或從上方列表點一個終端／拖進來</div></div>
      <div class="exit-overlay">
        <div>程式已結束</div>
        <button>重新啟動（Enter）</button>
      </div>
      <div class="drop-chooser">
        <div class="dc-path"></div>
        <button data-dc="continue">接續這個資料夾最近的 Claude 對話<small>claude --continue</small></button>
        <button data-dc="resume">選擇要接續哪一個對話<small>claude --resume</small></button>
        <button data-dc="cd">開一個在這個資料夾的終端</button>
        <button data-dc="paste" class="dc-sub">只貼上路徑</button>
        <button data-dc="cancel" class="dc-sub">取消（Esc）</button>
        <div class="dc-note">前三個會開新終端放在這格，原本的會留在上方列表</div>
      </div>`;
    grid.appendChild(el);
    const wrap = el.querySelector('.term-wrap');
    slotEls.push({ el, wrap, title: el.querySelector('.pane-title'), cwd: el.querySelector('.pane-cwd') });

    el.addEventListener('mouseenter', () => {
      if (!autoZoom || maximized || slots[i] == null || lockedSlot != null) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => activate(i, { zoom: true, focus: true }), config.hoverDelay);
    });
    el.addEventListener('mousedown', () => {
      clearTimeout(hoverTimer);
      const s = sessions.get(slots[i]);
      if (s) touch(s);
      activate(i, { zoom: autoZoom && !maximized && !!s, focus: true });
    });

    // 直接拖標題列：拖到視窗外 = 拉出成獨立視窗；拖到另一格 = 互換
    const header = el.querySelector('.pane-header');
    header.draggable = true;
    let draggingId = null;
    header.addEventListener('dragstart', (e) => {
      const id = slots[i];
      draggingId = id;
      if (id == null || e.target.closest('button')) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-qt-session', String(id));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    header.addEventListener('dragend', (e) => {
      el.classList.remove('dragging');
      const id = draggingId;
      draggingId = null;
      if (id != null) popoutIfDroppedOutside(id, e);
    });

    el.querySelector('.pane-header').addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      const s = sessions.get(slots[i]);
      if (!act || !s) return;
      if (act === 'claude') { qt.write(s.id, 'claude\r'); s.term.focus(); }
      if (act === 'pop') popout(s.id, false);
      if (act === 'max') { activate(i, { focus: true }); toggleMaximize(); }
      if (act === 'lock') toggleLock(i);
      if (act === 'restart') restart(s.id);
      if (act === 'close') closeSession(s.id);
    });
    el.querySelector('.empty-slot button').addEventListener('click', () => newSession({}, i));
    el.querySelector('.exit-overlay button').addEventListener('click', () => slots[i] != null && restart(slots[i]));

    // 拖放：列表的終端 → 放進這格；資料夾 → 問要怎麼開；檔案 → 貼路徑
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const sid = e.dataTransfer.getData('application/x-qt-session');
      if (sid) { moveToSlot(Number(sid), i); return; }
      const paths = [...e.dataTransfer.files].map((f) => qt.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      activate(i, { zoom: autoZoom && !maximized, focus: false });
      if (paths.length === 1 && (await qt.isDir(paths[0]))) return showChooser(i, paths[0]);
      const s = sessions.get(slots[i]);
      if (s) { qt.write(s.id, paths.map(quote).join(' ') + ' '); s.term.focus(); }
    });

    const chooser = el.querySelector('.drop-chooser');
    chooser.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const dir = el.__pendingDir;
      const act = btn.dataset.dc;
      closeChooser(i);
      if (!dir || act === 'cancel') return;
      if (act === 'paste') {
        const s = sessions.get(slots[i]);
        if (s) { qt.write(s.id, quote(dir) + ' '); s.term.focus(); }
        return;
      }
      const command = { continue: 'claude --continue', resume: 'claude --resume', cd: '' }[act];
      newSession({ cwd: dir, command }, i);
    });

    let fitTimer = null;
    new ResizeObserver(() => {
      if (animating) return; // 動畫中不重算，等動畫結束一次算好
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => fitSlot(i), 40);
    }).observe(wrap);
  }

  function showChooser(i, dir) {
    const el = slotEls[i].el;
    el.__pendingDir = dir;
    el.querySelector('.dc-path').textContent = '📁 ' + tilde(dir);
    el.classList.add('choosing');
    el.querySelector('.drop-chooser button').focus(); // Enter = 接續對話
  }
  function closeChooser(i) {
    const el = slotEls[i].el;
    el.classList.remove('choosing');
    el.__pendingDir = null;
    sessions.get(slots[i])?.term?.focus();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    slotEls.forEach((x, i) => {
      if (x.el.classList.contains('choosing')) { e.preventDefault(); e.stopPropagation(); closeChooser(i); }
    });
  }, true);

  // ---------- session ----------
  function attachTerm(s, cols, rows) {
    s.host = document.createElement('div');
    s.host.className = 'term-host';
    offscreen.appendChild(s.host);
    const { term, fit, serializer } = makeTerm(config, fontSize, s);
    Object.assign(s, { term, fit, serializer });
    if (cols && rows) term.resize(cols, rows);
    term.open(s.host);
    term.onData((d) => {
      if (s.exited) { if (d === '\r') restart(s.id); return; }
      qt.write(s.id, d);
    });
    const ptyResize = makePtyResizer(s.id);
    term.onResize(({ cols, rows }) => ptyResize(cols, rows));
    term.onTitleChange((t) => { s.osTitle = t; });
  }

  function newSession(opts = {}, slot, { hidden = false } = {}) {
    const s = {
      id: nextId++,
      name: opts.name || '',
      cwd: opts.cwd || '',
      proc: '',
      exited: false,
      popped: false,
      busy: false,
      unread: false,
      lastData: 0,
      lastUsed: 0
    };
    sessions.set(s.id, s);
    order.push(s.id);
    attachTerm(s);
    touch(s);
    if (!hidden) put(s.id, slot == null ? pickSlot() : slot);
    safeFit(s.fit, s.host);
    qt.spawn(s.id, s.term.cols, s.term.rows, { cwd: opts.cwd, command: opts.command });
    if (!hidden) activate(slotOf(s.id), { zoom: autoZoom && !maximized && order.length > 1, focus: true });
    renderTabs();
    return s;
  }

  function pickSlot() {
    const empty = slots.indexOf(null);
    if (empty >= 0) return empty;
    // 換掉最久沒用的那格，但不換掉鎖定的那格
    let best = -1;
    for (let i = 0; i < 4; i++) {
      if (i === lockedSlot) continue;
      if (best < 0 || sessions.get(slots[i]).lastUsed < sessions.get(slots[best]).lastUsed) best = i;
    }
    return best < 0 ? 0 : best;
  }

  // 把 session 放進第 slot 格（原本在那格的退回列表）
  function put(id, slot) {
    const s = sessions.get(id);
    const old = slots[slot];
    if (old != null && old !== id) {
      const o = sessions.get(old);
      if (o && o.host) { disableGL(o); offscreen.appendChild(o.host); }
    }
    const from = slotOf(id);
    if (from >= 0 && from !== slot) { slots[from] = null; refreshSlot(from); }
    slots[slot] = id;
    slotEls[slot].wrap.appendChild(s.host);
    enableGL(s);
    s.unread = false;
    refreshSlot(slot);
    fitSlot(slot);
  }

  function moveToSlot(id, slot) {
    const s = sessions.get(id);
    if (!s) return;
    if (s.popped) { dockFromPopout(id); return; }
    const from = slotOf(id);
    if (from === slot) return;
    const other = slots[slot];
    touch(s);
    put(id, slot);
    if (from >= 0 && other != null) put(other, from); // 兩格互換
    else if (from >= 0) fillSlot(from);
    activate(slot, { focus: true });
    renderTabs();
  }

  // 顯示某個 session：已在畫面上就切過去；不在就換掉最久沒用的那格
  function show(id, slot) {
    const s = sessions.get(id);
    if (!s) return;
    if (s.popped) { qt.focusPopout(id); return; }
    touch(s);
    let i = slotOf(id);
    if (i < 0) { i = slot == null ? pickSlot() : slot; put(id, i); }
    activate(i, { zoom: autoZoom && !maximized, focus: true });
    renderTabs();
  }

  // 某格空出來 → 補上列表中最近用過、還沒顯示的終端
  function fillSlot(i) {
    let best = null;
    for (const id of order) {
      const s = sessions.get(id);
      if (s.popped || slotOf(id) >= 0) continue;
      if (!best || s.lastUsed > best.lastUsed) best = s;
    }
    if (best) put(best.id, i);
    else { slots[i] = null; refreshSlot(i); }
  }

  function closeSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    const proc = runningProc(s);
    if (!s.exited && proc && !confirm(`「${label(s)}」裡還在執行 ${proc}，確定要關掉嗎？`)) return;
    qt.kill(id);
    const i = slotOf(id);
    if (s.term) s.term.dispose();
    if (s.host) s.host.remove();
    sessions.delete(id);
    order.splice(order.indexOf(id), 1);
    if (i >= 0) { slots[i] = null; fillSlot(i); }
    renderTabs();
    const a = activeSession();
    if (a) a.term.focus();
  }

  function restart(id) {
    const s = sessions.get(id);
    if (!s || s.popped) return;
    s.exited = false;
    s.term.reset();
    qt.spawn(id, s.term.cols, s.term.rows, { cwd: s.cwd });
    const i = slotOf(id);
    if (i >= 0) refreshSlot(i);
    renderTabs();
    s.term.focus();
  }

  // ---------- 拉出成獨立視窗 / 收回 ----------
  // 拉出去：交給 Mac 的終端機 app
  async function handoff(id) {
    const s = sessions.get(id);
    if (!s || s.handingOff) return;
    const proc = runningProc(s);
    const isClaude = /claude/i.test(proc);
    if (isClaude && s.busy &&
        !confirm(`claude 正在做事，拉出去會中斷目前這一步。\n${termApp} 會在同一個資料夾接續同一段對話（claude --continue）。\n\n要繼續嗎？`)) return;
    if (proc && !isClaude &&
        !confirm(`這格正在執行 ${proc}，拉出去會把它結束。\n${termApp} 會在同一個資料夾開一個新視窗。\n\n要繼續嗎？`)) return;
    s.handingOff = true;
    const res = await qt.handoff(id, { cwd: s.cwd, resumeClaude: isClaude });
    if (!res || !res.ok) {
      s.handingOff = false;
      alert((res && res.error) || `打不開 ${termApp}`);
      return;
    }
    removeSession(id);
  }

  function removeSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    const i = slotOf(id);
    if (s.term) s.term.dispose();
    if (s.host) s.host.remove();
    sessions.delete(id);
    order.splice(order.indexOf(id), 1);
    if (i >= 0) { slots[i] = null; fillSlot(i); }
    renderTabs();
    activeSession()?.term?.focus();
  }

  function popout(id, atCursor) {
    const s = sessions.get(id);
    if (!s) return;
    if (toTerminal) { handoff(id); return; }
    if (s.popped) { qt.focusPopout(id); return; }
    const i = slotOf(id);
    const rect = (i >= 0 ? slotEls[i].el : grid).getBoundingClientRect();
    const payload = {
      name: label(s),
      cwd: s.cwd,
      serialized: s.serializer.serialize({ scrollback: SCROLLBACK_TRANSFER }),
      cols: s.term.cols,
      rows: s.term.rows,
      fontSize,
      exited: s.exited,
      atCursor,
      width: Math.max(700, Math.round(rect.width)),
      height: Math.max(450, Math.round(rect.height + 30))
    };
    s.term.dispose();
    s.host.remove();
    s.term = s.host = s.fit = s.serializer = s.gl = null;
    s.popped = true;
    s.busy = false;
    if (i >= 0) { slots[i] = null; fillSlot(i); }
    qt.popout(id, payload);
    renderTabs();
  }

  function dockFromPopout(id) {
    // 由獨立視窗那邊序列化後送回；這裡只要叫它收回
    qt.requestDock(id); // 獨立視窗會把畫面內容送回來，見 onDocked
  }

  qt.onDocked((id, serialized, exited) => {
    const s = sessions.get(id);
    if (!s) return;
    s.popped = false;
    s.exited = !!exited;
    attachTerm(s);
    if (serialized) s.term.write(serialized);
    show(id);
    qt.resize(id, s.term.cols, s.term.rows);
  });

  // ---------- 畫面更新 ----------
  // 放大方式：
  //  'font'   → 放大時只改字的大小，終端行列數不變 → 裡面的程式（claude）不會重畫、不會閃
  //  'resize' → 放大時改行列數（看得到更多內容，但每次切換 claude 都會重畫）
  const zoomMode = config.zoomMode === 'font' ? 'font' : 'resize';
  let base = null; // 四格平均時的大小與行列數 { w, h, cols, rows }

  function fitSlot(i) {
    const s = sessions.get(slots[i]);
    if (!s || !s.fit) return;
    const wrap = slotEls[i].wrap;
    const zoomedLayout = grid.classList.contains('zoomed') && !maximized;
    if (zoomMode === 'font' && zoomedLayout && base) {
      if (s.term.cols !== base.cols || s.term.rows !== base.rows) s.term.resize(base.cols, base.rows);
      const scale = Math.min(wrap.clientWidth / base.w, wrap.clientHeight / base.h) * 0.98;
      const fs = Math.max(6, Math.floor(fontSize * scale * 2) / 2);
      if (s.term.options.fontSize !== fs) s.term.options.fontSize = fs;
      return;
    }
    if (s.term.options.fontSize !== fontSize) s.term.options.fontSize = fontSize;
    safeFit(s.fit, wrap);
    if (!zoomedLayout && !maximized && wrap.clientWidth > 20) {
      base = { w: wrap.clientWidth, h: wrap.clientHeight, cols: s.term.cols, rows: s.term.rows };
    }
  }

  function refreshSlot(i) {
    const { el, title, cwd } = slotEls[i];
    const s = sessions.get(slots[i]);
    el.classList.toggle('empty', !s);
    el.classList.toggle('exited', !!(s && s.exited));
    title.textContent = s ? label(s) + (runningProc(s) ? ` · ${runningProc(s)}` : '') : '空格';
    cwd.textContent = s ? tilde(s.cwd) : '';
  }

  function activate(i, { zoom = false, focus = false } = {}) {
    if (i < 0) return;
    activeSlot = i;
    slotEls.forEach((x, k) => x.el.classList.toggle('active', k === i));
    if (zoom) applyZoom(lockedSlot != null ? lockedSlot : i);
    const s = sessions.get(slots[i]);
    if (focus && s && s.term) s.term.focus();
    renderTabs();
  }

  function applyZoom(i) {
    const r = Math.min(Math.max(config.zoomRatio, 0.5), 0.95);
    const col = i % 2, row = Math.floor(i / 2);
    const big = `${r}fr`, small = `${1 - r}fr`;
    setLayout(col === 0 ? `${big} ${small}` : `${small} ${big}`, row === 0 ? `${big} ${small}` : `${small} ${big}`);
    grid.classList.add('zoomed');
  }

  function setEqual() {
    setLayout('1fr 1fr', '1fr 1fr');
    grid.classList.remove('zoomed');
  }

  // 改版面：動畫期間不重算終端大小，動畫結束後 4 格一次算好
  function setLayout(cols, rows) {
    if (grid.style.gridTemplateColumns === cols && grid.style.gridTemplateRows === rows) return;
    grid.style.gridTemplateColumns = cols;
    grid.style.gridTemplateRows = rows;
    if (animMs === 0) { [0, 1, 2, 3].forEach(fitSlot); return; }
    animating = true;
    clearTimeout(animTimer);
    animTimer = setTimeout(endAnimation, animMs + 60);
  }

  function endAnimation() {
    clearTimeout(animTimer);
    if (!animating) return;
    animating = false;
    [0, 1, 2, 3].forEach(fitSlot);
  }

  function toggleMaximize() {
    maximized = !maximized;
    grid.classList.toggle('maximized', maximized);
    setTimeout(() => [0, 1, 2, 3].forEach(fitSlot), 30);
    activeSession()?.term?.focus();
  }

  function toggleLock(i) {
    if (i == null || i < 0) return;
    lockedSlot = lockedSlot === i ? null : i;
    slotEls.forEach((x, k) => {
      const on = k === lockedSlot;
      x.el.classList.toggle('locked', on);
      const btn = x.el.querySelector('.lock-btn');
      btn.title = on ? '解除鎖定 (⌘L)' : '鎖定放大這格 (⌘L)';
    });
    if (lockedSlot != null && !maximized) {
      applyZoom(lockedSlot);
      activate(lockedSlot, { focus: true });
    }
  }

  function setAuto(on) {
    autoZoom = on;
    badge.textContent = `自動放大：${on ? '開' : '關'}`;
    badge.classList.toggle('off', !on);
    if (!on && lockedSlot == null) setEqual();
  }
  badge.addEventListener('click', () => setAuto(!autoZoom));
  document.getElementById('new-btn').addEventListener('click', () => newSession({}));

  grid.addEventListener('transitionend', (e) => {
    if (e.target === grid) endAnimation();
  });
  document.documentElement.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    if (autoZoom && config.resetOnLeave && !maximized && lockedSlot == null) setEqual();
  });
  window.addEventListener('resize', () => [0, 1, 2, 3].forEach(fitSlot));

  // ---------- 上方終端列表 ----------
  function tabEl(id) {
    let t = tabsEl.querySelector(`.tab[data-id="${id}"]`);
    if (t) return t;
    t = document.createElement('div');
    t.className = 'tab';
    t.dataset.id = id;
    t.draggable = true;
    t.innerHTML = '<span class="tab-slot"></span><span class="tab-dot"></span><span class="tab-name"></span><span class="tab-proc"></span><span class="tab-close" title="關閉">×</span>';
    return t;
  }

  function renderTabs() {
    if (renaming) return;
    const want = new Set(order.map(String));
    tabsEl.querySelectorAll('.tab').forEach((t) => { if (!want.has(t.dataset.id)) t.remove(); });
    order.forEach((id, idx) => {
      const s = sessions.get(id);
      const t = tabEl(id);
      if (tabsEl.children[idx] !== t) tabsEl.insertBefore(t, tabsEl.children[idx] || null);
      const i = slotOf(id);
      t.classList.toggle('visible', i >= 0);
      t.classList.toggle('active', i >= 0 && i === activeSlot);
      t.classList.toggle('popped', s.popped);
      t.classList.toggle('busy', s.busy && !s.exited);
      t.classList.toggle('unread', s.unread && !s.busy);
      t.classList.toggle('exited', s.exited);
      t.querySelector('.tab-slot').textContent = s.popped ? '⧉' : i >= 0 ? String(i + 1) : '';
      t.querySelector('.tab-name').textContent = label(s);
      t.querySelector('.tab-proc').textContent = s.exited ? '已結束' : runningProc(s);
      t.title = `${label(s)}\n${tilde(s.cwd)}${runningProc(s) ? '\n執行中：' + runningProc(s) : ''}\n\n點一下：顯示在畫面上\n拖到某一格：放進那格\n拖到視窗外：${toTerminal ? `在 ${termApp} 開啟` : '拉出成獨立視窗'}\n雙擊名稱：改名`;
    });
  }

  tabsEl.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    const id = Number(t.dataset.id);
    if (e.target.classList.contains('tab-close')) closeSession(id);
    else show(id);
  });

  tabsEl.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.tab-name');
    if (!name) return;
    const id = Number(name.parentElement.dataset.id);
    const s = sessions.get(id);
    renaming = true;
    name.contentEditable = 'true';
    name.focus();
    document.getSelection().selectAllChildren(name);
    const done = (save) => {
      if (!renaming) return;
      renaming = false;
      name.contentEditable = 'false';
      if (save) s.name = name.textContent.trim();
      renderTabs();
      for (let i = 0; i < 4; i++) refreshSlot(i);
      if (s.popped) qt.setPopTitle(id, label(s));
    };
    name.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
    };
    name.onblur = () => done(true);
  });

  tabsEl.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    e.dataTransfer.setData('application/x-qt-session', t.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    t.classList.add('dragging');
  });
  tabsEl.addEventListener('dragend', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    t.classList.remove('dragging');
    popoutIfDroppedOutside(Number(t.dataset.id), e);
  });

  // 拖到視窗外放開 → 拉出成獨立視窗
  async function popoutIfDroppedOutside(id, e) {
    if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') return; // 放在某一格裡了
    if (await qt.cursorOutside()) popout(id, true);
  }

  // ---------- 來自 main 的事件 ----------
  qt.onData((id, data) => {
    const s = sessions.get(id);
    if (!s || !s.term) return;
    s.term.write(data);
    s.lastData = Date.now();
    if (!s.busy) { s.busy = true; s.unread = false; renderTabs(); }
  });

  // 輸出停下來 2 秒 → 不在畫面上的終端標成「有新內容」（例如 claude 做完了）
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const s of sessions.values()) {
      if (s.busy && now - s.lastData > 2000) {
        s.busy = false;
        if (slotOf(s.id) < 0 && !s.popped) s.unread = true;
        changed = true;
      }
    }
    if (changed) renderTabs();
  }, 700);

  qt.onExit((id) => {
    const s = sessions.get(id);
    if (!s) return;
    s.exited = true;
    s.busy = false;
    const i = slotOf(id);
    if (i >= 0) refreshSlot(i);
    renderTabs();
  });

  qt.onInfo((info) => {
    let changed = false;
    for (const [id, v] of Object.entries(info)) {
      const s = sessions.get(Number(id));
      if (!s) continue;
      if (v.cwd && v.cwd !== s.cwd) { s.cwd = v.cwd; changed = true; }
      if (v.proc !== s.proc) { s.proc = v.proc; changed = true; }
    }
    if (changed) {
      renderTabs();
      for (let i = 0; i < 4; i++) refreshSlot(i);
    }
  });

  // ---------- 選單 / 快捷鍵 ----------
  qt.onMenu(async (action, arg) => {
    const s = activeSession();
    switch (action) {
      case 'new': newSession({}); break;
      case 'close': if (s) closeSession(s.id); break;
      case 'popout': if (s) popout(s.id, false); break;
      case 'restart': if (s) restart(s.id); break;
      case 'prev':
      case 'next': {
        if (!order.length) break;
        const cur = s ? order.indexOf(s.id) : -1;
        const step = action === 'next' ? 1 : -1;
        show(order[(cur + step + order.length) % order.length]);
        break;
      }
      case 'copy': { const sel = s?.term?.getSelection(); if (sel) qt.copy(sel); break; }
      case 'paste': {
        const text = await qt.paste();
        if (text && s && !s.exited) s.term.paste(text);
        break;
      }
      case 'selectAll': s?.term?.selectAll(); break;
      case 'clear': s?.term?.clear(); break;
      case 'toggleAuto': setAuto(!autoZoom); break;
      case 'equal': if (maximized) toggleMaximize(); if (lockedSlot != null) toggleLock(lockedSlot); setEqual(); break;
      case 'lock': toggleLock(activeSlot); break;
      case 'maximize': toggleMaximize(); break;
      case 'focus': activate(arg, { zoom: autoZoom && !maximized && slots[arg] != null, focus: true }); break;
      case 'fontUp':
      case 'fontDown':
        fontSize = Math.min(28, Math.max(8, fontSize + (action === 'fontUp' ? 1 : -1)));
        for (const x of sessions.values()) if (x.term) x.term.options.fontSize = fontSize;
        // 字級變了，四格平均時的行列數也要重算
        if (maximized) toggleMaximize();
        setEqual();
        if (!animating) [0, 1, 2, 3].forEach(fitSlot);
        break;
    }
  });

  // ---------- 啟動 ----------
  requestAnimationFrame(() => {
    const startup = Array.isArray(config.startup) && config.startup.length ? config.startup : [{}];
    startup.forEach((o, k) => newSession(o || {}, k < 4 ? k : undefined, { hidden: k >= 4 }));
    setEqual();
    activate(0, { focus: true });
  });

  // 給測試用
  window.__qt = {
    sessions, slots, order, show, popout, moveToSlot, newSession, closeSession, showChooser,
    toggleLock, handoff,
    get state() { return { activeSlot, maximized, autoZoom, lockedSlot, slots: [...slots], order: [...order] }; }
  };
})();
