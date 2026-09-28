const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

// A JSON file in userData read through `validate`; missing, corrupt or invalid
// reads as a copy of `defaults`, and a failed write is logged, never thrown.
function jsonPrefs(file, defaults, validate, label) {
  const filePath = () => path.join(app.getPath("userData"), file);
  return {
    path: filePath,
    read() {
      try {
        return validate(JSON.parse(fs.readFileSync(filePath(), "utf8")));
      } catch {
        return defaults && { ...defaults };
      }
    },
    write(value) {
      try {
        fs.mkdirSync(app.getPath("userData"), { recursive: true });
        fs.writeFileSync(filePath(), JSON.stringify(value), "utf8");
      } catch (err) {
        console.error(`[telar-desktop] failed to persist ${label}:`, err.message);
      }
    },
  };
}

module.exports = { jsonPrefs };
