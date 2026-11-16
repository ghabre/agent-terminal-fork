'use strict';
/* global Terminal, FitAddon, SearchAddon, WebLinksAddon */

const ipc = window.api;
const $ = (sel) => document.querySelector(sel);

const THEME = {
  background: '#111317',
  foreground: '#d6d9de',
  cursor: '#d6d9de',
  cursorAccent: '#111317',
  selectionBackground: '#3a4f72',
  black: '#1b1e24', red: '#ef6b6b', green: '#7bc27b', yellow: '#e5c07b',
  blue: '#5b9dff', magenta: '#c49cf2', cyan: '#56c6d6', white: '#d6d9de',
  brightBlack: '#5f6570', brightRed: '#ff8a8a', brightGreen: '#98d998', brightYellow: '#f0d595',
  brightBlue: '#82b5ff', brightMagenta: '#d7b8ff', brightCyan: '#7fdbe8', brightWhite: '#ffffff',
};

const AGENT_KEYS = ['claude', 'codex', 'cursor', 'shell'];
const BADGE = { claude: 'C', codex: 'X', cursor: 'Cu', shell: '>' };

const state = {
  settings: null,
  workspace: null,
  agents: {},
  tabs: [],
  activeId: null,
  historyScope: 'tab', // 'tab' | 'folder' | 'all'
  historyAgent: 'all',
  historyQuery: '',
  historyFolder: null, // folder picked in the Folder view; null follows the active tab
  viewer: null,
  nextTabId: 1,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function agentColor(agent) {
  return (state.agents[agent] && state.agents[agent].color) || '#8a8f98';
}

function agentLabel(agent) {
  return (state.agents[agent] && state.agents[agent].label) || agent;
}

// Agents switched on in Setup, in menu order.
function enabledAgents() {
  return AGENT_KEYS.filter((a) => !state.agents[a] || state.agents[a].enabled !== false);
}

function recordTitle(rec) {
  if (!rec) return 'New session';
  return rec.customTitle || rec.title || `${agentLabel(rec.agent)} session`;
}

function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function closePopovers() {
  $('#new-menu').classList.add('hidden');
  $('#ctx').classList.add('hidden');
}

function showContextMenu(x, y, items) {
  const ctx = $('#ctx');
  ctx.replaceChildren(
    ...items.map((it) =>
      it === '-'
        ? el('hr')
        : el('button', { onclick: () => { closePopovers(); it.run(); } }, el('span', {}, it.label), it.hint ? el('small', {}, it.hint) : null)
    )
  );
  ctx.classList.remove('hidden');
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

function quotePath(p) {
  return /[\s&()^'"]/.test(p) ? `"${p}"` : p;
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function createTab({ agent, cwd, record, mode, chain, activate = true }) {
  const id = `t${state.nextTabId++}`;
  const host = el('div', { class: 'term-host hidden-tab' });
  $('#terminals').append(host);

  const term = new Terminal({
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    scrollback: state.settings.scrollback,
    theme: THEME,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    windowsPty: { backend: 'conpty' },
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
  term.open(host);

  const tab = {
    id, agent, cwd, mode: mode || (record ? 'resume' : 'new'),
    record: record || null, term, fit, search, host,
    started: false, running: false, exitCode: null, dirty: false, lastSnapshot: 0,
    node: null, exitBar: null, input: newInput(),
    // Every conversation this tab has gone through (/clear, /new, /resume), oldest first.
    chain: [...new Set([...(chain || []), ...(record ? [record.id] : [])])],
    // Where the current conversation's output starts in the buffer (null: the top).
    snapMarker: null,
    enterMarks: [],
  };
  state.tabs.push(tab);

  term.onData((data) => {
    if (tab.running) {
      const enter = data.includes('\r') && !data.startsWith('\x1b[200~');
      // Save the transcript before the agent acts on Enter: /clear wipes the screen,
      // and the conversation it ends should keep what was on it.
      if (enter) snapshot(tab, true);
      trackInput(tab, data);
      ipc.write(tab.id, data);
      if (enter) markEnter(tab);
    } else if (tab.started && (data === '\r' || data === '\n')) restartTab(tab);
  });
  term.onResize(({ cols, rows }) => tab.running && ipc.resize(tab.id, cols, rows));
  term.onTitleChange(() => renderTabs());
  term.attachCustomKeyEventHandler((e) => handleTermKey(tab, e));

  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      ipc.clipboardWrite(term.getSelection());
      term.clearSelection();
      toast('Copied');
    } else {
      pasteInto(tab, true);
    }
  });
  host.addEventListener('dragover', (e) => e.preventDefault());
  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => ipc.pathForFile(f)).filter(Boolean);
    if (paths.length && tab.running) ipc.write(tab.id, paths.map(quotePath).join(' ') + ' ');
    term.focus();
  });

  renderTabs();
  if (activate) activateTab(id);
  saveState();
  return tab;
}

async function startTab(tab) {
  if (tab.running) return;
  tab.started = true;
  tab.exitCode = null;
  tab.input = newInput();
  if (tab.exitBar) {
    tab.exitBar.remove();
    tab.exitBar = null;
  }
  try {
    tab.fit.fit();
  } catch (_) { /* host not laid out yet */ }
  // A tab restarted in place still shows the last run, which history already holds.
  setSnapMarker(tab, hasOutput(tab) ? tab.term.registerMarker(0) : null);
  try {
    const res = await ipc.start({
      tabId: tab.id,
      agent: tab.agent,
      cwd: tab.cwd,
      recordId: tab.record && tab.record.id,
      mode: tab.mode,
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
    tab.record = res.record;
    if (!tab.chain.includes(res.record.id)) tab.chain.push(res.record.id);
    tab.cwd = res.record.cwd;
    tab.running = true;
    tab.mode = 'resume';
    ipc.resize(tab.id, tab.term.cols, tab.term.rows);
  } catch (err) {
    tab.term.writeln(`\x1b[31m${err.message}\x1b[0m`);
    tab.term.writeln('\x1b[2mPress Enter to retry, or close this tab.\x1b[0m');
  }
  renderTabs();
  renderStatus();
  renderHistory();
  saveState();
}

function restartTab(tab) {
  tab.term.write('\r\n');
  startTab(tab);
}

function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  closeViewer();
  state.activeId = id;
  tab.node && tab.node.classList.remove('activity');
  tab.activity = false;
  for (const t of state.tabs) t.host.classList.toggle('hidden-tab', t.id !== id);
  // Not requestAnimationFrame: Chromium pauses it while the window is hidden or
  // occluded, which would leave a restored tab's agent unstarted until it is painted.
  setTimeout(() => {
    try {
      tab.fit.fit();
    } catch (_) { /* ignore */ }
    if (!tab.started) startTab(tab);
    tab.term.focus();
  }, 0);
  renderTabs();
  renderStatus();
  // The Folder view follows the active tab's folder.
  state.historyFolder = null;
  if (state.historyScope !== 'all') renderHistory();
  saveState();
}

async function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  snapshot(tab, true);
  if (tab.running) await ipc.kill(tab.id).catch(() => {});
  tab.term.dispose();
  tab.host.remove();
  state.tabs.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    state.activeId = null;
    if (next) activateTab(next.id);
  }
  renderTabs();
  renderStatus();
  renderHistory();
  saveState();
}

function cycleTab(delta) {
  if (!state.tabs.length) return;
  const idx = state.tabs.findIndex((t) => t.id === state.activeId);
  const next = state.tabs[(idx + delta + state.tabs.length) % state.tabs.length];
  activateTab(next.id);
}

function tabLabel(tab) {
  const rec = tab.record;
  const where = rec ? rec.cwdLabel : labelForCwd(tab.cwd);
  const title = rec && (rec.customTitle || rec.title);
  return { main: title || agentLabel(tab.agent), sub: where };
}

function labelForCwd(cwd) {
  if (!cwd) return state.workspace && state.workspace.root ? 'workspace' : '';
  const d = state.workspace && state.workspace.dirs.find((x) => sameCwd(x.path, cwd));
  return d ? d.name : cwd.split(/[\\/]/).pop();
}

function renderTabs() {
  const wrap = $('#tabs');
  wrap.replaceChildren();
  for (const tab of state.tabs) {
    const { main, sub } = tabLabel(tab);
    const node = el(
      'div',
      {
        class: `tab${tab.id === state.activeId ? ' active' : ''}${tab.started && !tab.running ? ' exited' : ''}${tab.activity ? ' activity' : ''}`,
        style: `--c:${agentColor(tab.agent)}`,
        role: 'tab',
        title: `${agentLabel(tab.agent)} · ${tab.cwd || ''}`,
        draggable: 'true',
        onmousedown: (e) => {
          if (e.button === 0 && !e.target.closest('.close')) activateTab(tab.id);
          if (e.button === 1) {
            e.preventDefault();
            closeTab(tab.id);
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          tabMenu(tab, e.clientX, e.clientY);
        },
        ondragstart: (e) => {
          e.dataTransfer.setData('text/tab', tab.id);
          node.classList.add('dragging');
        },
        ondragend: () => node.classList.remove('dragging'),
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          const from = e.dataTransfer.getData('text/tab');
          if (!from || from === tab.id) return;
          const a = state.tabs.findIndex((t) => t.id === from);
          const [moved] = state.tabs.splice(a, 1);
          state.tabs.splice(state.tabs.indexOf(tab), 0, moved);
          renderTabs();
          saveState();
        },
      },
      el('span', { class: 'badge' }, BADGE[tab.agent] || '?'),
      el('span', { class: 'label' }, main, el('small', {}, sub)),
      el('span', { class: 'busy' }),
      el(
        'button',
        { class: 'close', title: 'Close (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); closeTab(tab.id); } },
        el('span', {}, '✕')
      )
    );
    tab.node = node;
    wrap.append(node);
  }
  $('#empty').classList.toggle('hidden', state.tabs.length > 0);
  const active = wrap.querySelector('.tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function tabMenu(tab, x, y) {
  showContextMenu(x, y, [
    { label: 'Rename…', run: () => renameRecord(tab.record, tab) },
    { label: tab.running ? 'Restart (resume)' : 'Resume', run: async () => { if (tab.running) await ipc.kill(tab.id); tab.running = false; restartTab(tab); } },
    { label: `New ${agentLabel(tab.agent)} here`, run: () => createTab({ agent: tab.agent, cwd: tab.cwd }) },
    { label: 'Duplicate folder in…', run: () => openNewMenu(tab.cwd) },
    '-',
    { label: 'Open folder', run: () => ipc.openPath(tab.cwd) },
    { label: 'Prompt history', hint: 'Ctrl+Shift+H', run: () => { activateTab(tab.id); state.historyScope = 'tab'; toggleHistory(true); } },
    { label: 'Sessions in this folder', run: () => { state.historyScope = 'folder'; state.historyFolder = tab.cwd; state.historyAgent = tab.agent; toggleHistory(true); } },
    { label: 'Save transcript…', run: () => { snapshot(tab, true); tab.record && ipc.historyExport(tab.record.id); } },
    '-',
    { label: 'Close', hint: 'Ctrl+Shift+W', run: () => closeTab(tab.id) },
  ]);
}

function hasOutput(tab) {
  const buf = tab.term.buffer.normal;
  return buf.length > tab.term.rows || buf.cursorY > 0 || buf.cursorX > 0;
}

function setSnapMarker(tab, marker) {
  if (tab.snapMarker && tab.snapMarker !== marker && !tab.enterMarks.some((m) => m.marker === tab.snapMarker)) tab.snapMarker.dispose();
  tab.snapMarker = marker;
}

// Remembers where the cursor was at each Enter, so a conversation the agent starts
// on that Enter can be cut out of the scrollback from there.
function markEnter(tab) {
  const marker = tab.term.registerMarker(0);
  if (!marker) return;
  tab.enterMarks.push({ t: Date.now(), marker });
  while (tab.enterMarks.length > 4) {
    const old = tab.enterMarks.shift();
    if (old.marker !== tab.snapMarker) old.marker.dispose();
  }
}

// Plain-text copy of the current conversation's part of the scrollback; this is what
// History shows as "Text".
function snapshot(tab, force) {
  if (!tab.record || !tab.started) return;
  if (!force && !tab.dirty) return;
  tab.dirty = false;
  tab.lastSnapshot = Date.now();
  const buf = tab.term.buffer.normal.length > 1 ? tab.term.buffer.normal : tab.term.buffer.active;
  const m = tab.snapMarker;
  // A disposed marker was trimmed off the top, so everything left is newer than it.
  const from = m && !m.isDisposed && m.line >= 0 ? Math.min(m.line, buf.length) : 0;
  const lines = [];
  for (let i = from; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return;
  // Most of the scrollback is gone: the screen was cleared. Keep the transcript saved so
  // far and append from here instead of overwriting it with the shorter screen.
  const last = tab.lastSnap;
  const cleared = !!last && last.recordId === tab.record.id && last.from === from && last.lines > 40 && lines.length < last.lines / 2;
  tab.lastSnap = { recordId: tab.record.id, from, lines: lines.length };
  return ipc.historySnapshot(tab.record.id, lines.join('\n') + '\n', cleared).catch(() => {});
}

// ---------------------------------------------------------------------------
// prompt capture
// ---------------------------------------------------------------------------
// Rebuilds the line being typed from the keystrokes sent to the pty, so each tab keeps
// a history of the prompts / commands sent from it. Edits made by the program itself
// (Up/Down history recall, Tab completion in a shell) can't be followed from the input
// alone: such a line is read back from the screen in a shell tab and skipped in an agent tab.

function newInput() {
  return { text: '', cur: 0, lost: false, lastEsc: 0 };
}

function insertInput(inp, str) {
  inp.text = inp.text.slice(0, inp.cur) + str + inp.text.slice(inp.cur);
  inp.cur += str.length;
}

function trackInput(tab, data) {
  const inp = tab.input;
  let i = 0;
  while (i < data.length) {
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i + 6);
      insertInput(inp, data.slice(i + 6, end < 0 ? data.length : end).replace(/\r\n?/g, '\n'));
      i = end < 0 ? data.length : end + 6;
      continue;
    }
    const ch = data[i];
    if (ch === '\x1b') {
      // CSI (arrows, Home/End/Delete, focus and mouse reports), SS3 arrows, or Alt+key.
      const m = /^\x1b(?:\[([0-9;<>?]*)([~@-Z\\a-z^_`{|}])|O([A-Za-z])|([\s\S]))?/.exec(data.slice(i));
      i += m[0].length;
      const key = m[2] === '~' ? m[1] : m[2] || m[3];
      if (key === 'D') inp.cur = Math.max(0, inp.cur - 1);
      else if (key === 'C') inp.cur = Math.min(inp.text.length, inp.cur + 1);
      else if (key === 'H' || key === '1' || key === '7') inp.cur = 0;
      else if (key === 'F' || key === '4' || key === '8') inp.cur = inp.text.length;
      else if (key === '3') inp.text = inp.text.slice(0, inp.cur) + inp.text.slice(inp.cur + 1);
      else if (key === 'A' || key === 'B') inp.lost = true;
      else if (m[4] === '\r') insertInput(inp, '\n'); // Alt+Enter
      else if (m[4]) inp.lost = true; // Alt+key: word moves and the like
      else if (m[0] === '\x1b') {
        // A double Esc clears the prompt in Claude and Codex.
        const now = Date.now();
        if (now - inp.lastEsc < 800) Object.assign(inp, newInput());
        else inp.lastEsc = now;
      }
      continue;
    }
    i++;
    if (ch === '\r') commitInput(tab);
    else if (ch === '\x7f' || ch === '\b') {
      if (inp.cur > 0) {
        inp.text = inp.text.slice(0, inp.cur - 1) + inp.text.slice(inp.cur);
        inp.cur--;
      }
    } else if (ch === '\x03') Object.assign(inp, newInput());
    else if (ch === '\x15') {
      inp.text = inp.text.slice(inp.cur);
      inp.cur = 0;
    } else if (ch === '\x0b') inp.text = inp.text.slice(0, inp.cur);
    else if (ch === '\x17') {
      const before = inp.text.slice(0, inp.cur).replace(/\S+\s*$/, '');
      inp.text = before + inp.text.slice(inp.cur);
      inp.cur = before.length;
    } else if (ch === '\x01') inp.cur = 0;
    else if (ch === '\x05') inp.cur = inp.text.length;
    else if (ch === '\n') insertInput(inp, '\n');
    else if (ch === '\t') {
      if (tab.agent === 'shell') inp.lost = true;
    } else if (ch >= ' ') insertInput(inp, ch);
  }
}

// The command on the shell prompt line under the cursor, without the "PS C:\...> " prefix.
function readShellLine(tab) {
  const buf = tab.term.buffer.active;
  let y = buf.baseY + buf.cursorY;
  let line = buf.getLine(y);
  if (!line) return null;
  let text = line.translateToString(true);
  while (line.isWrapped && y > 0) {
    line = buf.getLine(--y);
    text = line.translateToString(false) + text;
  }
  const m = /^PS [^>]*>\s?([\s\S]*)$/.exec(text);
  return m ? m[1] : null;
}

function commitInput(tab) {
  const inp = tab.input;
  tab.input = newInput();
  let text = inp.lost ? (tab.agent === 'shell' ? readShellLine(tab) : null) : inp.text;
  if (!text) return;
  text = text.trim();
  // A lone key is a menu answer (1/2/3, y/n) rather than a prompt.
  if (!text || (tab.agent !== 'shell' && text.length < 2)) return;
  ipc.addPrompt(tab.id, text);
}

// ---------------------------------------------------------------------------
// keyboard & clipboard
// ---------------------------------------------------------------------------

async function pasteInto(tab, fromMouse) {
  const clip = await ipc.clipboardRead();
  if (clip.text) tab.term.paste(clip.text);
  // With only an image on the clipboard, let the agent read it itself (Ctrl+V).
  else if (clip.hasImage && !fromMouse && tab.running) ipc.write(tab.id, '\x16');
  tab.term.focus();
}

function handleTermKey(tab, e) {
  if (e.type !== 'keydown') return true;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  const k = e.key.toLowerCase();

  if (ctrl && !e.shiftKey && k === 'c' && tab.term.hasSelection()) {
    ipc.clipboardWrite(tab.term.getSelection());
    tab.term.clearSelection();
    return false;
  }
  if (ctrl && e.shiftKey && k === 'c') {
    if (tab.term.hasSelection()) ipc.clipboardWrite(tab.term.getSelection());
    return false;
  }
  if (ctrl && k === 'v') {
    e.preventDefault();
    pasteInto(tab, false);
    return false;
  }
  // Multi-line prompts: agents read ESC+CR (Claude, Cursor) or LF (Codex) as a newline.
  if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter' && tab.running) {
    ipc.write(tab.id, tab.agent === 'codex' ? '\n' : '\x1b\r');
    insertInput(tab.input, '\n');
    return false;
  }
  if (isAppShortcut(e)) return false;
  return true;
}

function isAppShortcut(e) {
  const ctrl = e.ctrlKey && !e.altKey;
  const k = e.key.toLowerCase();
  if (ctrl && e.key === 'Tab') return true;
  if (ctrl && (e.key === 'PageUp' || e.key === 'PageDown')) return true;
  if (ctrl && e.shiftKey && ['t', 'w', 'h', 'f', 'i', ',', '1', '2', '3', '4', '!', '@', '#', '$'].includes(k)) return true;
  if (ctrl && !e.shiftKey && ['=', '+', '-', '0'].includes(e.key)) return true;
  if (ctrl && e.shiftKey && /^Digit[1-4]$/.test(e.code)) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal').classList.contains('hidden')) return closeModal();
    if (!$('#new-menu').classList.contains('hidden') || !$('#ctx').classList.contains('hidden')) return closePopovers();
    if (state.viewer) return closeViewer();
    if (!$('#find').classList.contains('hidden')) return closeFind();
  }
  if (!isAppShortcut(e)) return;
  e.preventDefault();
  const k = e.key.toLowerCase();
  if (e.key === 'Tab') return cycleTab(e.shiftKey ? -1 : 1);
  if (e.key === 'PageUp') return cycleTab(-1);
  if (e.key === 'PageDown') return cycleTab(1);
  if (e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
    const agent = AGENT_KEYS[Number(e.code.slice(5)) - 1];
    if (!enabledAgents().includes(agent)) return toast(`${agentLabel(agent)} is switched off (Settings → Workspaces & agents)`);
    const cur = activeTab();
    return createTab({ agent, cwd: cur ? cur.cwd : defaultCwd() });
  }
  if (e.shiftKey && k === 't') return openNewMenu();
  if (e.shiftKey && k === 'w') return state.activeId && closeTab(state.activeId);
  if (e.shiftKey && k === 'h') return toggleHistory();
  if (e.shiftKey && k === 'f') return openFind();
  if (e.shiftKey && k === 'i') return ipc.devtools();
  if (e.shiftKey && k === ',') return openSettings();
  if (e.key === '=' || e.key === '+') return setFontSize(state.settings.fontSize + 1);
  if (e.key === '-') return setFontSize(state.settings.fontSize - 1);
  if (e.key === '0') return setFontSize(14);
});

function setFontSize(size) {
  size = Math.max(8, Math.min(32, size));
  state.settings.fontSize = size;
  for (const t of state.tabs) t.term.options.fontSize = size;
  fitActive();
  ipc.saveSettings({ fontSize: size });
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

function openFind() {
  if (!activeTab()) return;
  $('#find').classList.remove('hidden');
  const inp = $('#find-input');
  inp.focus();
  inp.select();
}
function closeFind() {
  $('#find').classList.add('hidden');
  const t = activeTab();
  if (t) {
    t.search.clearDecorations();
    t.term.focus();
  }
}
function findStep(back) {
  const t = activeTab();
  const q = $('#find-input').value;
  if (!t || !q) return;
  const opts = { decorations: { matchOverviewRuler: '#e5c07b', activeMatchColorOverviewRuler: '#5b9dff', matchBackground: '#5a4a1f', activeMatchBackground: '#3a4f72' } };
  const hit = back ? t.search.findPrevious(q, opts) : t.search.findNext(q, opts);
  $('#find-input').style.borderColor = hit ? '' : 'var(--danger)';
}
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findStep(e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('#find-input').addEventListener('input', () => findStep(false));
$('#find-next').onclick = () => findStep(false);
$('#find-prev').onclick = () => findStep(true);
$('#find-close').onclick = closeFind;

// ---------------------------------------------------------------------------
// new tab menu
// ---------------------------------------------------------------------------

function defaultCwd() {
  return (state.workspace && state.workspace.root) || null;
}

// One group per workspace folder: the folder itself, then the Git repositories in it.
function fillCwdSelect(select, selected) {
  select.replaceChildren();
  const ws = state.workspace;
  const branch = (d) => (d.branch ? ' · ' + d.branch : '');
  if (ws && ws.dirs.length) {
    for (const rootDir of ws.dirs.filter((d) => d.kind === 'root')) {
      const group = el('optgroup', { label: rootDir.path });
      group.append(el('option', { value: rootDir.path }, `${rootDir.name} (workspace)${branch(rootDir)}`));
      for (const d of ws.dirs.filter((x) => x.kind === 'repo' && x.root === rootDir.root)) {
        group.append(el('option', { value: d.path }, `${d.name}${branch(d)}`));
      }
      select.append(group);
    }
  }
  if (selected && ![...select.options].some((o) => o.value.toLowerCase() === selected.toLowerCase())) {
    select.append(el('option', { value: selected }, selected));
  }
  if (!select.options.length) select.append(el('option', { value: '' }, 'Home folder'));
  if (selected) {
    const opt = [...select.options].find((o) => o.value.toLowerCase() === selected.toLowerCase());
    if (opt) opt.selected = true;
  }
}

function openNewMenu(cwd) {
  const menu = $('#new-menu');
  const cur = activeTab();
  fillCwdSelect($('#new-cwd'), cwd || (cur && cur.cwd) || defaultCwd());
  const list = $('#new-agents');
  list.replaceChildren();
  enabledAgents().forEach((agent) => {
    const i = AGENT_KEYS.indexOf(agent);
    const info = state.agents[agent] || { available: false, label: agent };
    const go = (mode) => {
      closePopovers();
      createTab({ agent, cwd: $('#new-cwd').value || null, mode });
    };
    list.append(
      el(
        'div',
        { class: `agent-row${info.available ? '' : ' unavailable'}`, style: `--c:${agentColor(agent)}` },
        el('span', { class: 'badge' }, BADGE[agent]),
        el(
          'button',
          { class: 'main-btn', onclick: () => go('new'), title: info.available ? info.path || '' : 'Not found. Set its command in Settings → Workspaces & agents.' },
          el('b', {}, info.label),
          el('small', {}, info.available ? `New session · Ctrl+Shift+${i + 1}` : 'Not found · set its path in Setup')
        ),
        agent !== 'shell'
          ? el(
              'div',
              { class: 'alt' },
              el('button', { class: 'small-btn', title: 'Continue the most recent conversation in this folder', onclick: () => go('continue') }, 'Last'),
              el('button', { class: 'small-btn', title: "Open the agent's own session picker", onclick: () => go('picker') }, 'Pick…')
            )
          : null
      )
    );
  });
  menu.classList.remove('hidden');
  const btn = $('#btn-new').getBoundingClientRect();
  menu.style.left = Math.min(btn.left, window.innerWidth - 350) + 'px';
}

$('#btn-new').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#new-menu').classList.contains('hidden')) openNewMenu();
  else closePopovers();
});
$('#new-browse').addEventListener('click', async () => {
  const dir = await ipc.pickFolder();
  if (dir) fillCwdSelect($('#new-cwd'), dir);
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('#btn-new')) closePopovers();
});

// ---------------------------------------------------------------------------
// history panel
// ---------------------------------------------------------------------------

function toggleHistory(force) {
  const side = $('#history');
  const show = force === undefined ? side.classList.contains('hidden') : force;
  side.classList.toggle('hidden', !show);
  $('#btn-history').classList.toggle('on', show);
  if (show) renderHistory();
  fitActive();
}

function dayKey(ms) {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const sameCwd = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The folder shown in the Folder view: the one picked there, else the active tab's.
function historyFolderCwd() {
  const tab = activeTab();
  return state.historyFolder || (tab && tab.cwd) || defaultCwd();
}

let historyRender = 0;
async function renderHistory() {
  if ($('#history').classList.contains('hidden')) return;
  const token = ++historyRender;
  const scope = state.historyScope;
  for (const b of document.querySelectorAll('#history-scope button')) b.classList.toggle('on', b.dataset.scope === scope);
  $('#history-filter').classList.toggle('hidden', scope === 'tab');
  $('#history-tabhead').classList.toggle('hidden', scope !== 'tab');
  $('#history-folder-row').classList.toggle('hidden', scope !== 'folder');
  $('#history-search').placeholder =
    scope === 'tab' ? 'Search prompts in this tab' : scope === 'folder' ? 'Search sessions in this folder' : 'Search title, folder or id';
  if (scope === 'tab') return renderTabPrompts(token);
  for (const b of document.querySelectorAll('#history-filter button')) b.classList.toggle('on', b.dataset.agent === state.historyAgent);

  const cwd = scope === 'folder' ? historyFolderCwd() : null;
  if (scope === 'folder') renderFolderRow(token, cwd);
  let recs = await ipc.historyList({ agent: state.historyAgent, cwd });
  if (token !== historyRender) return;
  const q = state.historyQuery.trim().toLowerCase();
  if (q) {
    recs = recs.filter((r) =>
      [recordTitle(r), r.cwd, r.cwdLabel, r.nativeId, r.branch].some((v) => v && String(v).toLowerCase().includes(q))
    );
  }
  const list = $('#history-list');
  list.replaceChildren();
  if (!recs.length) {
    const msg = q
      ? 'No matching sessions.'
      : scope === 'folder'
        ? 'No sessions in this folder yet. Every conversation started here is recorded.'
        : 'No sessions yet. Every tab you open is recorded here.';
    list.append(el('div', { class: 'h-empty' }, msg));
    return;
  }
  const groups = new Map();
  for (const r of recs) {
    const key = dayKey(r.lastActiveAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, items] of groups) {
    list.append(el('div', { class: 'h-group' }, key));
    for (const r of items) list.append(historyItem(r, { hideFolder: scope === 'folder' }));
  }
}

// Folder picker: workspace folders first, then any other folder that has history.
let importCache = { cwd: null, at: 0, items: [] };
async function renderFolderRow(token, cwd) {
  const folders = await ipc.historyFolders();
  if (token !== historyRender) return;
  const select = $('#history-folder-select');
  const counts = new Map(folders.map((f) => [f.cwd.toLowerCase(), f]));
  const opts = [];
  const seen = new Set();
  const add = (path, label) => {
    const key = path.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const f = [...counts.values()].find((x) => sameCwd(x.cwd, path));
    opts.push(el('option', { value: path }, `${label}${f ? ` · ${f.count}` : ''}`));
  };
  const ws = state.workspace;
  if (ws && ws.dirs) {
    for (const d of ws.dirs) add(d.path, d.kind === 'root' ? `${d.name} (workspace)` : d.name);
  }
  for (const f of folders) add(f.cwd, f.label || f.cwd);
  if (cwd) add(cwd, labelForCwd(cwd));
  select.replaceChildren(...opts);
  const cur = [...select.options].find((o) => sameCwd(o.value, cwd));
  if (cur) cur.selected = true;

  // Conversations the agents have for this folder that history does not list yet.
  const btn = $('#history-import');
  if (!cwd) return btn.classList.add('hidden');
  if (!sameCwd(importCache.cwd, cwd) || Date.now() - importCache.at > 30000) {
    importCache = { cwd, at: Date.now(), items: [] };
    importCache.items = await ipc.historyImportable(cwd).catch(() => []);
  }
  if (token !== historyRender) return;
  const n = importCache.items.length;
  btn.classList.toggle('hidden', !n);
  btn.textContent = `Import ${n}`;
  btn.title = n
    ? `Add ${plural(n, 'conversation')} found in the agents' own stores for this folder:\n` +
      importCache.items.slice(0, 12).map((c) => `• ${agentLabel(c.agent)}: ${c.title || c.id}`).join('\n')
    : '';
}

$('#history-folder-select').addEventListener('change', (e) => {
  state.historyFolder = e.target.value;
  renderHistory();
});
$('#history-import').addEventListener('click', async () => {
  const cwd = historyFolderCwd();
  try {
    const n = await ipc.historyImport(cwd);
    importCache = { cwd: null, at: 0, items: [] };
    toast(`Imported ${plural(n, 'conversation')}`);
  } catch (err) {
    toast(err.message);
  }
  renderHistory();
});

async function renderTabPrompts(token) {
  const tab = activeTab();
  const head = $('#history-tabhead');
  const list = $('#history-list');
  if (!tab) {
    head.replaceChildren();
    list.replaceChildren(el('div', { class: 'h-empty' }, 'Open a tab to see the prompts sent from it.'));
    return;
  }
  const chain = tab.chain.length ? tab.chain : tab.record ? [tab.record.id] : [];
  const [all, convs] = await Promise.all([
    chain.length ? ipc.historyPrompts(chain) : [],
    chain.length > 1 ? ipc.historyGet(chain) : [],
  ]);
  if (token !== historyRender) return;
  const { main, sub } = tabLabel(tab);
  head.style.setProperty('--c', agentColor(tab.agent));
  head.replaceChildren(
    el('span', { class: 'dot' }),
    el('div', { class: 'th-text' },
      el('div', { class: 't' }, main),
      el('div', { class: 'm' }, [
        agentLabel(tab.agent),
        sub,
        convs.length > 1 ? plural(convs.length, 'conversation') : null,
        plural(all.length, 'prompt'),
      ].filter(Boolean).join(' · '))),
    all.length
      ? el('button', {
          class: 'small-btn',
          title: 'Copy every prompt sent from this tab',
          onclick: () => {
            ipc.clipboardWrite(all.map((p) => p.text).join(tab.agent === 'shell' ? '\n' : '\n\n'));
            toast(`Copied ${all.length} prompts`);
          },
        }, 'Copy all')
      : null
  );

  const q = state.historyQuery.trim().toLowerCase();
  const items = (q ? all.filter((p) => p.text.toLowerCase().includes(q)) : all).slice().reverse();
  list.replaceChildren();

  // Every conversation this tab went through (/clear, /new, /resume), newest first.
  const byId = new Map(convs.map((r) => [r.id, r]));
  if (convs.length > 1 && !q) {
    list.append(el('div', { class: 'h-group' }, 'Conversations in this tab'));
    for (const id of chain.slice().reverse()) {
      const r = byId.get(id);
      if (r) list.append(historyItem(r, { hideFolder: true, current: tab.record && tab.record.id === id }));
    }
  }

  if (!items.length) {
    list.append(el('div', { class: 'h-empty' }, q ? 'No matching prompts.' : 'Nothing sent from this tab yet. Every prompt or command you enter is recorded here.'));
    return;
  }
  let group = null;
  let conv = null;
  for (const p of items) {
    const key = dayKey(p.t);
    if (key !== group) {
      group = key;
      conv = null;
      list.append(el('div', { class: 'h-group' }, key));
    }
    if (convs.length > 1 && p.recordId !== conv) {
      conv = p.recordId;
      const r = byId.get(conv);
      list.append(el('div', { class: 'h-conv', style: `--c:${agentColor(tab.agent)}` }, r ? recordTitle(r) : 'Conversation'));
    }
    list.append(promptItem(tab, p));
  }
}

function promptItem(tab, p) {
  const insert = (send) => {
    if (!tab.running) return toast('This tab is not running. Resume it first.');
    tab.term.paste(p.text);
    // Give the agent a moment to take the paste before Enter.
    if (send) setTimeout(() => tab.running && sendEnter(tab), 60);
    tab.term.focus();
  };
  return el(
    'div',
    {
      class: 'p-item',
      title: `${new Date(p.t).toLocaleString()}\nClick to insert · double-click to send`,
      onclick: (e) => !e.target.closest('.acts') && e.detail === 1 && insert(false),
      // The first click of the double-click already inserted the text.
      ondblclick: (e) => !e.target.closest('.acts') && tab.running && sendEnter(tab),
    },
    el('span', { class: 'p-time' }, new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    el('div', { class: 'p-text' }, p.text),
    el(
      'span',
      { class: 'acts' },
      el('button', { title: 'Copy', onclick: () => { ipc.clipboardWrite(p.text); toast('Copied'); } }, '⧉'),
      el('button', { title: 'Send again', onclick: () => insert(true) }, '⏎')
    )
  );
}

function sendEnter(tab) {
  trackInput(tab, '\r');
  ipc.write(tab.id, '\r');
}

function historyItem(rec, { hideFolder = false, current = false } = {}) {
  const openTab = state.tabs.find((t) => t.record && t.record.id === rec.id);
  const meta = [
    rec.agent !== 'shell' || state.historyAgent === 'all' ? agentLabel(rec.agent) : null,
    hideFolder ? null : rec.cwdLabel,
    rec.branch,
    relTime(rec.lastActiveAt),
    rec.runs > 1 ? `${rec.runs} runs` : null,
    rec.prompts ? plural(rec.prompts, 'prompt') : null,
    rec.imported ? 'imported' : null,
  ].filter(Boolean);
  return el(
    'div',
    {
      class: `h-item${openTab ? ' open' : ''}${current ? ' current' : ''}`,
      style: `--c:${agentColor(rec.agent)}`,
      title: `${rec.cwd}\n${rec.nativeId ? 'Session ' + rec.nativeId : 'Native session id not detected yet'}\nDouble-click to resume`,
      onclick: (e) => {
        if (e.target.closest('.acts')) return;
        if (openTab) activateTab(openTab.id);
        else openViewer(rec.id);
      },
      ondblclick: () => resumeRecord(rec),
      oncontextmenu: (e) => {
        e.preventDefault();
        recordMenu(rec, e.clientX, e.clientY);
      },
    },
    el('span', { class: 'dot' }),
    el('span', { class: 't' }, recordTitle(rec)),
    el(
      'span',
      { class: 'acts' },
      current
        ? el('span', { class: 'here' }, 'current')
        : openTab
          ? el('span', { class: 'open-pill' }, 'open')
          : el('button', { title: 'Resume in a new tab', onclick: () => resumeRecord(rec) }, '▶'),
      el('button', { title: 'More', onclick: (e) => recordMenu(rec, e.clientX, e.clientY) }, '⋯')
    ),
    el('span', { class: 'm' }, meta.join(' · '))
  );
}

function recordMenu(rec, x, y) {
  showContextMenu(x, y, [
    { label: 'Resume', run: () => resumeRecord(rec) },
    { label: 'View transcript', run: () => openViewer(rec.id) },
    { label: 'Rename…', run: () => renameRecord(rec) },
    '-',
    { label: 'Export as text…', run: () => ipc.historyExport(rec.id) },
    { label: 'Show log file', run: () => ipc.historyOpenFolder(rec.id) },
    { label: 'Copy resume command', run: () => copyResumeCommand(rec) },
    '-',
    { label: 'Delete from history', run: () => deleteRecord(rec) },
  ]);
}

function resumeRecord(rec) {
  const open = state.tabs.find((t) => t.record && t.record.id === rec.id);
  if (open) return activateTab(open.id);
  createTab({ agent: rec.agent, cwd: rec.cwd, record: rec, mode: 'resume' });
}

function resumeCommand(rec) {
  const id = rec.nativeId;
  if (!id) return null;
  if (rec.agent === 'claude') return `claude --resume ${id}`;
  if (rec.agent === 'codex') return `codex resume ${id}`;
  if (rec.agent === 'cursor') return `cursor-agent --resume ${id}`;
  return null;
}

function copyResumeCommand(rec) {
  const cmd = resumeCommand(rec);
  if (!cmd) return toast('No native session id recorded for this session yet');
  ipc.clipboardWrite(`cd "${rec.cwd}"; ${cmd}`);
  toast('Resume command copied');
}

function renameRecord(rec, tab) {
  if (!rec) return;
  const input = el('input', { value: rec.customTitle || rec.title || '', placeholder: recordTitle(rec), spellcheck: 'false' });
  openModal('Rename session', [el('label', { class: 'field' }, input)], [
    { label: 'Cancel' },
    {
      label: 'Save',
      primary: true,
      run: async () => {
        const updated = await ipc.historyRename(rec.id, input.value.trim());
        for (const t of state.tabs) if (t.record && t.record.id === rec.id) t.record = updated;
        renderTabs();
        renderHistory();
      },
    },
  ]);
  setTimeout(() => input.select(), 0);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && $('#modal-actions .primary-btn').click());
  void tab;
}

function deleteRecord(rec) {
  openModal('Delete session from history?', [
    el('p', {}, `"${recordTitle(rec)}" and its saved transcript will be removed from NI Agent Terminal.`),
    el('p', { class: 'help' }, `The conversation in ${agentLabel(rec.agent)}'s own store is not touched.`),
  ], [
    { label: 'Cancel' },
    {
      label: 'Delete',
      primary: true,
      run: async () => {
        try {
          await ipc.historyDelete(rec.id);
          if (state.viewer && state.viewer.id === rec.id) closeViewer();
          for (const t of state.tabs) t.chain = t.chain.filter((id) => id !== rec.id);
          importCache = { cwd: null, at: 0, items: [] };
          saveState();
          renderHistory();
        } catch (err) {
          toast(err.message);
        }
      },
    },
  ]);
}

$('#btn-history').onclick = () => toggleHistory();
$('#history-folder').onclick = () => ipc.historyOpenFolder(state.historyScope === 'folder' ? { cwd: historyFolderCwd() } : null);
$('#history-scope').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.historyScope = b.dataset.scope;
  renderHistory();
});
$('#history-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.historyAgent = b.dataset.agent;
  renderHistory();
});
$('#history-search').addEventListener('input', (e) => {
  state.historyQuery = e.target.value;
  renderHistory();
});

// ---------------------------------------------------------------------------
// transcript viewer
// ---------------------------------------------------------------------------

let viewerTerm = null;
let viewerFit = null;

async function openViewer(id) {
  const data = await ipc.historyRead(id);
  if (!data) return toast('Session not found');
  closePopovers();
  state.viewer = { id, data, mode: data.text ? 'text' : 'raw' };
  const rec = data.record;
  $('#viewer').classList.remove('hidden');
  $('#viewer-dot').style.setProperty('--c', agentColor(rec.agent));
  $('#viewer-name').textContent = recordTitle(rec);
  $('#viewer-meta').textContent = [
    agentLabel(rec.agent),
    rec.cwd,
    `started ${new Date(rec.createdAt).toLocaleString()}`,
    rec.nativeId ? `session ${rec.nativeId}` : null,
  ].filter(Boolean).join(' · ');
  renderViewer();
}

function renderViewer() {
  const v = state.viewer;
  if (!v) return;
  for (const b of document.querySelectorAll('#viewer-mode button')) b.classList.toggle('on', b.dataset.mode === v.mode);
  const pre = $('#viewer-text');
  const host = $('#viewer-term');
  if (v.mode === 'text') {
    host.classList.add('hidden');
    pre.classList.remove('hidden');
    pre.textContent = v.data.text || 'No text snapshot was saved for this session. Use Replay to view the raw recording.';
    pre.scrollTop = pre.scrollHeight;
  } else {
    pre.classList.add('hidden');
    host.classList.remove('hidden');
    if (viewerTerm) viewerTerm.dispose();
    viewerTerm = new Terminal({
      fontFamily: state.settings.fontFamily,
      fontSize: state.settings.fontSize,
      scrollback: 100000,
      theme: THEME,
      disableStdin: true,
      cursorBlink: false,
    });
    viewerFit = new FitAddon.FitAddon();
    viewerTerm.loadAddon(viewerFit);
    viewerTerm.open(host);
    requestAnimationFrame(() => {
      viewerFit.fit();
      viewerTerm.write(v.data.raw || 'No recording found for this session.');
    });
  }
}

function closeViewer() {
  if (!state.viewer) return;
  state.viewer = null;
  $('#viewer').classList.add('hidden');
  if (viewerTerm) {
    viewerTerm.dispose();
    viewerTerm = null;
  }
  const t = activeTab();
  if (t) t.term.focus();
}

$('#viewer-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !state.viewer) return;
  state.viewer.mode = b.dataset.mode;
  renderViewer();
});
$('#viewer-close').onclick = closeViewer;
$('#viewer-export').onclick = () => state.viewer && ipc.historyExport(state.viewer.id);
$('#viewer-resume').onclick = () => {
  if (!state.viewer) return;
  const rec = state.viewer.data.record;
  closeViewer();
  resumeRecord(rec);
};

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

function renderStatus() {
  const tab = activeTab();
  const agentEl = $('#st-agent');
  if (!tab) {
    agentEl.textContent = '';
    $('#st-cwd').textContent = '';
    $('#st-branch').textContent = '';
    $('#st-session').textContent = '';
  } else {
    const rec = tab.record;
    agentEl.textContent = agentLabel(tab.agent) + (tab.started && !tab.running ? ' (exited)' : '');
    agentEl.style.setProperty('--c', agentColor(tab.agent));
    $('#st-cwd').textContent = tab.cwd || '';
    $('#st-branch').textContent = rec && rec.branch ? `⎇ ${rec.branch}` : '';
    $('#st-session').textContent = rec && rec.nativeId ? rec.nativeId.slice(0, 8) : tab.agent === 'shell' ? '' : 'session: detecting…';
  }
  const ws = state.workspace;
  const st = $('#st-ws');
  if (ws && ws.roots && ws.roots.length) {
    const extra = ws.roots.length > 1 ? ` +${ws.roots.length - 1}` : '';
    st.textContent = `workspace: ${ws.roots[0]}${extra}${ws.missing && ws.missing.length ? ' (folder missing)' : ''}`;
    st.title = `Workspace folders (click to change):\n${ws.roots.join('\n')}`;
  } else {
    st.textContent = 'workspace: not set (click to choose)';
    st.title = 'Choose workspace folders';
  }
}
$('#st-cwd').onclick = () => { const t = activeTab(); if (t && t.cwd) ipc.openPath(t.cwd); };
$('#st-session').onclick = () => { const t = activeTab(); if (t && t.record) copyResumeCommand(t.record); };
$('#st-ws').onclick = () => openSetup();

// ---------------------------------------------------------------------------
// modal & settings
// ---------------------------------------------------------------------------

// opts.locked: no closing by Esc or a click outside (first-run Setup).
// opts.wide: a wider card.
let modalLocked = false;
function openModal(title, body, actions, opts = {}) {
  modalLocked = !!opts.locked;
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...body);
  $('#modal .modal-card').classList.toggle('wide', !!opts.wide);
  $('#modal-actions').replaceChildren(
    ...actions.map((a) =>
      el('button', {
        class: a.primary ? 'primary-btn' : 'small-btn',
        onclick: async () => {
          if (a.run && (await a.run()) === false) return;
          modalLocked = false;
          closeModal();
        },
      }, a.label)
    )
  );
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  if (modalLocked) return;
  $('#modal').classList.add('hidden');
  const t = activeTab();
  if (t) t.term.focus();
}
$('#modal').addEventListener('mousedown', (e) => e.target.id === 'modal' && closeModal());

function applySaved(res) {
  state.settings = res.settings;
  state.workspace = res.workspace;
  for (const a of res.agents) state.agents[a.id] = a;
  renderEmptyActions();
  renderTabs();
  renderStatus();
  renderHistory();
}

function openSettings() {
  const s = state.settings;
  const restore = el('input', { type: 'checkbox' });
  restore.checked = !!s.restoreTabs;
  const fontSize = el('input', { type: 'number', min: 8, max: 32, value: s.fontSize });
  const startup = {};
  const extra = {};
  for (const a of AGENT_KEYS) {
    startup[a] = el('input', { type: 'checkbox' });
    startup[a].checked = (s.startupTabs || []).includes(a);
    extra[a] = el('input', { value: s.extraArgs[a] || '', spellcheck: 'false', placeholder: a === 'claude' ? 'e.g. --permission-mode acceptEdits' : a === 'codex' ? 'e.g. --model gpt-5-codex' : '' });
  }
  const ws = state.workspace;
  const wsSummary = ws && ws.roots && ws.roots.length ? ws.roots.join('\n') : 'No workspace folder set';
  const agentsSummary = enabledAgents().map(agentLabel).join(', ') || 'none';
  openModal('Settings', [
    el('div', { class: 'field' }, el('span', {}, 'Workspaces & agents'),
      el('div', { class: 'row setup-summary' },
        el('div', { class: 'grow' }, el('div', { class: 'mono-sm' }, wsSummary), el('div', { class: 'help' }, `Agents: ${agentsSummary}`)),
        el('button', { class: 'small-btn', onclick: () => openSetup() }, 'Change…'))),
    el('label', { class: 'check' }, restore, 'Reopen and resume last tabs on startup'),
    el('div', { class: 'field' }, el('span', {}, 'Tabs to open when there is nothing to restore'),
      el('div', { class: 'row' }, ...enabledAgents().map((a) => el('label', { class: 'check' }, startup[a], agentLabel(a))))),
    el('label', { class: 'field' }, el('span', {}, 'Font size'), fontSize),
    ...enabledAgents().map((a) => el('label', { class: 'field' }, el('span', {}, `${agentLabel(a)} extra arguments`), extra[a])),
    el('div', { class: 'help' }, `Data folder: ${state.userData}`),
  ], [
    { label: 'Cancel' },
    {
      label: 'Save',
      primary: true,
      run: async () => {
        const patch = {
          restoreTabs: restore.checked,
          fontSize: Number(fontSize.value) || 14,
          startupTabs: AGENT_KEYS.filter((a) => startup[a].checked),
          extraArgs: Object.fromEntries(AGENT_KEYS.map((a) => [a, extra[a].value.trim()])),
        };
        applySaved(await ipc.saveSettings(patch));
        setFontSize(state.settings.fontSize);
      },
    },
  ]);
}
$('#btn-settings').onclick = openSettings;

// ---------------------------------------------------------------------------
// setup: workspace folders and agents (first start, or Settings → Change…)
// ---------------------------------------------------------------------------

const AGENT_HINTS = {
  claude: 'Claude Code CLI (npm i -g @anthropic-ai/claude-code)',
  codex: 'OpenAI Codex CLI (npm i -g @openai/codex)',
  cursor: 'Cursor Agent CLI (cursor-agent)',
  shell: 'Plain shell tab: powershell.exe, pwsh.exe or cmd.exe',
};

async function openSetup({ first = false } = {}) {
  const info = await ipc.setupInfo();
  const s = info.settings;
  const status = Object.fromEntries(info.agents.map((a) => [a.id, a]));
  let roots = s.workspaces.length ? [...s.workspaces] : [...info.suggested];

  // ---- workspace folders ----
  const wsList = el('div', { class: 'ws-list' });
  const renderRoots = async () => {
    const desc = await ipc.setupDescribe(roots).catch(() => ({ dirs: [], missing: [] }));
    const repoCount = (r) => desc.dirs.filter((d) => d.kind === 'repo' && d.root === r).length;
    wsList.replaceChildren(
      ...(roots.length
        ? roots.map((r, i) =>
            el('div', { class: 'ws-row' },
              el('div', { class: 'grow' },
                el('div', { class: 'mono-sm' }, r),
                el('div', { class: 'help' },
                  (desc.missing || []).includes(r)
                    ? 'Folder not found'
                    : `${i === 0 ? 'Default for new tabs · ' : ''}${repoCount(r)} Git ${repoCount(r) === 1 ? 'repository' : 'repositories'} inside`)),
              i > 0 ? el('button', { class: 'small-btn', title: 'Make this the default folder', onclick: () => { roots.unshift(roots.splice(i, 1)[0]); renderRoots(); } }, '↑') : null,
              el('button', { class: 'small-btn', title: 'Remove', onclick: () => { roots.splice(i, 1); renderRoots(); } }, '✕')))
        : [el('div', { class: 'help ws-empty' }, 'No folder yet. Tabs would open in your home folder.')])
    );
  };
  const addFolder = el('button', {
    class: 'small-btn',
    onclick: async () => {
      const dir = await ipc.pickFolder({ title: 'Add a workspace folder', defaultPath: roots[0] || info.home });
      if (dir && !roots.some((r) => sameCwd(r, dir))) roots.push(dir);
      renderRoots();
    },
  }, 'Add folder…');

  // ---- agents ----
  const rows = {};
  const locateSoon = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const found = await ipc.setupLocate(Object.fromEntries(AGENT_KEYS.map((a) => [a, rows[a].command.value.trim()])));
        for (const a of AGENT_KEYS) rows[a].setFound(found[a]);
      }, 250);
    };
  })();
  const agentCards = AGENT_KEYS.map((a) => {
    const st = status[a] || {};
    const cfg = (s.agents && s.agents[a]) || {};
    const enabled = el('input', { type: 'checkbox' });
    enabled.checked = cfg.enabled !== false;
    const found = el('span', { class: 'found' });
    const setFound = (p) => {
      found.textContent = p ? `found · ${p}` : 'not found';
      found.classList.toggle('missing', !p);
      found.title = p || 'Not on PATH. Install it, or enter the full path to its .exe / .cmd.';
    };
    setFound(st.path);
    const command = el('input', { value: cfg.command || '', placeholder: `${st.defaultCommand || a} (from PATH)`, spellcheck: 'false' });
    command.addEventListener('input', locateSoon);
    const browseCmd = el('button', {
      class: 'small-btn',
      onclick: async () => {
        const f = await ipc.pickFile({ title: `${agentLabel(a)} command`, defaultPath: command.value || st.path || undefined });
        if (f) {
          command.value = f;
          locateSoon();
        }
      },
    }, 'Browse…');
    let configDir = null;
    let accountField = null;
    if (st.configEnv) {
      configDir = el('input', { value: cfg.configDir || '', placeholder: `Default: ${st.defaultConfigDir}`, spellcheck: 'false' });
      const browseDir = el('button', {
        class: 'small-btn',
        onclick: async () => {
          const d = await ipc.pickFolder({ title: `${agentLabel(a)} account folder (${st.configEnv})`, defaultPath: configDir.value || st.defaultConfigDir });
          if (d) configDir.value = d;
        },
      }, 'Browse…');
      accountField = el('label', { class: 'field' },
        el('span', {}, `Account folder (${st.configEnv})`),
        el('div', { class: 'row' }, configDir, browseDir),
        el('div', { class: 'help' }, 'Empty: your normal login. Another folder runs this agent under a separate account (sign in once in a tab); its conversations and history stay with that folder.'));
    } else if (a === 'cursor') {
      accountField = el('div', { class: 'help' }, 'Cursor Agent uses its normal login (no separate account folder).');
    }
    const body = el('div', { class: 'agent-body' },
      el('label', { class: 'field' }, el('span', {}, 'Command'), el('div', { class: 'row' }, command, browseCmd)),
      accountField);
    const card = el('div', { class: 'agent-card', style: `--c:${agentColor(a)}` },
      el('div', { class: 'agent-head' },
        el('label', { class: 'check' }, enabled, el('span', { class: 'badge' }, BADGE[a]), el('b', {}, agentLabel(a))),
        found),
      el('div', { class: 'help' }, AGENT_HINTS[a]),
      body);
    const sync = () => card.classList.toggle('off', !enabled.checked);
    enabled.addEventListener('change', sync);
    sync();
    rows[a] = { enabled, command, configDir, setFound };
    return card;
  });

  renderRoots();
  const body = [
    first ? el('p', { class: 'setup-intro' }, 'Choose the folders the agents work in and how each agent is started. You can change this later in Settings.') : null,
    el('div', { class: 'setup-section' },
      el('h4', {}, 'Workspace folders'),
      el('div', { class: 'help' }, 'New tabs open in the first folder. Git repositories inside these folders (up to two levels down, e.g. repos/<name>) are listed in the new-tab folder picker and the History Folder view.'),
      wsList,
      el('div', { class: 'row' }, addFolder)),
    el('div', { class: 'setup-section' }, el('h4', {}, 'Agents'), ...agentCards),
  ].filter(Boolean);

  const save = async () => {
    const agents = {};
    for (const a of AGENT_KEYS) {
      agents[a] = {
        enabled: rows[a].enabled.checked,
        command: rows[a].command.value.trim(),
        configDir: rows[a].configDir ? rows[a].configDir.value.trim() : '',
      };
    }
    if (!AGENT_KEYS.some((a) => agents[a].enabled)) {
      toast('Enable at least one agent');
      return false;
    }
    const startupTabs = (state.settings.startupTabs || []).filter((a) => agents[a].enabled);
    const res = await ipc.saveSettings({ setupDone: true, workspaces: roots, agents, startupTabs });
    applySaved(res);
    if (first && !state.tabs.length) openStartupTabs();
    return true;
  };
  openModal(first ? 'Welcome: set up NI Agent Terminal' : 'Workspaces & agents', body, [
    first
      ? { label: 'Skip for now', run: async () => { applySaved(await ipc.saveSettings({ setupDone: true })); if (!state.tabs.length) openStartupTabs(); } }
      : { label: 'Cancel' },
    { label: first ? 'Start' : 'Save', primary: true, run: save },
  ], { wide: true, locked: first });
}

// ---------------------------------------------------------------------------
// layout, persistence, lifecycle
// ---------------------------------------------------------------------------

function fitActive() {
  setTimeout(() => {
    const t = activeTab();
    if (t) {
      try {
        t.fit.fit();
      } catch (_) { /* ignore */ }
    }
    if (viewerTerm && viewerFit) viewerFit.fit();
  });
}
new ResizeObserver(fitActive).observe($('#terminals'));

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 300);
}
function saveStateNow() {
  clearTimeout(saveTimer);
  // Tabs that were never activated have no record yet; keep them as agent + folder.
  const tabs = state.tabs.map((t) =>
    t.record ? { recordId: t.record.id, agent: t.agent, chain: t.chain } : { agent: t.agent, cwd: t.cwd, mode: t.mode }
  );
  const activeIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeId));
  return ipc.saveState({ tabs, activeIndex }).catch(() => {});
}

ipc.onData(({ tabId, data }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.term.write(data);
  tab.dirty = true;
  if (tab.id !== state.activeId && !tab.activity) {
    tab.activity = true;
    if (tab.node) tab.node.classList.add('activity');
  }
});

ipc.onExit(({ tabId, exitCode, record }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.running = false;
  tab.exitCode = exitCode;
  if (record) tab.record = record;
  snapshot(tab, true);
  tab.term.write(`\r\n\x1b[2m[${agentLabel(tab.agent)} exited with code ${exitCode}]\x1b[0m\r\n`);
  const bar = el(
    'div',
    { class: 'exit-bar' },
    el('span', {}, `Exited (${exitCode}).`),
    el('button', { class: 'primary-btn', onclick: () => restartTab(tab) }, tab.agent === 'shell' ? 'Restart' : 'Resume  ⏎'),
    el('button', { class: 'small-btn', onclick: () => closeTab(tab.id) }, 'Close')
  );
  tab.exitBar = bar;
  tab.host.append(bar);
  renderTabs();
  renderStatus();
  renderHistory();
});

ipc.onPrompt(({ tabId, recordId }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (tab && tab.record && tab.record.id === recordId) tab.record.prompts = (tab.record.prompts || 0) + 1;
  if (state.historyScope !== 'tab' || tabId === state.activeId) renderHistory();
});

// The tab's conversation was identified, renamed, or the agent moved on to another one.
ipc.onSessionUpdate(({ tabId, record, previousId, replacedId, at }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (tab && record) {
    tab.record = record;
    if (replacedId) {
      // A placeholder record was folded into this one.
      tab.chain = tab.chain.map((id) => (id === replacedId ? record.id : id));
    } else if (previousId) {
      // A new or older conversation in this tab: its transcript starts at the Enter
      // that began it. The previous conversation's text was saved on that Enter.
      const mark = tab.enterMarks.filter((m) => m.t <= (at || Date.now()) + 1000).pop();
      setSnapMarker(tab, mark ? mark.marker : tab.term.registerMarker(0));
      tab.lastSnap = null;
      tab.dirty = true;
    }
    tab.chain = [...new Set([...tab.chain.filter((id) => id !== record.id), record.id])];
  }
  renderTabs();
  renderStatus();
  renderHistory();
  saveState();
});

ipc.onBeforeClose(async () => {
  try {
    await Promise.race([
      Promise.all([...state.tabs.map((t) => snapshot(t, true)), saveStateNow()]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } finally {
    ipc.closedOk();
  }
});

// Periodic snapshots so a crash or power loss still leaves a readable transcript.
setInterval(() => {
  for (const t of state.tabs) if (t.dirty && Date.now() - t.lastSnapshot > 30000) snapshot(t, false);
}, 10000);
setInterval(() => renderHistory(), 60000);

async function boot() {
  const init = await ipc.init();
  state.settings = init.settings;
  state.workspace = init.workspace;
  state.userData = init.userData;
  for (const a of init.agents) state.agents[a.id] = a;
  renderEmptyActions();

  // First start: Setup comes first, and the startup tabs open once it is done.
  if (!state.settings.setupDone) {
    renderTabs();
    renderStatus();
    return openSetup({ first: true });
  }

  if (init.restore.length) {
    init.restore.forEach((t) =>
      createTab({
        agent: t.agent,
        cwd: t.record ? t.record.cwd : t.cwd,
        record: t.record,
        chain: t.chain,
        mode: t.record ? 'resume' : t.mode || 'new',
        activate: false,
      })
    );
    const idx = Math.min(init.activeIndex || 0, state.tabs.length - 1);
    activateTab(state.tabs[idx].id);
  } else {
    openStartupTabs();
  }
  renderTabs();
  renderStatus();
  const ws = state.workspace;
  if (!ws || !ws.roots || !ws.roots.length) toast('No workspace folder set. Click "workspace" in the status bar to choose one.');
  else if (ws.missing && ws.missing.length) toast(`Workspace folder not found: ${ws.missing[0]}`);
}

function openStartupTabs() {
  const startup = (state.settings.startupTabs || []).filter((a) => enabledAgents().includes(a) && state.agents[a] && state.agents[a].available);
  startup.forEach((a, i) => createTab({ agent: a, cwd: defaultCwd(), activate: i === 0 }));
}

function renderEmptyActions() {
  const empty = $('#empty-actions');
  empty.replaceChildren(
    ...enabledAgents().map((a) => el('button', { class: 'small-btn', onclick: () => createTab({ agent: a, cwd: defaultCwd() }) }, `New ${agentLabel(a)}`)),
    el('button', { class: 'small-btn', onclick: () => openSetup() }, 'Workspaces & agents…')
  );
}

boot().catch((err) => {
  document.body.append(el('pre', { style: 'position:fixed;inset:60px 20px auto;color:#ef6b6b;white-space:pre-wrap' }, err.stack || String(err)));
});
