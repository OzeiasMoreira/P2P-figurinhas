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

function waitForNeighbor(store, url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (store.neighborList().includes(url)) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeout) {
        clearInterval(poll);
        reject(new Error(`Tempo excedido aguardando vizinho ${url}`));
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
  assert.ok(first.store.neighborList().includes(normalizePeerUrl(second.config.advertised_url)));
  assert.ok(second.store.neighborList().includes(normalizePeerUrl(first.config.advertised_url)));
});

test("mostra conexao recebida mesmo quando tambem existe conexao de saida", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-bidirectional-peer-"));
  const first = createApplication(config(directory, 19));
  const second = createApplication(config(directory, 20));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([first.listen(), second.listen()]);

  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-20");
  second.node.connect(first.config.advertised_url);
  await waitForPeer(second.node, "ALUNO-19");

  const firstPeer = first.node.connectedPeers().find((peer) => peer.peer_id === "ALUNO-20");
  const secondPeer = second.node.connectedPeers().find((peer) => peer.peer_id === "ALUNO-19");
  assert.equal(firstPeer.incoming, true);
  assert.equal(firstPeer.outgoing, true);
  assert.equal(secondPeer.incoming, true);
  assert.equal(secondPeer.outgoing, true);
});

test("ignora IDs de aluno anunciados como peers no HELLO", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-hello-peer-ids-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();
  app.config.advertised_url = `ws://192.0.2.19:${app.config.port}/`;

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
  assert.ok(first.store.neighborList().includes(normalizePeerUrl(third.config.advertised_url)));
});

test("repassa SEARCH recebido mesmo quando receiver_peer_id vem diferente", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-search-receiver-compat-"));
  const apps = [1, 2, 3].map((number) => createApplication(config(directory, number)));
  context.after(async () => {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(apps.map((app) => app.listen()));
  const [first, second, third] = apps;

  second.node.connect(third.config.advertised_url);
  await waitForPeer(second.node, "ALUNO-03");
  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-02");

  const received = waitForEvent(
    second.node,
    "search_received",
    (event) => event.receiver_mismatch === true && event.sticker_id === "FIG-28"
  );
  const forwarded = waitForEvent(
    second.node,
    "search_forwarded",
    (event) => event.to_peer_id === "ALUNO-03" && event.previous_ttl === 5 && event.ttl === 4
  );
  const socket = [...first.node.peerSockets.get("ALUNO-02")]
    .find((candidate) => candidate.readyState === WebSocket.OPEN);
  socket.send(JSON.stringify({
    type: "SEARCH",
    message_id: "550e8400-e29b-41d4-a716-446655449901",
    origin_peer_id: "ALUNO-01",
    origin_peer_ip: "127.0.0.1",
    sender_peer_id: "ALUNO-01",
    receiver_peer_id: "ALUNO-03",
    query_id: "550e8400-e29b-41d4-a716-446655449902",
    ttl: 5,
    sticker_id: "FIG-28"
  }));

  await Promise.all([received, forwarded]);
});

test("busca iniciada nao retorna a propria figurinha como SEARCH_HIT", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-search-no-self-hit-"));
  const first = createApplication(config(directory, 19));
  const second = createApplication(config(directory, 20));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([first.listen(), second.listen()]);

  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-20");

  let selfHit = false;
  first.node.on("event", (event) => {
    if (event.type === "search_hit" && event.peer_id === "ALUNO-19") {
      selfHit = true;
    }
  });
  const searchWirePromise = waitForWireMessage(
    second.node,
    "SEARCH",
    (message) => message.origin_peer_id === "ALUNO-19" && message.sticker_id === "FIG-19"
  );

  first.node.startSearch("FIG-19", 7);
  const searchWire = await searchWirePromise;

  assert.equal(searchWire.ttl, 7);
  assert.equal(selfHit, false);
});

test("retorna SEARCH_MISS quando a figurinha nao foi encontrada no ramo", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-search-miss-"));
  const first = createApplication(config(directory, 19));
  const second = createApplication(config(directory, 20));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([first.listen(), second.listen()]);

  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-20");

  const miss = waitForEvent(
    first.node,
    "search_miss",
    (event) => event.peer_id === "ALUNO-20" && event.sticker_id === "FIG-28"
  );
  first.node.startSearch("FIG-28", 1);

  await miss;
});

test("finaliza busca por timeout quando vizinho nao responde", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-search-timeout-"));
  const app = createApplication({
    ...config(directory, 19),
    search_timeout_ms: 80
  });
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();

  const socket = new WebSocket(`ws://127.0.0.1:${app.config.port}`);
  context.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "HELLO",
    message_id: "550e8400-e29b-41d4-a716-446655448001",
    sender_peer_id: "ALUNO-20",
    peer_url: "ws://127.0.0.1:8080/",
    peers: []
  }));
  await waitForPeer(app.node, "ALUNO-20");

  const miss = waitForEvent(
    app.node,
    "search_miss",
    (event) => event.sticker_id === "FIG-28" && event.reason === "timeout",
    1000
  );
  app.node.startSearch("FIG-28", 7);

  await miss;
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
  assert.equal(first.store.neighborList().includes(normalizePeerUrl(third.config.advertised_url)), false);

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
  const outgoing = await first.node.offerTrade("ALUNO-03", "FIG-01", "FIG-03");
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
  first.store.addSearch({
    kind: "SEARCH_HIT",
    query_id: "550e8400-e29b-41d4-a716-446655440201",
    sticker_id: "FIG-02",
    peer_id: "ALUNO-02"
  });

  const outgoing = await first.node.offerTrade("ALUNO-02", "FIG-01", "FIG-02");
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

test("bloqueia proposta de troca sem SEARCH_HIT anterior", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-trade-without-search-"));
  const first = createApplication(config(directory, 1));
  const second = createApplication(config(directory, 2));
  context.after(async () => {
    await Promise.allSettled([first.close(), second.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await Promise.all([first.listen(), second.listen()]);
  first.node.connect(second.config.advertised_url);
  await waitForPeer(first.node, "ALUNO-02");

  await assert.rejects(
    () => first.node.offerTrade("ALUNO-02", "FIG-01", "FIG-02"),
    /Busque FIG-02/
  );
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
  first.store.addSearch({
    kind: "SEARCH_HIT",
    query_id: "550e8400-e29b-41d4-a716-446655440203",
    sticker_id: "FIG-02",
    peer_id: "ALUNO-02"
  });

  const outgoing = await first.node.offerTrade("ALUNO-02", "FIG-01", "FIG-02");
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

test("salva IP de conexao recebida mesmo sem peer_url no HELLO", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-incoming-peer-url-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();
  app.config.advertised_url = `ws://192.0.2.19:${app.config.port}/`;

  await connectAndHello(
    `ws://127.0.0.1:${app.config.port}`,
    "ALUNO-20",
    []
  );

  await waitForNeighbor(app.store, `ws://127.0.0.1:${app.config.port}/`);
});

test("envia peers do HELLO sem URLs duplicadas", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-hello-dedup-"));
  const app = createApplication(config(directory, 19));
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.listen();

  app.node.knownPeerUrls.add("127.0.0.1:8080");
  app.node.knownPeerUrls.add("ws://127.0.0.1:8080/");
  const hello = await connectAndHello(`ws://127.0.0.1:${app.config.port}`, "ALUNO-20");

  assert.equal(
    hello.peers.filter((peer) => peer === "ws://127.0.0.1:8080/").length,
    1
  );
  assert.equal(
    hello.peers.includes(normalizePeerUrl(app.config.advertised_url)),
    false
  );
});

test("limpa vizinhos antigos ao iniciar o servidor", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-start-clean-neighbors-"));
  const configPath = path.join(directory, "config.json");
  const appConfig = {
    ...config(directory, 19),
    config_path: configPath,
    neighbors: ["ws://127.0.0.1:1/"]
  };
  fs.writeFileSync(configPath, `${JSON.stringify({
    peer_id: appConfig.peer_id,
    author_sticker: appConfig.author_sticker,
    host: appConfig.host,
    port: appConfig.port,
    advertised_url: appConfig.advertised_url,
    neighbors: appConfig.neighbors,
    data_file: appConfig.data_file
  }, null, 2)}\n`, "utf8");
  const app = createApplication(appConfig);
  context.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await app.listen();

  assert.deepEqual(app.node.knownPeerUrls, new Set());
  assert.deepEqual(app.store.neighborList(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).neighbors, []);
});
