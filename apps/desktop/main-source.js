const fs = require("node:fs");
const path = require("node:path");

/** main.js and every module under main/, as one string, for source-contract tests. */
function mainSource() {
  const dir = path.join(__dirname, "main");
  const files = ["main.js", ...fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join("main", f))];
  return files.map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
}

module.exports = { mainSource };
