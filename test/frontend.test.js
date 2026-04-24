"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

const buildDom = async () => {
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/",
    runScripts: "outside-only",
  });

  return dom;
};

test("frontend renders snapshot rows and updates socket indicator", async () => {
  const dom = await buildDom();
  const { window } = dom;
  const socketHandlers = new Map();

  window.io = () => ({
    on(eventName, handler) {
      socketHandlers.set(eventName, handler);
    },
  });

  window.fetch = async () => ({
    json: async () => ({
      servers: [
        {
          name: "Alpha",
          status: "normal",
          priority: 1,
          capacity: 100,
          load: 25,
          warningTolerance: 80,
          response: "OK",
          respondedAt: "2026-01-01T00:00:00Z",
          probedAt: "2026-01-01T00:00:01Z",
        },
      ],
    }),
  });

  const intervals = [];
  window.setInterval = (fn, delay) => {
    intervals.push({ fn, delay });
    return intervals.length;
  };
  window.clearInterval = () => {};

  const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  window.eval(appJs);

  await new Promise((resolve) => setTimeout(resolve, 0));

  const socketIndicator = window.document.getElementById("socketIndicator");
  const statusTableBody = window.document.getElementById("statusTableBody");

  assert.match(socketIndicator.className, /socket-pending/);
  assert.match(statusTableBody.textContent, /Alpha/);
  assert.equal(intervals[0].delay, 3000);

  socketHandlers.get("connect")();
  assert.match(socketIndicator.className, /socket-ok/);

  socketHandlers.get("monitor:update")({
    servers: [
      {
        name: "Beta",
        status: "danger",
        priority: 2,
        capacity: 200,
        load: 220,
        warningTolerance: 70,
        response: "Timeout",
        respondedAt: null,
        probedAt: "2026-01-01T00:01:00Z",
      },
    ],
  });

  assert.match(statusTableBody.innerHTML, /Beta/);
  assert.match(statusTableBody.innerHTML, /status-danger/);

  socketHandlers.get("disconnect")();
  assert.match(socketIndicator.className, /socket-down/);
});
