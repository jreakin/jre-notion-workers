/**
 * Build Notion API block objects for digest page content.
 * Uses the block structure expected by blocks.children.append.
 */
type RichTextItem = { type: "text"; text: { content: string } };

function paragraph(content: string): { type: "paragraph"; paragraph: { rich_text: RichTextItem[] } } {
  return {
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}

function heading2(content: string): { type: "heading_2"; heading_2: { rich_text: RichTextItem[] } } {
  return {
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content } }] },
  };
}

function bulletedListItem(
  content: string
): { type: "bulleted_list_item"; bulleted_list_item: { rich_text: RichTextItem[] } } {
  return {
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [{ type: "text", text: { content } }] },
  };
}

export function buildDigestBlocks(lines: string[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      blocks.push(heading2(line.replace(/^##\s*/, "")));
    } else if (line.startsWith("- ")) {
      blocks.push(bulletedListItem(line.replace(/^-\s*/, "")));
    } else if (line.trim()) {
      blocks.push(paragraph(line));
    }
  }
  return blocks;
}
