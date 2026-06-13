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
const LIVE_THRESHOLD_MS = 5 * 60 * 1000; // mtime within 5 min => probably running

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

Keys: ↑/↓ move · enter resume · type to filter · → details · tab all/here · esc quit`);
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

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return t ? t.text : '';
  }
  return '';
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
} catch {
  cache = {};
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
      cwd: null,
      gitBranch: null,
      version: null,
      userCount: 0,
      assistantCount: 0,
      firstTs: null,
      lastTs: null,
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

    rl.on('close', () => resolve(meta));
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
    let detail = null; // session shown in detail view

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

      if (detail) {
        renderDetail(lines, detail, cols, rows);
      } else {
        const scope = showAll ? 'all projects' : scopeLabel;
        lines.push(`${c.bold}${c.cyan} Claude Sessions${c.reset}${c.dim} — ${scope} · ${list.length} session${list.length === 1 ? '' : 's'}${c.reset}`);
        lines.push(filter ? ` ${c.yellow}filter:${c.reset} ${filter}${c.inverse} ${c.reset}` : `${c.dim} type to filter…${c.reset}`);
        lines.push('');

        const rowsPerItem = 2;
        const listHeight = Math.max(1, Math.floor((rows - 5) / rowsPerItem));
        if (selected < offset) offset = selected;
        if (selected >= offset + listHeight) offset = selected - listHeight + 1;
        const slice = list.slice(offset, offset + listHeight);

        slice.forEach((s, i) => {
          const idx = offset + i;
          const sel = idx === selected;
          const live = isLive(s) ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
          const pointer = sel ? `${c.cyan}❯${c.reset}` : ' ';
          const title = truncate(titleOf(s), cols - 8);
          const titleStr = sel ? `${c.bold}${title}${c.reset}` : title;
          const proj = showAll ? ` ${c.magenta}${truncate(projectLabel(s.projectDir, s.cwd), 40)}${c.reset}` : '';
          const meta = `${relTime(s.mtimeMs)} · ${s.userCount} msgs · ${fmtSize(s.size)} · ${s.id.slice(0, 8)}${s.gitBranch && s.gitBranch !== 'HEAD' ? ` · ${s.gitBranch}` : ''}`;
          lines.push(` ${pointer} ${live} ${titleStr}`);
          lines.push(`     ${c.dim}${truncate(meta, cols - 6)}${c.reset}${proj}`);
        });

        if (list.length === 0) lines.push(`   ${c.dim}(no matching sessions)${c.reset}`);

        while (lines.length < rows - 1) lines.push('');
        lines.length = rows - 1;
        lines.push(`${c.dim} ↑↓ move · enter resume · → details · tab ${showAll ? 'this project' : 'all projects'} · esc quit${c.reset}`);
      }

      out.write(`${ESC}H${ESC}2J` + lines.map((l) => truncateAnsiSafe(l, cols)).join('\n'));
    }

    // Rough guard: only hard-truncate lines with no escape codes; styled lines
    // are already built within width budgets above.
    function truncateAnsiSafe(line, cols) {
      return line.includes('\x1b') ? line : truncate(line, cols);
    }

    function renderDetail(lines, s, cols, rows) {
      lines.push(`${c.bold}${c.cyan} ${truncate(titleOf(s), cols - 2)}${c.reset}`);
      lines.push('');
      lines.push(` ${c.dim}session${c.reset}   ${s.id}`);
      lines.push(` ${c.dim}folder${c.reset}    ${s.cwd || projectLabel(s.projectDir)}`);
      lines.push(` ${c.dim}branch${c.reset}    ${s.gitBranch || '—'}`);
      lines.push(` ${c.dim}activity${c.reset}  ${relTime(s.mtimeMs)} (last) · started ${s.firstTs ? new Date(s.firstTs).toLocaleString() : '—'}`);
      lines.push(` ${c.dim}messages${c.reset}  ${s.userCount} user · ${s.assistantCount} assistant · ${fmtSize(s.size)}`);
      lines.push(` ${c.dim}version${c.reset}   ${s.version || '—'}`);
      lines.push('');
      const budget = rows - lines.length - 4;
      const wrap = (label, text, max) => {
        if (!text) return;
        lines.push(` ${c.yellow}${label}${c.reset}`);
        const words = text.replace(/\s+/g, ' ').trim();
        let i = 0;
        let used = 0;
        while (i < words.length && used < max) {
          lines.push(`   ${words.slice(i, i + cols - 4)}`);
          i += cols - 4;
          used++;
        }
        lines.push('');
      };
      wrap('first message', s.firstUserText, Math.max(2, Math.floor(budget / 2)));
      if (s.lastUserText && s.lastUserText !== s.firstUserText) {
        wrap('last message', s.lastUserText, Math.max(2, Math.floor(budget / 2)));
      }
      while (lines.length < rows - 1) lines.push('');
      lines.length = rows - 1;
      lines.push(`${c.dim} enter resume · ← back · esc quit${c.reset}`);
    }

    function resumeSelected(s) {
      cleanup();
      resolve(s);
    }

    process.stdout.on('resize', render);

    process.stdin.on('data', (key) => {
      const list = visible();

      if (key === '\x03') { cleanup(); resolve(null); return; } // ctrl-c

      if (detail) {
        if (key === '\r' || key === '\n') return resumeSelected(detail);
        if (key === '\x1b[D' || key === '\x1b' || key === 'q') { detail = null; render(); }
        return;
      }

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
        case '\x1b[C': // right -> detail
          if (list[selected]) detail = list[selected];
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
