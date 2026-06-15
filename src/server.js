"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { loadConfig } = require("./config");
const { P2PNode } = require("./p2p-node");
const { normalizePeerId } = require("./protocol");
const { Store } = require("./store");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function createApplication(config) {
  const store = new Store(config.data_file, config.author_sticker);
  const node = new P2PNode(config, store);
  const eventClients = new Set();
  const wsServer = new WebSocketServer({ noServer: true });

  node.on("event", (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of eventClients) {
      response.write(payload);
    }
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url, { config, store, node, eventClients });
        return;
      }
      serveStatic(response, url.pathname);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/" && url.pathname !== "/p2p") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      wsServer.emit("connection", webSocket, request);
    });
  });
  wsServer.on("connection", (socket) => node.attach(socket));

  return {
    config,
    node,
    server,
    store,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      const address = server.address();
      if (config.port === 0 && address && typeof address === "object") {
        config.port = address.port;
        config.advertised_url = `ws://127.0.0.1:${address.port}`;
      }
      node.start();
      return address;
    },
    async close() {
      node.stop();
      for (const response of eventClients) {
        response.end();
      }
      await new Promise((resolve) => wsServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function handleApi(request, response, url, context) {
  const { config, store, node, eventClients } = context;

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, {
      peer_id: config.peer_id,
      advertised_url: config.advertised_url,
      websocket_endpoints: websocketEndpoints(config.advertised_url),
      author_sticker: config.author_sticker,
      inventory: store.inventoryList(),
      peers: node.connectedPeers(),
      trades: [...store.state.trades].reverse(),
      searches: [...store.state.searches].reverse().slice(0, 50),
      inventory_snapshots: Object.fromEntries(node.inventorySnapshots)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/stickers") {
    const body = await readJson(request);
    const item = store.registerSticker(
      body.sticker_id,
      Number(body.quantity),
      body.image_url
    );
    node.emit("event", {
      type: "inventory_updated",
      timestamp: new Date().toISOString(),
      inventory: store.inventoryList()
    });
    sendJson(response, 201, item);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/search") {
    const body = await readJson(request);
    const queryId = node.startSearch(body.sticker_id, body.ttl ?? 7);
    sendJson(response, 202, { query_id: queryId });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/neighbors") {
    const body = await readJson(request);
    if (!body.url || !node.connect(body.url)) {
      throw new Error("Endereço de vizinho inválido ou igual ao endereço local");
    }
    sendJson(response, 202, { url: body.url });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/trades") {
    const body = await readJson(request);
    const trade = node.offerTrade(
      body.peer_id,
      body.offer_sticker_id,
      body.want_sticker_id
    );
    sendJson(response, 201, trade);
    return;
  }

  const responseMatch = url.pathname.match(/^\/api\/trades\/([^/]+)\/respond$/);
  if (request.method === "POST" && responseMatch) {
    const body = await readJson(request);
    const trade = node.respondToTrade(
      decodeURIComponent(responseMatch[1]),
      body.accept === true
    );
    sendJson(response, 200, trade);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/inventory/query") {
    const body = await readJson(request);
    const requestId = node.requestInventory(normalizePeerId(body.peer_id));
    sendJson(response, 202, { request_id: requestId });
    return;
  }

  sendJson(response, 404, { error: "Rota não encontrada" });
}

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "Arquivo não encontrado" });
    return;
  }
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(filePath).pipe(response);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Corpo da requisição excede 1 MB");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Corpo JSON inválido");
  }
}

function sendJson(response, status, data) {
  if (response.headersSent) {
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(data)}\n`);
}

function websocketEndpoints(advertisedUrl) {
  const parsed = new URL(advertisedUrl);
  const root = new URL(parsed);
  root.pathname = "/";
  const p2p = new URL(parsed);
  p2p.pathname = "/p2p";
  return [...new Set([root.toString(), p2p.toString()])];
}

if (require.main === module) {
  const config = loadConfig();
  const app = createApplication(config);
  app.listen()
    .then(() => {
      console.log(`Nó ${config.peer_id} em http://localhost:${config.port}`);
      console.log(`WebSocket P2P: ${config.advertised_url}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApplication };
