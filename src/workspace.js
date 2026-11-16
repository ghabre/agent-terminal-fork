'use strict';
// ni-agentic-development workspace awareness.
//
// The workspace is a shared root (README.md, AGENTS.md, CLAUDE.md, docs/) with the
// product and PS repositories checked out as independent Git repos under repos/.
// Agents are started either at the root, so they load the shared instructions, or
// inside one repo under repos/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE_NAME = 'ni-agentic-development';

function isWorkspace(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'AGENTS.md')).isFile() &&
      fs.statSync(path.join(dir, 'repos')).isDirectory()
    );
  } catch (_) {
    return false;
  }
}

// Search order: explicit setting, NI_WORKSPACE, folders above the exe, common checkout roots.
function detectRoot(configured, exeDir) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.env.NI_WORKSPACE) candidates.push(process.env.NI_WORKSPACE);
  for (let d = exeDir; d && path.dirname(d) !== d; d = path.dirname(d)) {
    candidates.push(d, path.join(d, WORKSPACE_NAME));
  }
  const home = os.homedir();
  for (const base of ['source/AzureRepos', 'source/repos', 'repos', 'src', 'Documents/GitHub', '']) {
    candidates.push(path.join(home, base, WORKSPACE_NAME));
  }
  return candidates.find(isWorkspace) || null;
}

function readBranch(repoDir) {
  try {
    const gitPath = path.join(repoDir, '.git');
    let gitDir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(repoDir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 8);
  } catch (_) {
    return null;
  }
}

function describe(root) {
  if (!root) return { root: null, valid: false, dirs: [] };
  const valid = isWorkspace(root);
  const dirs = [{ path: root, name: path.basename(root), kind: 'root', branch: readBranch(root) }];
  const reposDir = path.join(root, 'repos');
  let entries = [];
  try {
    entries = fs.readdirSync(reposDir, { withFileTypes: true });
  } catch (_) { /* no repos yet */ }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(reposDir, e.name);
    if (!fs.existsSync(path.join(full, '.git'))) continue;
    dirs.push({ path: full, name: e.name, kind: 'repo', branch: readBranch(full) });
  }
  dirs.sort((a, b) => (a.kind === 'root' ? -1 : b.kind === 'root' ? 1 : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
  return { root, valid, dirs };
}

// Short label for a working directory relative to the workspace.
function labelFor(root, cwd) {
  if (!cwd) return '';
  if (root) {
    const rel = path.relative(root, cwd);
    if (!rel) return path.basename(root);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const parts = rel.split(path.sep);
      return parts[0] === 'repos' && parts[1] ? parts.slice(1).join('/') : rel.split(path.sep).join('/');
    }
  }
  return path.basename(cwd) || cwd;
}

module.exports = { detectRoot, describe, labelFor, readBranch, isWorkspace, WORKSPACE_NAME };
