"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeWebSocketUrl,
  resolveAdvertisedUrl,
  saveConfigNeighbors
} = require("../src/config");

test("mantém URL anunciada quando configurada explicitamente", () => {
  assert.equal(
    resolveAdvertisedUrl("ws://192.168.1.19:8080/p2p", "0.0.0.0", 8080),
    "ws://192.168.1.19:8080/p2p"
  );
});

test("usa o host de escuta quando a URL está automática", () => {
  assert.equal(
    resolveAdvertisedUrl("auto", "192.168.1.19", 8080),
    "ws://192.168.1.19:8080"
  );
});

test("normaliza URL anunciada sem protocolo", () => {
  assert.equal(
    normalizeWebSocketUrl("172.16.2.60:8080"),
    "ws://172.16.2.60:8080/"
  );
});

test("salva vizinhos no config.json preservando demais campos", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-config-neighbors-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    peer_id: "ALUNO-19",
    author_sticker: {
      sticker_id: "FIG-19",
      image_url: "https://example.test/FIG-19.png"
    },
    host: "0.0.0.0",
    port: 8080,
    advertised_url: "auto",
    neighbors: []
  }, null, 2), "utf8");

  const config = { config_path: configPath, neighbors: [] };
  const changed = saveConfigNeighbors(config, [
    "ws://172.16.3.88:8080/",
    "ws://172.16.3.88:8080/",
    "ws://172.16.3.70:8080/"
  ]);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(changed, true);
  assert.equal(saved.peer_id, "ALUNO-19");
  assert.deepEqual(saved.neighbors, [
    "ws://172.16.3.70:8080/",
    "ws://172.16.3.88:8080/"
  ]);
  assert.deepEqual(config.neighbors, saved.neighbors);
});
