"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMockServer } = require("../mockup_test_servers/mock-apache-status-servers.js");

const startServer = (server, port, host) =>
  new Promise((resolve) => {
    server.listen(port, host, () => resolve(server.address()));
  });

const stopServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

test("mock server serves plain-text mod_status style payload", async () => {
  const mock = createMockServer({
    port: 0,
    servers: [
      {
        route: "/server-01",
        name: "Mock",
        delayMs: 1,
        totalMin: 10,
        totalMax: 10,
      },
    ],
  });

  const address = await startServer(mock.server, mock.port, mock.host);

  try {
    const response = await fetch(`http://${mock.host}:${address.port}/server-01/server-status?auto`);
    const body = await response.text();

    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(body, /^BusyWorkers:\s*\d+/m);
    assert.match(body, /^IdleWorkers:\s*\d+/m);
    assert.match(body, /^Scoreboard:\s+/m);
  } finally {
    await stopServer(mock.server);
  }
});
