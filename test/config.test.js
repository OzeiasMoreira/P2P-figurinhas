"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAdvertisedUrl } = require("../src/config");

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
