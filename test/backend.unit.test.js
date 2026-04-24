"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATUS_WEIGHT,
  buildProbeUrl,
  buildSnapshot,
  buildStatePayload,
  computeStatus,
  fetchWithTimeout,
  formatLocalTimestamp,
  getServerKey,
  parseStatusText,
  readConfig,
  runProbe,
} = require("../index.js");

test("readConfig parses config entries into numeric fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-config-"));
  const configPath = path.join(tempDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify([
      {
        name: "A",
        url: "http://127.0.0.1:8811/server-01",
        capacity: "100",
        priority: "1",
        probingIntervalMs: "5000",
        probeTimeoutMs: "4500",
        warningTolerance: "80",
      },
    ]),
    "utf8"
  );

  const [entry] = readConfig(configPath);
  assert.deepEqual(
    {
      name: entry.name,
      url: entry.url,
      capacity: entry.capacity,
      priority: entry.priority,
      probingIntervalMs: entry.probingIntervalMs,
      probeTimeoutMs: entry.probeTimeoutMs,
      warningTolerance: entry.warningTolerance,
    },
    {
      name: "A",
      url: "http://127.0.0.1:8811/server-01",
      capacity: 100,
      priority: 1,
      probingIntervalMs: 5000,
      probeTimeoutMs: 4500,
      warningTolerance: 80,
    }
  );
});

test("buildProbeUrl appends /server-status?auto correctly", () => {
  assert.equal(
    buildProbeUrl({ url: "http://127.0.0.1:8811/server-01" }),
    "http://127.0.0.1:8811/server-01/server-status?auto"
  );
  assert.equal(
    buildProbeUrl({ url: "http://127.0.0.1:8811/server-01/" }),
    "http://127.0.0.1:8811/server-01/server-status?auto"
  );
});

test("parseStatusText extracts BusyWorkers and IdleWorkers", () => {
  assert.deepEqual(
    parseStatusText("BusyWorkers: 12\nIdleWorkers: 88\n"),
    { busyWorkers: 12, idleWorkers: 88 }
  );
  assert.equal(parseStatusText("BusyWorkers: abc\nIdleWorkers: 88"), null);
});

test("computeStatus follows danger warning normal thresholds", () => {
  assert.equal(computeStatus(-1, 100, 80), "danger");
  assert.equal(computeStatus(100, 100, 80), "danger");
  assert.equal(computeStatus(80, 100, 80), "warning");
  assert.equal(computeStatus(79, 100, 80), "normal");
});

test("formatLocalTimestamp uses YYYY-MM-DD HH:MM:SS in local time", () => {
  const formatted = formatLocalTimestamp(new Date(2026, 3, 24, 18, 5, 9));
  assert.equal(formatted, "2026-04-24 18:05:09");
});

test("buildStatePayload and buildSnapshot preserve sorting contract", () => {
  const config = [
    { name: "B", url: "http://b", priority: 1, capacity: 100, warningTolerance: 80 },
    { name: "A", url: "http://a", priority: 1, capacity: 100, warningTolerance: 80 },
    { name: "C", url: "http://c", priority: 2, capacity: 100, warningTolerance: 80 },
  ];
  const states = new Map([
    [getServerKey(config[0]), { load: 50, status: "normal", response: "OK", respondedAt: "r1", probedAt: "p1" }],
    [getServerKey(config[1]), { load: 90, status: "warning", response: "OK", respondedAt: "r2", probedAt: "p2" }],
    [getServerKey(config[2]), { load: 101, status: "danger", response: "OK", respondedAt: "r3", probedAt: "p3" }],
  ]);

  const snapshot = buildSnapshot(config, states);
  assert.deepEqual(snapshot.map((item) => item.name), ["A", "B", "C"]);
  assert.equal(STATUS_WEIGHT.warning > STATUS_WEIGHT.normal, true);
});

test("fetchWithTimeout returns response body from supplied fetch implementation", async () => {
  const result = await fetchWithTimeout(
    "http://example.test",
    100,
    async () => ({
      ok: true,
      status: 200,
      text: async () => "BusyWorkers: 3\nIdleWorkers: 7\n",
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /BusyWorkers/);
});

test("runProbe stores success state for valid endpoint response", async () => {
  const states = new Map();
  const server = {
    name: "Test",
    url: "http://127.0.0.1:8811/server-01",
    capacity: 100,
    priority: 1,
    probeTimeoutMs: 100,
    warningTolerance: 80,
  };

  await runProbe(server, states, {
    broadcastSnapshot: () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "BusyWorkers: 15\nIdleWorkers: 70\n",
    }),
  });

  const saved = states.get(getServerKey(server));
  assert.equal(saved.load, 85);
  assert.equal(saved.status, "warning");
  assert.equal(saved.response, "OK");
  assert.match(saved.respondedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(saved.probedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("runProbe stores failure state for timeout and invalid payload", async () => {
  const timeoutStates = new Map();
  const invalidStates = new Map();
  const server = {
    name: "Test",
    url: "http://127.0.0.1:8811/server-01",
    capacity: 100,
    priority: 1,
    probeTimeoutMs: 100,
    warningTolerance: 80,
  };

  await runProbe(server, timeoutStates, {
    broadcastSnapshot: () => {},
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  await runProbe(server, invalidStates, {
    broadcastSnapshot: () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "missing worker counts",
    }),
  });

  assert.equal(timeoutStates.get(getServerKey(server)).response, "Timeout");
  assert.equal(invalidStates.get(getServerKey(server)).status, "danger");
});
