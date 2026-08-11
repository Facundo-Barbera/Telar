import { startEngine } from "./daemon";

const daemon = await startEngine();
process.stdout.write(`Telar vNext engine listening on ${daemon.discovery.host}:${daemon.discovery.port}\n`);

const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
