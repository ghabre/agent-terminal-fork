'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');

const { AGENTS, buildEnv, resolveLaunch, locate, agentEnv } = require('./agents');
const { listSessions, claudeLiveSession, claudeSessionExists, copyConversation, nativeTitle, samePath, normPath } = require('./sessions');
const { History } = require('./history');
const workspace = require('./workspace');

// Test hooks: an isolated data folder, and a screenshot-then-quit smoke run.
if (process.env.NI_TERM_USERDATA) app.setPath('userData', process.env.NI_TERM_USERDATA);
const SMOKE_SHOT = process.env.NI_TERM_SMOKE || null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const settingsFile = path.join(userData, 'settings.json');
const stateFile = path.join(userData, 'state.json');

const DEFAULT_AGENTS = {
  claude: { enabled: true, command: '' },
  codex: { enabled: true, command: '' },
  cursor: { enabled: true, command: '' },
  shell: { enabled: true, command: '' },
};

const DEFAULT_SETTINGS = {
  // Setup (workspace folders + agents) is shown on first start until it is saved.
  setupDone: false,
  workspaces: [],
  agents: DEFAULT_AGENTS,
  restoreTabs: true,
  fontSize: 14,
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  scrollback: 20000,
  extraArgs: { claude: '', codex: '', cursor: '', shell: '' },
  startupTabs: ['claude', 'codex', 'cursor'],
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...s };
  out.extraArgs = { ...DEFAULT_SETTINGS.extraArgs, ...(s.extraArgs || {}) };
  // 1.1 had a single workspaceRoot (the ni-agentic-development folder).
  if (!Array.isArray(out.workspaces)) out.workspaces = [];
  if (!out.workspaces.length && s.workspaceRoot) out.workspaces = [s.workspaceRoot];
  out.workspaces = out.workspaces.filter((p) => typeof p === 'string' && p.trim());
  delete out.workspaceRoot;
  const agents = {};
  for (const id of Object.keys(DEFAULT_AGENTS)) {
    const a = (s.agents && s.agents[id]) || {};
    agents[id] = {
      enabled: a.enabled !== false,
      command: typeof a.command === 'string' ? a.command.trim() : '',
      ...normalizeAccounts(id, a),
    };
  }
  out.agents = agents;
  return out;
}

// Accounts of one agent: [{ id, name, configDir, apiKeyEnc? }] plus the one new tabs
// use. A Claude / Codex account is a config folder ('' = the normal login); a Cursor
// account is an API key, kept encrypted (apiKeyEnc), with no key = the normal login.
function normalizeAccounts(agentId, a) {
  const kind = AGENTS[agentId].accountKind;
  if (!kind) return { accounts: [], activeAccount: null };
  const seen = new Set();
  const freshId = () => `acct-${crypto.randomUUID().slice(0, 8)}`;
  let accounts = (Array.isArray(a.accounts) ? a.accounts : [])
    .filter((x) => x && typeof x === 'object')
    .map((x, i) => {
      let id = typeof x.id === 'string' && x.id.trim() ? x.id.trim() : i === 0 ? 'default' : freshId();
      if (seen.has(id)) id = freshId();
      seen.add(id);
      const acct = {
        id,
        name: (typeof x.name === 'string' && x.name.trim()) || (i === 0 ? 'Default' : `Account ${i + 1}`),
        configDir: kind === 'dir' && typeof x.configDir === 'string' ? x.configDir.trim() : '',
      };
      if (kind === 'key' && typeof x.apiKeyEnc === 'string' && x.apiKeyEnc) acct.apiKeyEnc = x.apiKeyEnc;
      return acct;
    });
  let active = a.activeAccount;
  if (!accounts.length) {
    accounts = [{ id: 'default', name: 'Default', configDir: '' }];
    // 1.2 had one account folder per agent: keep it as a second account, still in use.
    const legacy = kind === 'dir' && typeof a.configDir === 'string' ? a.configDir.trim() : '';
    if (legacy) {
      accounts.push({ id: 'account-2', name: path.basename(legacy) || 'Account 2', configDir: legacy });
      active = 'account-2';
    }
  }
  if (!accounts.some((x) => x.id === active)) active = accounts[0].id;
  return { accounts, activeAccount: active };
}

// Settings as the window sees them: API keys are never sent, only whether one is saved.
function publicSettings() {
  const agents = {};
  for (const [id, a] of Object.entries(settings.agents)) {
    agents[id] = { ...a, accounts: (a.accounts || []).map(({ apiKeyEnc, ...x }) => ({ ...x, hasKey: !!apiKeyEnc })) };
  }
  return { ...settings, agents };
}

function encryptKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows cannot encrypt the API key here, so it was not saved.');
  return safeStorage.encryptString(key).toString('base64');
}

function decryptKey(enc) {
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (_) {
    return null;
  }
}

let settings = normalizeSettings(readJson(settingsFile, {}));

// The portable build unpacks to a temp folder; PORTABLE_EXECUTABLE_DIR is where the user put the .exe.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));

// The workspace folder a working directory belongs to, else the first one.
function workspaceFor(cwd) {
  return workspace.containingRoot(settings.workspaces, cwd) || settings.workspaces[0] || null;
}

function agentCfg(id) {
  return settings.agents[id] || { enabled: true, command: '', accounts: [], activeAccount: null };
}

const sameDir = (a, b) => (!a && !b) || (!!a && !!b && samePath(a, b));

function accountById(agentId, accountId) {
  return (agentCfg(agentId).accounts || []).find((x) => x.id === accountId) || null;
}

// The account new tabs of this agent use.
function activeAccount(agentId) {
  const cfg = agentCfg(agentId);
  return accountById(agentId, cfg.activeAccount) || (cfg.accounts || [])[0] || null;
}

// The account a conversation runs under: the one it was started with, else (records
// from before accounts, or a removed account) the one with the same config folder.
function accountForRecord(rec) {
  const kind = rec && AGENTS[rec.agent] && AGENTS[rec.agent].accountKind;
  if (!kind) return null;
  const byId = rec.accountId && accountById(rec.agent, rec.accountId);
  if (byId) return byId;
  if (kind === 'dir') return (agentCfg(rec.agent).accounts || []).find((x) => sameDir(x.configDir, rec.configDir)) || null;
  return null;
}

function agentStatus() {
  const env = buildEnv({});
  return Object.values(AGENTS).map((a) => {
    const cfg = agentCfg(a.id);
    const found = locate(a.id, cfg.command, env);
    return {
      id: a.id,
      label: a.label,
      color: a.color,
      enabled: cfg.enabled,
      available: !!found,
      path: found,
      defaultCommand: a.command,
      accountKind: a.accountKind || null,
      configEnv: a.configEnv || null,
      keyEnv: a.keyEnv || null,
      defaultConfigDir: a.defaultConfigDir || null,
    };
  });
}

const history = new History(path.join(userData, 'history'));
const sessions = new Map(); // tabId -> live pty session
let win = null;
let closing = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function publicRecord(rec) {
  if (!rec) return null;
  const roots = [...settings.workspaces, ...(rec.workspaceRoot ? [rec.workspaceRoot] : [])];
  const acct = accountForRecord(rec);
  return {
    ...rec,
    cwdLabel: workspace.labelFor(roots, rec.cwd),
    branch: workspace.readBranch(rec.cwd),
    accountId: acct ? acct.id : rec.accountId || null,
    accountName: acct ? acct.name : rec.configDir ? path.basename(rec.configDir) : null,
  };
}

// ---------------------------------------------------------------------------
// Conversation tracking
// ---------------------------------------------------------------------------
// A tab is one agent process, but the agent can go through several conversations:
// /clear and /new start a fresh one, /resume switches to an older one. Every couple of
// seconds each live tab is matched against the agent's own store, and the tab moves
// to the history record of the conversation it is on now, so each conversation
// is listed and resumable on its own.
//
// Claude: ~/.claude/sessions/<pid>.json names the current session exactly.
// Codex / Cursor: a conversation created in the tab's folder is attributed to the tab
// in which Enter was pressed just before it appeared (or that had just started).

const TRACK_MS = 2000;
const TITLE_MS = 20000;

function liveTabOf(agent, nativeId, exceptTab) {
  for (const [tabId, s] of sessions) {
    if (tabId === exceptTab || s.agent !== agent) continue;
    const rec = history.get(s.recordId);
    if (rec && rec.nativeId === nativeId) return tabId;
  }
  return null;
}

// Which live tab created this conversation, and how sure we are.
function ownerOf(agent, cwd, birth) {
  let best = null;
  for (const [tabId, s] of sessions) {
    if (s.agent !== agent) continue;
    const rec = history.get(s.recordId);
    if (!rec || !samePath(rec.cwd, cwd)) continue;
    // The agent writes a new conversation right after the Enter that started it.
    for (const e of s.enters) {
      if (birth >= e - 1500 && birth <= e + 15000 && (!best || !best.byEnter || e > best.at)) best = { tabId, at: e, byEnter: true };
    }
    // Some agents create their conversation as soon as they start.
    if (!best && birth >= s.since - 2000 && birth <= s.since + 30000) best = { tabId, at: s.since, byEnter: false };
  }
  return best;
}

// A record this run created that never became a real conversation: the agent never
// wrote it, or only slash commands were sent. It is replaced rather than kept.
function isThrowaway(rec, s) {
  if (rec.createdAt < s.since - 1000) return false;
  if (rec.agent === 'claude' && rec.nativeId && !claudeSessionExists(rec.cwd, rec.nativeId, rec.configDir)) return true;
  return history.prompts(rec.id).every((p) => p.text.startsWith('/'));
}

function switchConversation(tabId, s, rec, target) {
  const other = history.findByNative(s.agent, target.id);
  if (other && other.id !== rec.id && liveTabOf(s.agent, target.id, tabId)) return; // open in another tab
  const now = Date.now();
  let next;
  let replacedId = null;
  if (other && other.id !== rec.id) {
    // Switched to (or turned out to be) a conversation already in history.
    if (!rec.nativeId || isThrowaway(rec, s)) {
      next = history.merge(rec.id, other.id, 'continued in this tab');
      replacedId = rec.id;
    } else {
      history.endRun(rec.id);
      history.beginRun(other.id, 'switched to this conversation', { switched: true });
      history.movePrompts(rec.id, other.id, target.birth - 1500);
      next = other;
    }
  } else if (!rec.nativeId || isThrowaway(rec, s)) {
    // First sight of the conversation, or the earlier one was empty: fill it in.
    next = history.update(rec.id, { nativeId: target.id, title: rec.nativeId ? null : rec.title });
  } else {
    next = history.create({ agent: s.agent, cwd: rec.cwd, nativeId: target.id, workspaceRoot: rec.workspaceRoot, configDir: rec.configDir, accountId: rec.accountId, parentId: rec.id });
    history.endRun(rec.id);
    history.beginRun(next.id, 'new conversation in this tab', { switched: true });
    history.movePrompts(rec.id, next.id, target.birth - 1500);
  }
  s.recordId = next.id;
  s.lastSwitchAt = now;
  s.titleAt = 0;
  if (SMOKE_SHOT) console.log(`[track ${tabId}] ${rec.id.slice(0, 8)}/${rec.nativeId} -> ${next.id.slice(0, 8)}/${target.id}`);
  send('session:update', {
    tabId,
    record: publicRecord(history.get(next.id)),
    previousId: next.id !== rec.id ? rec.id : null,
    replacedId,
    at: target.birth, // about when the new conversation began
  });
}

function trackTab(tabId, s, listFor) {
  const rec = history.get(s.recordId);
  if (!rec) return;
  const now = Date.now();
  const enteredThisRun = s.enters.some((e) => e > s.since);
  let target = null;

  if (s.agent === 'claude') {
    const id = claudeLiveSession(s.pty.pid, rec.cwd, s.since, s.configDir);
    if (id) {
      s.exact = true;
      const birth = s.enters.length ? s.enters[s.enters.length - 1] : now;
      if (id !== rec.nativeId && (!rec.nativeId || enteredThisRun)) target = { id, birth };
    }
  }
  if (!target && !s.exact) {
    const cands = listFor(s.agent, rec.cwd, s.configDir).filter((c) => c.t >= s.since - 2000 && c.id !== rec.nativeId && !liveTabOf(s.agent, c.id, tabId));
    const mine = cands
      .filter((c) => c.birth >= Math.max(s.since, s.lastSwitchAt) - 2000)
      .map((c) => ({ c, owner: ownerOf(s.agent, rec.cwd, c.birth) }))
      .filter((x) => x.owner && x.owner.tabId === tabId)
      .sort((a, b) => b.c.birth - a.c.birth);
    if (!rec.nativeId) {
      // A conversation this tab created, else one it continued (Last / Pick… / /resume).
      const created = mine[0] && mine[0].c;
      const continued = s.mode !== 'new' ? cands.find((c) => c.birth < s.since - 2000) : null;
      target = created || continued || null;
    } else if (enteredThisRun) {
      const fresh = mine.find((x) => x.owner.byEnter && !history.findByNative(s.agent, x.c.id));
      if (fresh) target = fresh.c;
    }
  }
  if (target) switchConversation(tabId, s, rec, target);

  const cur = history.get(s.recordId);
  if (cur && cur.nativeId && !cur.customTitle && now - s.titleAt > (cur.title ? TITLE_MS : TRACK_MS)) {
    s.titleAt = now;
    const title = nativeTitle(s.agent, cur.cwd, cur.nativeId, cur.configDir);
    if (title && title !== cur.title) {
      history.update(cur.id, { title });
      send('session:update', { tabId, record: publicRecord(cur) });
    }
  }
}

function trackSessions() {
  const cache = new Map();
  const listFor = (agent, cwd, dir) => {
    const key = `${agent}|${normPath(cwd)}|${dir || ''}`;
    if (!cache.has(key)) {
      let since = Date.now();
      for (const s of sessions.values()) if (s.agent === agent) since = Math.min(since, s.since);
      cache.set(key, listSessions(agent, cwd, since - 5000, dir));
    }
    return cache.get(key);
  };
  for (const [tabId, s] of [...sessions]) {
    if (s.agent === 'shell' || sessions.get(tabId) !== s) continue;
    try {
      trackTab(tabId, s, listFor);
    } catch (err) {
      if (SMOKE_SHOT) console.log(`[track ${tabId}] ${err.stack}`);
    }
  }
}
setInterval(trackSessions, TRACK_MS);

function startPty({ tabId, agent, cwd, recordId, mode, accountId, cols, rows }) {
  if (!AGENTS[agent]) throw new Error(`Unknown agent ${agent}`);
  stopPty(tabId);

  const cfg = agentCfg(agent);
  let rec = recordId ? history.get(recordId) : null;
  let runMode = mode || 'new';

  if (rec) {
    cwd = rec.cwd;
    if (agent === 'claude' && rec.nativeId) {
      // A Claude session that never received a message was never written to disk;
      // start it fresh under the same id instead of failing to resume.
      runMode = claudeSessionExists(rec.cwd, rec.nativeId, rec.configDir) ? 'resume' : 'new';
    } else if (rec.nativeId) {
      runMode = 'resume';
    } else if (runMode === 'resume') {
      runMode = 'new';
    }
  } else {
    if (!cwd || !fs.existsSync(cwd)) cwd = settings.workspaces.find((p) => fs.existsSync(p)) || require('os').homedir();
    const nativeId = agent === 'claude' && runMode === 'new' ? crypto.randomUUID() : null;
    // The account folder is kept with the record: the conversation lives in that
    // folder's store, so resuming it later must use the same one.
    const acct = accountById(agent, accountId) || activeAccount(agent);
    rec = history.create({ agent, cwd, nativeId, workspaceRoot: workspaceFor(cwd), configDir: (acct && acct.configDir) || null, accountId: acct ? acct.id : null });
  }
  // Cursor's account is an API key; a record whose account was removed uses the current one.
  const keyAcct = AGENTS[agent].accountKind === 'key' ? accountForRecord(rec) || activeAccount(agent) : null;
  const apiKey = keyAcct ? decryptKey(keyAcct.apiKeyEnc) : null;
  if (keyAcct && keyAcct.apiKeyEnc && !apiKey) throw new Error(`The API key of ${AGENTS[agent].label} account "${keyAcct.name}" cannot be read. Enter it again in Setup.`);
  if (!fs.existsSync(cwd)) throw new Error(`Working folder no longer exists: ${cwd}`);
  if (rec.configDir && !fs.existsSync(rec.configDir)) fs.mkdirSync(rec.configDir, { recursive: true });

  const root = workspaceFor(cwd);
  const env = buildEnv({
    AGENT_TERMINAL: '1',
    AGENT_TERMINAL_WORKSPACE: root || '',
    AGENT_TERMINAL_SESSION: rec.id,
    // Names used by 1.x; kept so existing scripts and instructions keep working.
    NI_WORKSPACE: root || '',
    NI_AGENT_TERMINAL: '1',
    NI_AGENT_TERMINAL_SESSION: rec.id,
    ...agentEnv(agent, rec.configDir, apiKey),
  });
  const launch = resolveLaunch(agent, runMode, rec.nativeId, settings.extraArgs[agent], env, cfg.command);

  const proc = pty.spawn(launch.file, launch.args, {
    name: 'xterm-256color',
    cols: Math.max(cols || 120, 20),
    rows: Math.max(rows || 30, 5),
    cwd,
    env,
    useConpty: true,
  });

  const s = {
    pty: proc,
    agent,
    mode: runMode,
    configDir: rec.configDir || null,
    recordId: rec.id,
    since: Date.now(),
    lastSwitchAt: 0,
    titleAt: 0,
    enters: [], // when Enter was sent, newest last; ties new conversations to this tab
    exact: false, // Claude's pid file is being read
    buf: '',
    flushTimer: null,
  };
  let markExited;
  s.exited = new Promise((resolve) => { markExited = resolve; });
  sessions.set(tabId, s);
  history.beginRun(rec.id, launch.display);

  if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] spawn ${launch.file} ${launch.args} cwd=${cwd} ${cols}x${rows}`);
  proc.onData((data) => {
    if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] +${Date.now() - s.since}ms ${data.length}b`);
    // s.recordId, not rec: the tab may have moved on to another conversation.
    history.append(s.recordId, data);
    // Coalesce chunks so a busy TUI redraw is one IPC message, not hundreds.
    s.buf += data;
    if (!s.flushTimer) {
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        const out = s.buf;
        s.buf = '';
        send('pty:data', { tabId, data: out });
      }, 8);
    }
  });

  proc.onExit(({ exitCode }) => {
    markExited();
    if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] exit ${exitCode}`);
    if (sessions.get(tabId) !== s) return;
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
      send('pty:data', { tabId, data: s.buf });
      s.buf = '';
    }
    sessions.delete(tabId);
    history.endRun(s.recordId, exitCode);
    if (!closing) send('pty:exit', { tabId, exitCode, record: publicRecord(history.get(s.recordId)) });
  });

  return { record: publicRecord(rec), display: launch.display, mode: runMode };
}

// Resolves once the process has exited (or after a few seconds).
function stopPty(tabId) {
  const s = sessions.get(tabId);
  if (!s) return Promise.resolve();
  sessions.delete(tabId);
  clearTimeout(s.flushTimer);
  history.endRun(s.recordId, null);
  try {
    s.pty.kill();
  } catch (_) { /* already exited */ }
  return Promise.race([s.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

// Moves a conversation to another account of its agent: the tab's process is stopped,
// the conversation is copied into that account's store (Claude, Codex), and the record
// follows the account, so the next start resumes it there. That account also becomes
// the one new tabs of this agent use.
async function switchAccount({ tabId, recordId, accountId }) {
  const s = tabId ? sessions.get(tabId) : null;
  const rec = history.get(s ? s.recordId : recordId);
  if (!rec) throw new Error('Session not found');
  const agent = AGENTS[rec.agent];
  if (!agent.accountKind) throw new Error(`${agent.label} has no accounts`);
  const acct = accountById(rec.agent, accountId);
  if (!acct) throw new Error('That account no longer exists. Check Setup.');
  for (const [id, other] of sessions) {
    if (id !== tabId && other.recordId === rec.id) throw new Error('This conversation is running in another tab. Switch that tab instead.');
  }
  if (s) await stopPty(tabId);
  let copied = true;
  if (agent.accountKind === 'dir' && !sameDir(rec.configDir, acct.configDir)) {
    if (acct.configDir) fs.mkdirSync(acct.configDir, { recursive: true });
    copied = !rec.nativeId || copyConversation(rec.agent, rec.cwd, rec.nativeId, rec.configDir, acct.configDir || null);
  }
  history.update(rec.id, { accountId: acct.id, configDir: agent.accountKind === 'dir' ? acct.configDir || null : rec.configDir });
  if (settings.agents[rec.agent].activeAccount !== acct.id) {
    settings.agents[rec.agent].activeAccount = acct.id;
    writeJson(settingsFile, settings);
  }
  return { record: publicRecord(rec), settings: publicSettings(), copied };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      return { ok: true, value: await fn(arg) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

handle('app:init', () => {
  const state = readJson(stateFile, { tabs: [] });
  const restore = settings.restoreTabs
    ? (state.tabs || [])
        .map((t) => ({
          ...t,
          record: t.recordId ? publicRecord(history.get(t.recordId)) : null,
          chain: (Array.isArray(t.chain) ? t.chain : []).filter((id) => history.get(id)),
        }))
        .filter((t) => AGENTS[t.agent] && (t.record || !t.recordId))
    : [];
  return {
    version: app.getVersion(),
    settings: publicSettings(),
    workspace: workspace.describe(settings.workspaces),
    agents: agentStatus(),
    restore,
    activeIndex: state.activeIndex || 0,
    userData,
  };
});

handle('pty:start', (opts) => startPty(opts));
handle('pty:kill', (tabId) => { stopPty(tabId); });
handle('pty:switchAccount', (opts) => switchAccount(opts || {}));
ipcMain.on('pty:write', (_e, { tabId, data }) => {
  const s = sessions.get(tabId);
  if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] write ${JSON.stringify(data)}`);
  if (!s) return;
  if (typeof data === 'string' && data.includes('\r') && !data.startsWith('\x1b[200~')) {
    s.enters.push(Date.now());
    if (s.enters.length > 8) s.enters.shift();
  }
  s.pty.write(data);
});
ipcMain.on('pty:resize', (_e, { tabId, cols, rows }) => {
  const s = sessions.get(tabId);
  if (s && cols > 0 && rows > 0) {
    try {
      s.pty.resize(cols, rows);
    } catch (_) { /* exited between messages */ }
  }
});

handle('history:list', (filter) => history.list(filter || {}).map(publicRecord));
handle('history:folders', () => history.folders().map((f) => ({ ...f, label: workspace.labelFor(settings.workspaces, f.cwd) })));
handle('history:get', (ids) => (ids || []).map((id) => publicRecord(history.get(id))).filter(Boolean));

// Conversations in the agents' own stores for this folder that history has no record of,
// e.g. ones started outside the app, or before conversation tracking existed.
const IMPORT_DAYS = 60;
function importable(cwd) {
  const since = Date.now() - IMPORT_DAYS * 86400000;
  const out = [];
  for (const agent of ['claude', 'codex', 'cursor']) {
    const cfg = agentCfg(agent);
    if (!cfg.enabled) continue;
    // Look in the default store and in every account's folder.
    const kind = AGENTS[agent].accountKind;
    const dirs = kind === 'dir'
      ? [null, ...(cfg.accounts || []).map((x) => x.configDir || null)].filter((d, i, all) => all.findIndex((o) => sameDir(o, d)) === i)
      : [null];
    for (const dir of dirs) {
      const acct = kind === 'dir' ? (cfg.accounts || []).find((x) => sameDir(x.configDir, dir)) : null;
      for (const c of listSessions(agent, cwd, since, dir)) {
        if (history.findByNative(agent, c.id) || liveTabOf(agent, c.id, null) || out.some((x) => x.agent === agent && x.id === c.id)) continue;
        const title = nativeTitle(agent, cwd, c.id, dir) || c.title || null;
        // A Claude session holding nothing but a /clear has no title to show.
        if (agent === 'claude' && !title) continue;
        out.push({ agent, id: c.id, title, birth: c.birth, t: c.t, configDir: dir, accountId: acct ? acct.id : null });
      }
    }
  }
  return out.sort((a, b) => b.t - a.t);
}
handle('history:importable', (cwd) => (cwd && fs.existsSync(cwd) ? importable(cwd) : []));
handle('history:import', (cwd) => {
  let n = 0;
  for (const c of importable(cwd)) {
    const rec = history.create({
      agent: c.agent,
      cwd,
      nativeId: c.id,
      title: c.title,
      workspaceRoot: workspaceFor(cwd),
      configDir: c.configDir,
      accountId: c.accountId,
      imported: true,
      createdAt: Math.min(c.birth || c.t, c.t),
    });
    history.update(rec.id, { lastActiveAt: c.t });
    n++;
  }
  return n;
});
handle('history:read', (id) => {
  const r = history.read(id);
  return r && { ...r, record: publicRecord(r.record) };
});
handle('history:delete', (id) => {
  for (const s of sessions.values()) if (s.recordId === id) throw new Error('Close the tab running this session first.');
  return history.remove(id);
});
handle('history:rename', ({ id, title }) => publicRecord(history.update(id, { customTitle: title || null })));
handle('history:prompts', (ids) => history.prompts(ids));
ipcMain.on('history:addPrompt', (_e, { tabId, text }) => {
  // Attribute the prompt to whatever conversation the tab is running right now.
  const s = sessions.get(tabId);
  if (s && history.addPrompt(s.recordId, text)) send('history:prompt', { tabId, recordId: s.recordId });
});
handle('history:snapshot', ({ id, text, cleared }) => history.writeSnapshot(id, text, { cleared }));
handle('history:openFolder', (arg) => {
  const rec = typeof arg === 'string' && history.get(arg);
  if (rec) {
    const target = history.logPath(rec);
    if (fs.existsSync(target)) return shell.showItemInFolder(target);
    return shell.openPath(path.dirname(target));
  }
  // { cwd }: that folder's history; nothing: the history root.
  const dir = arg && arg.cwd ? history.folderDir(arg.cwd) : history.root;
  return shell.openPath(fs.existsSync(dir) ? dir : history.root);
});
handle('history:export', async (id) => {
  const r = history.read(id);
  if (!r) throw new Error('Session not found');
  const name = `${r.record.agent}-${new Date(r.record.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  const res = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (res.canceled || !res.filePath) return false;
  const text = r.text || stripAnsi(r.raw || '');
  fs.writeFileSync(res.filePath, text);
  return res.filePath;
});

handle('settings:save', (patch) => {
  const p = patch || {};
  const agents = { ...settings.agents };
  for (const [id, a] of Object.entries(p.agents || {})) {
    if (!agents[id]) continue;
    const next = { ...agents[id], ...a };
    if (Array.isArray(a.accounts)) {
      // A Cursor key arrives as plain apiKey (new or replaced) or as clearKey; an
      // account sent with neither keeps the key it has.
      next.accounts = a.accounts.map((x) => {
        const old = (agents[id].accounts || []).find((o) => o.id === x.id) || {};
        const acct = { id: x.id, name: x.name, configDir: x.configDir };
        if (typeof x.apiKey === 'string' && x.apiKey.trim()) acct.apiKeyEnc = encryptKey(x.apiKey.trim());
        else if (!x.clearKey && old.apiKeyEnc) acct.apiKeyEnc = old.apiKeyEnc;
        return acct;
      });
    }
    agents[id] = next;
  }
  settings = normalizeSettings({ ...settings, ...p, agents, extraArgs: { ...settings.extraArgs, ...(p.extraArgs || {}) } });
  writeJson(settingsFile, settings);
  return { settings: publicSettings(), workspace: workspace.describe(settings.workspaces), agents: agentStatus() };
});

// What Setup needs: the current choices, folders worth suggesting, and where each
// agent's command resolves to.
handle('setup:info', () => {
  const suggested = settings.workspaces.length ? [] : workspace.suggestRoots(exeDir);
  return { settings: publicSettings(), suggested, agents: agentStatus(), home: workspace.home() };
});
// Resolves typed commands without saving them: { claude: 'claude', … } -> { claude: path|null, … }.
handle('setup:locate', (commands) => {
  const env = buildEnv({});
  const out = {};
  for (const id of Object.keys(AGENTS)) out[id] = locate(id, (commands || {})[id], env);
  return out;
});
handle('setup:describe', (roots) => workspace.describe(roots || []));

handle('workspace:pickFolder', async (opts) => {
  const res = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || undefined,
    defaultPath: (opts && opts.defaultPath) || settings.workspaces[0] || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});
handle('dialog:pickFile', async (opts) => {
  const res = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || undefined,
    defaultPath: (opts && opts.defaultPath) || undefined,
    properties: ['openFile'],
    filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'ps1'] }, { name: 'All files', extensions: ['*'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});
handle('workspace:refresh', () => workspace.describe(settings.workspaces));

handle('state:save', (state) => writeJson(stateFile, state));
handle('shell:openPath', (p) => shell.openPath(p));
handle('clipboard:read', () => ({ text: clipboard.readText(), hasImage: !clipboard.readImage().isEmpty() }));
handle('clipboard:write', (text) => clipboard.writeText(text || ''));
handle('app:devtools', () => win && win.webContents.toggleDevTools());

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g, '').replace(/\r(?!\n)/g, '');
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const state = readJson(stateFile, {});
  let bounds = state.bounds || { width: 1360, height: 860 };
  if (bounds.x !== undefined) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return bounds.x < a.x + a.width - 100 && bounds.x + bounds.width > a.x + 100 && bounds.y >= a.y - 20 && bounds.y < a.y + a.height - 100;
    });
    if (!visible) bounds = { width: bounds.width, height: bounds.height };
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#111317',
    title: 'NI Agent Terminal',
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16181d', symbolColor: '#c9ccd1', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Agents keep streaming while the window is in the background.
      backgroundThrottling: false,
    },
  });
  // Show right away (backgroundColor avoids a white flash). Waiting for 'ready-to-show'
  // is unreliable: on some machines it never fires, which left a windowless instance
  // holding the single-instance lock, so every later launch exited silently.
  if (state.maximized) win.maximize();
  win.show();
  if (SMOKE_SHOT) {
    win.webContents.on('console-message', (_e, level, message, line, source) => console.log(`[renderer:${level}] ${message} (${source}:${line})`));
    const delay = Number(process.env.NI_TERM_SMOKE_DELAY || 12000);
    if (process.env.NI_TERM_SMOKE_JS) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.NI_TERM_SMOKE_JS).catch((e) => console.log('smoke js', e)), delay / 2);
    }
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SMOKE_SHOT, img.toPNG());
      win.close();
    }, delay);
  }
  win.loadFile(path.join(__dirname, 'index.html'));

  // Links printed by agents open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  let readyToClose = false;
  win.on('close', (e) => {
    if (readyToClose) return;
    e.preventDefault();
    const finish = () => {
      if (readyToClose) return;
      readyToClose = true;
      const cur = readJson(stateFile, {});
      writeJson(stateFile, { ...cur, bounds: win.getNormalBounds(), maximized: win.isMaximized() });
      closing = true;
      for (const tabId of [...sessions.keys()]) stopPty(tabId);
      history.flush();
      win.destroy();
    };
    ipcMain.once('app:closed-ok', finish);
    send('app:before-close');
    setTimeout(finish, 2500);
  });
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  } else if (app.isReady()) {
    createWindow();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => {
  history.flush();
  app.quit();
});
