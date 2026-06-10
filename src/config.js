"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizePeerId, normalizeStickerId } = require("./protocol");

function loadConfig(configPath = process.env.CONFIG_PATH || "config.json") {
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    const examplePath = path.resolve("config.example.json");
    if (path.basename(absolutePath) === "config.json" && fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, absolutePath);
    } else {
      throw new Error(
        `Arquivo ${absolutePath} não encontrado. Copie config.example.json para config.json.`
      );
    }
  }

  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const port = Number(process.env.PORT || raw.port || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("A porta deve ser um inteiro entre 0 e 65535");
  }

  return {
    peer_id: normalizePeerId(raw.peer_id),
    author_sticker: {
      sticker_id: normalizeStickerId(raw.author_sticker?.sticker_id),
      image_url: raw.author_sticker?.image_url || ""
    },
    host: process.env.HOST || raw.host || "0.0.0.0",
    port,
    advertised_url: process.env.ADVERTISED_URL || raw.advertised_url ||
      `ws://127.0.0.1:${port}/p2p`,
    neighbors: Array.isArray(raw.neighbors) ? raw.neighbors : [],
    data_file: path.resolve(raw.data_file || `data/${normalizePeerId(raw.peer_id)}.json`),
    config_path: absolutePath
  };
}

module.exports = { loadConfig };
