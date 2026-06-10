"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const {
    ProtocolError,
    createMessage,
    normalizePeerId,
    normalizeStickerId,
    validateMessage
} = require("./protocol");

const OPEN = WebSocket.OPEN;
const CONNECTING = WebSocket.CONNECTING;

class P2PNode extends EventEmitter {
    constructor(config, store) {
        super();
        this.config = config;
        this.store = store;
        this.sockets = new Set();
        this.peerSockets = new Map();
        this.outboundSockets = new Map();
        this.queryRoutes = new Map();
        this.inventorySnapshots = new Map();
        this.processedMessages = new Set();
        this.knownPeerUrls = new Set(config.neighbors || []);
        this.reconnectTimers = new Map();
        this.stopped = false;
    }

    start() {
        this.stopped = false;
        for (const url of this.knownPeerUrls) {
            this.connect(url);
        }
    }

    stop() {
        this.stopped = true;
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();
        for (const socket of this.sockets) {
            socket.close();
        }
    }

    attach(socket, outboundUrl = null) {
        if (this.sockets.has(socket)) {
            return;
        }

        socket.p2p = {
            peerId: null,
            outboundUrl,
            helloSent: false
        };
        this.sockets.add(socket);
        if (outboundUrl) {
            this.outboundSockets.set(outboundUrl, socket);
        }

        socket.on("open", () => this.#sendHello(socket));
        socket.on("message", (data, isBinary) => {
            if (isBinary) {
                this.#emit("error", { message: "Mensagem binária ignorada" });
                return;
            }
            this.#handleRaw(socket, data.toString("utf8"));
        });
        socket.on("close", () => this.#detach(socket));
        socket.on("error", (error) => {
            this.#emit("connection_error", {
                peer_url: outboundUrl,
                message: error.message
            });
        });

        if (socket.readyState === OPEN) {
            this.#sendHello(socket);
        }
    }

    connect(rawUrl) {
        let url;
        try {
            url = normalizePeerUrl(rawUrl);
        } catch (error) {
            this.#emit("connection_error", { peer_url: rawUrl, message: error.message });
            return false;
        }

        if (url === this.config.advertised_url) {
            return false;
        }

        this.knownPeerUrls.add(url);
        const existing = this.outboundSockets.get(url);
        if (existing && [OPEN, CONNECTING].includes(existing.readyState)) {
            return true;
        }

        const socket = new WebSocket(url);
        this.attach(socket, url);
        return true;
    }

    connectedPeers() {
        return [...this.peerSockets.entries()]
            .map(([peer_id, sockets]) => ({
                peer_id,
                connections: [...sockets].filter((socket) => socket.readyState === OPEN).length,
                urls: [...sockets]
                    .map((socket) => socket.p2p.outboundUrl)
                    .filter(Boolean)
            }))
            .filter((peer) => peer.connections > 0)
            .sort((a, b) => a.peer_id.localeCompare(b.peer_id));
    }

    startSearch(stickerId, ttl = 7) {
        const normalized = normalizeStickerId(stickerId);
        if (!Number.isInteger(ttl) || ttl < 0 || ttl > 64) {
            throw new Error("ttl deve ser um inteiro entre 0 e 64");
        }

        const queryId = randomUUID();
        this.store.markQueryProcessed(queryId);
        this.store.addSearch({
            kind: "SEARCH",
            query_id: queryId,
            sticker_id: normalized,
            ttl
        });

        if (this.store.quantity(normalized) > 0) {
            const result = {
                query_id: queryId,
                sticker_id: normalized,
                peer_id: this.config.peer_id,
                peer_url: this.config.advertised_url
            };
            this.#emit("search_hit", result);
            return queryId;
        }

        for (const socket of this.#openSockets()) {
            if (!socket.p2p.peerId) {
                continue;
            }
            this.#send(socket, createMessage("SEARCH", {
                origin_peer_id: this.config.peer_id,
                origin_peer_ip: this.config.advertised_url,
                sender_peer_id: this.config.peer_id,
                receiver_peer_id: socket.p2p.peerId,
                query_id: queryId,
                ttl,
                sticker_id: normalized
            }));
        }

        this.#emit("search_started", { query_id: queryId, sticker_id: normalized, ttl });
        return queryId;
    }

    offerTrade(peerId, offerStickerId, wantStickerId) {
        const receiver = normalizePeerId(peerId);
        const offer = normalizeStickerId(offerStickerId);
        const want = normalizeStickerId(wantStickerId);
        if (offer === want) {
            throw new Error("As figurinhas oferecida e desejada devem ser diferentes");
        }
        if (this.store.availableQuantity(offer) < 1) {
            throw new Error(`Sem disponibilidade de ${offer}`);
        }

        const tradeId = randomUUID();
        const trade = {
            trade_id: tradeId,
            direction: "outgoing",
            peer_id: receiver,
            offer_sticker_id: offer,
            want_sticker_id: want,
            status: "pending"
        };
        this.store.addTrade(trade);

        const message = createMessage("TRADE_OFFER", {
            trade_id: tradeId,
            origin_peer_id: this.config.peer_id,
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: receiver,
            offer_sticker_id: offer,
            want_sticker_id: want,
            offer_image_url: this.#imageUrl(offer)
        });
        if (!this.#sendToPeer(receiver, message)) {
            this.store.updateTrade(tradeId, { status: "failed" }, "outgoing");
            throw new Error(`O peer ${receiver} não está conectado`);
        }

        this.#emit("trade_updated", trade);
        return trade;
    }

    respondToTrade(tradeId, accept) {
        const trade = this.store.findTrade(tradeId, "incoming");
        if (!trade || trade.status !== "pending") {
            throw new Error("Proposta pendente não encontrada");
        }

        if (accept && this.store.availableQuantity(trade.want_sticker_id) < 1) {
            throw new Error(`Sem disponibilidade de ${trade.want_sticker_id}`);
        }

        const type = accept ? "TRADE_ACCEPT" : "TRADE_REJECT";
        const status = accept ? "accepted" : "rejected";
        this.store.updateTrade(tradeId, { status }, "incoming");

        const message = createMessage(type, {
            trade_id: tradeId,
            origin_peer_id: this.config.peer_id,
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: trade.peer_id,
            offer_sticker_id: trade.offer_sticker_id,
            want_sticker_id: trade.want_sticker_id,
            want_image_url: this.#imageUrl(trade.want_sticker_id)
        });
        if (!this.#sendToPeer(trade.peer_id, message)) {
            this.store.updateTrade(tradeId, { status: "pending" }, "incoming");
            throw new Error(`O peer ${trade.peer_id} não está conectado`);
        }

        this.#emit("trade_updated", {...trade, status });
        return this.store.findTrade(tradeId, "incoming");
    }

    requestInventory(peerId) {
        const receiver = normalizePeerId(peerId);
        const requestId = randomUUID();
        const message = createMessage("INVENTORY_REQUEST", {
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: receiver,
            request_id: requestId
        });
        if (!this.#sendToPeer(receiver, message)) {
            throw new Error(`O peer ${receiver} não está conectado`);
        }
        return requestId;
    }

    #handleRaw(socket, raw) {
        let message;
        try {
            message = validateMessage(JSON.parse(raw));
        } catch (error) {
            const detail = error instanceof ProtocolError || error instanceof SyntaxError ?
                error.message :
                "Mensagem inválida";
            this.#emit("protocol_error", { message: detail });
            return;
        }

        if (this.processedMessages.has(message.message_id)) {
            return;
        }
        this.processedMessages.add(message.message_id);
        if (this.processedMessages.size > 5000) {
            this.processedMessages.delete(this.processedMessages.values().next().value);
        }

        try {
            this.#handleMessage(socket, message);
        } catch (error) {
            this.#emit("protocol_error", {
                type: message.type,
                message: error.message
            });
        }
    }

    #handleMessage(socket, message) {
        if (message.type === "HELLO") {
            this.#handleHello(socket, message);
            return;
        }

        if (!socket.p2p.peerId) {
            throw new ProtocolError("HELLO deve ser a primeira mensagem da conexão");
        }

        switch (message.type) {
            case "SEARCH":
                this.#handleSearch(socket, message);
                break;
            case "SEARCH_HIT":
            case "SEARCH_MISS":
                this.#handleSearchResponse(message);
                break;
            case "TRADE_OFFER":
                this.#handleTradeOffer(message);
                break;
            case "TRADE_ACCEPT":
                this.#handleTradeAccept(message);
                break;
            case "TRADE_REJECT":
                this.#handleTradeReject(message);
                break;
            case "TRANSFER_CONFIRM":
                this.#handleTransferConfirm(message);
                break;
            case "INVENTORY_REQUEST":
                this.#handleInventoryRequest(message);
                break;
            case "INVENTORY_RESPONSE":
                this.#handleInventoryResponse(message);
                break;
            default:
                throw new ProtocolError(`Tipo não tratado: ${message.type}`);
        }
    }

    #handleHello(socket, message) {
        socket.p2p.peerId = message.sender_peer_id;
        if (!this.peerSockets.has(message.sender_peer_id)) {
            this.peerSockets.set(message.sender_peer_id, new Set());
        }
        this.peerSockets.get(message.sender_peer_id).add(socket);

        for (const peerUrl of message.peers || []) {
            if (typeof peerUrl === "string" && peerUrl !== this.config.advertised_url) {
                this.connect(peerUrl);
            }
        }

        if (!socket.p2p.helloSent) {
            this.#sendHello(socket);
        }
        this.#emit("peer_connected", { peer_id: message.sender_peer_id });
    }

    #handleSearch(socket, message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        if (this.store.hasProcessedQuery(message.query_id)) {
            return;
        }

        this.store.markQueryProcessed(message.query_id);
        this.queryRoutes.set(message.query_id, socket);
        this.store.addSearch({
            kind: "FORWARDED_SEARCH",
            query_id: message.query_id,
            origin_peer_id: message.origin_peer_id,
            sticker_id: message.sticker_id,
            ttl: message.ttl
        });

        if (this.store.quantity(message.sticker_id) > 0) {
            const hit = createMessage("SEARCH_HIT", {
                origin_peer_id: this.config.peer_id,
                sender_peer_id: this.config.peer_id,
                receiver_peer_id: message.origin_peer_id,
                query_id: message.query_id,
                sticker_id: message.sticker_id,
                peer_url: this.config.advertised_url
            });
            this.#send(socket, hit);
            return;
        }

        if (message.ttl <= 0) {
            return;
        }

        for (const neighbor of this.#openSockets()) {
            if (neighbor === socket || !neighbor.p2p.peerId) {
                continue;
            }
            this.#send(neighbor, createMessage("SEARCH", {
                origin_peer_id: message.origin_peer_id,
                origin_peer_ip: message.origin_peer_ip,
                sender_peer_id: this.config.peer_id,
                receiver_peer_id: neighbor.p2p.peerId,
                query_id: message.query_id,
                ttl: message.ttl - 1,
                sticker_id: message.sticker_id
            }));
        }
    }

    #handleSearchResponse(message) {
        if (message.receiver_peer_id === this.config.peer_id) {
            if (message.type === "SEARCH_HIT") {
                const result = {
                    query_id: message.query_id,
                    sticker_id: message.sticker_id,
                    peer_id: message.origin_peer_id,
                    peer_url: message.peer_url || null
                };
                this.store.addSearch({ kind: "SEARCH_HIT", ...result });
                if (message.peer_url) {
                    this.connect(message.peer_url);
                }
                this.#emit("search_hit", result);
            } else {
                this.#emit("search_miss", {
                    query_id: message.query_id,
                    sticker_id: message.sticker_id,
                    peer_id: message.origin_peer_id
                });
            }
            return;
        }

        const route = this.queryRoutes.get(message.query_id);
        if (route?.readyState === OPEN) {
            this.#send(route, {
                ...message,
                message_id: randomUUID(),
                sender_peer_id: this.config.peer_id
            });
        }
    }

    #handleTradeOffer(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        const tradeId = message.trade_id || message.message_id;
        if (this.store.findTrade(tradeId, "incoming")) {
            return;
        }
        const trade = {
            trade_id: tradeId,
            direction: "incoming",
            peer_id: message.origin_peer_id,
            offer_sticker_id: message.offer_sticker_id,
            want_sticker_id: message.want_sticker_id,
            offer_image_url: message.offer_image_url || "",
            status: "pending"
        };
        this.store.addTrade(trade);
        this.#emit("trade_offer", trade);
    }

    #handleTradeAccept(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        const tradeId = message.trade_id || message.message_id;
        const trade = this.store.findTrade(tradeId, "outgoing");
        if (!trade || trade.status !== "pending" || trade.peer_id !== message.sender_peer_id) {
            return;
        }
        if (this.store.quantity(trade.offer_sticker_id) < 1) {
            this.store.updateTrade(tradeId, { status: "failed" }, "outgoing");
            throw new Error(`Sem disponibilidade de ${trade.offer_sticker_id}`);
        }

        this.store.applyTrade(
            trade.offer_sticker_id,
            trade.want_sticker_id,
            message.want_image_url || ""
        );
        this.store.updateTrade(tradeId, { status: "completed" }, "outgoing");

        const confirmation = createMessage("TRANSFER_CONFIRM", {
            trade_id: tradeId,
            origin_peer_id: this.config.peer_id,
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: trade.peer_id,
            offer_sticker_id: trade.offer_sticker_id,
            want_sticker_id: trade.want_sticker_id,
            offer_image_url: this.#imageUrl(trade.offer_sticker_id),
            want_image_url: this.#imageUrl(trade.want_sticker_id)
        });
        this.#sendToPeer(trade.peer_id, confirmation);
        this.#emit("trade_updated", this.store.findTrade(tradeId, "outgoing"));
        this.#emit("inventory_updated", { inventory: this.store.inventoryList() });
    }

    #handleTradeReject(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        const tradeId = message.trade_id || message.message_id;
        const trade = this.store.findTrade(tradeId, "outgoing");
        if (!trade || trade.status !== "pending") {
            return;
        }
        this.store.updateTrade(tradeId, { status: "rejected" }, "outgoing");
        this.#emit("trade_updated", this.store.findTrade(tradeId, "outgoing"));
    }

    #handleTransferConfirm(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        const tradeId = message.trade_id || message.message_id;
        const trade = this.store.findTrade(tradeId, "incoming");
        if (!trade || trade.status !== "accepted") {
            return;
        }

        this.store.applyTrade(
            trade.want_sticker_id,
            trade.offer_sticker_id,
            message.offer_image_url || trade.offer_image_url || ""
        );
        this.store.updateTrade(tradeId, { status: "completed" }, "incoming");
        this.#emit("trade_updated", this.store.findTrade(tradeId, "incoming"));
        this.#emit("inventory_updated", { inventory: this.store.inventoryList() });
    }

    #handleInventoryRequest(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        this.#sendToPeer(message.sender_peer_id, createMessage("INVENTORY_RESPONSE", {
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: message.sender_peer_id,
            request_id: message.request_id,
            inventory: this.store.inventoryList()
        }));
    }

    #handleInventoryResponse(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        this.inventorySnapshots.set(message.sender_peer_id, {
            inventory: message.inventory,
            received_at: new Date().toISOString()
        });
        this.#emit("inventory_response", {
            request_id: message.request_id,
            peer_id: message.sender_peer_id,
            inventory: message.inventory
        });
    }

    #sendHello(socket) {
        if (socket.readyState !== OPEN || socket.p2p.helloSent) {
            return;
        }
        const peers = [...this.knownPeerUrls];
        if (this.config.advertised_url) {
            peers.unshift(this.config.advertised_url);
        }
        this.#send(socket, createMessage("HELLO", {
            sender_peer_id: this.config.peer_id,
            peers: [...new Set(peers)]
        }));
        socket.p2p.helloSent = true;
    }

    #sendToPeer(peerId, message) {
        const sockets = this.peerSockets.get(peerId);
        if (!sockets) {
            return false;
        }
        const socket = [...sockets].find((candidate) => candidate.readyState === OPEN);
        return socket ? this.#send(socket, message) : false;
    }

    #send(socket, message) {
        if (socket.readyState !== OPEN) {
            return false;
        }
        socket.send(JSON.stringify(message));
        return true;
    }

    #openSockets() {
        return [...this.sockets].filter((socket) => socket.readyState === OPEN);
    }

    #imageUrl(stickerId) {
        return this.store.state.inventory[stickerId]?.image_url || "";
    }

    #detach(socket) {
        this.sockets.delete(socket);
        if (socket.p2p?.outboundUrl &&
            this.outboundSockets.get(socket.p2p.outboundUrl) === socket) {
            this.outboundSockets.delete(socket.p2p.outboundUrl);
            this.#scheduleReconnect(socket.p2p.outboundUrl);
        }
        if (socket.p2p?.peerId) {
            const peers = this.peerSockets.get(socket.p2p.peerId);
            peers?.delete(socket);
            if (peers?.size === 0) {
                this.peerSockets.delete(socket.p2p.peerId);
                this.#emit("peer_disconnected", { peer_id: socket.p2p.peerId });
            }
        }
    }

    #scheduleReconnect(url) {
        if (this.stopped || this.reconnectTimers.has(url)) {
            return;
        }
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(url);
            this.connect(url);
        }, 3000);
        timer.unref();
        this.reconnectTimers.set(url, timer);
    }

    #emit(type, data = {}) {
        this.emit("event", {
            type,
            timestamp: new Date().toISOString(),
            ...data
        });
    }
}

function normalizePeerUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) {
        throw new Error("Endereço vazio");
    }

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ?
        value :
        `ws://${value}`;
    const parsed = new URL(withProtocol);
    if (!["ws:", "wss:"].includes(parsed.protocol)) {
        throw new Error("Use um IP, ws:// ou wss://");
    }
    if (!parsed.port) {
        parsed.port = "8080";
    }
    if (parsed.pathname === "/" || parsed.pathname === "") {
        parsed.pathname = "/p2p";
    }
    return parsed.toString();
}

module.exports = { P2PNode, normalizePeerUrl };
