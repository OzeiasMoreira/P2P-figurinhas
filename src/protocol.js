"use strict";

const { randomUUID } = require("node:crypto");

const MESSAGE_TYPES = new Set([
  "HELLO",
  "SEARCH",
  "SEARCH_HIT",
  "SEARCH_MISS",
  "TRADE_OFFER",
  "TRADE_ACCEPT",
  "TRADE_REJECT",
  "TRANSFER_CONFIRM",
  "INVENTORY_REQUEST",
  "INVENTORY_RESPONSE"
]);

const REQUIRED_FIELDS = {
  HELLO: ["message_id", "sender_peer_id"],
  SEARCH: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "query_id",
    "ttl",
    "sticker_id"
  ],
  SEARCH_HIT: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "query_id",
    "sticker_id"
  ],
  SEARCH_MISS: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "query_id",
    "sticker_id"
  ],
  TRADE_OFFER: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "offer_sticker_id",
    "want_sticker_id"
  ],
  TRADE_ACCEPT: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "offer_sticker_id",
    "want_sticker_id"
  ],
  TRADE_REJECT: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "offer_sticker_id",
    "want_sticker_id"
  ],
  TRANSFER_CONFIRM: [
    "message_id",
    "origin_peer_id",
    "sender_peer_id",
    "receiver_peer_id",
    "offer_sticker_id",
    "want_sticker_id"
  ],
  INVENTORY_REQUEST: [
    "message_id",
    "sender_peer_id",
    "receiver_peer_id",
    "request_id"
  ],
  INVENTORY_RESPONSE: [
    "message_id",
    "sender_peer_id",
    "receiver_peer_id",
    "request_id",
    "inventory"
  ]
};

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

function normalizePeerId(value) {
  const match = String(value || "").trim().toUpperCase().match(/^ALUNO-?(\d{1,2})$/);
  if (!match) {
    throw new ProtocolError(`peer_id inválido: ${value}`);
  }
  return `ALUNO-${match[1].padStart(2, "0")}`;
}

function normalizeStickerId(value) {
  const match = String(value || "").trim().toUpperCase().match(/^FIG-?(\d{1,2})(?:\.PNG)?$/);
  if (!match) {
    throw new ProtocolError(`sticker_id inválido: ${value}`);
  }
  return `FIG-${match[1].padStart(2, "0")}`;
}

function requireUuid(value, field) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(String(value || ""))) {
    throw new ProtocolError(`${field} deve ser um UUID`);
  }
}

function validateMessage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("A mensagem deve ser um objeto JSON");
  }

  const message = { ...input, type: String(input.type || "").toUpperCase() };
  if (!MESSAGE_TYPES.has(message.type)) {
    throw new ProtocolError(`Tipo de mensagem não suportado: ${message.type}`);
  }

  for (const field of REQUIRED_FIELDS[message.type]) {
    if (message[field] === undefined || message[field] === null || message[field] === "") {
      throw new ProtocolError(`Campo obrigatório ausente: ${field}`);
    }
  }

  for (const field of ["origin_peer_id", "sender_peer_id", "receiver_peer_id"]) {
    if (message[field] !== undefined) {
      message[field] = normalizePeerId(message[field]);
    }
  }

  for (const field of ["sticker_id", "offer_sticker_id", "want_sticker_id"]) {
    if (message[field] !== undefined) {
      message[field] = normalizeStickerId(message[field]);
    }
  }

  if (["SEARCH", "SEARCH_HIT", "SEARCH_MISS"].includes(message.type)) {
    requireUuid(message.query_id, "query_id");
  }

  if (message.type === "SEARCH") {
    if (!Number.isInteger(message.ttl) || message.ttl < 0 || message.ttl > 64) {
      throw new ProtocolError("ttl deve ser um inteiro entre 0 e 64");
    }
  }

  if (message.type === "HELLO" && message.peers !== undefined && !Array.isArray(message.peers)) {
    throw new ProtocolError("peers deve ser uma lista");
  }

  if (message.type === "INVENTORY_RESPONSE" && !Array.isArray(message.inventory)) {
    throw new ProtocolError("inventory deve ser uma lista");
  }

  return message;
}

function createMessage(type, fields = {}) {
  return validateMessage({
    type,
    message_id: randomUUID(),
    ...fields
  });
}

module.exports = {
  MESSAGE_TYPES,
  ProtocolError,
  createMessage,
  normalizePeerId,
  normalizeStickerId,
  validateMessage
};
