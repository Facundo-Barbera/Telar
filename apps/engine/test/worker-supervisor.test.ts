import { expect, test } from "bun:test";
import { WorkerReconnectController, type SupervisedWorker } from "../src/worker-supervisor";

test("a connection loss during the first registration retries instead of publishing a disconnected worker", async () => {
  let attempts = 0;
  let stopped = 0;
  const controller = new WorkerReconnectController<{}, SupervisedWorker>({
    connect: async () => ({}),
    createWorker: (_client, onConnectionLost) => ({
      async start() {
        attempts += 1;
        if (attempts === 1) onConnectionLost();
      },
      async stop() {
        stopped += 1;
      },
    }),
    pause: async () => {},
  });

  await controller.start();
  expect(attempts).toBe(2);
  expect(stopped).toBe(1);
  await controller.stop();
  expect(stopped).toBe(2);
});
