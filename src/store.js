"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeStickerId } = require("./protocol");

const MAX_HISTORY = 2000;

class Store {
  constructor(filePath, initial) {
    this.filePath = filePath;
    this.initial = initial;
    this.state = this.#load();
  }

  #load() {
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        inventory: parsed.inventory || {},
        processed_queries: parsed.processed_queries || [],
        searches: parsed.searches || [],
        trades: parsed.trades || []
      };
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
    this.state = state;
    this.save();
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
      image_url: imageUrl || current?.image_url || ""
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
      this.state.inventory[received] = { quantity: 0, image_url: receivedImageUrl };
    } else if (receivedImageUrl && !this.state.inventory[received].image_url) {
      this.state.inventory[received].image_url = receivedImageUrl;
    }
    this.state.inventory[received].quantity += 1;
    this.save();
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
    this.state.trades.push({ ...trade, updated_at: new Date().toISOString() });
    this.state.trades = this.state.trades.slice(-MAX_HISTORY);
    this.save();
    return trade;
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
}

module.exports = { Store };
