function escapedAt(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function protectLine(source) {
  let result = "";
  let inlineTicks = 0;
  for (let index = 0; index < source.length;) {
    if (source[index] === "`") {
      let count = 1;
      while (source[index + count] === "`") count += 1;
      if (inlineTicks === 0) inlineTicks = count;
      else if (inlineTicks === count) inlineTicks = 0;
      result += source.slice(index, index + count);
      index += count;
      continue;
    }
    if (inlineTicks === 0 && source[index] === "$" && !escapedAt(source, index)) {
      const tail = source.slice(index);
      const braced = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?:[^{}\r\n]*)\}/.exec(tail)?.[0] || "";
      const uppercase = /^\$[A-Z_][A-Za-z0-9_]+/.exec(tail)?.[0] || "";
      const token = braced || uppercase;
      // `$x + y$` remains normal inline math. Shell variables are protected
      // only when their token is not immediately closed by a math delimiter.
      if (token && tail[token.length] !== "$") {
        result += "\\$";
        index += 1;
        continue;
      }
    }
    result += source[index];
    index += 1;
  }
  return result;
}

function tableDelimiterLine(line) {
  const value = String(line || "");
  if (!/^ {0,3}\|?/.test(value) || !value.includes("|")) return false;
  const cells = value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableHeaderLine(line) {
  const value = String(line || "");
  if (!/^ {0,3}\|?/.test(value) || !value.includes("|")) return false;
  const cells = value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 2 && cells.some((cell) => cell.trim());
}

function markdownFenceMarker(line) {
  return /^ {0,3}(`{3,}|~{3,})/.exec(String(line || ""))?.[1] || "";
}

function standaloneSectionLine(line) {
  const value = String(line || "");
  if (/^ {0,3}#{1,6}[ \t]+\S.*$/.test(value)) return true;
  const match = /^ {0,3}(\*\*|__)(\S(?:.*\S)?)[ \t]*\1[ \t]*$/.exec(value);
  return Boolean(match?.[2]?.trim());
}

function topLevelListLine(line) {
  return /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\S/.test(String(line || ""));
}

/**
 * Restore block boundaries commonly lost while an Agent final response is
 * assembled. A standalone emphasized label followed by a list is a section
 * title, not a lazy continuation of the preceding list item. The first plain
 * paragraph after that section list must likewise leave the final list item.
 * Fenced examples and indented list content stay untouched.
 */
export function ensureSectionBlockBoundaries(input) {
  const source = String(input || "");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let fence = null;
  let waitingForSectionList = false;
  let insideSectionList = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = markdownFenceMarker(line);
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }

    if (!line.trim()) {
      output.push(line);
      if (insideSectionList) insideSectionList = false;
      continue;
    }

    if (standaloneSectionLine(line)) {
      if (output.length && output.at(-1)?.trim()) output.push("");
      output.push(line);
      waitingForSectionList = true;
      insideSectionList = false;
      const next = lines[index + 1] || "";
      if (next.trim() && topLevelListLine(next)) output.push("");
      continue;
    }

    if (topLevelListLine(line)) {
      if (waitingForSectionList) {
        waitingForSectionList = false;
        insideSectionList = true;
      }
      output.push(line);
      continue;
    }

    if (waitingForSectionList) waitingForSectionList = false;
    if (insideSectionList && /^\S/.test(line)) {
      if (output.at(-1)?.trim()) output.push("");
      insideSectionList = false;
    }
    output.push(line);
  }

  return output.join("\n");
}

/**
 * GFM tables need a block boundary before their header. Agent output often puts
 * the header directly after a short label, which otherwise leaves the pipes as
 * ordinary paragraph text. Only add the missing boundary for a complete
 * header+delimiter pair outside fenced code.
 */
export function ensureBlankLineBeforeTables(input) {
  const source = String(input || "");
  const lines = source.split(/\r?\n/);
  const output = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = markdownFenceMarker(line);
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
    }
    const previous = output[output.length - 1] || "";
    const next = lines[index + 1] || "";
    if (!fence && previous.trim() && tableHeaderLine(line) && tableDelimiterLine(next)) output.push("");
    output.push(line);
  }
  return output.join("\n");
}

/**
 * Prevent shell environment variables in Agent prose from opening a remark-math
 * span that can consume everything up to a much later dollar sign. Fenced and
 * inline code are already opaque to Markdown and are deliberately unchanged.
 */
export function protectShellVariablesFromInlineMath(input) {
  const source = String(input || "");
  let fence = null;
  return source.split(/(\r?\n)/).map((part) => {
    if (/^\r?\n$/.test(part)) return part;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(part)?.[1] || "";
    if (marker) {
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
      return part;
    }
    return fence ? part : protectLine(part);
  }).join("");
}
