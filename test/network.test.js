"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../src/server");

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
  first.node.startSearch("FIG-03", 7);
  const hit = await hitPromise;
  assert.equal(hit.peer_id, "ALUNO-03");

  if (!first.node.connectedPeers().some((peer) => peer.peer_id === "ALUNO-03")) {
    await waitForEvent(
      first.node,
      "peer_connected",
      (event) => event.peer_id === "ALUNO-03"
    );
  }

  const offerPromise = waitForEvent(third.node, "trade_offer");
  const outgoing = first.node.offerTrade("ALUNO-03", "FIG-01", "FIG-03");
  const incoming = await offerPromise;
  assert.equal(incoming.trade_id, outgoing.trade_id);

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
  third.node.respondToTrade(incoming.trade_id, true);
  await Promise.all([firstCompleted, thirdCompleted]);

  assert.equal(first.store.quantity("FIG-01"), 27);
  assert.equal(first.store.quantity("FIG-03"), 1);
  assert.equal(third.store.quantity("FIG-03"), 27);
  assert.equal(third.store.quantity("FIG-01"), 1);
});
