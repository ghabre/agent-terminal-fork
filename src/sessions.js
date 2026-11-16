'use strict';
// Native session discovery and titles.
//
// Each agent can switch conversations while it runs (/clear, /new, /resume), so the
// app keeps asking the agent's own store which conversation a tab is on:
//   claude  ~/.claude/sessions/<pid>.json names the live process's current session
//           exactly; the project folder's *.jsonl files are the fallback.
//   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, whose first line holds id + cwd.
//   cursor  ~/.cursor/chats/<ws>/<chatId>/meta.json, which holds cwd + createdAtMs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

const normPath = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a, b) => !!a && !!b && normPath(a) === normPath(b);

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function safeReaddir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function readRange(file, start, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, start);
    return buf.slice(0, n).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const readHead = (file, bytes = 65536) => readRange(file, 0, bytes);

function readTail(file, bytes) {
  const st = safeStat(file);
  if (!st) return '';
  const start = Math.max(0, st.size - bytes);
  const text = readRange(file, start, st.size - start);
  // Drop the partial first line when the read started mid-file.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

// The first JSONL line, however long: Codex's session_meta line embeds the full base
// instructions and is regularly over 20 KB. Returns null until the line is complete.
function readFirstLine(file, max = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let pos = 0;
    while (pos < max) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return null;
      const nl = buf.indexOf(10);
      if (nl >= 0 && nl < n) {
        chunks.push(Buffer.from(buf.slice(0, nl)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(buf.slice(0, n)));
      pos += n;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const claudeBase = () => process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const codexBase = () => process.env.CODEX_HOME || path.join(HOME, '.codex');
const cursorBase = () => process.env.CURSOR_CHATS_DIR || path.join(HOME, '.cursor', 'chats');

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function claudeProjectDir(cwd) {
  return path.join(claudeBase(), 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function claudeSessionFile(cwd, id) {
  const own = path.join(claudeProjectDir(cwd), `${id}.jsonl`);
  if (safeStat(own)) return own;
  // The session may have been started from another folder.
  const base = path.join(claudeBase(), 'projects');
  for (const d of safeReaddir(base)) {
    const f = path.join(base, d.name, `${id}.jsonl`);
    if (d.isDirectory() && safeStat(f)) return f;
  }
  return null;
}

function claudeSessionExists(cwd, id) {
  return !!id && !!claudeSessionFile(cwd, id);
}

// The session a running Claude process is on right now, read from its pid file.
// Claude rewrites the file on /clear and /resume, so it follows the conversation exactly.
function claudeLiveSession(pid, cwd, since) {
  if (!pid) return null;
  const file = path.join(claudeBase(), 'sessions', `${pid}.json`);
  const st = safeStat(file);
  // Ignore a file left behind by an earlier process that had the same pid.
  if (!st || st.mtimeMs < since - 10000) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.pid !== undefined && Number(j.pid) !== Number(pid)) return null;
    if (j.cwd && cwd && !samePath(j.cwd, cwd)) return null;
    if (j.startedAt && j.startedAt < since - 10000) return null;
    return typeof j.sessionId === 'string' ? j.sessionId : null;
  } catch (_) {
    return null; // being rewritten
  }
}

function claudeSessions(cwd, since) {
  const dir = claudeProjectDir(cwd);
  const out = [];
  for (const e of safeReaddir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const st = safeStat(path.join(dir, e.name));
    if (st && st.mtimeMs >= since) out.push({ id: e.name.slice(0, -6), birth: st.birthtimeMs || st.ctimeMs, t: st.mtimeMs });
  }
  return out;
}

function claudeTitle(cwd, nativeId) {
  const file = claudeSessionFile(cwd, nativeId);
  if (!file) return null;
  // Claude appends ai-title / custom-title lines as the conversation goes; the last one wins.
  const tail = readTail(file, 512 * 1024).split('\n');
  let ai = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line.includes('-title"') && !line.includes('"summary"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === 'custom-title' && j.customTitle) return j.customTitle;
      if (!ai && j.type === 'ai-title' && j.aiTitle) ai = j.aiTitle;
      if (!ai && j.type === 'summary' && j.summary) ai = j.summary;
    } catch (_) { /* skip */ }
  }
  if (ai) return ai;
  for (const line of readHead(file, 262144).split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const j = JSON.parse(line);
      const c = j.message && j.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null;
      if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').slice(0, 80);
    } catch (_) { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexDayDirs(since) {
  const base = path.join(codexBase(), 'sessions');
  const dirs = new Set();
  const now = Date.now();
  for (let t = Math.max(since - 86400000, now - 40 * 86400000); ; t += 86400000) {
    const d = new Date(Math.min(t, now));
    dirs.add(path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
    if (t >= now) break;
  }
  return [...dirs];
}

const codexMetaCache = new Map(); // rollout path -> { id, cwd }

function codexMeta(file, name) {
  if (codexMetaCache.has(file)) return codexMetaCache.get(file);
  const idMatch = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  const first = readFirstLine(file);
  if (first === null) return null; // first line still being written
  const meta = { id: idMatch ? idMatch[1] : null, cwd: null };
  try {
    const j = JSON.parse(first);
    const p = j.payload || j;
    meta.id = p.id || p.session_id || meta.id;
    meta.cwd = p.cwd || null;
  } catch (_) {
    const m = first.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (m) {
      try {
        meta.cwd = JSON.parse(`"${m[1]}"`);
      } catch (_) { /* leave null */ }
    }
  }
  codexMetaCache.set(file, meta);
  return meta;
}

function codexSessions(cwd, since) {
  const out = [];
  for (const dir of codexDayDirs(since)) {
    for (const e of safeReaddir(dir)) {
      if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
      const file = path.join(dir, e.name);
      const st = safeStat(file);
      if (!st || st.mtimeMs < since) continue;
      const meta = codexMeta(file, e.name);
      if (!meta || !meta.id || !samePath(meta.cwd, cwd)) continue;
      out.push({ id: meta.id, birth: st.birthtimeMs || st.ctimeMs, t: st.mtimeMs });
    }
  }
  return out;
}

let codexIndex = { mtime: -1, names: new Map() };
function codexTitle(nativeId) {
  const file = path.join(codexBase(), 'session_index.jsonl');
  const st = safeStat(file);
  if (!st) return null;
  if (st.mtimeMs !== codexIndex.mtime) {
    const names = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.id && j.thread_name) names.set(j.id, j.thread_name);
        } catch (_) { /* skip */ }
      }
    } catch (_) { /* unreadable */ }
    codexIndex = { mtime: st.mtimeMs, names };
  }
  return codexIndex.names.get(nativeId) || null;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function cursorSessions(cwd, since) {
  const out = [];
  for (const ws of safeReaddir(cursorBase())) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(cursorBase(), ws.name);
    for (const chat of safeReaddir(wsDir)) {
      if (!chat.isDirectory()) continue;
      const chatDir = path.join(wsDir, chat.name);
      let t = 0;
      for (const f of ['meta.json', 'store.db', 'store.db-wal']) {
        const st = safeStat(path.join(chatDir, f));
        if (st) t = Math.max(t, st.mtimeMs);
      }
      if (t < since) continue;
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8'));
      } catch (_) { /* not written yet */ }
      if (meta.cwd && !samePath(meta.cwd, cwd)) continue;
      const dirSt = safeStat(chatDir);
      out.push({ id: chat.name, birth: meta.createdAtMs || (dirSt ? dirSt.birthtimeMs : t), t, title: meta.title || null });
    }
  }
  return out;
}

function cursorTitle(nativeId) {
  for (const ws of safeReaddir(cursorBase())) {
    const meta = path.join(cursorBase(), ws.name, nativeId, 'meta.json');
    if (safeStat(meta)) {
      try {
        return JSON.parse(fs.readFileSync(meta, 'utf8')).title || null;
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

// Conversations of an agent in a folder that were written to since `since`:
// [{ id, birth, t, title? }], most recently written first.
function listSessions(agentId, cwd, since) {
  let out = [];
  if (agentId === 'claude') out = claudeSessions(cwd, since);
  else if (agentId === 'codex') out = codexSessions(cwd, since);
  else if (agentId === 'cursor') out = cursorSessions(cwd, since);
  return out.sort((a, b) => b.t - a.t);
}

// The title the agent itself gave the conversation, when it keeps one.
function nativeTitle(agentId, cwd, nativeId) {
  if (!nativeId) return null;
  if (agentId === 'claude') return claudeTitle(cwd, nativeId);
  if (agentId === 'codex') return codexTitle(nativeId);
  if (agentId === 'cursor') return cursorTitle(nativeId);
  return null;
}

module.exports = {
  listSessions,
  claudeLiveSession,
  claudeSessionExists,
  nativeTitle,
  samePath,
  normPath,
};
