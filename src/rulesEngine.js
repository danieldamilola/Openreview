'use strict';

/**
 * Deterministic rule engine (CodeRabbit ast-grep-style layer).
 *
 * Runs exact pattern rules over the diff BEFORE the LLM step, so known-bad
 * patterns (eval, secrets, focused tests, ...) are caught deterministically
 * at zero API cost. Rule hits flow through the same pipeline as LLM
 * findings: anchor check, severity threshold, comment cap, GitHub posting.
 *
 * Rules live in YAML files under the rules directory (default: rules).
 * Minimal constrained schema on purpose — flat scalars plus string
 *
 *   rules:
 *     - id: no-console-log
 *       description: "Forbid console.log in shipped code"
 *       severity: minor            # critical | major | minor
 *       files: ["src/**", "lib/**"]   # globs; omit to match all files
 *       pattern: "console\\.(log|debug)\\("  # JS regex, tested per added line
 *       flags: "i"                 # optional, subset of [ims]
 *       message: "Remove console.log before merging."
 *       suggestion: "Use the repo logger instead."   # optional
 *
 * Zero npm dependencies: includes a small purpose-built parser for exactly
 * this schema (comments, quotes, inline and block lists). Anything fancier
 * belongs in a real YAML library, not here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { globToRegExp } = require('./diffCollector');
const { SEVERITIES } = require('./promptBuilder');

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser (only what the rule schema needs).
// ---------------------------------------------------------------------------

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        out += c + (line[i + 1] || '');
        i++;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '#') {
      break;
    } else {
      out += c;
    }
  }
  return out;
}

function unescapeDouble(s) {
  return s
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

function parseScalar(raw) {
  const t = String(raw).trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return unescapeDouble(t.slice(1, -1));
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '' || t === '~' || t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function splitInlineList(inner) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (inner[i + 1] || '');
        i++;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => String(parseScalar(p))).filter((p) => p !== '');
}

function assignPair(obj, rest, where) {
  const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rest);
  if (!m) throw new Error(`invalid mapping ${where}: ${JSON.stringify(rest)}`);
  return [m[1], m[2].trim()];
}

// Parse rule-file text into an array of raw rule objects (unvalidated).
function parseRulesYaml(text, sourceName = '<rules>') {
  const rules = [];
  let current = null;
  let dashIndent = -1;
  let pendingList = null;
  const lines = String(text || '').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const stripped = stripComment(lines[n]);
    if (!stripped.trim()) continue;
    const indent = stripped.match(/^ */)[0].length;
    const trimmed = stripped.trim();
    if (!current && trimmed === 'rules:') continue;
    if (trimmed.startsWith('- ') && (current === null || indent <= dashIndent)) {
      if (current) rules.push(current);
      current = {};
      dashIndent = indent;
      pendingList = null;
      const rest = trimmed.slice(2).trim();
      if (rest) {
        const [k, v] = assignPair(current, rest, `${sourceName}:${n + 1}`);
        if (v === '') {
          current[k] = [];
          pendingList = k;
        } else if (v.startsWith('[') && v.endsWith(']')) {
          current[k] = splitInlineList(v.slice(1, -1));
        } else {
          current[k] = parseScalar(v);
        }
      }
      continue;
    }
    if (!current) {
      throw new Error(`${sourceName}:${n + 1}: expected "rules:" list, got: ${JSON.stringify(trimmed)}`);
    }
    if (trimmed.startsWith('- ') && pendingList) {
      current[pendingList].push(String(parseScalar(trimmed.slice(2).trim())));
      continue;
    }
    {
      const [k, v] = assignPair(current, trimmed, `${sourceName}:${n + 1}`);
      if (v === '') {
        current[k] = [];
        pendingList = k;
      } else if (v.startsWith('[') && v.endsWith(']')) {
        current[k] = splitInlineList(v.slice(1, -1));
        pendingList = null;
      } else {
        current[k] = parseScalar(v);
        pendingList = null;
      }
    }
  }
  if (current) rules.push(current);
  return rules;
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

const VALID_FLAGS = /^[ims]*$/;

function validateRule(raw, seenIds) {
  const fail = (error) => ({ rule: null, error });
  if (!raw || typeof raw !== 'object') return fail('rule must be a mapping');
  const id = raw.id === undefined || raw.id === null ? '' : String(raw.id).trim();
  if (!id) return fail('rule is missing required "id"');
  if (seenIds.has(id)) return fail(`duplicate rule id: ${id}`);
  const severity = String(raw.severity || '').toLowerCase();
  if (!SEVERITIES.includes(severity)) {
    return fail(`rule ${id}: severity must be one of ${SEVERITIES.join('|')}, got ${JSON.stringify(raw.severity)}`);
  }
  let files = raw.files === undefined ? ['**'] : raw.files;
  if (typeof files === 'string') files = [files];
  if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string' || !f.trim())) {
    return fail(`rule ${id}: "files" must be a non-empty list of globs`);
  }
  const pattern = raw.pattern === undefined || raw.pattern === null ? '' : String(raw.pattern);
  if (!pattern) return fail(`rule ${id}: missing required "pattern" regex`);
  const flags = raw.flags === undefined || raw.flags === null ? '' : String(raw.flags);
  if (!VALID_FLAGS.test(flags)) return fail(`rule ${id}: "flags" must be a subset of [ims]`);
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    return fail(`rule ${id}: invalid regex ${JSON.stringify(pattern)}: ${e.message}`);
  }
  const message = raw.message === undefined || raw.message === null ? '' : String(raw.message).trim();
  if (!message) return fail(`rule ${id}: missing required "message"`);
  seenIds.add(id);
  return {
    rule: {
      id,
      description: raw.description === undefined ? '' : String(raw.description),
      severity,
      files: files.map((f) => f.trim()),
      pattern,
      flags,
      multiline: raw.multiline === true,
      message,
      suggestion: raw.suggestion === undefined || raw.suggestion === null ? '' : String(raw.suggestion),
      _re: re,
    },
    error: null,
  };
}

// Load every *.yml / *.yaml file in dir. Never throws: problems are
// collected in errors[] as { file, id?, error }.
function loadRules(dir, cwd) {
  const root = path.isAbsolute(dir) ? dir : path.join(cwd || process.cwd(), dir);
  const rules = [];
  const errors = [];
  const seenIds = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { rules, errors };
    return { rules, errors: [{ file: root, error: `cannot read rules dir: ${e.message}` }] };
  }
  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of files) {
    const full = path.join(root, name);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      errors.push({ file: name, error: `cannot read file: ${e.message}` });
      continue;
    }
    let rawRules;
    try {
      rawRules = parseRulesYaml(text, name);
    } catch (e) {
      errors.push({ file: name, error: e.message });
      continue;
    }
    for (const raw of rawRules) {
      const { rule, error } = validateRule(raw, seenIds);
      if (rule) rules.push(rule);
      else errors.push({ file: name, id: raw && raw.id, error });
    }
  }
  return { rules, errors };
}

// ---------------------------------------------------------------------------
// Scanning.
// ---------------------------------------------------------------------------

function matchesAnyGlob(filePath, patterns) {
  return (patterns || []).some((p) => {
    const pat = String(p).trim();
    if (!pat || pat.startsWith('#')) return false;
    try {
      if (pat.endsWith('/')) return filePath.startsWith(pat);
      return globToRegExp(pat).test(filePath);
    } catch {
      return false;
    }
  });
}

// Scan parsed diff hunks: one finding per rule per added line.
function scanDiff(diffResult, rules) {
  const findings = [];
  for (const file of (diffResult && diffResult.files) || []) {
    if (!file || file.binary || file.status === 'deleted') continue;
    const applicable = (rules || []).filter((r) => matchesAnyGlob(file.file, r.files));
    if (applicable.length === 0) continue;
    for (const hunk of file.hunks || []) {
      const addedLines = (hunk.lines || []).filter((line) => line && line.type === 'add');
      const addedText = addedLines.map((line) => line.content).join('\n');
      for (const r of applicable.filter((rule) => rule.multiline)) {
        let offset = 0;
        while (offset < addedText.length) {
          const match = r._re.exec(addedText.slice(offset));
          if (!match) break;
          const beforeMatch = addedText.slice(offset, offset + match.index);
          const addedLineIndex = beforeMatch.split('\n').length - 1;
          const line = addedLines[addedLineIndex];
          if (line) {
            findings.push({
              file: file.file,
              line: line.newLine,
              severity: r.severity,
              message: r.message,
              suggestion: r.suggestion || undefined,
              rule: r.id,
            });
          }
          offset += match.index + match[0].length;
        }
      }
      for (const l of hunk.lines || []) {
        if (!l || l.type !== 'add') continue;
        for (const r of applicable.filter((rule) => !rule.multiline)) {
          let hit = false;
          try {
            hit = r._re.test(l.content);
          } catch {
            hit = false;
          }
          // Reset state for regexes that could carry lastIndex.
          if (r._re && typeof r._re.lastIndex === 'number') r._re.lastIndex = 0;
          if (hit) {
            findings.push({
              file: file.file,
              line: l.newLine,
              severity: r.severity,
              message: r.message,
              suggestion: r.suggestion || undefined,
              rule: r.id,
            });
          }
        }
      }
    }
  }
  return findings;
}

// Drop LLM findings that land on the exact file+line of a rule hit.
// Deterministic rules win: they are consistent and cost nothing.
function dedupeAgainstRules(llmFindings, ruleFindings) {
  const ruleKeys = new Set((ruleFindings || []).map((f) => `${f.file}:${f.line}`));
  const kept = [];
  const duplicates = [];
  for (const f of llmFindings || []) {
    if (f && ruleKeys.has(`${f.file}:${f.line}`)) duplicates.push(f);
    else kept.push(f);
  }
  return { kept, duplicates };
}

module.exports = {
  parseRulesYaml,
  validateRule,
  loadRules,
  matchesAnyGlob,
  scanDiff,
  dedupeAgainstRules,
};
