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

  store.registerSticker("FIG-03", 0);
  assert.throws(() => store.applyTrade("FIG-03", "FIG-02"), /Sem disponibilidade/);
  assert.equal(store.quantity("FIG-03"), 0);
});

test("registra query_id apenas uma vez", (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  store.markQueryProcessed("query-1");
  store.markQueryProcessed("query-1");
  assert.deepEqual(store.state.processed_queries, ["query-1"]);
});
