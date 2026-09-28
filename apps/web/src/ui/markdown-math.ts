
type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = HastElement | HastText | { type: string; children?: HastNode[] };
type HastRoot = { type: "root"; children: HastNode[] };

const isElement = (node: HastNode): node is HastElement => node.type === "element";

const classNames = (node: HastElement): string[] => {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/);
  return [];
};

const isBlank = (node: HastNode): boolean => node.type === "text" && (node as HastText).value.trim() === "";

const soleInlineMath = (node: HastNode): HastElement | null => {
  if (!isElement(node) || node.tagName !== "p") return null;
  const content = node.children.filter((child) => !isBlank(child));
  if (content.length !== 1) return null;
  const only = content[0];
  if (!only || !isElement(only) || only.tagName !== "code") return null;
  return classNames(only).includes("math-inline") ? only : null;
};

const promote = (math: HastElement): HastElement => ({
  type: "element",
  tagName: "pre",
  properties: {},
  children: [
    {
      ...math,
      properties: {
        ...math.properties,
        className: classNames(math).map((name) => (name === "math-inline" ? "math-display" : name)),
      },
    },
  ],
});

const walk = (nodes: HastNode[]): HastNode[] =>
  nodes.map((node) => {
    const math = soleInlineMath(node);
    if (math) return promote(math);
    if (isElement(node) && node.children?.length) return { ...node, children: walk(node.children) };
    return node;
  });

export const rehypeDisplayStandaloneMath = () => (tree: HastRoot) => {
  tree.children = walk(tree.children);
};
