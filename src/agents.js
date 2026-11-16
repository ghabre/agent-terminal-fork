'use strict';
// Agent definitions, command resolution and native-session discovery.
//
// Every agent keeps its own conversation store; this module only needs to know
// enough about each store to find the session a tab created, so that the tab can
// later be resumed with the agent's own --resume flag.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    color: '#d97757',
    // Claude accepts a caller-chosen session id, so the id is known before launch.
    presetId: true,
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['--resume', nativeId];
      if (mode === 'new' && nativeId) return ['--session-id', nativeId];
      if (mode === 'continue') return ['--continue'];
      if (mode === 'picker') return ['--resume'];
      return [];
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    color: '#10a37f',
    presetId: false,
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['resume', nativeId];
      if (mode === 'continue') return ['resume', '--last'];
      if (mode === 'picker') return ['resume'];
      return [];
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    command: 'cursor-agent',
    color: '#7c8cff',
    presetId: false,
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['--resume', nativeId];
      if (mode === 'continue') return ['resume'];
      if (mode === 'picker') return ['ls'];
      return [];
    },
  },
  shell: {
    id: 'shell',
    label: 'Shell',
    command: 'powershell.exe',
    color: '#8a8f98',
    presetId: false,
    args() {
      return ['-NoLogo'];
    },
  },
};

// Folders where the agent installers put their shims; a GUI launched from
// Explorer does not always inherit a PATH that already contains them.
function extraPathDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'cursor-agent'));
  dirs.push(path.join(HOME, '.local', 'bin'));
  return dirs;
}

const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_NEW_ROOT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_SESSION_*',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_NEW_ROOT',
  'CODEX_SANDBOX*',
  'CODEX_THREAD_ID',
  'CURSOR_AGENT_SESSION*',
  'AI_AGENT',
  'NI_TERM_*',
];

function buildEnv(extra) {
  const env = { ...process.env };
  const sep = path.delimiter;
  const current = (env.Path || env.PATH || '').split(sep).filter(Boolean);
  for (const d of extraPathDirs()) {
    if (!current.some((c) => c.toLowerCase() === d.toLowerCase())) current.push(d);
  }
  delete env.PATH;
  env.Path = current.join(sep);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.ELECTRON_RUN_AS_NODE;
  // If this app was itself launched from inside an agent session, the per-session
  // markers would leak into every tab: Claude, for one, then treats the tab as a child
  // session and stops saving its transcript, which breaks resume and history.
  for (const name of Object.keys(env)) {
    if (SESSION_MARKERS.some((m) => (m.endsWith('*') ? name.startsWith(m.slice(0, -1)) : name === m))) delete env[name];
  }
  return { ...env, ...extra };
}

function which(name, env) {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const dirs = (env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = path.extname(name) ? [''] : ['.exe', '.cmd', '.bat', '.ps1'];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

// Quote one argument for a Windows command line (CommandLineToArgvW rules).
function quoteArg(arg) {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// npm writes .cmd shims that just forward to an .exe or a node script. Launching
// the target directly avoids cmd.exe's "Terminate batch job (Y/N)?" on Ctrl+C.
function unwrapShim(cmdPath) {
  let text;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch (_) {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const exe = text.match(/"%dp0%\\([^"]+\.exe)"/i);
  if (exe) {
    const target = path.join(dir, exe[1]);
    if (fs.existsSync(target)) return { file: target, pre: [] };
  }
  const js = text.match(/"%dp0%\\([^"]+\.js)"/i);
  if (js) {
    const target = path.join(dir, js[1]);
    const nodeExe = fs.existsSync(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : 'node.exe';
    if (fs.existsSync(target)) return { file: nodeExe, pre: [target] };
  }
  return null;
}

// Returns { file, args } where args is a single pre-quoted string, which is how
// node-pty passes a command line through unchanged on Windows.
function resolveLaunch(agentId, mode, nativeId, extraArgs, env) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const resolved = which(agent.command, env);
  if (!resolved) {
    throw new Error(`'${agent.command}' was not found on PATH. Install it or add its folder to PATH.`);
  }
  const args = [...agent.args(mode, nativeId), ...splitArgs(extraArgs)];
  const ext = path.extname(resolved).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    const shim = unwrapShim(resolved);
    if (shim) {
      const file = which(shim.file, env) || shim.file;
      return { file, args: [...shim.pre, ...args].map(quoteArg).join(' '), display: [agent.command, ...args].join(' ') };
    }
    const inner = [resolved, ...args].map(quoteArg).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${inner}"`, display: [agent.command, ...args].join(' ') };
  }
  if (ext === '.ps1') {
    const all = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args];
    return { file: 'powershell.exe', args: all.map(quoteArg).join(' '), display: [agent.command, ...args].join(' ') };
  }
  return { file: resolved, args: args.map(quoteArg).join(' '), display: [agent.command, ...args].join(' ') };
}

// Splits a user-entered extra-arguments string, honouring double quotes.
function splitArgs(str) {
  if (!str || !str.trim()) return [];
  const out = [];
  const re = /"((?:\\"|[^"])*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

module.exports = { AGENTS, buildEnv, resolveLaunch };
