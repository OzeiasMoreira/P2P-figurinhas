"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ProtocolError,
  createMessage,
  normalizePeerId,
  normalizeStickerId,
  validateMessage
} = require("../src/protocol");
const { normalizePeerUrl } = require("../src/p2p-node");

test("normaliza identificadores usados nos exemplos da documentação", () => {
  assert.equal(normalizePeerId("aluno03"), "ALUNO-03");
  assert.equal(normalizePeerId("ALUNO-3"), "ALUNO-03");
  assert.equal(normalizeStickerId("fig-12.png"), "FIG-12");
  assert.equal(normalizeStickerId("FIG12"), "FIG-12");
});

test("valida SEARCH e preserva campos de extensão", () => {
  const message = createMessage("SEARCH", {
    origin_peer_id: "ALUNO-01",
    sender_peer_id: "ALUNO-01",
    receiver_peer_id: "ALUNO-02",
    query_id: "550e8400-e29b-41d4-a716-446655440000",
    ttl: 7,
    sticker_id: "FIG-02.PNG",
    origin_peer_ip: "ws://127.0.0.1:8080/p2p"
  });

  assert.equal(message.sticker_id, "FIG-02");
  assert.equal(message.origin_peer_ip, "ws://127.0.0.1:8080/p2p");
});

test("rejeita ttl inválido e campos obrigatórios ausentes", () => {
  assert.throws(
    () => validateMessage({
      type: "SEARCH",
      message_id: "MSG-1",
      origin_peer_id: "ALUNO-01",
      sender_peer_id: "ALUNO-01",
      receiver_peer_id: "ALUNO-02",
      query_id: "550e8400-e29b-41d4-a716-446655440000",
      ttl: -1,
      sticker_id: "FIG-02"
    }),
    ProtocolError
  );

  assert.throws(
    () => validateMessage({ type: "HELLO", message_id: "MSG-1" }),
    /sender_peer_id/
  );
});

test("aceita IP puro anunciado pelo HELLO", () => {
  assert.equal(normalizePeerUrl("192.168.1.10"), "ws://192.168.1.10:8080/");
  assert.equal(normalizePeerUrl("ws://localhost:8081"), "ws://localhost:8081/");
  assert.equal(
    normalizePeerUrl("ws://localhost:8081/p2p"),
    "ws://localhost:8081/p2p"
  );
});
