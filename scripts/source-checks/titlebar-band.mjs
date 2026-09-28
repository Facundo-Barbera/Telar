import { filesUnder, read } from "./files.mjs";

export const titlebarBandCheck = {
  name: "titlebar-inset-sets-the-band",
  protects: "a cockpit header that reserves the traffic lights' width also sits on their centreline (--titlebar-band-height)",
  run() {
    const reserves = filesUnder("apps/web/src", /\.tsx$/).filter((file) => read(file).includes("--titlebar-inset"));
    if (reserves.length <= 2) return [`apps/web/src: only ${reserves.length} headers reserve --titlebar-inset; the scan has rotted.`];
    return reserves.filter((file) => !read(file).includes("--titlebar-band-height")).map((file) => `${file}: reserves --titlebar-inset but never sets --titlebar-band-height`);
  },
};
