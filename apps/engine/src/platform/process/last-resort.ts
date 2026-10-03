const detail = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));
const headline = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export function installLastResortHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Telar engine: kept running past an unhandled rejection: ${detail(reason)}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`Telar engine stopped: uncaught ${headline(error).split("\n")[0]}\n${detail(error)}\n`);
    process.exit(1);
  });
}
