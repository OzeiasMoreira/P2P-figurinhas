"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeStickerId } = require("./protocol");

const MAX_HISTORY = 2000;
const TRADE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_IMAGE_BASE_URL =
  "https://raw.githubusercontent.com/rgcoelho01/album/main/docs/images";

class Store {
  constructor(filePath, initial) {
    this.filePath = filePath;
    this.initial = initial;
    this.state = this.#load();
    this.#fillMissingImageUrls();
    this.completeAcceptedIncomingTrades();
    this.expirePendingTrades();
    this.save();
  }

  #load() {
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const state = {
        inventory: parsed.inventory || {},
        processed_queries: parsed.processed_queries || [],
        searches: parsed.searches || [],
        trades: parsed.trades || []
      };
      const authorStickerId = normalizeStickerId(this.initial.sticker_id);
      if (!state.inventory[authorStickerId]) {
        state.inventory[authorStickerId] = {
          quantity: 28,
          image_url: this.initial.image_url || ""
        };
      } else if (this.initial.image_url) {
        state.inventory[authorStickerId].image_url = this.initial.image_url;
      }
      return state;
    }

    const stickerId = normalizeStickerId(this.initial.sticker_id);
    const state = {
      inventory: {
        [stickerId]: {
          quantity: 28,
          image_url: this.initial.image_url || ""
        }
      },
      processed_queries: [],
      searches: [],
      trades: []
    };
    return state;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  inventoryList() {
    return Object.entries(this.state.inventory)
      .map(([sticker_id, item]) => ({
        sticker_id,
        quantity: item.quantity,
        image_url: item.image_url || ""
      }))
      .sort((a, b) => a.sticker_id.localeCompare(b.sticker_id));
  }

  quantity(stickerId) {
    return this.state.inventory[normalizeStickerId(stickerId)]?.quantity || 0;
  }

  reservedQuantity(stickerId) {
    const normalized = normalizeStickerId(stickerId);
    return this.state.trades.reduce((total, trade) => {
      if (trade.direction === "outgoing" && trade.status === "pending" &&
          trade.offer_sticker_id === normalized) {
        return total + 1;
      }
      if (trade.direction === "incoming" && trade.status === "accepted" &&
          trade.want_sticker_id === normalized) {
        return total + 1;
      }
      return total;
    }, 0);
  }

  availableQuantity(stickerId) {
    this.expirePendingTrades();
    return this.quantity(stickerId) - this.reservedQuantity(stickerId);
  }

  registerSticker(stickerId, quantity, imageUrl = "") {
    const normalized = normalizeStickerId(stickerId);
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new Error("A quantidade deve ser um inteiro não negativo");
    }
    const current = this.state.inventory[normalized];
    this.state.inventory[normalized] = {
      quantity,
      image_url: imageUrl || current?.image_url || this.#imageUrlFor(normalized)
    };
    this.save();
    return this.state.inventory[normalized];
  }

  applyTrade(sentStickerId, receivedStickerId, receivedImageUrl = "") {
    const sent = normalizeStickerId(sentStickerId);
    const received = normalizeStickerId(receivedStickerId);
    if (this.quantity(sent) < 1) {
      throw new Error(`Sem disponibilidade de ${sent}`);
    }
    this.state.inventory[sent].quantity -= 1;
    if (!this.state.inventory[received]) {
      this.state.inventory[received] = {
        quantity: 0,
        image_url: receivedImageUrl || this.#imageUrlFor(received)
      };
    } else if (receivedImageUrl && !this.state.inventory[received].image_url) {
      this.state.inventory[received].image_url = receivedImageUrl;
    } else if (!this.state.inventory[received].image_url) {
      this.state.inventory[received].image_url = this.#imageUrlFor(received);
    }
    this.state.inventory[received].quantity += 1;
    this.save();
  }

  completeAcceptedIncomingTrades() {
    let changed = false;
    for (const trade of this.state.trades) {
      if (trade.direction !== "incoming" || trade.status !== "accepted") {
        continue;
      }

      const sent = normalizeStickerId(trade.want_sticker_id);
      const received = normalizeStickerId(trade.offer_sticker_id);
      if (this.quantity(sent) < 1) {
        trade.status = "failed";
        trade.updated_at = new Date().toISOString();
        changed = true;
        continue;
      }

      this.state.inventory[sent].quantity -= 1;
      if (!this.state.inventory[received]) {
        this.state.inventory[received] = {
          quantity: 0,
          image_url: trade.offer_image_url || this.#imageUrlFor(received)
        };
      } else if (trade.offer_image_url && !this.state.inventory[received].image_url) {
        this.state.inventory[received].image_url = trade.offer_image_url;
      } else if (!this.state.inventory[received].image_url) {
        this.state.inventory[received].image_url = this.#imageUrlFor(received);
      }
      this.state.inventory[received].quantity += 1;
      trade.status = "completed";
      trade.updated_at = new Date().toISOString();
      changed = true;
    }
    return changed;
  }

  expirePendingTrades(now = new Date()) {
    const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const expired = [];
    for (const trade of this.state.trades) {
      if (trade.status !== "pending") {
        continue;
      }
      const reference = trade.expires_at || trade.created_at || trade.updated_at;
      if (!reference) {
        trade.created_at = new Date(currentTime).toISOString();
        trade.expires_at = new Date(currentTime + TRADE_TIMEOUT_MS).toISOString();
        continue;
      }
      const expiresAt = trade.expires_at
        ? new Date(trade.expires_at).getTime()
        : new Date(reference).getTime() + TRADE_TIMEOUT_MS;
      if (currentTime < expiresAt) {
        if (!trade.expires_at) {
          trade.expires_at = new Date(expiresAt).toISOString();
        }
        continue;
      }
      trade.status = "expired";
      trade.updated_at = new Date(currentTime).toISOString();
      trade.expires_at = new Date(expiresAt).toISOString();
      expired.push({ ...trade });
    }
    if (expired.length) {
      this.save();
    }
    return expired;
  }

  #fillMissingImageUrls() {
    for (const [stickerId, item] of Object.entries(this.state.inventory)) {
      if (!item.image_url || this.#isGeneratedStickerImageUrl(item.image_url)) {
        item.image_url = this.#imageUrlFor(stickerId);
      }
    }
  }

  #imageUrlFor(stickerId) {
    const normalized = normalizeStickerId(stickerId);
    return `${DEFAULT_IMAGE_BASE_URL}/${normalized}.png`;
  }

  #isGeneratedStickerImageUrl(imageUrl) {
    return /\/figurinhas\/FIG-?\d{1,2}\.png(?:$|[?#])/i.test(String(imageUrl || ""));
  }

  hasProcessedQuery(queryId) {
    return this.state.processed_queries.includes(queryId);
  }

  markQueryProcessed(queryId) {
    if (!this.hasProcessedQuery(queryId)) {
      this.state.processed_queries.push(queryId);
      this.state.processed_queries = this.state.processed_queries.slice(-MAX_HISTORY);
      this.save();
    }
  }

  addSearch(search) {
    this.state.searches.push({ ...search, timestamp: new Date().toISOString() });
    this.state.searches = this.state.searches.slice(-MAX_HISTORY);
    this.save();
  }

  addTrade(trade) {
    const now = new Date();
    const stored = {
      ...trade,
      created_at: trade.created_at || now.toISOString(),
      updated_at: now.toISOString()
    };
    if (stored.status === "pending" && !stored.expires_at) {
      stored.expires_at = new Date(now.getTime() + TRADE_TIMEOUT_MS).toISOString();
    }
    this.state.trades.push(stored);
    this.state.trades = this.state.trades.slice(-MAX_HISTORY);
    this.save();
    return stored;
  }

  findTrade(tradeId, direction) {
    return this.state.trades.find(
      (trade) => trade.trade_id === tradeId && (!direction || trade.direction === direction)
    );
  }

  updateTrade(tradeId, changes, direction) {
    const trade = this.findTrade(tradeId, direction);
    if (!trade) {
      throw new Error(`Troca não encontrada: ${tradeId}`);
    }
    Object.assign(trade, changes, { updated_at: new Date().toISOString() });
    this.save();
    return trade;
  }

  clearHistory(scopes = []) {
    const selected = new Set(scopes);
    const cleared = {};

    if (selected.has("searches")) {
      cleared.searches = this.state.searches.length;
      this.state.searches = [];
    }

    if (selected.has("trades")) {
      const activeStatuses = new Set(["pending", "accepted"]);
      const activeTrades = this.state.trades.filter(
        (trade) => activeStatuses.has(trade.status)
      );
      cleared.trades = this.state.trades.length - activeTrades.length;
      this.state.trades = activeTrades;
    }

    this.save();
    return cleared;
  }
}

module.exports = { Store, TRADE_TIMEOUT_MS };
