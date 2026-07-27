// pattern: Functional Core
// Hierarchy-preserving outline paste (pkm-tu3a): parse clipboard text into a
// forest by indentation, then plan the exact op batch that anchors it at the
// paste location. Indent widths are compared ordinally with an indent stack,
// so 2-space, 4-space, and tab clipboards all work without configuration; an
// over-indent jump of any size is exactly one level (malformed input clamps,
// never throws).

export interface PastedNode {
  text: string;
  children: PastedNode[];
}

const TAB_WIDTH = 4; // only matters when one clipboard mixes tabs and spaces

const BULLET_RE = /^[-*+] /;

interface MeasuredLine {
  width: number; // leading whitespace as columns, tabs expanded
  rest: string;  // the line after its indent
}

function measure(line: string): MeasuredLine {
  let width = 0;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === "\t") width += TAB_WIDTH;
    else if (line[i] === " ") width += 1;
    else break;
  }
  return { width, rest: line.slice(i) };
}

/** Clipboard text -> forest. Blank lines vanish; bullets are stripped only
 * when EVERY non-blank line carries one (a consistent markdown list), so
 * prose with one leading dash stays verbatim. */
export function parseOutlineForest(text: string): PastedNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
    .filter((line) => line.trim() !== "")
    .map(measure);
  if (lines.length === 0) return [];
  const stripBullets = lines.every((l) => BULLET_RE.test(l.rest));
  const roots: PastedNode[] = [];
  // Open ancestors with the width that opened each level. Pop everything at
  // or deeper than the current width: equal = sibling, between-levels =
  // sibling of the nearest shallower level (clamp), deeper = child.
  const stack: { width: number; node: PastedNode }[] = [];
  for (const { width, rest } of lines) {
    const node: PastedNode = {
      text: stripBullets ? rest.replace(BULLET_RE, "") : rest,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].width >= width) {
      stack.pop();
    }
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ width, node });
  }
  return roots;
}

/** Whether onPaste should intercept: multi-line text that parses to at least
 * one node. Single-line and blank-only pastes keep the native splice. */
export function isOutlinePaste(text: string): boolean {
  return text.replace(/\r\n?/g, "\n").includes("\n")
    && parseOutlineForest(text).length > 0;
}
