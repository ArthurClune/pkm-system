// pattern: Imperative Shell
import { useEffect } from "react";
import keyboardDoc from "../../../docs/keyboard.md?raw";
import { parseHelpMarkdown, type HelpBlock, type Inline } from "../help/parseHelpMarkdown";

// docs/keyboard.md is the single source of truth; parsed once at module
// load since the doc is static for the lifetime of the page.
const blocks: HelpBlock[] = parseHelpMarkdown(keyboardDoc);

function renderInline(inline: Inline) {
  return inline.map((segment, i) =>
    segment.code
      ? <code className="inline-code" key={i}>{segment.text}</code>
      : segment.text,
  );
}

const HEADING_TAGS = { 1: "h1", 2: "h2", 3: "h3" } as const;

/** Split out from Help() so tests can render a small fixture's parsed
 * blocks without going through the real doc's module-level import. */
export function HelpBlocks({ blocks }: { blocks: HelpBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          const Tag = HEADING_TAGS[block.level];
          return <Tag key={i}>{renderInline(block.inline)}</Tag>;
        }
        if (block.kind === "paragraph") {
          return <p key={i}>{renderInline(block.inline)}</p>;
        }
        return (
          <div className="roam-table-scroll" key={i}>
            <table className="roam-table">
              <thead>
                <tr>
                  {block.header.map((cell, ci) => <th key={ci}>{renderInline(cell)}</th>)}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => <td key={ci}>{renderInline(cell)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

export function Help() {
  useEffect(() => { document.title = "Keyboard shortcuts — pkm"; }, []);

  return (
    <article className="help-page">
      <HelpBlocks blocks={blocks} />
    </article>
  );
}
