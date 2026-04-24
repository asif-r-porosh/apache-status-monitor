# Apache Status Monitor

Apache Status Monitor is a lightweight real-time dashboard for monitoring Apache
`mod_status` endpoints exposed through `server-status?auto`.

It is built for operators who need a small, understandable monitoring surface
without bringing in a large observability stack. The project focuses on
per-server probing isolation, fast visual feedback, and a simple deployment
model.

## Why This Project Exists

This project is intended for situations where you need:

- a quick operational view of Apache worker load
- a very small deployment footprint
- independent probe timing per monitored server
- a live browser dashboard without a frontend framework
- an easily auditable codebase for internal tooling

In practical terms, it helps answer:

- Which Apache servers are healthy right now?
- Which servers are approaching capacity?
- Which servers are overloaded or not responding?
- When was each server last probed and last successfully responded?

## Features

- Real-time monitoring of Apache `server-status?auto` endpoints
- One independent probe loop per configured server
- Per-server configuration for:
  - `capacity`
  - `priority`
  - `probingIntervalMs`
  - `probeTimeoutMs`
  - `warningTolerance`
- Live updates over Socket.IO
- Mobile-responsive HTML dashboard
- Light and dark theme support via system theme detection
- Local-time timestamps in `YYYY-MM-DD HH:MM:SS` 24-hour format
- Mock Apache status server with 10 endpoints for local testing
- Automated test suite with unit, integration, mock-server, and frontend DOM coverage

## Project Layout

```text
./apache-status-monitor
├── config.json
├── index.html
├── index.js
├── mockup_test_servers/
│   ├── mock-apache-status-servers.js
│   └── sample-server-status.txt
├── package.json
├── public/
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       └── socket.io.min.js
└── test/
```

## Requirements

- Node.js 18 or later
- Apache servers exposing `server-status?auto`, or the bundled mock server for local testing

## Setup

Install dependencies:

```bash
npm install
```

Start the monitor:

```bash
npm start
```

By default the monitor listens on port `3000`.

Open the dashboard:

- [http://localhost:3000](http://localhost:3000)

## Configuration

The monitor reads its server list from [config.json](/apache-status-monitor/config.json:1).

Each entry defines one monitored endpoint:

```json
{
  "name": "Dev Test Server 1",
  "url": "http://127.0.0.1:8811/server-01",
  "capacity": 100,
  "priority": 1,
  "probingIntervalMs": 5000,
  "probeTimeoutMs": 4500,
  "warningTolerance": 80
}
```

Field meanings:

- `name`: display name in the dashboard
- `url`: base URL of the monitored server; the monitor appends `/server-status?auto`
- `capacity`: maximum expected worker capacity for status evaluation
- `priority`: lower number means higher operational priority
- `probingIntervalMs`: how often that server is probed
- `probeTimeoutMs`: maximum time allowed for one probe
- `warningTolerance`: warning threshold as a percentage of capacity

Status rules:

- `danger` when `load >= capacity` or probing fails
- `warning` when `load >= capacity * warningTolerance / 100`
- `normal` otherwise

## How To Use It

1. Configure one or more servers in `config.json`
2. Start the monitor with `npm start`
3. Open the dashboard in a browser
4. Watch live updates for:
   - current `load`
   - `status`
   - `response`
   - `respondedAt`
   - `probedAt`

Sorting behavior:

- rows are grouped by `priority` ascending
- within the same priority group, status is sorted descending:
  - `danger`
  - `warning`
  - `normal`

## How To Test It

Start the bundled mock Apache status server:

```bash
npm run mock-servers
```

This starts 10 local mock endpoints on port `8811`.

Then start the monitor:

```bash
npm start
```

Open:

- [http://localhost:3000](http://localhost:3000)

The default `config.json` is already prepared to use all 10 mock servers, so you
should immediately see a mix of:

- `normal`
- `warning`
- `danger`

## Automated Tests

Run the complete automated suite:

```bash
npm test
```

Run the suite with coverage reporting:

```bash
npm run test:coverage
```

The test suite covers:

- backend unit logic
- probe and parsing behavior
- mock server behavior
- HTTP API behavior
- Socket.IO update flow
- frontend DOM rendering and socket state behavior

## How It Works

The monitor backend is intentionally small.

At runtime:

1. The server starts an HTTP app and a Socket.IO server
2. Each configured server gets its own independent probe loop
3. Before each loop iteration, `config.json` is re-read
4. The backend requests:

   ```text
   <configured url>/server-status?auto
   ```

5. It parses:
   - `BusyWorkers`
   - `IdleWorkers`
6. It calculates:

   ```text
   load = BusyWorkers + IdleWorkers
   ```

7. It evaluates the status using `capacity` and `warningTolerance`
8. It stores the latest in-memory state for each server
9. It broadcasts the latest snapshot to connected browsers over Socket.IO

Probe-loop design:

- each server is isolated from every other server
- one slow or failing server does not delay the others
- probe timing stays predictable per endpoint
- overlapping probes for the same server are avoided

## Frontend Notes

The frontend is plain HTML, CSS, and JavaScript.

It uses:

- bundled Socket.IO client from `public/js/socket.io.min.js`
- a small browser script in `public/js/app.js`
- a responsive table layout
- a blinking `◎` indicator for frontend/backend socket connection state
- system light/dark theme support through `prefers-color-scheme`

## Further Development

Reasonable next steps for the project:

- persistent historical metrics storage
- alert hooks for email, webhook, or chat notifications
- filtering and search in the dashboard
- grouping by environment, service, or region
- authentication if exposed beyond a trusted internal network
- exportable health snapshots or JSON feeds for other tools
- containerization and CI automation

## Tests And Coverage

This project includes a professional baseline automated suite and coverage
reporting suitable for a small production-style internal tool. Coverage is
intended to remain strong around:

- parsing logic
- status evaluation logic
- config reload behavior
- integration flow
- UI rendering behavior

When extending the project, new behavior should be accompanied by targeted tests
so the coverage profile stays meaningful rather than inflated.
