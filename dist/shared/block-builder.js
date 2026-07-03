function paragraph(content) {
    return {
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content } }] },
    };
}
function heading2(content) {
    return {
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content } }] },
    };
}
function bulletedListItem(content) {
    return {
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content } }] },
    };
}
export function buildDigestBlocks(lines) {
    const blocks = [];
    for (const line of lines) {
        if (line.startsWith("## ")) {
            blocks.push(heading2(line.replace(/^##\s*/, "")));
        }
        else if (line.startsWith("- ")) {
            blocks.push(bulletedListItem(line.replace(/^-\s*/, "")));
        }
        else if (line.trim()) {
            blocks.push(paragraph(line));
        }
    }
    return blocks;
}
