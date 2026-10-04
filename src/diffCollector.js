'use strict';

/**
 * Diff collector: turns `git diff` output (or two SHAs) into structured
 * per-file hunks with size limits, truncation flags, and ignore patterns.
 *
 * CodeRabbit-style behavior implemented here:
 * - full PR diff via base...head (three-dot) with fallback to base..head,
 * - incremental review by passing priorHead as base (only new commits),
 * - per-file / per-hunk analysis downstream, never whole-repo dumps,
 * - ignore patterns (e.g. lockfiles, generated code, vendor).
 *
 * Pure functions (parseUnifiedDiff, chunkFiles, buildChangedLineIndex) are
 * unit-testable without git. collectDiff() shells out to git for live use.
 */

const { execFileSync } = require('node:child_process');

const DEFAULT_LIMITS = {
  maxFiles: 100,
  maxFileChars: 20000,
  maxTotalChars: 120000,
  maxHunkLines: 300,
};

function globToRegExp(glob) {
  // Minimal glob -> RegExp: supports **, *, ?, character-free escaping.
  // Used so the action has zero npm dependencies.
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**' => match anything including slashes. A trailing slash
        // matches zero or more directories, so "**/*.js" also hits
        // root-level files like "a.js" (minimatch behavior).
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if ('+()^$.{}[]|\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesIgnore(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => {
    const pat = p.trim();
    if (!pat || pat.startsWith('#')) return false;
    try {
      // Allow directory prefixes like "dist/" to match anything under it.
      if (pat.endsWith('/')) return filePath.startsWith(pat);
      return globToRegExp(pat).test(filePath);
    } catch {
      return false;
    }
  });
}

function parseIgnorePatterns(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map((s) => s.trim()).filter(Boolean);
  return String(input)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function emptyResult(statsExtra) {
  return {
    files: [],
    truncated: false,
    empty: true,
    stats: { files: 0, additions: 0, deletions: 0, ...statsExtra },
  };
}

/**
 * Parse unified diff text into per-file hunk structures.
 * @param {string} diffText raw `git diff` output
 * @param {object} [options] { limits, ignorePatterns }
 */
function parseUnifiedDiff(diffText, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const ignorePatterns = parseIgnorePatterns(options.ignorePatterns);

  if (!diffText || !diffText.trim()) return emptyResult();

  const files = [];
  const lines = diffText.split('\n');
  let current = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  const skippedIgnored = [];

  function pushFile() {
    if (current) {
      if (hunk) {
        current.hunks.push(hunk);
        hunk = null;
      }
      // Per-file char accounting + truncation flag
      const size = current.hunks.reduce(
        (n, hh) => n + hh.lines.reduce((m, l) => m + l.content.length + 1, 0),
        0
      );
      current.sizeChars = size;
      if (size > limits.maxFileChars) {
        current.truncated = true;
        truncated = true;
      }
      files.push(current);
    }
    current = null;
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.startsWith('diff --git ')) {
      pushFile();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      const aPath = m ? m[1] : '';
      const bPath = m ? m[2] : '';
      current = {
        file: bPath || aPath,
        oldFile: aPath,
        newFile: bPath,
        status: 'modified',
        binary: false,
        hunks: [],
        truncated: false,
        sizeChars: 0,
      };
      hunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('Binary files ') && line.includes(' differ')) {
      current.binary = true;
      current.status = current.status || 'modified';
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldFile = line.slice('rename from '.length).trim();
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newFile = line.slice('rename to '.length).trim();
      current.file = current.newFile;
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    const hm = HUNK_HEADER.exec(line);
    if (hm) {
      if (hunk) current.hunks.push(hunk);
      const oldStart = Number(hm[1]);
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = {
        oldStart,
        oldLines: oldCount,
        newStart,
        newLines: newCount,
        lines: [],
        truncated: false,
      };
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const kind = line[0];
    const content = line.slice(1);
    if (kind === ' ' || kind === '+' || kind === '-') {
      if (hunk.lines.length >= limits.maxHunkLines) {
        hunk.truncated = true;
        current.truncated = true;
        truncated = true;
        // Still advance counters so subsequent hunks stay aligned.
        if (kind === ' ') {
          oldLine += 1;
          newLine += 1;
        } else if (kind === '+') {
          newLine += 1;
          additions += 1;
        } else {
          oldLine += 1;
          deletions += 1;
        }
        continue;
      }
      if (kind === ' ') {
        hunk.lines.push({ type: 'context', oldLine, newLine, content });
        oldLine += 1;
        newLine += 1;
      } else if (kind === '+') {
        hunk.lines.push({ type: 'add', oldLine: null, newLine, content });
        newLine += 1;
        additions += 1;
      } else {
        hunk.lines.push({ type: 'del', oldLine, newLine: null, content });
        oldLine += 1;
        deletions += 1;
      }
    }
  }
  pushFile();

  // Apply ignore patterns (post-parse so stats stay honest, then filter).
  let kept = files;
  if (ignorePatterns.length > 0) {
    kept = [];
    for (const f of files) {
      if (matchesIgnore(f.file, ignorePatterns)) {
        skippedIgnored.push(f.file);
      } else {
        kept.push(f);
      }
    }
  }

  // Apply maxFiles limit.
  let limited = kept;
  if (kept.length > limits.maxFiles) {
    limited = kept.slice(0, limits.maxFiles);
    truncated = true;
  }

  // Apply global char budget across files in order.
  let budget = limits.maxTotalChars;
  for (const f of limited) {
    const size = f.sizeChars || 0;
    if (size > budget && budget >= 0) {
      f.truncated = true;
      truncated = true;
      // Drop hunks from the tail until the file fits (keep at least one hunk).
      let acc = 0;
      const keptHunks = [];
      for (const hh of f.hunks) {
        const hs = hh.lines.reduce((n, l) => n + l.content.length + 1, 0);
        if (acc + hs <= Math.max(budget, 0) || keptHunks.length === 0) {
          keptHunks.push(hh);
          acc += hs;
        } else {
          truncated = true;
          f.truncated = true;
        }
      }
      f.hunks = keptHunks;
      f.sizeChars = acc;
    }
    budget -= f.sizeChars || 0;
    if (budget < 0) {
      truncated = true;
    }
  }

  return {
    files: limited,
    truncated,
    empty: limited.length === 0,
    stats: {
      files: limited.length,
      totalFilesSeen: files.length,
      additions,
      deletions,
      skippedIgnored,
    },
  };
}

/**
 * Build a Set-like index of changed (added) new-side line numbers per file.
 * Findings must anchor to these lines only.
 */
function buildChangedLineIndex(diffResult) {
  const index = new Map(); // file -> Set(newLine)
  for (const f of diffResult.files || []) {
    const set = new Set();
    for (const h of f.hunks || []) {
      for (const l of h.lines || []) {
        if (l.type === 'add' && l.newLine != null) set.add(l.newLine);
      }
    }
    index.set(f.file, set);
  }
  return index;
}

/**
 * Split files into prompt-sized chunks (each chunk = list of files).
 * Respects maxTotalChars per chunk so no single LLM call is oversized.
 */
function chunkFiles(diffResult, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const f of diffResult.files || []) {
    const size = f.sizeChars || 0;
    if (current.length > 0 && currentChars + size > limits.maxTotalChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(f);
    currentChars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Collect a live diff from git given base/head SHAs.
 * Three-dot (merge-base) is preferred for PRs; falls back to two-dot.
 * For incremental reviews pass the previously-reviewed head as `base`.
 */
function collectDiff({ base, head, cwd, ignorePatterns, limits, gitRunner } = {}) {
  if (!base || !head) {
    throw new Error('collectDiff requires both base and head SHAs');
  }
  const run = gitRunner || ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  let diffText = '';
  try {
    diffText = run(['diff', `${base}...${head}`, '--unified=3', '--no-color', '--no-ext-diff']);
  } catch {
    diffText = run(['diff', `${base}`, `${head}`, '--unified=3', '--no-color', '--no-ext-diff']);
  }
  return parseUnifiedDiff(diffText, { ignorePatterns, limits });
}

module.exports = {
  DEFAULT_LIMITS,
  globToRegExp,
  matchesIgnore,
  parseIgnorePatterns,
  parseUnifiedDiff,
  buildChangedLineIndex,
  chunkFiles,
  collectDiff,
};
