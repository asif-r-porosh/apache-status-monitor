"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { io: ioClient } = require("socket.io-client");

const { createMonitorApp } = require("../index.js");

const writeConfig = (configPath, config) => {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
};

const waitForEvent = (socket, eventName, predicate = () => true) =>
  new Promise((resolve) => {
    const handler = (payload) => {
      if (!predicate(payload)) {
        return;
      }

      socket.off(eventName, handler);
      resolve(payload);
    };

    socket.on(eventName, handler);
  });

test("monitor API and socket broadcast reflect probe results", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-int-"));
  const configPath = path.join(tempDir, "config.json");
  let fetchCount = 0;

  writeConfig(configPath, [
    {
      name: "Server A",
      url: "http://127.0.0.1:8811/server-a",
      capacity: 100,
      priority: 1,
      probingIntervalMs: 1000,
      probeTimeoutMs: 100,
      warningTolerance: 80,
    },
    {
      name: "Server B",
      url: "http://127.0.0.1:8811/server-b",
      capacity: 100,
      priority: 1,
      probingIntervalMs: 1000,
      probeTimeoutMs: 100,
      warningTolerance: 80,
    },
  ]);

  const app = createMonitorApp({
    host: "127.0.0.1",
    port: 0,
    configPath,
    fetchImpl: async (url) => {
      fetchCount += 1;

      if (String(url).includes("server-a")) {
        return {
          ok: true,
          status: 200,
          text: async () => "BusyWorkers: 10\nIdleWorkers: 20\n",
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => "BusyWorkers: 50\nIdleWorkers: 45\n",
      };
    },
  });

  await app.start();
  t.after(async () => {
    await app.stop();
  });

  const address = app.server.address();
  const socket = ioClient(`http://${address.address}:${address.port}`, {
    transports: ["websocket"],
  });

  t.after(() => {
    socket.close();
  });

  const payload = await waitForEvent(
    socket,
    "monitor:update",
    (message) => message.servers.every((server) => server.response !== "Pending")
  );
  assert.equal(Array.isArray(payload.servers), true);
  assert.equal(payload.servers.length, 2);

  const apiResponse = await fetch(`http://${address.address}:${address.port}/api/status`);
  const apiPayload = await apiResponse.json();

  assert.equal(apiResponse.status, 200);
  assert.equal(apiPayload.servers[0].name, "Server B");
  assert.equal(apiPayload.servers[0].status, "warning");
  assert.equal(apiPayload.servers[1].status, "normal");
  assert.equal(fetchCount >= 2, true);
});

test("monitor re-reads config and removes cancelled loops when config changes", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-reload-"));
  const configPath = path.join(tempDir, "config.json");

  writeConfig(configPath, [
    {
      name: "Server A",
      url: "http://127.0.0.1:8811/server-a",
      capacity: 100,
      priority: 1,
      probingIntervalMs: 80,
      probeTimeoutMs: 50,
      warningTolerance: 80,
    },
  ]);

  const app = createMonitorApp({
    host: "127.0.0.1",
    port: 0,
    configPath,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "BusyWorkers: 10\nIdleWorkers: 10\n",
    }),
  });

  await app.start();
  t.after(async () => {
    await app.stop();
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(app.activeLoops.size, 1);

  writeConfig(configPath, [
    {
      name: "Server B",
      url: "http://127.0.0.1:8811/server-b",
      capacity: 100,
      priority: 1,
      probingIntervalMs: 80,
      probeTimeoutMs: 50,
      warningTolerance: 80,
    },
  ]);

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const snapshot = app.buildSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].name, "Server B");
});
