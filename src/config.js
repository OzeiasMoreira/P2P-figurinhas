"use strict";

const fs = require("node:fs");
const os = require("node:os");
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

  const host = process.env.HOST || raw.host || "0.0.0.0";
  const configuredUrl = process.env.ADVERTISED_URL || raw.advertised_url;

  return {
    peer_id: normalizePeerId(raw.peer_id),
    author_sticker: {
      sticker_id: normalizeStickerId(raw.author_sticker?.sticker_id),
      image_url: raw.author_sticker?.image_url || ""
    },
    host,
    port,
    advertised_url: resolveAdvertisedUrl(configuredUrl, host, port),
    neighbors: Array.isArray(raw.neighbors) ? raw.neighbors : [],
    data_file: path.resolve(raw.data_file || `data/${normalizePeerId(raw.peer_id)}.json`),
    config_path: absolutePath
  };
}

function resolveAdvertisedUrl(configuredUrl, host, port) {
  if (configuredUrl && configuredUrl !== "auto") {
    return normalizeWebSocketUrl(configuredUrl);
  }

  const address = host === "0.0.0.0" ? findLanIpv4() : host;
  return `ws://${address}:${port}`;
}

function normalizeWebSocketUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `ws://${value}`;
  const parsed = new URL(withProtocol);
  if (!["ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("advertised_url deve usar ws:// ou wss://");
  }
  if (!parsed.port) {
    parsed.port = "8080";
  }
  return parsed.toString();
}

function findLanIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal &&
          !address.address.startsWith("169.254.")) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

function saveConfigNeighbors(config, neighbors) {
  if (!config?.config_path) {
    return false;
  }
  const absolutePath = path.resolve(config.config_path);
  if (!fs.existsSync(absolutePath)) {
    return false;
  }

  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const normalizedNeighbors = [...new Set(neighbors || [])].sort();
  const currentNeighbors = Array.isArray(raw.neighbors) ? [...raw.neighbors].sort() : [];
  if (JSON.stringify(currentNeighbors) === JSON.stringify(normalizedNeighbors)) {
    return false;
  }

  raw.neighbors = normalizedNeighbors;
  const temporary = `${absolutePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, absolutePath);
  config.neighbors = normalizedNeighbors;
  return true;
}

module.exports = {
  findLanIpv4,
  loadConfig,
  normalizeWebSocketUrl,
  resolveAdvertisedUrl,
  saveConfigNeighbors
};
