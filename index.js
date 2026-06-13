#!/usr/bin/env node
'use strict';

/**
 * cs — Claude session browser & resumer.
 *
 * Scans ~/.claude/projects/<encoded-cwd>/*.jsonl, shows an interactive
 * picker (title, age, message count, live indicator), and resumes the
 * selected session via `claude --resume <id>`.
 *
 * Zero dependencies. Node >= 18.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CACHE_FILE = path.join(os.homedir(), '.cache', 'claude-sessions-cache.json');
const CACHE_VERSION = 2; // bump when scanned meta shape changes (invalidates old cache)
const LIVE_THRESHOLD_MS = 5 * 60 * 1000; // mtime within 5 min => probably running
const PREVIEW_DEFAULT = 3; // sentences shown in the preview pane by default
const PREVIEW_MAX = 40; // ceiling for → expansion
const TAIL_MAX_CHARS = 6000; // how much trailing conversation text to retain per session

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.filter((a) => !a.startsWith('-'));

if (flags.has('--help') || flags.has('-h')) {
  console.log(`cs — browse & resume Claude Code sessions

Usage: cs [query] [options]

  cs              pick a session for the current project folder
  cs auth         pre-filter sessions matching "auth"
  cs --all        sessions across ALL project folders
  cs --list       non-interactive: print the table and exit
  cs --empty      include sessions with zero user messages

Keys: ↑/↓ move · enter resume · type to filter · →/← preview more/less · tab all/here · esc quit`);
  process.exit(0);
}

const optAll = flags.has('--all') || flags.has('-a');
const optList = flags.has('--list') || flags.has('-l');
const optEmpty = flags.has('--empty');
const initialFilter = positional.join(' ');

// ---------------------------------------------------------------- helpers

function encodeProjectPath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function relTime(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(str, width) {
  if (str.length <= width) return str;
  return str.slice(0, Math.max(0, width - 1)) + '…';
}

// Greedy word-wrap; hard-breaks any single token longer than width.
function wordWrap(str, width) {
  const lines = [];
  let line = '';
  for (const word of str.split(' ')) {
    if (word.length > width) {
      if (line) { lines.push(line); line = ''; }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
  }
  return '';
}

// Split a blob of conversation text into display "sentences". Newlines act as
// hard boundaries (so lists/code don't merge into run-ons), and within a line
// we break on . ! ? terminators.
function splitSentences(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const norm = line.replace(/\s+/g, ' ').trim();
    if (!norm) continue;
    // Break only on a terminator followed by whitespace, so dots inside paths,
    // versions and decimals (e.g. ~/.claude, 2.1.143, 0.5) don't split.
    for (const p of norm.split(/(?<=[.!?])\s+/)) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function isNoise(text) {
  if (!text) return true;
  const t = text.trimStart();
  return (
    t.startsWith('<') || // <command-name>, <local-command-stdout>, <system-reminder>…
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted')
  );
}

// ---------------------------------------------------------------- cache

let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (cache.__v !== CACHE_VERSION) cache = { __v: CACHE_VERSION };
} catch {
  cache = { __v: CACHE_VERSION };
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    /* cache is best-effort */
  }
}

// ---------------------------------------------------------------- scanning

function scanSessionFile(filePath) {
  return new Promise((resolve) => {
    const meta = {
      aiTitle: null,
      firstUserText: null,
      lastUserText: null,
      tailText: '',
      cwd: null,
      gitBranch: null,
      version: null,
      userCount: 0,
      assistantCount: 0,
      firstTs: null,
      lastTs: null,
    };

    // Rolling buffer of the most recent meaningful message texts (both roles).
    // We keep more than we need, then trim to TAIL_MAX_CHARS at the end.
    const recent = [];
    const pushRecent = (role, text) => {
      recent.push(role === 'user' ? `You: ${text}` : text);
      if (recent.length > 16) recent.shift();
    };

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      // Cheap string probes before paying for JSON.parse on big files.
      const tsMatch = line.lastIndexOf('"timestamp":"');
      if (tsMatch !== -1) {
        const ts = line.slice(tsMatch + 13, tsMatch + 13 + 24).split('"')[0];
        if (!meta.firstTs) meta.firstTs = ts;
        meta.lastTs = ts;
      }

      if (line.includes('"type":"ai-title"')) {
        try {
          const d = JSON.parse(line);
          if (d.aiTitle) meta.aiTitle = d.aiTitle;
        } catch {}
        return;
      }

      const isSidechain = line.includes('"isSidechain":true');
      if (isSidechain) return;

      if (line.includes('"type":"assistant"')) {
        meta.assistantCount++;
        try {
          const d = JSON.parse(line);
          if (d.message && d.message.role === 'assistant') {
            const text = extractText(d.message.content);
            if (text) pushRecent('assistant', text);
          }
        } catch {}
        return;
      }

      if (line.includes('"type":"user"')) {
        try {
          const d = JSON.parse(line);
          if (!d.message || d.message.role !== 'user') return;
          if (!meta.cwd && d.cwd) meta.cwd = d.cwd;
          if (d.gitBranch) meta.gitBranch = d.gitBranch;
          if (d.version) meta.version = d.version;
          const text = extractText(d.message.content);
          if (isNoise(text)) return;
          meta.userCount++;
          if (!meta.firstUserText) meta.firstUserText = text;
          meta.lastUserText = text;
          pushRecent('user', text);
        } catch {}
      } else if (!meta.cwd && line.includes('"cwd":"')) {
        try {
          const d = JSON.parse(line);
          if (d.cwd) meta.cwd = d.cwd;
          if (d.gitBranch) meta.gitBranch = d.gitBranch;
          if (d.version) meta.version = d.version;
        } catch {}
      }
    });

    rl.on('close', () => {
      let tail = recent.join('\n');
      if (tail.length > TAIL_MAX_CHARS) tail = tail.slice(tail.length - TAIL_MAX_CHARS);
      meta.tailText = tail;
      resolve(meta);
    });
    stream.on('error', () => resolve(meta));
  });
}

async function loadSessions(projectDirs) {
  const sessions = [];
  const jobs = [];

  for (const dir of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const filePath = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      const id = f.replace(/\.jsonl$/, '');
      const cacheKey = filePath;
      const cached = cache[cacheKey];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        sessions.push({ id, filePath, projectDir: dir, mtimeMs: st.mtimeMs, size: st.size, ...cached.meta });
      } else {
        jobs.push(
          scanSessionFile(filePath).then((meta) => {
            cache[cacheKey] = { mtimeMs: st.mtimeMs, size: st.size, meta };
            sessions.push({ id, filePath, projectDir: dir, mtimeMs: st.mtimeMs, size: st.size, ...meta });
          })
        );
      }
    }
  }

  await Promise.all(jobs);
  saveCache();

  let result = sessions;
  if (!optEmpty) result = result.filter((s) => s.userCount > 0);
  result.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return result;
}

function projectLabel(projectDir, sessionCwd) {
  if (sessionCwd) return sessionCwd.replace(os.homedir(), '~');
  return path.basename(projectDir);
}

function titleOf(s) {
  if (s.aiTitle) return s.aiTitle;
  if (s.firstUserText) return s.firstUserText.replace(/\s+/g, ' ').trim();
  return '(no messages)';
}

function isLive(s) {
  return Date.now() - s.mtimeMs < LIVE_THRESHOLD_MS;
}

// ---------------------------------------------------------------- list mode

function printList(sessions, scopeLabel) {
  console.log(`Claude sessions — ${scopeLabel}\n`);
  if (sessions.length === 0) {
    console.log('  (none found)');
    return;
  }
  for (const s of sessions) {
    const live = isLive(s) ? '●' : ' ';
    const proj = optAll ? `  [${projectLabel(s.projectDir, s.cwd)}]` : '';
    console.log(` ${live} ${truncate(titleOf(s), 70)}${proj}`);
    console.log(`     ${relTime(s.mtimeMs).padEnd(9)} ${String(s.userCount).padStart(3)} msgs  ${fmtSize(s.size).padEnd(8)} ${s.id}`);
  }
  console.log('\nResume with: claude --resume <session-id>');
}

// ---------------------------------------------------------------- TUI

const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  inverse: `${ESC}7m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
  magenta: `${ESC}35m`,
};

function tui(allSessions, scopeLabel, hereDir, startAll) {
  return new Promise((resolve) => {
    let filter = initialFilter;
    let selected = 0;
    let offset = 0;
    let showAll = startAll;
    let previewN = PREVIEW_DEFAULT; // sentences shown in the preview pane (sticky)

    const out = process.stdout;
    out.write(`${ESC}?1049h${ESC}?25l`); // alt screen, hide cursor
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write(`${ESC}?25h${ESC}?1049l`); // show cursor, leave alt screen
    }

    function visible() {
      let list = showAll ? allSessions : allSessions.filter((s) => s.projectDir === hereDir);
      if (filter) {
        const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
        list = list.filter((s) => {
          const hay = `${titleOf(s)} ${s.firstUserText || ''} ${s.id} ${projectLabel(s.projectDir, s.cwd)}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
      }
      return list;
    }

    function render() {
      const rows = out.rows || 24;
      const cols = out.columns || 80;
      const list = visible();
      if (selected >= list.length) selected = Math.max(0, list.length - 1);

      const lines = [];
      const scope = showAll ? 'all projects' : scopeLabel;
      lines.push(`${c.bold}${c.cyan} Claude Sessions${c.reset}${c.dim} — ${scope} · ${list.length} session${list.length === 1 ? '' : 's'}${c.reset}`);
      lines.push(filter ? ` ${c.yellow}filter:${c.reset} ${filter}${c.inverse} ${c.reset}` : `${c.dim} type to filter…${c.reset}`);
      lines.push('');

      // Build the preview pane for the highlighted session first, so we know how
      // much vertical space the list gets. The list keeps at least 2 items.
      const headerLines = 3;
      const footerLines = 1;
      const budget = Math.max(2, rows - headerLines - footerLines);
      const maxPreview = Math.max(0, budget - 4); // always leave room for ≥2 items
      const previewLines = list[selected] ? buildPreviewLines(list[selected], previewN, cols, maxPreview) : [];

      const listHeight = Math.max(2, budget - previewLines.length);
      const itemsVisible = Math.max(1, Math.floor(listHeight / 2));
      if (selected < offset) offset = selected;
      if (selected >= offset + itemsVisible) offset = selected - itemsVisible + 1;
      const slice = list.slice(offset, offset + itemsVisible);

      const listLines = [];
      slice.forEach((s, i) => {
        const idx = offset + i;
        const sel = idx === selected;
        const live = isLive(s) ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
        const pointer = sel ? `${c.cyan}❯${c.reset}` : ' ';
        const title = truncate(titleOf(s), cols - 8);
        const titleStr = sel ? `${c.bold}${title}${c.reset}` : title;
        const proj = showAll ? ` ${c.magenta}${truncate(projectLabel(s.projectDir, s.cwd), 40)}${c.reset}` : '';
        const meta = `${relTime(s.mtimeMs)} · ${s.userCount} msgs · ${fmtSize(s.size)} · ${s.id.slice(0, 8)}${s.gitBranch && s.gitBranch !== 'HEAD' ? ` · ${s.gitBranch}` : ''}`;
        listLines.push(` ${pointer} ${live} ${titleStr}`);
        listLines.push(`     ${c.dim}${truncate(meta, cols - 6)}${c.reset}${proj}`);
      });
      if (list.length === 0) listLines.push(`   ${c.dim}(no matching sessions)${c.reset}`);

      // Pad list region to its reserved height, then append the preview pane.
      while (listLines.length < listHeight) listLines.push('');
      listLines.length = listHeight;
      lines.push(...listLines, ...previewLines);

      while (lines.length < rows - 1) lines.push('');
      lines.length = rows - 1;
      lines.push(`${c.dim} ↑↓ move · enter resume · →/← preview · tab ${showAll ? 'this project' : 'all projects'} · esc quit${c.reset}`);

      out.write(`${ESC}H${ESC}2J` + lines.map((l) => truncateAnsiSafe(l, cols)).join('\n'));
    }

    // Rough guard: only hard-truncate lines with no escape codes; styled lines
    // are already built within width budgets above.
    function truncateAnsiSafe(line, cols) {
      return line.includes('\x1b') ? line : truncate(line, cols);
    }

    // Preview pane: a separator label plus the last `n` sentences of the
    // session's conversation tail, wrapped to width and capped to `maxHeight`.
    function buildPreviewLines(s, n, cols, maxHeight) {
      if (maxHeight < 2) return [];
      const sentences = splitSentences(s.tailText || s.lastUserText || s.firstUserText || '');
      const shown = sentences.slice(-n);
      const label = ` ${c.dim}╶─ preview · last ${shown.length} of ${sentences.length} · ${c.reset}${c.cyan}→${c.reset}${c.dim} more · ${c.reset}${c.cyan}←${c.reset}${c.dim} less ─╴${c.reset}`;
      const body = [];
      if (shown.length === 0) {
        body.push(`   ${c.dim}(no conversation text yet)${c.reset}`);
      } else {
        const wrapWidth = Math.max(10, cols - 4);
        for (const sent of shown) {
          for (const seg of wordWrap(sent, wrapWidth)) {
            body.push(`   ${c.dim}${seg}${c.reset}`);
          }
        }
      }
      // Cap: keep the label and the most recent body lines that fit.
      const room = maxHeight - 1;
      const kept = body.length > room ? body.slice(body.length - room) : body;
      return [label, ...kept];
    }

    function resumeSelected(s) {
      cleanup();
      resolve(s);
    }

    process.stdout.on('resize', render);

    process.stdin.on('data', (key) => {
      const list = visible();

      if (key === '\x03') { cleanup(); resolve(null); return; } // ctrl-c

      switch (key) {
        case '\x1b': // bare esc
          if (filter) { filter = ''; selected = 0; }
          else { cleanup(); resolve(null); return; }
          break;
        case '\x1b[A': // up
          selected = Math.max(0, selected - 1);
          break;
        case '\x1b[B': // down
          selected = Math.min(Math.max(0, list.length - 1), selected + 1);
          break;
        case '\x1b[C': // right -> more preview
          previewN = Math.min(PREVIEW_MAX, previewN + 1);
          break;
        case '\x1b[D': // left -> less preview
          previewN = Math.max(1, previewN - 1);
          break;
        case '\t':
          showAll = !showAll;
          selected = 0;
          offset = 0;
          break;
        case '\r':
        case '\n':
          if (list[selected]) return resumeSelected(list[selected]);
          break;
        case '\x7f': // backspace
          filter = filter.slice(0, -1);
          break;
        default:
          if (key.length === 1 && key >= ' ') {
            filter += key;
            selected = 0;
          }
      }
      render();
    });

    render();
  });
}

// ---------------------------------------------------------------- main

(async () => {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(`No Claude projects directory at ${PROJECTS_DIR}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const hereDir = path.join(PROJECTS_DIR, encodeProjectPath(cwd));
  const allDirs = fs
    .readdirSync(PROJECTS_DIR)
    .map((d) => path.join(PROJECTS_DIR, d))
    .filter((d) => {
      try { return fs.statSync(d).isDirectory(); } catch { return false; }
    });

  const hereExists = fs.existsSync(hereDir);
  const scopeLabel = cwd.replace(os.homedir(), '~');

  // Always load everything (cache makes repeat runs instant) so tab-toggle works.
  const dirsToLoad = optAll || !hereExists ? allDirs : Array.from(new Set([hereDir, ...allDirs]));
  const sessions = await loadSessions(dirsToLoad);

  if (optList || !process.stdin.isTTY || !process.stdout.isTTY) {
    const list = optAll ? sessions : sessions.filter((s) => s.projectDir === hereDir);
    printList(list, optAll ? 'all projects' : scopeLabel);
    return;
  }

  if (!hereExists && !optAll) {
    console.log(`${c.dim}No sessions for ${scopeLabel} — showing all projects.${c.reset}`);
  }

  const startAll = optAll || !hereExists;

  const picked = await tui(sessions, scopeLabel, hereDir, startAll);
  if (!picked) process.exit(0);

  console.log(`Resuming ${picked.id} — ${titleOf(picked)}`);
  const r = spawnSync('claude', ['--resume', picked.id], {
    stdio: 'inherit',
    cwd: picked.cwd && fs.existsSync(picked.cwd) ? picked.cwd : process.cwd(),
  });
  process.exit(r.status ?? 0);
})();
