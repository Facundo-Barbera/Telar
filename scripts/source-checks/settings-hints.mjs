import { filesUnder, read } from "./files.mjs";

export const settingsHintsCheck = {
  name: "settings-errors-keep-their-own-slot",
  protects: "no settings row puts its write failure in the hint, where it would replace the explanation",
  run() {
    return filesUnder("apps/web/src/features/settings", /\.tsx$/)
      .filter((file) => read(file).includes("hint={error ??"))
      .map((file) => `${file}: passes its error as the hint; use the row's error slot`);
  },
};
