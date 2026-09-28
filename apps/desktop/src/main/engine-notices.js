"use strict";

const fs = require("node:fs");
const http = require("node:http");

const STREAM_PATH = "/v2/push/desktop/stream";
const MESSAGES_PATH = "/v2/push/desktop/messages";
const RETRY_MS = 2_000;

function frames(onMessage) {
  let buffered = "";
  return (chunk) => {
    buffered += chunk;
    const parts = buffered.split("\n\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onMessage(JSON.parse(line.slice(6)));
        } catch {
          continue;
        }
      }
    }
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function createEngineNotices({ onMessage, retryMs = RETRY_MS, readDiscovery: read = readJson }) {
  let discoveryFile = null;
  const readDiscovery = () => (discoveryFile ? read(discoveryFile) : null);
  let request = null;
  let timer = null;
  let stopped = false;

  const retry = () => {
    request = null;
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, retryMs);
    timer.unref?.();
  };

  function connect() {
    if (stopped) return;
    const discovery = readDiscovery();
    if (!discovery?.port || !discovery?.token) return retry();
    request = http.get(
      { host: discovery.host || "127.0.0.1", port: discovery.port, path: STREAM_PATH, headers: { authorization: `Bearer ${discovery.token}` } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return retry();
        }
        response.setEncoding("utf8");
        response.on("data", frames(onMessage));
        response.on("end", retry);
        response.on("error", retry);
      },
    );
    request.on("error", retry);
  }

  function send(message) {
    const discovery = readDiscovery();
    if (!discovery?.port || !discovery?.token) return;
    const body = JSON.stringify(message);
    const post = http.request(
      {
        host: discovery.host || "127.0.0.1",
        port: discovery.port,
        method: "POST",
        path: MESSAGES_PATH,
        headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => response.resume(),
    );
    post.on("error", () => {});
    post.end(body);
  }

  return {
    send,
    start(file) {
      if (discoveryFile && !stopped) return;
      discoveryFile = file;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      discoveryFile = null;
      if (timer) clearTimeout(timer);
      request?.destroy();
    },
  };
}

module.exports = { createEngineNotices, STREAM_PATH, MESSAGES_PATH };
