"use strict";

(function () {
  const escapeHtml = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const setSocketState = (socketIndicator, state, label) => {
    socketIndicator.className = `socket-indicator socket-${state}`;
    socketIndicator.setAttribute("aria-label", label);
    socketIndicator.setAttribute("title", label);
  };

  const renderRows = (statusTableBody, servers) => {
    if (!Array.isArray(servers) || servers.length === 0) {
      statusTableBody.innerHTML = '<tr><td colspan="9" class="empty-row">No servers configured.</td></tr>';
      return;
    }

    statusTableBody.innerHTML = servers
      .map((server) => `
        <tr class="row-${escapeHtml(server.status)}">
          <td data-label="Server">${escapeHtml(server.name)}</td>
          <td data-label="Status"><span class="status-pill status-${escapeHtml(server.status)}">${escapeHtml(server.status)}</span></td>
          <td data-label="Priority">${escapeHtml(server.priority)}</td>
          <td data-label="Capacity">${escapeHtml(server.capacity)}</td>
          <td data-label="Load">${escapeHtml(server.load)}</td>
          <td data-label="Tolerance">${escapeHtml(server.warningTolerance)}</td>
          <td data-label="Response">${escapeHtml(server.response)}</td>
          <td data-label="Responded At">${escapeHtml(server.respondedAt || "-")}</td>
          <td data-label="Probed At">${escapeHtml(server.probedAt || "-")}</td>
        </tr>
      `)
      .join("");
  };

  const createFrontendApp = ({
    documentRef = document,
    ioFactory = io,
    fetchImpl = fetch,
    pollIntervalMs = 3000,
    timerApi = { setInterval, clearInterval },
  } = {}) => {
    const socketIndicator = documentRef.getElementById("socketIndicator");
    const statusTableBody = documentRef.getElementById("statusTableBody");
    const socket = ioFactory();

    const fetchSnapshot = () =>
      fetchImpl("/api/status", { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => renderRows(statusTableBody, payload.servers))
        .catch(() => {});

    socket.on("connect", () => {
      setSocketState(socketIndicator, "ok", "Socket connected");
    });

    socket.on("disconnect", () => {
      setSocketState(socketIndicator, "down", "Socket disconnected");
    });

    socket.on("connect_error", () => {
      setSocketState(socketIndicator, "down", "Socket disconnected");
    });

    socket.on("monitor:update", (payload) => {
      renderRows(statusTableBody, payload.servers);
    });

    setSocketState(socketIndicator, "pending", "Socket connecting");
    fetchSnapshot();
    const pollHandle = timerApi.setInterval(fetchSnapshot, pollIntervalMs);

    return {
      destroy() {
        timerApi.clearInterval(pollHandle);
      },
      fetchSnapshot,
      renderRows: (servers) => renderRows(statusTableBody, servers),
      setSocketState: (state, label) => setSocketState(socketIndicator, state, label),
      socket,
    };
  };

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.__apacheStatusMonitorApp = createFrontendApp();
  }

  if (typeof module !== "undefined") {
    module.exports = {
      createFrontendApp,
    };
  }
})();
