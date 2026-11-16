# NI Agent Terminal

A Windows multi-tab terminal for **Claude Code**, **Codex** and **Cursor Agent** (plus a PowerShell tab), built for the `ni-agentic-development` workspace. Every tab is recorded in a per-agent history and can be resumed exactly through the agent's own session store.

## Run

- `dist\NI-Agent-Terminal-1.1.0-portable.exe`: single file, no install.
- `dist\NI-Agent-Terminal-1.1.0-setup.exe`: per-user installer with Start menu entry.

Requires the agent CLIs on `PATH` (`claude`, `codex`, `cursor-agent`). `%APPDATA%\npm` and `%LOCALAPPDATA%\cursor-agent` are added automatically.

## Workspace integration

On first start the app finds `ni-agentic-development` (setting → `NI_WORKSPACE` → folders above the exe → `~/source/AzureRepos`, `~/source/repos`, …). It is recognised by `AGENTS.md` plus `repos/`.

- New tabs start at the workspace root, so the agents load the shared `AGENTS.md` / `CLAUDE.md`. The folder picker also lists every Git checkout under `repos/` with its current branch.
- Every tab gets `NI_WORKSPACE=<root>` and `NI_AGENT_TERMINAL_SESSION=<history id>`.
- Agent session markers inherited from a parent agent (`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_SANDBOX*`, …) are stripped. Otherwise a tab opened from an app started inside Claude Code would run as a child session with transcripts disabled.

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
- *Folder*: the sessions started in one folder, which defaults to the active tab's. Pick another folder from the list (workspace root, `repos/*`, any folder with history) and filter by agent. *Import N* appears when an agent's own store has conversations for that folder that History has none for: started outside the app, or lost before 1.1. Imported ones resume like any other.
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
