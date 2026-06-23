"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createApplication } = require("../src/server");
const { normalizePeerUrl } = require("../src/p2p-node");

function config(directory, number) {
  const suffix = String(number).padStart(2, "0");
  return {
    peer_id: `ALUNO-${suffix}`,
    author_sticker: {
      sticker_id: `FIG-${suffix}`,
      image_url: `https://example.test/FIG-${suffix}.png`
    },
    host: "127.0.0.1",
    port: 0,
    advertised_url: "ws://127.0.0.1:0/p2p",
    neighbors: [],
    data_file: path.join(directory, `ALUNO-${suffix}.json`)
  };
}

function waitForEvent(node, type, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.off("event", listener);
      reject(new Error(`Tempo excedido aguardando ${type}`));
    }, timeout);
    const listener = (event) => {
      if (event.type === type && predicate(event)) {
        clearTimeout(timer);
        node.off("event", listener);
        resolve(event);
      }
    };
    node.on("event", listener);
  });
}

function connectAndHello(url, peerId, peers = []) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Tempo excedido conectando em ${url}`));
    }, 3000);
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "HELLO",
        message_id: `550e8400-e29b-41d4-a716-44665544${peerId.slice(-2)}00`,
        sender_peer_id: peerId,
        peers
      }));
    });
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(data.toString("utf8")));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForWireMessage(node, type, predicate = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const sockets = [...node.sockets];
    const timer = setTimeout(() => {
      for (const socket of sockets) {
        socket.off("message", listener);
      }
      reject(new Error(`Tempo excedido aguardando mensagem ${type}`));
    }, timeout);
    const listener = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === type && predicate(message)) {
        clearTimeout(timer);
        for (const socket of sockets) {
          socket.off("message", listener);
        }
        resolve(message);
      }
    };
    for (const socket of sockets) {
      socket.on("message", listener);
    }
  });
}

function waitForPeer(node, peerId, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const peer = node.connectedPeers().find((item) => item.peer_id === peerId);
      if (peer) {
        clearInterval(poll);
        resolve(peer);
        return;
      }
      if (Date.now() - startedAt > timeout) {
        clearInterval(poll);
        reject(new Error(`Tempo excedido aguardando peer ${peerId}`));
      }
    }, 50);
  });
}

test("servidor aceita WebSocket na raiz, em /p2p e em /ws", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-endpoints-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();

  const hello = await connectAndHello(
    `ws://127.0.0.1:${app.config.port}`,
    "ALUNO-20"
  );
  assert.equal(hello.type, "HELLO");
  assert.equal(hello.sender_peer_id, "ALUNO-19");
  assert.ok(Array.isArray(hello.peers));
  assert.deepEqual(
    Object.keys(hello).sort(),
    ["message_id", "peer_url", "peers", "sender_peer_id", "type"]
  );

  await connectAndHello(`ws://127.0.0.1:${app.config.port}/p2p`, "ALUNO-21");
  await connectAndHello(`ws://127.0.0.1:${app.config.port}/ws`, "ALUNO-22");
});

test("conexão manual aguarda o HELLO do vizinho", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-connect-"));
  const first = createApplication(config(directory, 19));
  const second = createApplication(config(directory, 20));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([first.listen(), second.listen()]);

  const connected = await first.node.connectAndWait(second.config.advertised_url);
  assert.equal(connected.peer_id, "ALUNO-20");
  assert.equal(first.node.connectedPeers()[0].outgoing, true);
  assert.equal(first.node.connectedPeers()[0].incoming, false);
  assert.equal(second.node.connectedPeers()[0].incoming, true);
  assert.equal(second.node.connectedPeers()[0].outgoing, false);
});

test("ignora IDs de aluno anunciados como peers no HELLO", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-hello-peer-ids-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();

  await connectAndHello(
    `ws://127.0.0.1:${app.config.port}`,
    "ALUNO-20",
    ["ALUNO-19", "ALUNO-21"]
  );

  assert.equal(
    [...app.node.knownPeerUrls].some((url) => url.includes("aluno-")),
    false
  );
});

test("conexão manual informa falha em destino indisponível", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-failure-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();

  await assert.rejects(
    app.node.connectAndWait("ws://127.0.0.1:1", 500),
    /Nao foi possivel|Tempo esgotado/
  );
});

test("conexão manual informa quando o endpoint WebSocket responde 404", async (context) => {
  const server = require("node:http").createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-http-404-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const address = server.address();
  await assert.rejects(
    app.node.connectAndWait(`ws://127.0.0.1:${address.port}`, 1000),
    /HTTP 404.*\/p2p/
  );
});

test("descobre e conecta automaticamente nos vizinhos anunciados por HELLO", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-discovery-"));
  const apps = [1, 2, 3].map((number) => createApplication(config(directory, number)));
  context.after(async () => {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all(apps.map((app) => app.listen()));
  const [first, second, third] = apps;

  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-02");

  second.node.connect(third.config.advertised_url);
  await waitForPeer(second.node, "ALUNO-03");

  const discovered = await waitForPeer(first.node, "ALUNO-03");
  assert.equal(discovered.outgoing, true);
  assert.ok(discovered.urls.includes(normalizePeerUrl(third.config.advertised_url)));
});

test("desconecta de um aluno e cancela reconexÃ£o automÃ¡tica", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-disconnect-"));
  const apps = [19, 20, 21, 22].map((number) => createApplication(config(directory, number)));
  context.after(async () => {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(apps.map((app) => app.listen()));
  const [first, second, third, fourth] = apps;

  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-20");
  second.node.connect(third.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-21");

  const result = first.node.disconnectPeer("ALUNO-21");
  assert.equal(result.peer_id, "ALUNO-21");
  assert.ok(result.disconnected >= 1);
  assert.equal(first.node.connectedPeers().some((peer) => peer.peer_id === "ALUNO-21"), false);
  assert.equal(first.node.knownPeerUrls.has(normalizePeerUrl(third.config.advertised_url)), false);

  second.node.connect(fourth.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-22");
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(first.node.connectedPeers().some((peer) => peer.peer_id === "ALUNO-21"), false);
  assert.equal(first.node.manuallyDisconnectedPeerIds.has("ALUNO-21"), true);
  assert.equal(
    first.node.manuallyDisconnectedPeerUrls.has(normalizePeerUrl(third.config.advertised_url)),
    true
  );
});

test("três nós encontram figurinha e concluem troca bilateral", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-network-"));
  const apps = [1, 2, 3].map((number) => createApplication(config(directory, number)));
  context.after(async () => {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all(apps.map((app) => app.listen()));
  const [first, second, third] = apps;

  const firstSeesSecond = waitForEvent(
    first.node,
    "peer_connected",
    (event) => event.peer_id === "ALUNO-02"
  );
  first.node.connect(second.config.advertised_url);
  await firstSeesSecond;

  const secondSeesThird = waitForEvent(
    second.node,
    "peer_connected",
    (event) => event.peer_id === "ALUNO-03"
  );
  second.node.connect(third.config.advertised_url);
  await secondSeesThird;

  const hitPromise = waitForEvent(
    first.node,
    "search_hit",
    (event) => event.peer_id === "ALUNO-03" && event.sticker_id === "FIG-03"
  );
  const searchWirePromise = waitForWireMessage(
    second.node,
    "SEARCH",
    (message) => message.origin_peer_id === "ALUNO-01"
  );
  const hitWirePromise = waitForWireMessage(
    first.node,
    "SEARCH_HIT",
    (message) => message.origin_peer_id === "ALUNO-03"
  );
  first.node.startSearch("FIG-03", 7);
  const searchWire = await searchWirePromise;
  assert.equal(searchWire.sender_peer_id, "ALUNO-01");
  assert.equal(searchWire.origin_peer_ip, "127.0.0.1");
  assert.equal(searchWire.sticker_id, "FIG-03");
  assert.equal(searchWire.ttl, 7);
  assert.match(searchWire.query_id, /^[0-9a-f-]{36}$/i);
  const hit = await hitPromise;
  const hitWire = await hitWirePromise;
  assert.equal(hit.peer_id, "ALUNO-03");
  assert.equal(hitWire.receiver_peer_id, "ALUNO-01");
  assert.equal(hitWire.sticker_id, "FIG-03");

  if (!first.node.connectedPeers().some((peer) => peer.peer_id === "ALUNO-03")) {
    await waitForEvent(
      first.node,
      "peer_connected",
      (event) => event.peer_id === "ALUNO-03"
    );
  }

  const offerPromise = waitForEvent(third.node, "trade_offer");
  const offerWirePromise = waitForWireMessage(third.node, "TRADE_OFFER");
  const outgoing = first.node.offerTrade("ALUNO-03", "FIG-01", "FIG-03");
  const incoming = await offerPromise;
  const offerWire = await offerWirePromise;
  assert.equal(incoming.trade_id, outgoing.trade_id);
  assert.equal(offerWire.offer_sticker_id, "FIG-01");
  assert.equal(offerWire.want_sticker_id, "FIG-03");

  const firstCompleted = waitForEvent(
    first.node,
    "trade_updated",
    (event) => event.trade_id === outgoing.trade_id && event.status === "completed"
  );
  const thirdCompleted = waitForEvent(
    third.node,
    "trade_updated",
    (event) => event.trade_id === outgoing.trade_id && event.status === "completed"
  );
  const acceptWirePromise = waitForWireMessage(first.node, "TRADE_ACCEPT");
  const confirmWirePromise = waitForWireMessage(third.node, "TRANSFER_CONFIRM");
  third.node.respondToTrade(incoming.trade_id, true);
  const acceptWire = await acceptWirePromise;
  assert.equal(third.store.quantity("FIG-03"), 27);
  assert.equal(third.store.quantity("FIG-01"), 1);
  const confirmWire = await confirmWirePromise;
  await Promise.all([firstCompleted, thirdCompleted]);

  assert.equal(acceptWire.origin_peer_id, "ALUNO-03");
  assert.equal(acceptWire.offer_sticker_id, "FIG-03");
  assert.equal(acceptWire.want_sticker_id, "FIG-01");
  assert.equal(confirmWire.origin_peer_id, "ALUNO-01");
  assert.equal(confirmWire.offer_sticker_id, "FIG-01");
  assert.equal(confirmWire.want_sticker_id, "FIG-03");

  assert.equal(first.store.quantity("FIG-01"), 27);
  assert.equal(first.store.quantity("FIG-03"), 1);
  assert.equal(third.store.quantity("FIG-03"), 27);
  assert.equal(third.store.quantity("FIG-01"), 1);
});

test("conclui troca quando TRADE_ACCEPT vem sem trade_id", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-accept-compat-"));
  const first = createApplication(config(directory, 1));
  const second = createApplication(config(directory, 2));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all([first.listen(), second.listen()]);
  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-02");
  await waitForPeer(second.node, "ALUNO-01");

  const outgoing = first.node.offerTrade("ALUNO-02", "FIG-01", "FIG-02");
  const completed = waitForEvent(
    first.node,
    "trade_updated",
    (event) => event.trade_id === outgoing.trade_id && event.status === "completed"
  );
  const socket = [...second.node.peerSockets.get("ALUNO-01")]
    .find((candidate) => candidate.readyState === WebSocket.OPEN);
  socket.send(JSON.stringify({
    type: "TRADE_ACCEPT",
    message_id: "550e8400-e29b-41d4-a716-446655440201",
    origin_peer_id: "ALUNO-02",
    sender_peer_id: "ALUNO-02",
    receiver_peer_id: "ALUNO-01",
    offer_sticker_id: "FIG-01",
    want_sticker_id: "FIG-02"
  }));

  await completed;
  assert.equal(first.store.quantity("FIG-01"), 27);
  assert.equal(first.store.quantity("FIG-02"), 1);
});

test("rejeita troca quando TRADE_REJECT vem sem trade_id", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-reject-compat-"));
  const first = createApplication(config(directory, 1));
  const second = createApplication(config(directory, 2));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all([first.listen(), second.listen()]);
  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-02");
  await waitForPeer(second.node, "ALUNO-01");

  const outgoing = first.node.offerTrade("ALUNO-02", "FIG-01", "FIG-02");
  const rejected = waitForEvent(
    first.node,
    "trade_updated",
    (event) => event.trade_id === outgoing.trade_id && event.status === "rejected"
  );
  const socket = [...second.node.peerSockets.get("ALUNO-01")]
    .find((candidate) => candidate.readyState === WebSocket.OPEN);
  socket.send(JSON.stringify({
    type: "TRADE_REJECT",
    message_id: "550e8400-e29b-41d4-a716-446655440202",
    origin_peer_id: "ALUNO-02",
    sender_peer_id: "ALUNO-02",
    receiver_peer_id: "ALUNO-01",
    offer_sticker_id: "FIG-01",
    want_sticker_id: "FIG-02"
  }));

  await rejected;
  assert.equal(first.store.quantity("FIG-01"), 28);
  assert.equal(first.store.quantity("FIG-02"), 0);
});

test("ignora conexao que se identifica como o proprio aluno", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-self-connection-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();

  const ignored = waitForEvent(app.node, "self_connection_ignored");
  const socket = new WebSocket(`ws://127.0.0.1:${app.config.port}`);
  socket.once("open", () => {
    socket.send(JSON.stringify({
      type: "HELLO",
      message_id: "550e8400-e29b-41d4-a716-446655441900",
      sender_peer_id: "ALUNO-19",
      peer_url: "ws://172.16.3.109:8080/",
      peers: []
    }));
  });

  await ignored;
  socket.close();

  assert.equal(
    app.node.connectedPeers().some((peer) => peer.peer_id === "ALUNO-19"),
    false
  );
  assert.equal(
    app.node.knownPeerUrls.has(normalizePeerUrl("ws://172.16.3.109:8080/")),
    false
  );
});
