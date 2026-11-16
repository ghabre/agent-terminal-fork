# NI Agent Terminal

A Windows multi-tab terminal for **Claude Code**, **Codex** and **Cursor Agent** (plus a shell tab) that works in any folders you choose. Every conversation is recorded in a per-folder, per-agent history and can be resumed exactly through the agent's own session store.

## Run

- `distNI-Agent-Terminal-1.2.0-portable.exe`: single file, no install.
- `distNI-Agent-Terminal-1.2.0-setup.exe`: per-user installer with Start menu entry.

## Setup

On first start a Setup screen asks for:

- **Workspace folders**: any number of folders (a monorepo, a folder of checkouts, a single project…). New tabs open in the first one. Every Git repository inside them, up to two levels down (`<folder>/<repo>` or `<folder>/repos/<repo>`), is listed with its current branch in the new-tab folder picker and in History's *Folder* view.
- **Agents**, each of them:
  - **On / off**: switched-off agents are hidden from menus and shortcuts.
  - **Command**: a name on `PATH` (default `claude`, `codex`, `cursor-agent`, `powershell.exe`) or a full path to an `.exe` / `.cmd`. Setup shows where each resolves. `%APPDATA%
pm`, `%LOCALAPPDATA%cursor-agent` and `~/.local/bin` are searched as well.
  - **Account folder** (Claude, Codex): a separate config folder, passed as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so the agent runs under another login with its own conversation store. Leave it empty for your normal login. Each history record remembers the folder it was created with, so resuming it and following its `/clear` / `/new` keep using the right store. Cursor Agent has no such option and uses its normal login.

Change all of this later in **Settings → Workspaces & agents**, or click *workspace* in the status bar. If you upgrade from 1.1, the old `ni-agentic-development` folder is carried over as the first workspace folder, and Setup is shown once.

Every tab gets `AGENT_TERMINAL_WORKSPACE=<workspace folder>` and `AGENT_TERMINAL_SESSION=<history id>`. The 1.x names `NI_WORKSPACE` / `NI_AGENT_TERMINAL_SESSION` are still set too. Agent session markers inherited from a parent agent (`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_SANDBOX*`, …) are stripped. Otherwise a tab opened from an app started inside Claude Code would run as a child session with transcripts disabled.

## History

Saved per working folder, then per agent, in `%APPDATA%\NI Agent Terminal\history\`:

| File | Content |
|---|---|
| `index.json` | One record per conversation: agent, folder, native session id, title, runs, timestamps |
| `folders\<folder>\folder.json` | The folder's full path (`<folder>` is its name plus a short hash, e.g. `FRAMEWORK-1a2b3c4d`) |
| `folders\<folder>\<agent>\<id>.log` | Raw terminal output of every run (ANSI kept, used by *Replay*), capped at 25 MB |
| `folders\<folder>\<agent>\<id>.txt` | Plain-text transcript, saved on every Enter, every 30 s, on exit and on close; runs are appended |
| `folders\<folder>\<agent>\<id>.prompts.jsonl` | Prompts / commands sent in that conversation, one `{t, text}` per line |

History from 1.0 (flat `<agent>\` folders) is moved into this layout on first start; the old index is kept as `index.v1.bak.json`.

**One record per conversation, not per tab.** Running `/clear` or `/new` in a tab starts a new conversation, and `/resume` switches to another one. The tab follows the switch: the new conversation gets its own record, and the old one stays in History, resumable. A conversation where nothing but slash commands was sent is reused instead of kept.
- Claude: read exactly from Claude's per-process file `~/.claude/sessions/<pid>.json`. Claude also gets its id up front (`--session-id`).
- Codex (`~/.codex/sessions/**/rollout-*.jsonl`) and Cursor (`~/.cursor/chats/*/<id>/meta.json`): a conversation that appears in the tab's folder is matched to the tab in which Enter was just pressed.

Resuming a record runs `claude --resume <id>`, `codex resume <id>` or `cursor-agent --resume <id>`. Titles come from the agents: Claude's AI or custom title, Codex's thread name (`~/.codex/session_index.jsonl`), Cursor's chat title. The *Last* and *Pick…* buttons in the new-tab menu use each agent's own continue/picker. If the conversation picked is already in History, the tab joins that record.

**History panel** (Ctrl+Shift+H):
- *This tab*: every conversation the tab went through (current one marked), then every prompt or command sent from it, newest first, across restarts, resumes and `/clear`. It has search and *Copy all*. Click a prompt to insert it, double-click or ⏎ to send it again. The line is rebuilt from your keystrokes (typing, paste, arrows, Backspace, Ctrl+W/U/K, Shift+Enter). Some lines are skipped: a single-key menu answer in an agent tab, and an agent prompt recalled with Up/Down. In a shell tab, a recalled or Tab-completed line is read back from the screen.
- *Folder*: the sessions started in one folder, which defaults to the active tab's. Pick another folder from the list (workspace folders, the Git repositories in them, any folder with history) and filter by agent. *Import N* appears when an agent's own store has conversations for that folder that History has none for: started outside the app, or lost before 1.1. Imported ones resume like any other.
- *All*: every session in every folder, filterable by agent.

*Files* opens the history folder on disk (the selected folder's, in the *Folder* view).

Open tabs are saved on close and resumed on the next start. A tab only starts its agent when it is first shown.

## Keys

| Key | Action |
|---|---|
| Ctrl+Shift+T | New tab menu (folder, agent, Last / Pick…) |
| Ctrl+Shift+1 / 2 / 3 / 4 | New Claude / Codex / Cursor / Shell in the current tab's folder |
| Ctrl+Tab, Ctrl+PgUp/PgDn | Switch tabs (tabs can also be dragged) |
| Ctrl+Shift+W, middle-click | Close tab |
| Ctrl+Shift+H | History panel (*This tab* prompts / *All sessions*) |
| Ctrl+Shift+F | Find in terminal |
| Ctrl+C with selection, Ctrl+Shift+C | Copy |
| Ctrl+V, right-click | Paste (an image-only clipboard is passed to the agent) |
| Shift+Enter | Newline in the agent prompt |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font size |
| Enter on an exited tab | Resume it |

Dropping files on a terminal inserts their quoted paths.

## Develop

```powershell
npm install
npm start               # run from source
npm run check           # syntax check
npm run dist            # portable + installer exe into dist\
```

Smoke testing: `NI_TERM_USERDATA` uses an isolated data folder. `NI_TERM_SMOKE=<png>` takes a screenshot and quits after `NI_TERM_SMOKE_DELAY` ms. `NI_TERM_SMOKE_JS` runs a script in the window halfway through.

Build note: without Windows Developer Mode, electron-builder fails to unpack `winCodeSign` (macOS symlinks). Extract it once without the `darwin` folder:

```powershell
$c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
& .\node_modules\7zip-bin\win\x64\7za.exe x -y "-o$c\winCodeSign-2.6.0" (Get-ChildItem $c -Filter *.7z)[0].FullName '-xr!darwin'
```

Stack: Electron 33, xterm.js 5.5, node-pty 1.1 (ConPTY, N-API prebuilds, so no native rebuild), electron-builder 25.

## License

MIT, see [LICENSE](LICENSE).
