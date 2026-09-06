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

test("a candidate whose start() throws is stopped before the retry builds another", async () => {
  let built = 0;
  let stopped = 0;
  const controller = new WorkerReconnectController<{}, SupervisedWorker>({
    connect: async () => ({}),
    createWorker: async () => {
      built += 1;
      const attempt = built;
      return {
        async start() {
          if (attempt === 1) throw new Error("registration refused");
        },
        async stop() {
          stopped += 1;
        },
      };
    },
    pause: async () => {},
  });
  await controller.start();
  expect(built).toBe(2);
  expect(stopped).toBe(1);
  await controller.stop();
  expect(stopped).toBe(2);
});

test("stop during an async createWorker discards the candidate and never starts it", async () => {
  let started = 0;
  let stopped = 0;
  let release: (() => void) | undefined;
  const controller = new WorkerReconnectController<{}, SupervisedWorker>({
    connect: async () => ({}),
    createWorker: async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return {
        async start() {
          started += 1;
        },
        async stop() {
          stopped += 1;
        },
      };
    },
    pause: async () => {},
  });
  const starting = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = controller.stop();
  release!();
  await Promise.all([starting, stopping]);
  expect(started).toBe(0);
  expect(stopped).toBe(1);
});

test("a connection loss after registration replaces the worker with a fresh one, and stop ends the loop", async () => {
  let built = 0;
  let stopped = 0;
  let lose: (() => void) | undefined;
  const controller = new WorkerReconnectController<{}, SupervisedWorker>({
    connect: async () => ({}),
    createWorker: async (_client, onConnectionLost) => {
      built += 1;
      lose = onConnectionLost;
      return {
        async start() {},
        async stop() {
          stopped += 1;
        },
      };
    },
    pause: async () => {},
  });

  await controller.start();
  expect(built).toBe(1);
  lose!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stopped).toBe(1);
  expect(built).toBe(2);

  await controller.stop();
  expect(stopped).toBe(2);
  lose!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(built).toBe(2);
});
