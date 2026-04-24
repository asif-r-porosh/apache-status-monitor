"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const ROOT_DIR = __dirname;
const INDEX_PATH = path.join(ROOT_DIR, "index.html");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

const formatLocalTimestamp = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const readConfig = (configPath) => {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

  if (!Array.isArray(parsed)) {
    throw new Error("config.json must contain an array");
  }

  return parsed.map((server, index) => ({
    name: String(server.name),
    url: String(server.url),
    capacity: Number.parseInt(server.capacity, 10),
    priority: Number.parseInt(server.priority, 10),
    probingIntervalMs: Number.parseInt(server.probingIntervalMs, 10),
    probeTimeoutMs: Number.parseInt(server.probeTimeoutMs, 10),
    warningTolerance: Number.parseInt(server.warningTolerance, 10),
    _configIndex: index,
  }));
};

const getServerKey = (server) => `${server.name}::${server.url}`;

const buildProbeUrl = (server) => {
  const url = new URL(server.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = `${pathname}/server-status`;
  url.search = "auto";
  return url.toString();
};

const parseStatusText = (rawText) => {
  const busyMatch = rawText.match(/^BusyWorkers:\s*(\d+)/m);
  const idleMatch = rawText.match(/^IdleWorkers:\s*(\d+)/m);

  if (!busyMatch || !idleMatch) {
    return null;
  }

  return {
    busyWorkers: Number.parseInt(busyMatch[1], 10),
    idleWorkers: Number.parseInt(idleMatch[1], 10),
  };
};

const computeStatus = (load, capacity, warningTolerance) => {
  if (load === -1 || load >= capacity) {
    return "danger";
  }

  if (load >= (capacity * warningTolerance) / 100) {
    return "warning";
  }

  return "normal";
};

const STATUS_WEIGHT = {
  normal: 1,
  warning: 2,
  danger: 3,
};

const buildStatePayload = (config, currentState) => {
  const probedAt = currentState?.probedAt || null;
  const respondedAt = currentState?.respondedAt || null;
  const load = typeof currentState?.load === "number" ? currentState.load : -1;
  const response = currentState?.response || "Pending";
  const status = currentState?.status || computeStatus(load, config.capacity, config.warningTolerance);

  return {
    name: config.name,
    url: config.url,
    priority: config.priority,
    capacity: config.capacity,
    warningTolerance: config.warningTolerance,
    load,
    status,
    response,
    respondedAt,
    probedAt,
  };
};

const buildSnapshot = (config, serverStates) =>
  config
    .map((server) => buildStatePayload(server, serverStates.get(getServerKey(server))))
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      if (STATUS_WEIGHT[left.status] !== STATUS_WEIGHT[right.status]) {
        return STATUS_WEIGHT[right.status] - STATUS_WEIGHT[left.status];
      }

      return left.name.localeCompare(right.name);
    });

const fetchWithTimeout = async (url, timeoutMs, fetchImpl = fetch) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "text/plain",
      },
    });

    const body = await response.text();
    return {
      ok: response.ok,
      statusCode: response.status,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
};

const runProbe = async (server, serverStates, options = {}) => {
  const broadcastSnapshot = options.broadcastSnapshot || (() => {});
  const fetchImpl = options.fetchImpl || fetch;
  const key = getServerKey(server);
  const probeUrl = buildProbeUrl(server);
  const probedAt = formatLocalTimestamp();

  try {
    const result = await fetchWithTimeout(probeUrl, server.probeTimeoutMs, fetchImpl);

    if (!result.ok) {
      throw new Error(`HTTP ${result.statusCode}`);
    }

    const workerCounts = parseStatusText(result.body);
    if (!workerCounts) {
      throw new Error("Invalid server-status response");
    }

    const load = workerCounts.busyWorkers + workerCounts.idleWorkers;
    serverStates.set(key, {
      load,
      status: computeStatus(load, server.capacity, server.warningTolerance),
      response: "OK",
      respondedAt: formatLocalTimestamp(),
      probedAt,
    });
  } catch (error) {
    const response =
      error && error.name === "AbortError" ? "Timeout" : error.message || "Probe failed";

    serverStates.set(key, {
      load: -1,
      status: "danger",
      response,
      respondedAt: null,
      probedAt,
    });
  }

  broadcastSnapshot();
};

const serveFile = (res, filePath) => {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    res.end(data);
  });
};

const createMonitorApp = (options = {}) => {
  const host = options.host || process.env.HOST || "0.0.0.0";
  const port = Number.parseInt(options.port ?? process.env.PORT ?? 3000, 10);
  const configPath = options.configPath || path.join(ROOT_DIR, "config.json");
  const fetchImpl = options.fetchImpl || fetch;
  const activeLoops = new Map();
  const serverStates = new Map();
  const timers = new Set();

  let syncHandle = null;
  let stopped = false;

  const buildSnapshotForApp = () => {
    let config;

    try {
      config = readConfig(configPath);
    } catch (error) {
      return [];
    }

    return buildSnapshot(config, serverStates);
  };

  const broadcastSnapshot = () => {
    io.emit("monitor:update", {
      generatedAt: formatLocalTimestamp(),
      servers: buildSnapshotForApp(),
    });
  };

  const scheduleTimeout = (fn, delayMs) => {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, delayMs);
    timers.add(handle);
    return handle;
  };

  const ensureProbeLoops = () => {
    if (stopped) {
      return;
    }

    let config;

    try {
      config = readConfig(configPath);
    } catch (error) {
      console.error(`Failed to read config.json: ${error.message}`);
      syncHandle = scheduleTimeout(ensureProbeLoops, 1000);
      return;
    }

    const configuredKeys = new Set(config.map(getServerKey));

    for (const [key, loop] of activeLoops.entries()) {
      if (!configuredKeys.has(key)) {
        loop.cancelled = true;
        activeLoops.delete(key);
        serverStates.delete(key);
      }
    }

    for (const serverConfig of config) {
      const key = getServerKey(serverConfig);
      if (activeLoops.has(key)) {
        continue;
      }

      const loop = { cancelled: false };
      activeLoops.set(key, loop);
      serverStates.set(key, {
        load: -1,
        status: "danger",
        response: "Pending",
        respondedAt: null,
        probedAt: null,
      });

      const runLoop = async () => {
        if (loop.cancelled || stopped) {
          return;
        }

        let latestConfig;

        try {
          latestConfig = readConfig(configPath).find((item) => getServerKey(item) === key);
        } catch (error) {
          console.error(`Failed to reload config for ${serverConfig.name}: ${error.message}`);
        }

        if (!latestConfig) {
          activeLoops.delete(key);
          serverStates.delete(key);
          return;
        }

        const cycleStartedAt = Date.now();
        await runProbe(latestConfig, serverStates, { broadcastSnapshot, fetchImpl });

        if (loop.cancelled || stopped) {
          return;
        }

        const elapsedMs = Date.now() - cycleStartedAt;
        const delayMs = Math.max(0, latestConfig.probingIntervalMs - elapsedMs);
        scheduleTimeout(() => {
          runLoop().catch((error) => {
            console.error(`Probe loop crashed for ${latestConfig.name}: ${error.message}`);
            activeLoops.delete(key);
            scheduleTimeout(ensureProbeLoops, 1000);
          });
        }, delayMs);
      };

      runLoop().catch((error) => {
        console.error(`Probe loop crashed for ${serverConfig.name}: ${error.message}`);
        activeLoops.delete(key);
        scheduleTimeout(ensureProbeLoops, 1000);
      });
    }

    broadcastSnapshot();
    syncHandle = scheduleTimeout(ensureProbeLoops, 1000);
  };

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/") {
      serveFile(res, INDEX_PATH);
      return;
    }

    if (requestUrl.pathname === "/api/status") {
      const payload = JSON.stringify({
        generatedAt: formatLocalTimestamp(),
        servers: buildSnapshotForApp(),
      });

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(payload);
      return;
    }

    if (requestUrl.pathname.startsWith("/public/")) {
      const relativePath = requestUrl.pathname.replace(/^\/public\//, "");
      const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
      serveFile(res, path.join(PUBLIC_DIR, safePath));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  const io = new Server(server, {
    serveClient: false,
  });

  io.on("connection", (socket) => {
    socket.emit("monitor:update", {
      generatedAt: formatLocalTimestamp(),
      servers: buildSnapshotForApp(),
    });
  });

  const start = () =>
    new Promise((resolve) => {
      server.listen(port, host, () => {
        ensureProbeLoops();
        resolve();
      });
    });

  const stop = () =>
    new Promise((resolve, reject) => {
      stopped = true;

      for (const loop of activeLoops.values()) {
        loop.cancelled = true;
      }

      if (syncHandle) {
        clearTimeout(syncHandle);
      }

      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();

      io.close(() => {
        if (!server.listening) {
          resolve();
          return;
        }

        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }

          resolve();
        });
      });
    });

  return {
    host,
    port,
    server,
    io,
    start,
    stop,
    buildSnapshot: buildSnapshotForApp,
    serverStates,
    activeLoops,
  };
};

if (require.main === module) {
  const app = createMonitorApp();
  app.start().then(() => {
    console.log(`Apache Status Monitor listening on http://${app.host}:${app.port}`);
  });
}

module.exports = {
  STATUS_WEIGHT,
  buildProbeUrl,
  buildSnapshot,
  buildStatePayload,
  computeStatus,
  createMonitorApp,
  fetchWithTimeout,
  formatLocalTimestamp,
  getServerKey,
  parseStatusText,
  readConfig,
  runProbe,
};
