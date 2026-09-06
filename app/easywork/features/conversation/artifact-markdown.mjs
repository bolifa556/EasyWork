import { remoteArtifactPath, stripFileLinkDecoration, FILE_LINK_DECORATION } from "../../../../shared/remote-artifact-links.mjs";

const isCard = (node) => node.type === "artifactCard";
const textOf = (node) => node.value || (node.children || []).map(textOf).join("");
const hasContent = (nodes) => nodes.some((node) => node.type === "text" ? node.value.trim() : node.children ? hasContent(node.children) : true);
const iconSource = FILE_LINK_DECORATION.source;
const trailingIcons = new RegExp(`[^\\S\\n]*(?:${iconSource}\\s*)+$`, "u");
const leadingIcons = new RegExp(`^(?:\\s*${iconSource})+[^\\S\\n]*`, "u");
const isFilenameText = (node) => ["text", "inlineCode", "strong", "emphasis"].includes(node.type) && (!node.children || node.children.every(isFilenameText));

function trimAdjacentIcon(node, end) {
  if (node?.type === "text") node.value = node.value.replace(end ? trailingIcons : leadingIcons, "");
  else if (["strong", "emphasis", "delete"].includes(node?.type)) {
    trimAdjacentIcon(end ? node.children.at(-1) : node.children[0], end);
  }
}

/** Turn only captured file links into block cards; keep the rest of the AST. */
export function remarkArtifactCards({ cards = [] } = {}) {
  return (tree) => {
    const byPath = new Map(cards.filter((card) => card.path).map((card) => [card.path, card]));
    const byName = new Map();
    for (const card of cards) {
      if (!byName.has(card.name)) byName.set(card.name, card);
      else byName.set(card.name, null); // Never guess between duplicate filenames.
    }
    const definitions = new Map();
    const visit = (node) => {
      if (node.type === "definition") definitions.set(node.identifier, node);
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
    const used = new Set();
    const marker = (card) => {
      used.add(card.id);
      return { type: "artifactCard", data: { hName: "div", hProperties: { "data-artifact-id": card.id } }, children: [] };
    };
    // Lift cards out of emphasis, paragraphs and headings; never nest an
    // article inside a paragraph. Lists, tables and quotes keep their structure.
    const split = (node, children) => {
      if (!children.some(isCard)) return [{ ...node, children }];
      const result = [];
      let prose = [];
      const flush = () => {
        if (hasContent(prose)) result.push({ ...node, children: prose });
        prose = [];
      };
      for (const child of children) {
        if (isCard(child)) { flush(); result.push(child); }
        else prose.push(child);
      }
      flush();
      return result;
    };
    const transform = (node) => {
      if (node.type === "link" || node.type === "linkReference") {
        const target = node.type === "link" ? node.url : definitions.get(node.identifier)?.url;
        const card = String(target || "").startsWith("file://") ? byPath.get(remoteArtifactPath(target)) : null;
        if (card) return [marker(card)];
      }
      if (!node.children) return [node];
      // Old replies can persist only a filename. Replace an exact standalone
      // placeholder without swallowing surrounding prose or code examples.
      if (node.type === "paragraph") {
        const name = stripFileLinkDecoration(textOf(node)).trim();
        const card = byName.get(name);
        if (card && node.children.every(isFilenameText)) return [marker(card)];
      }
      const children = node.children.flatMap(transform);
      for (let index = 0; index < children.length; index += 1) {
        if (!isCard(children[index])) continue;
        const before = children[index - 1], after = children[index + 1];
        trimAdjacentIcon(before, true);
        trimAdjacentIcon(after, false);
      }
      if (["paragraph", "heading", "strong", "emphasis", "delete"].includes(node.type)) return split(node, children);
      return [{ ...node, children }];
    };
    tree.children = transform(tree)[0].children;
    // Keep artifacts from agents that provided no link accessible, while
    // linked artifacts appear only at their original position.
    for (const card of cards) if (!used.has(card.id)) tree.children.push(marker(card));
  };
}
