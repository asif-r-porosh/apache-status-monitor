"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.PORT, 10) || 8811;
const SAMPLE_STATUS_PATH = path.join(__dirname, "sample-server-status.txt");
const sampleStatusTemplate = fs.readFileSync(SAMPLE_STATUS_PATH, "utf8");

const defaultMockServers = Array.from({ length: 10 }, (_, index) => ({
  route: `/server-${String(index + 1).padStart(2, "0")}`,
  name: `Dev Test Server ${index + 1}`,
  delayMs: [180, 260, 420, 620, 900, 230, 540, 760, 310, 1120][index],
  totalMin: [20, 95, 75, 150, 130, 40, 210, 180, 320, 420][index],
  totalMax: [65, 155, 145, 245, 310, 140, 410, 500, 620, 760][index],
}));

const randomInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const buildWorkerCounts = (config) => {
  const totalWorkers = randomInt(config.totalMin, config.totalMax);
  const busyWorkers = randomInt(0, totalWorkers);
  const idleWorkers = totalWorkers - busyWorkers;

  return {
    busyWorkers,
    idleWorkers,
  };
};

const renderApacheStatus = ({ host, busyWorkers, idleWorkers }) => {
  const now = new Date();
  const currentTime = now.toUTCString().replace("GMT", "UTC");
  const restartTime = new Date(now.getTime() - randomInt(900000, 7200000))
    .toUTCString()
    .replace("GMT", "UTC");
  const uptimeSeconds = randomInt(600, 28800);
  const totalAccesses = randomInt(10, 9000);
  const totalKBytes = randomInt(10, 64000);
  const totalDuration = randomInt(5, 2000);
  const connsTotal = busyWorkers > 0 ? randomInt(1, busyWorkers) : 0;
  const scoreboard = "_".repeat(idleWorkers) + "W".repeat(busyWorkers) + ".".repeat(320);

  return sampleStatusTemplate
    .replace(/^127\.0\.0\.1$/m, host)
    .replace(/^CurrentTime: .*/m, `CurrentTime: ${currentTime}`)
    .replace(/^RestartTime: .*/m, `RestartTime: ${restartTime}`)
    .replace(/^ServerUptimeSeconds: .*/m, `ServerUptimeSeconds: ${uptimeSeconds}`)
    .replace(/^ServerUptime: .*/m, `ServerUptime: ${Math.floor(uptimeSeconds / 60)} minutes ${uptimeSeconds % 60} seconds`)
    .replace(/^Total Accesses: .*/m, `Total Accesses: ${totalAccesses}`)
    .replace(/^Total kBytes: .*/m, `Total kBytes: ${totalKBytes}`)
    .replace(/^Total Duration: .*/m, `Total Duration: ${totalDuration}`)
    .replace(/^BusyWorkers: .*/m, `BusyWorkers: ${busyWorkers}`)
    .replace(/^IdleWorkers: .*/m, `IdleWorkers: ${idleWorkers}`)
    .replace(/^Processes: .*/m, `Processes: ${randomInt(2, 8)}`)
    .replace(/^ConnsTotal: .*/m, `ConnsTotal: ${connsTotal}`)
    .replace(/^ConnsAsyncWaitIO: .*/m, `ConnsAsyncWaitIO: ${randomInt(0, 1)}`)
    .replace(/^ConnsAsyncWriting: .*/m, `ConnsAsyncWriting: ${randomInt(0, 1)}`)
    .replace(/^ConnsAsyncKeepAlive: .*/m, `ConnsAsyncKeepAlive: ${randomInt(0, 2)}`)
    .replace(/^ConnsAsyncClosing: .*/m, `ConnsAsyncClosing: ${randomInt(0, 1)}`)
    .replace(/^Scoreboard: .*/m, `Scoreboard: ${scoreboard}`);
};

const createMockServer = ({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  servers = defaultMockServers,
} = {}) => {
  const mockServerMap = servers.reduce((accumulator, serverConfig) => {
    accumulator[`${serverConfig.route}/server-status`] = serverConfig;
    return accumulator;
  }, {});

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${host}:${port}`);
    const config = mockServerMap[parsedUrl.pathname];

    if (!config) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Mock Apache status route not found");
      return;
    }

    const { busyWorkers, idleWorkers } = buildWorkerCounts(config);
    const statusText = renderApacheStatus({
      host,
      busyWorkers,
      idleWorkers,
    });

    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(statusText);
    }, config.delayMs);
  });

  return {
    host,
    port,
    routes: servers.map((serverConfig) => ({
      name: serverConfig.name,
      url: `http://${host}:${port}${serverConfig.route}/server-status?auto`,
    })),
    server,
  };
};

if (require.main === module) {
  const instance = createMockServer();

  instance.server.listen(instance.port, instance.host, () => {
    console.log(`Mock Apache status server running at http://${instance.host}:${instance.port}`);
    instance.routes.forEach((route) => {
      console.log(`- ${route.name}: ${route.url}`);
    });
  });
}

module.exports = {
  createMockServer,
  defaultMockServers,
};
