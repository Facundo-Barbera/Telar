/** Bun's text loader: `import source from "./bridge.py" with { type: "text" }`. */
declare module "*.py" {
  const source: string;
  export default source;
}
