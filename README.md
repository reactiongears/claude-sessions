# claude-sessions (`cs`)

A fast, zero-dependency terminal UI for **browsing and resuming Claude Code
sessions** — built for the moment you have several sessions running in the same
project folder and `claude --resume` becomes a guessing game of timestamps.

Instead of scrolling a flat list of dates, you get titled, searchable rows with
a live indicator, and pressing **Enter** drops you straight back into the
session — in its original working directory.

```
 Claude Sessions — ~/Documents/_dev · 2 sessions
 type to filter…

 ❯ ● Build CLI for managing multiple concurrent Claude sessions
     21s ago · 14 msgs · 161 KB · a4b04c4a · main
   ○ Debug Claude Code hanging in art-web folder
     25d ago ·  7 msgs · 307 KB · de82dc58

 ↑↓ move · enter resume · → details · tab all projects · esc quit
```

> `●` = green, this session's file changed in the last 5 minutes (probably
> running right now). `○` = idle. `❯` marks the current selection.

---

## Why this exists

Claude Code stores every session as a `.jsonl` file under
`~/.claude/projects/<encoded-cwd>/`. The built-in `--resume` picker is great
when there's one session per folder — but if you run multiple concurrent
sessions in the same project (a refactor here, a bug hunt there), they all pile
into the same list and the only thing distinguishing them is a timestamp.

`cs` reads the same files, pulls out each session's **AI-generated title**,
first/last message, message counts and git branch, and presents them as a
searchable menu. No more "which `de82dc58` was the auth one?"

---

## Install

### Option A — npm (recommended)

```bash
npm install -g claude-session-picker
```

This installs two commands: **`claude-sessions`** and the short alias **`cs`**.

> Heads up: the short `cs` name can collide with other tools (Coursier,
> dotnet-script). If you already use `cs` for something else, just use the
> `claude-sessions` command instead.

### Option B — run without installing

```bash
npx claude-session-picker
```

### Option C — straight from GitHub

```bash
npm install -g github:reactiongears/claude-sessions
```

Requires **Node.js ≥ 18**. No other dependencies.

---

## Usage

```bash
cs                 # pick a session for the current folder
cs auth            # open with "auth" pre-filtered
cs --all           # browse sessions across ALL project folders
cs --list          # non-interactive: print a table and exit
cs --empty         # include sessions that have zero user messages
cs --help          # full help
```

Run `cs` with no arguments inside a project and you'll see only that folder's
sessions. Hit **Tab** to fan out to every project on your machine.

---

## Navigating the menu

### Main list

```
 Claude Sessions — ~/Documents/_dev · 4 sessions
 filter: auth▏

 ❯ ● Implement auth middleware and session refresh
     2m ago · 31 msgs · 1.2 MB · 1a4844c7 · feature/auth
   ○ Audit auth token expiry bug
     1h ago · 12 msgs · 408 KB · e41dc1c1 · main
   ○ Add OAuth provider login
     3d ago ·  9 msgs · 220 KB · 7755b94b · main

 ↑↓ move · enter resume · → details · tab all projects · esc quit
```

| Key        | Action                                              |
|------------|-----------------------------------------------------|
| `↑` / `↓`  | Move the selection                                  |
| **type**   | Live-filter by title, first message, id, or project |
| `Enter`    | Resume the highlighted session                      |
| `→`        | Open the detail view for the highlighted session    |
| `Tab`      | Toggle between **this folder** and **all projects** |
| `Backspace`| Delete a character from the filter                  |
| `Esc`      | Clear the filter — press again to quit              |
| `Ctrl-C`   | Quit immediately                                    |

### Filtering as you type

Just start typing — no command needed. Every space-separated word must match
somewhere in the row, so `auth refresh` narrows to sessions mentioning both.

```
 Claude Sessions — ~/Documents/_dev · 1 session
 filter: auth refresh▏

 ❯ ● Implement auth middleware and session refresh
     2m ago · 31 msgs · 1.2 MB · 1a4844c7 · feature/auth

 ↑↓ move · enter resume · → details · tab all projects · esc quit
```

### All-projects view (`Tab` or `cs --all`)

When browsing everything, each row gains a project tag so you can tell where it
lives:

```
 Claude Sessions — all projects · 58 sessions
 type to filter…

 ❯ ● Implement auth middleware and session refresh   ~/Documents/_dev
     2m ago · 31 msgs · 1.2 MB · 1a4844c7 · feature/auth
   ○ Draft offer letter for new hire                  ~/Documents/_dev/reactiongears
     3m ago · 13 msgs · 2.4 MB · 1a4844c7
   ○ Set up new uConsole CM5 device                   ~/Documents/_maker/uConsole
     4h ago · 29 msgs · 3.1 MB · b5416a3f

 ↑↓ move · enter resume · → details · tab this project · esc quit
```

### Detail view (`→`)

Press `→` on any session to inspect it before committing — handy when two
sessions have similar titles:

```
 Implement auth middleware and session refresh

 session   1a4844c7-3ab2-4765-9e43-e2718ec75783
 folder    ~/Documents/_dev
 branch    feature/auth
 activity  2m ago (last) · started 6/12/2026, 3:14:02 PM
 messages  31 user · 44 assistant · 1.2 MB
 version   2.1.143

 first message
   can you add auth middleware that refreshes the session token
   when it's within 5 minutes of expiry

 last message
   great, now write a test for the refresh edge case

 enter resume · ← back · esc quit
```

From here, `Enter` resumes and `←` goes back to the list.

---

## What each row tells you

```
 ❯ ● Implement auth middleware and session refresh
     2m ago · 31 msgs · 1.2 MB · 1a4844c7 · feature/auth
   │ │     │           │         │          └─ git branch (if not HEAD)
   │ │     │           │         └─ short session id
   │ │     │           └─ file size on disk
   │ │     └─ count of your (non-noise) messages
   │ └─ time since the session was last touched
   └─ live: ● = active in last 5 min, ○ = idle
```

The **title** is Claude Code's own AI-generated summary of the session. If a
session is too new to have one yet, `cs` falls back to your first message.

---

## How it works

- Scans `~/.claude/projects/<encoded-cwd>/*.jsonl`, streaming each file once to
  extract title, first/last user message, timestamps, branch and counts.
- Caches that metadata in `~/.cache/claude-sessions-cache.json`, keyed by file
  mtime + size — so after the first scan, repeat runs are **~50 ms** even across
  dozens of large sessions.
- Resuming simply runs `claude --resume <session-id>` with the session's
  original working directory, so you land exactly where you left off.

Nothing is written to your session files; `cs` is read-only apart from its own
cache.

---

## Development

```bash
git clone https://github.com/reactiongears/claude-sessions.git
cd claude-sessions
npm link        # provides the global `cs` / `claude-sessions` commands
cs --list       # sanity check
```

It's a single file — `index.js`, ~450 lines, no dependencies. PRs welcome.

---

## License

MIT © reactiongears
