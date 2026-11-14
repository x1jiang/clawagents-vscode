import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { markdownUrlTransform } from "./markdownLinks";

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ATTR_NAME_MAP: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  colSpan: "colspan",
  rowSpan: "rowspan",
  tabIndex: "tabindex",
};

const SPACE_SEPARATED_ATTRS = new Set(["className", "class"]);

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype);

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function serializeProperties(props: Properties | undefined): string {
  if (!props) return "";
  const parts: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(props)) {
    if (rawVal === null || rawVal === undefined || rawVal === false) continue;
    const attrName = ATTR_NAME_MAP[rawKey] ?? rawKey.toLowerCase();
    if (rawVal === true) {
      parts.push(` ${attrName}`);
      continue;
    }
    let attrVal = Array.isArray(rawVal)
      ? rawVal.map(String).join(SPACE_SEPARATED_ATTRS.has(rawKey) ? " " : ", ")
      : String(rawVal);
    if (attrName === "href" || attrName === "src") {
      attrVal = markdownUrlTransform(attrVal, attrName);
      if (!attrVal) continue;
    }
    parts.push(` ${attrName}="${escapeHtmlAttr(attrVal)}"`);
  }
  return parts.join("");
}

function serializeNode(node: Root | RootContent | ElementContent): string {
  switch (node.type) {
    case "root":
      return node.children.map(serializeNode).join("");
    case "text":
      return escapeHtmlText(node.value);
    case "element": {
      const el = node as Element;
      const attrs = serializeProperties(el.properties);
      if (VOID_ELEMENTS.has(el.tagName)) {
        return `<${el.tagName}${attrs}>`;
      }
      const childrenHtml = el.children.map(serializeNode).join("");
      return `<${el.tagName}${attrs}>${childrenHtml}</${el.tagName}>`;
    }
    default:
      return "";
  }
}

export function renderMarkdownToHtml(markdown: string): string {
  const tree = markdownProcessor.parse(markdown);
  const hast = markdownProcessor.runSync(tree) as Root;
  return serializeNode(hast);
}
