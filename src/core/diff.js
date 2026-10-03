'use strict';

// A unified-diff parser. The unified format is the shared interchange for
// Git-based hosting, so this stays platform-neutral and reusable.

// Parse a `---`/`+++` path into a repo-relative path, or null for /dev/null.
// Handles the `a/`/`b/` prefixes, trailing timestamps after a tab, and paths
// git quotes when they contain spaces.
function diffPath(line) {
  let text = line.trimEnd();

  const tab = text.indexOf('\t');
  if (tab !== -1) {
    text = text.slice(0, tab);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  if (text === '/dev/null') {
    return null;
  }
  if (text.startsWith('a/') || text.startsWith('b/')) {
    text = text.slice(2);
  }

  return text;
}

// Git and GitHub's diff viewers show this many context lines by default.
const DEFAULT_CONTEXT = 3;

function record(map, path, line) {
  let set = map.get(path);
  if (!set) {
    set = new Set();
    map.set(path, set);
  }

  set.add(line);
}

// Expand a set of changed lines to include the surrounding context window.
// Lines are 1-based, so the lower edge never goes below 1.
function expand(set, context) {
  if (context <= 0) {
    return set;
  }

  const out = new Set();
  for (const line of set) {
    for (let n = Math.max(1, line - context); n <= line + context; n++) {
      out.add(n);
    }
  }

  return out;
}

// diffText: a git unified diff. context: how many unchanged lines around each
// changed line to include, defaulting to the standard 3. Returns a Map
// from repo-relative path to a Set of new-side line numbers in scope. Deleted
// files and removed lines have no new-side line and are skipped.
function changedLines(diffText, context = DEFAULT_CONTEXT) {
  const map = new Map();
  let path = null;
  let newLine = 0;

  for (const raw of diffText.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('+++ ')) {
      path = diffPath(line.slice(4));
      newLine = 0;
      continue;
    }
    if (line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        newLine = Number(match[1]);
      }

      continue;
    }

    if (path === null || path === '/dev/null') {
      continue;
    }

    if (line.startsWith('+')) {
      record(map, path, newLine);
      newLine += 1;
    } else if (line.startsWith(' ')) {
      // Context lines occupy a new-side slot but are not themselves changed.
      newLine += 1;
    }
  }

  for (const file of map.keys()) {
    map.set(file, expand(map.get(file), context));
  }

  return map;
}

module.exports = { changedLines, diffPath, DEFAULT_CONTEXT };
