const childStopsItself = () => process.listenerCount("disconnect") > 1;
process.on("disconnect", () => {
  if (!childStopsItself()) process.exit(0);
});

const title = process.env.TELAR_PROCESS_TITLE;
if (typeof title === "string" && title.trim() !== "") {
  process.title = title;
  Object.defineProperty(process, "title", {
    configurable: true,
    enumerable: true,
    get: () => title,
    set: () => {
    },
  });
}
