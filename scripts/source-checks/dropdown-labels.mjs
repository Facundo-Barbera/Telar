import { filesUnder, read } from "./files.mjs";

// Base UI's GroupLabel throws when no Menu.Group is open above it, and only when the menu opens.
/** Lines of `source` with a `<DropdownMenuLabel` outside an open group. A heuristic: tags in order, not a JSX parse. */
export function ungroupedLabels(source) {
  const pattern = /<(DropdownMenuContent|DropdownMenuGroup|DropdownMenuRadioGroup)[\s>]|<\/(DropdownMenuGroup|DropdownMenuRadioGroup)>|<(DropdownMenuLabel)[\s>]/g;
  const offenders = [];
  let depth = 0;
  for (const match of source.matchAll(pattern)) {
    if (match[1] === "DropdownMenuContent") depth = 0;
    else if (match[1]) depth += 1;
    else if (match[2]) depth = Math.max(0, depth - 1);
    else if (match[3] && depth === 0) offenders.push(source.slice(0, match.index).split("\n").length);
  }
  return offenders;
}

export const dropdownLabelsCheck = {
  name: "dropdown-labels-are-grouped",
  protects: "every DropdownMenuLabel in the cockpit sits inside a group, or opening its menu throws",
  run() {
    return filesUnder("apps/web/src", /\.tsx$/).flatMap((file) => {
      const source = read(file);
      return source.includes("<DropdownMenuLabel") ? ungroupedLabels(source).map((line) => `${file}:${line}: a DropdownMenuLabel outside a DropdownMenuGroup`) : [];
    });
  },
};
