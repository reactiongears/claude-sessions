# claude-sessions (`cs`)

A fast, zero-dependency terminal UI for **browsing and resuming Claude Code
sessions** — built for the moment you have several sessions running in the same
project folder and `claude --resume` becomes a guessing game of timestamps.

Instead of scrolling a flat list of dates, you get titled, searchable rows with
a live indicator and a **scrollable preview of the conversation**, and pressing
**Enter** drops you straight back into the session — in its original working
directory.

```
 Claude Sessions — ~/Documents/_dev · 2 sessions
 type to filter…

   ● Build CLI for managing multiple concurrent Claude sessions
     21s ago · 14 msgs · 161 KB · a4b04c4a · main
 ❯ ○ Debug Claude Code hanging in art-web folder
     25d ago ·  7 msgs · 307 KB · de82dc58

 ╶─ preview · last 3 of 41 · → more · ← less ─╴
   The hang was a stale lock file in ~/.claude.
   Removing it and restarting cleared the descriptor error.
   Want me to run that and check for other oversized sessions?
 ↑↓ move · enter resume · →/← preview · tab all projects · esc quit
```

> `●` = green, this session's file changed in the last 5 minutes (probably
> running right now). `○` = idle. `❯` marks the current selection. The preview
> pane shows the tail of the highlighted conversation.

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

Clone the repo and link it globally:

```bash
git clone https://github.com/reactiongears/claude-sessions.git
cd claude-sessions
npm link
```

That installs two commands: **`cs`** and the longer alias **`claude-sessions`**.
Run `cs` from any project folder and you're off.

> Heads up: the short `cs` name can collide with other tools (Coursier,
> dotnet-script). If you already use `cs` for something else, use the
> `claude-sessions` command instead — or alias it to whatever you like.

**Requirements:** Node.js ≥ 18. No other dependencies.

**Updating:** `git pull` inside the cloned folder — the linked command picks up
changes automatically, no reinstall needed.

**Uninstalling:** `npm unlink -g claude-session-picker` (or just delete the
clone and run `npm unlink` from it).

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

 ╶─ preview · last 3 of 58 · → more · ← less ─╴
   Added the refresh guard and a test for the 5-minute edge case.
   All 14 tests pass.
   Anything else you want hardened before I push?
 ↑↓ move · enter resume · →/← preview · tab all projects · esc quit
```

| Key         | Action                                              |
|-------------|-----------------------------------------------------|
| `↑` / `↓`   | Move the selection (preview follows)                |
| `→`         | Show **one more** sentence in the preview           |
| `←`         | Show **one fewer** sentence in the preview          |
| **type**    | Live-filter by title, first message, id, or project |
| `Enter`     | Resume the highlighted session                      |
| `Tab`       | Toggle between **this folder** and **all projects** |
| `Backspace` | Delete a character from the filter                  |
| `Esc`       | Clear the filter — press again to quit              |
| `Ctrl-C`    | Quit immediately                                    |

Your chosen preview depth is **sticky** — set it once with `→`/`←` and every
session you arrow to shows that many sentences.

### Filtering as you type

Just start typing — no command needed. Every space-separated word must match
somewhere in the row, so `auth refresh` narrows to sessions mentioning both.

```
 Claude Sessions — ~/Documents/_dev · 1 session
 filter: auth refresh▏

 ❯ ● Implement auth middleware and session refresh
     2m ago · 31 msgs · 1.2 MB · 1a4844c7 · feature/auth

 ╶─ preview · last 3 of 58 · → more · ← less ─╴
   Added the refresh guard and a test for the 5-minute edge case.
   All 14 tests pass.
   Anything else you want hardened before I push?
 ↑↓ move · enter resume · →/← preview · tab all projects · esc quit
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

 ╶─ preview · last 3 of 58 · → more · ← less ─╴
   Added the refresh guard and a test for the 5-minute edge case.
   All 14 tests pass.
   Anything else you want hardened before I push?
 ↑↓ move · enter resume · →/← preview · tab this project · esc quit
```

### Preview pane (`→` / `←`)

The pane below the list always shows the **tail of the highlighted
conversation** — the last few sentences of what you and Claude were saying,
spanning both your messages and Claude's replies. It updates instantly as you
move the selection, so you can recognize a session by its content, not just its
title.

- Press `→` to reveal **one more** sentence (reading further back).
- Press `←` to peel one back off.
- Starts at 3 sentences; the depth you pick sticks across the whole list.

```
 ╶─ preview · last 6 of 58 · → more · ← less ─╴
   You: can you also handle the case where the token is already expired
   Good catch — if it's already past expiry I now force a full re-auth
   instead of a silent refresh, and surface a clear error to the caller.
   Added the refresh guard and a test for the 5-minute edge case.
   All 14 tests pass.
   Anything else you want hardened before I push?
```

`You:` marks your messages; unprefixed lines are Claude's.

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
  extract title, first/last user message, the conversation tail (for the
  preview pane), timestamps, branch and counts.
- Caches that metadata in `~/.cache/claude-sessions-cache.json`, keyed by file
  mtime + size — so after the first scan, repeat runs are **~50 ms** even across
  dozens of large sessions.
- Resuming simply runs `claude --resume <session-id>` with the session's
  original working directory, so you land exactly where you left off.

Nothing is written to your session files; `cs` is read-only apart from its own
cache.

---

## Development

Follow the [Install](#install) steps, then edit away — `npm link` symlinks the
clone, so changes take effect immediately. Sanity-check with `cs --list`.

It's a single file — `index.js`, ~500 lines, no dependencies. PRs welcome.

---

## License

MIT © reactiongears
