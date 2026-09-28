'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { javascriptFiles } = require('./javascript-files');

const root = path.resolve(__dirname, '..');

const BLOCK_KEYWORD = /(?<![.\w$])(if|for|while|else|try|catch|finally|do)(?![\w$]|\s*:)/g;
const HAS_CONDITION = new Set(['if', 'for', 'while', 'catch']);
const AFTER_OPERATOR = /[(,=:[!&|?{};+\-*%<>~^]$/;
const AFTER_KEYWORD = /\b(?:return|typeof|case|throw|new|delete|void|in|of|else|do|yield|await)$/;

function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

function skipSpace(code, index) {
  while (index < code.length && /\s/.test(code[index])) {
    index += 1;
  }

  return index;
}

function closingParen(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === '(') {
      depth += 1;
    }
    if (code[index] === ')') {
      depth -= 1;
    }
    if (depth === 0) {
      return index;
    }
  }

  return code.length;
}

function lineEnd(code, index) {
  const newline = code.indexOf('\n', index);
  return newline === -1 ? code.length : newline;
}

function commentEnd(source, start) {
  if (source.startsWith('//', start) || (start === 0 && source.startsWith('#!'))) {
    return lineEnd(source, start);
  }
  if (source.startsWith('/*', start)) {
    const close = source.indexOf('*/', start + 2);
    return close === -1 ? source.length : close + 2;
  }

  return start;
}

function quotedEnd(source, start) {
  let index = start + 1;
  while (index < source.length && source[index] !== source[start] && source[index] !== '\n') {
    index += source[index] === '\\' ? 2 : 1;
  }

  return index + 1;
}

function expressionEnd(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '`') {
      index = templateEnd(source, index);
    } else if (char === '"' || char === "'") {
      index = quotedEnd(source, index);
    } else {
      if (char === '{') {
        depth += 1;
      }
      if (char === '}') {
        depth -= 1;
      }

      index += 1;
    }
  }

  return index;
}

function templateEnd(source, start) {
  let index = start + 1;
  while (index < source.length && source[index] !== '`') {
    if (source[index] === '\\') {
      index += 2;
    } else if (source.startsWith('${', index)) {
      index = expressionEnd(source, index + 2);
    } else {
      index += 1;
    }
  }

  return index + 1;
}

function regexEnd(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length && source[index] !== '\n' && (source[index] !== '/' || inClass)) {
    if (source[index] === '\\') {
      index += 1;
    } else if (source[index] === '[') {
      inClass = true;
    } else if (source[index] === ']') {
      inClass = false;
    }

    index += 1;
  }

  index += 1;
  while (/[a-z]/.test(source[index] ?? '')) {
    index += 1;
  }

  return index;
}

function regexMayStart(code) {
  const before = code.slice(-200).trimEnd();
  return before === '' || AFTER_OPERATOR.test(before) || AFTER_KEYWORD.test(before);
}

function literalEnd(source, index, code) {
  const char = source[index];
  if (char === '"' || char === "'") {
    return quotedEnd(source, index);
  }
  if (char === '`') {
    return templateEnd(source, index);
  }
  if (char === '/' && regexMayStart(code)) {
    return regexEnd(source, index);
  }

  return index;
}

function codeOnly(source) {
  let code = '';
  let index = 0;
  while (index < source.length) {
    let end = commentEnd(source, index);
    if (end === index) {
      end = literalEnd(source, index, code);
    }
    if (end > index) {
      code += blank(source.slice(index, end));
      index = end;
    } else {
      code += source[index];
      index += 1;
    }
  }

  return code;
}

function bodyStart(code, keyword, afterKeyword) {
  let index = skipSpace(code, afterKeyword);
  if (keyword === 'for' && code.startsWith('await', index)) {
    index = skipSpace(code, index + 'await'.length);
  }
  if (HAS_CONDITION.has(keyword) && code[index] === '(') {
    index = skipSpace(code, closingParen(code, index) + 1);
  }

  return index;
}

function isDoWhileTail(code, keyword, matchIndex, start) {
  return keyword === 'while' && code[start] === ';' && code.slice(0, matchIndex).trimEnd().endsWith('}');
}

function blockProblems(code) {
  const found = [];
  for (const match of code.matchAll(BLOCK_KEYWORD)) {
    const keyword = match[1];
    const start = bodyStart(code, keyword, match.index + keyword.length);
    if (keyword === 'else' && /^if\b/.test(code.slice(start, start + 3))) {
      continue;
    }
    if (isDoWhileTail(code, keyword, match.index, start)) {
      continue;
    }
    if (code[start] !== '{') {
      found.push({ index: match.index, message: `Put the body of \`${keyword}\` in braces.` });
    } else if (/\S/.test(code.slice(start + 1, lineEnd(code, start)))) {
      found.push({ index: match.index, message: `Put the body of \`${keyword}\` on its own lines.` });
    }
  }

  return found;
}

function sharedLines(code) {
  const found = [];
  const forHeaders = [];
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if ('([{'.includes(char)) {
      const isForHeader = char === '(' && /\bfor\s*(?:await\s*)?$/.test(code.slice(Math.max(0, index - 16), index));
      forHeaders.push(isForHeader);
    } else if (')]}'.includes(char)) {
      forHeaders.pop();
    } else if (char === ';' && !forHeaders[forHeaders.length - 1]) {
      if (/[^\s)}\];,]/.test(code.slice(index + 1, lineEnd(code, index)))) {
        found.push({ index, message: 'Put each statement on its own line.' });
      }
    }
  }

  return found;
}

function isTernaryMark(code, index) {
  if (code[index] !== '?') {
    return false;
  }

  const next = code[index + 1];
  const optionalChain = next === '.' && !/\d/.test(code[index + 2]);
  return next !== '?' && code[index - 1] !== '?' && !optionalChain;
}

function nestedTernaries(code) {
  const found = [];
  const inside = [false];
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if ('([{'.includes(char)) {
      inside.push(false);
    } else if (')]}'.includes(char)) {
      if (inside.length > 1) {
        inside.pop();
      }
    } else if (char === ';' || char === ',') {
      inside[inside.length - 1] = false;
    } else if (isTernaryMark(code, index)) {
      if (inside[inside.length - 1]) {
        found.push({ index, message: 'Do not nest ternaries.' });
      }

      inside[inside.length - 1] = true;
    }
  }

  return found;
}

function findViolations(source) {
  const code = codeOnly(source);
  const problems = [...blockProblems(code), ...sharedLines(code), ...nestedTernaries(code)];
  return problems
    .sort((a, b) => a.index - b.index)
    .map(({ index, message }) => ({ line: code.slice(0, index).split('\n').length, message }));
}

function main() {
  const files = javascriptFiles();
  let count = 0;
  for (const file of files) {
    for (const { line, message } of findViolations(fs.readFileSync(file, 'utf8'))) {
      console.error(`${path.relative(root, file)}:${line}: ${message}`);
      count++;
    }
  }

  if (count > 0) {
    console.error(`Style violations: ${count}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Style checked ${files.length} JavaScript files.`);
}

if (require.main === module) {
  main();
}

module.exports = { findViolations };
