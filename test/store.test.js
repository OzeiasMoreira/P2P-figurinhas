"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-store-"));
  const store = new Store(path.join(directory, "state.json"), {
    sticker_id: "FIG-01",
    image_url: "https://example.test/FIG-01.png"
  });
  return { directory, store };
}

test("inicia com 28 cópias da figurinha autoral", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(store.quantity("FIG-01"), 28);
});

test("troca atualiza as duas quantidades e impede saldo negativo", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  store.applyTrade("FIG-01", "FIG-02", "https://example.test/FIG-02.png");
  assert.equal(store.quantity("FIG-01"), 27);
  assert.equal(store.quantity("FIG-02"), 1);
  assert.equal(
    store.inventoryList().find((item) => item.sticker_id === "FIG-02").image_url,
    "https://example.test/FIG-02.png"
  );

  store.applyTrade("FIG-01", "FIG-04");
  assert.equal(
    store.inventoryList().find((item) => item.sticker_id === "FIG-04").image_url,
    "https://raw.githubusercontent.com/rgcoelho01/album/main/docs/images/FIG-04.png"
  );

  store.registerSticker("FIG-03", 0);
  assert.throws(() => store.applyTrade("FIG-03", "FIG-02"), /Sem disponibilidade/);
  assert.equal(store.quantity("FIG-03"), 0);
});

test("preenche URL padrÃ£o para figurinhas antigas sem imagem", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-store-images-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  fs.writeFileSync(filePath, JSON.stringify({
    inventory: {
      "FIG-07": { quantity: 1, image_url: "" }
    },
    processed_queries: [],
    searches: [],
    trades: []
  }), "utf8");

  const store = new Store(filePath, {
    sticker_id: "FIG-19",
    image_url: "https://example.test/public/figurinhas/FIG-19.png"
  });

  assert.equal(
    store.inventoryList().find((item) => item.sticker_id === "FIG-07").image_url,
    "https://raw.githubusercontent.com/rgcoelho01/album/main/docs/images/FIG-07.png"
  );
});

test("conclui trocas recebidas que ficaram aceitas sem confirmaÃ§Ã£o", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-store-accepted-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  fs.writeFileSync(filePath, JSON.stringify({
    inventory: {
      "FIG-19": {
        quantity: 28,
        image_url: "https://example.test/FIG-19.png"
      }
    },
    processed_queries: [],
    searches: [],
    trades: [{
      trade_id: "accepted-incoming",
      direction: "incoming",
      peer_id: "ALUNO-07",
      offer_sticker_id: "FIG-07",
      want_sticker_id: "FIG-19",
      offer_image_url: "https://example.test/FIG-07.png",
      status: "accepted"
    }]
  }), "utf8");

  const store = new Store(filePath, {
    sticker_id: "FIG-19",
    image_url: "https://example.test/FIG-19.png"
  });

  assert.equal(store.quantity("FIG-19"), 27);
  assert.equal(store.quantity("FIG-07"), 1);
  assert.equal(store.state.trades[0].status, "completed");
});

test("registra query_id apenas uma vez", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  store.markQueryProcessed("query-1");
  store.markQueryProcessed("query-1");
  assert.deepEqual(store.state.processed_queries, ["query-1"]);
});

test("atualiza a URL da figurinha autoral ao recarregar a configuração", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = store.filePath;

  const reloaded = new Store(filePath, {
    sticker_id: "FIG-01",
    image_url: "https://example.test/nova-FIG-01.png"
  });

  assert.equal(
    reloaded.inventoryList()[0].image_url,
    "https://example.test/nova-FIG-01.png"
  );
});

test("limpa historico sem apagar trocas ativas", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  store.addSearch({ query_id: "query-1", sticker_id: "FIG-02" });
  store.addTrade({ trade_id: "pending", status: "pending" });
  store.addTrade({ trade_id: "accepted", status: "accepted" });
  store.addTrade({ trade_id: "failed", status: "failed" });
  store.addTrade({ trade_id: "completed", status: "completed" });

  const cleared = store.clearHistory(["searches", "trades"]);

  assert.deepEqual(cleared, { searches: 1, trades: 2 });
  assert.deepEqual(
    store.state.trades.map((trade) => trade.trade_id),
    ["pending", "accepted"]
  );
  assert.deepEqual(store.state.searches, []);
});

test("expira propostas pendentes antigas e libera quantidade reservada", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  store.addTrade({
    trade_id: "old-pending",
    direction: "outgoing",
    peer_id: "ALUNO-02",
    offer_sticker_id: "FIG-01",
    want_sticker_id: "FIG-02",
    status: "pending",
    created_at: createdAt,
    expires_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  });

  assert.equal(store.reservedQuantity("FIG-01"), 1);
  const expired = store.expirePendingTrades();

  assert.equal(expired.length, 1);
  assert.equal(store.state.trades[0].status, "expired");
  assert.equal(store.reservedQuantity("FIG-01"), 0);
  assert.equal(store.availableQuantity("FIG-01"), 28);
});
