"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
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
        this.manuallyDisconnectedPeerIds = new Set();
        this.manuallyDisconnectedPeerUrls = new Set();
        this.knownPeerUrls = new Set();
        for (const url of config.neighbors || []) {
            this.#rememberPeerUrl(url);
        }
        this.reconnectTimers = new Map();
        this.tradeExpirationTimer = null;
        this.stopped = false;
    }

    start() {
        this.stopped = false;
        this.#expirePendingTrades();
        if (!this.tradeExpirationTimer) {
            this.tradeExpirationTimer = setInterval(() => {
                this.#expirePendingTrades();
            }, 10_000);
            this.tradeExpirationTimer.unref();
        }
        for (const url of this.knownPeerUrls) {
            this.connect(url, "configured");
        }
    }

    stop() {
        this.stopped = true;
        if (this.tradeExpirationTimer) {
            clearInterval(this.tradeExpirationTimer);
            this.tradeExpirationTimer = null;
        }
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();
        for (const socket of this.sockets) {
            socket.close();
        }
    }

    attach(socket, outboundUrl = null, connectionSource = "incoming") {
        if (this.sockets.has(socket)) {
            return;
        }

        socket.p2p = {
            peerId: null,
            peerUrl: null,
            outboundUrl,
            connectionSource,
            helloSent: false,
            canceling: false,
            connectedAt: new Date().toISOString()
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
        socket.on("close", (code, reason) => {
            this.#detach(socket, code, reason.toString("utf8"));
        });
        socket.on("error", (error) => {
            if (socket.p2p.canceling) {
                return;
            }
            this.#emit("connection_error", {
                peer_url: outboundUrl,
                message: error.message
            });
        });
        socket.on("unexpected-response", (_request, response) => {
            response.resume();
            const suffix = new URL(outboundUrl).pathname === "/p2p"
                ? ""
                : " Tente adicionar /p2p ao endereço.";
            socket.emit(
                "p2p_connection_failure",
                new Error(`Servidor respondeu HTTP ${response.statusCode}.${suffix}`)
            );
        });

        if (socket.readyState === OPEN) {
            this.#sendHello(socket);
        }
    }

    connect(rawUrl, connectionSource = "manual") {
        let url;
        try {
            url = normalizePeerUrl(rawUrl);
        } catch (error) {
            this.#emit("connection_error", { peer_url: rawUrl, message: error.message });
            return false;
        }

        if (url === normalizePeerUrl(this.config.advertised_url)) {
            return false;
        }

        const manualConnection = ["manual", "configured"].includes(connectionSource);
        if (manualConnection) {
            this.manuallyDisconnectedPeerUrls.delete(url);
        } else if (this.manuallyDisconnectedPeerUrls.has(url)) {
            return false;
        }

        this.#rememberPeerUrl(url, manualConnection);
        const existing = this.outboundSockets.get(url);
        if (existing && [OPEN, CONNECTING].includes(existing.readyState)) {
            return true;
        }

        const socket = new WebSocket(url);
        this.attach(socket, url, connectionSource);
        return true;
    }

    async connectAndWait(rawUrl, timeoutMs = 5000) {
        const url = normalizePeerUrl(rawUrl);
        if (!this.connect(url)) {
            throw new Error("Endereco de vizinho invalido ou igual ao endereco local");
        }

        const socket = this.outboundSockets.get(url);
        if (socket?.readyState === OPEN && socket.p2p?.peerId) {
            return { peer_id: socket.p2p.peerId, url };
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                clearInterval(poll);
                socket?.off("error", onError);
                socket?.off("close", onClose);
                socket?.off("p2p_connection_failure", onFailure);
                if (error) {
                    this.#cancelOutboundConnection(url, socket);
                    reject(error);
                } else {
                    resolve({ peer_id: socket.p2p.peerId, url });
                }
            };
            const onError = (error) => finish(
                new Error(`Nao foi possivel conectar em ${url}: ${error.message}`)
            );
            const onClose = () => finish(
                new Error(`A conexao com ${url} foi encerrada antes do HELLO`)
            );
            const onFailure = (error) => finish(error);
            const poll = setInterval(() => {
                if (socket?.readyState === OPEN && socket.p2p?.peerId) {
                    finish();
                }
            }, 50);
            const timer = setTimeout(() => finish(
                new Error(`Tempo esgotado conectando em ${url}`)
            ), timeoutMs);

            socket?.once("error", onError);
            socket?.once("close", onClose);
            socket?.once("p2p_connection_failure", onFailure);
        });
    }

    connectedPeers() {
        return [...this.peerSockets.entries()]
            .filter(([peer_id]) => peer_id !== this.config.peer_id)
            .map(([peer_id, sockets]) => {
                const openSockets = [...sockets].filter(
                    (socket) => socket.readyState === OPEN
                );
                const outgoing = openSockets.some((socket) => socket.p2p.outboundUrl);
                return {
                    peer_id,
                    connections: openSockets.length,
                    incoming: !outgoing && openSockets.some(
                        (socket) => !socket.p2p.outboundUrl
                    ),
                    outgoing,
                    connected_at: openSockets
                        .map((socket) => socket.p2p.connectedAt)
                        .sort()[0] || null,
                    urls: openSockets
                        .map((socket) => socket.p2p.outboundUrl)
                        .filter(Boolean)
                };
            })
            .filter((peer) => peer.connections > 0)
            .sort((a, b) => a.peer_id.localeCompare(b.peer_id));
    }

    disconnectPeer(peerId) {
        const normalized = normalizePeerId(peerId);
        this.manuallyDisconnectedPeerIds.add(normalized);
        const sockets = [...(this.peerSockets.get(normalized) || [])];
        for (const socket of sockets) {
            socket.p2p.canceling = true;
            if (socket.p2p.outboundUrl) {
                this.#forgetPeerUrl(socket.p2p.outboundUrl, true);
            }
            if (socket.p2p.peerUrl) {
                this.#forgetPeerUrl(socket.p2p.peerUrl, true);
            }
            if ([OPEN, CONNECTING].includes(socket.readyState)) {
                socket.close(1000, "desconectado pelo usuario");
            }
        }
        this.peerSockets.delete(normalized);
        this.#emit("peer_disconnected", {
            peer_id: normalized,
            reason: "desconectado pelo usuario"
        });
        this.#broadcastHello();
        return { peer_id: normalized, disconnected: sockets.length };
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
                origin_peer_ip: originPeerAddress(this.config.advertised_url),
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
        this.#expirePendingTrades();
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
        this.#expirePendingTrades();
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
        const responseOffer = accept
            ? trade.want_sticker_id
            : trade.offer_sticker_id;
        const responseWant = accept
            ? trade.offer_sticker_id
            : trade.want_sticker_id;

        const message = createMessage(type, {
            trade_id: tradeId,
            origin_peer_id: this.config.peer_id,
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: trade.peer_id,
            offer_sticker_id: responseOffer,
            want_sticker_id: responseWant,
            offer_image_url: this.#imageUrl(responseOffer)
        });
        if (!this.#sendToPeer(trade.peer_id, message)) {
            this.store.updateTrade(tradeId, { status: "pending" }, "incoming");
            throw new Error(`O peer ${trade.peer_id} não está conectado`);
        }

        if (accept) {
            this.store.applyTrade(
                trade.want_sticker_id,
                trade.offer_sticker_id,
                trade.offer_image_url || ""
            );
            this.store.updateTrade(tradeId, { status: "completed" }, "incoming");
            this.#emit("inventory_updated", { inventory: this.store.inventoryList() });
        }

        this.#emit("trade_updated", this.store.findTrade(tradeId, "incoming"));
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
                protocol_type: message.type,
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
        const previousPeerId = socket.p2p.peerId;
        if (message.sender_peer_id === this.config.peer_id) {
            socket.p2p.canceling = true;
            if (message.peer_url) {
                this.#forgetPeerUrl(message.peer_url, true);
            }
            if (socket.p2p.outboundUrl) {
                this.#forgetPeerUrl(socket.p2p.outboundUrl, true);
            }
            this.#emit("self_connection_ignored", {
                peer_id: message.sender_peer_id,
                peer_url: message.peer_url || socket.p2p.outboundUrl || null
            });
            socket.close(1000, "conexao com o proprio no ignorada");
            return;
        }
        const manualConnection = ["manual", "configured"].includes(socket.p2p.connectionSource);
        if (manualConnection) {
            this.manuallyDisconnectedPeerIds.delete(message.sender_peer_id);
        } else if (this.manuallyDisconnectedPeerIds.has(message.sender_peer_id)) {
            socket.p2p.canceling = true;
            if (message.peer_url) {
                this.#forgetPeerUrl(message.peer_url, true);
            }
            socket.close(1000, "peer desconectado manualmente");
            return;
        }

        socket.p2p.peerId = message.sender_peer_id;
        if (!this.peerSockets.has(message.sender_peer_id)) {
            this.peerSockets.set(message.sender_peer_id, new Set());
        }
        this.peerSockets.get(message.sender_peer_id).add(socket);

        let discoveredNewUrl = false;
        let senderPeerUrl = "";
        if (message.peer_url) {
            try {
                senderPeerUrl = normalizePeerUrl(message.peer_url);
                socket.p2p.peerUrl = senderPeerUrl;
                if (isDiscoverablePeerUrl(senderPeerUrl)) {
                    discoveredNewUrl = this.#rememberPeerUrl(message.peer_url) || discoveredNewUrl;
                } else {
                    this.#emit("peer_url_ignored", {
                        peer_id: message.sender_peer_id,
                        peer_url: senderPeerUrl,
                        reason: "hostname_not_resolvable"
                    });
                }
            } catch {
                senderPeerUrl = "";
            }
        }
        for (const peerUrl of message.peers || []) {
            if (typeof peerUrl !== "string") {
                continue;
            }
            if (!looksLikePeerUrl(peerUrl)) {
                continue;
            }
            let normalizedPeerUrl;
            try {
                normalizedPeerUrl = normalizePeerUrl(peerUrl);
            } catch {
                continue;
            }
            if (!isDiscoverablePeerUrl(normalizedPeerUrl)) {
                this.#emit("peer_url_ignored", {
                    peer_id: message.sender_peer_id,
                    peer_url: normalizedPeerUrl,
                    reason: "hostname_not_resolvable"
                });
                continue;
            }
            const isSenderUrl = senderPeerUrl && normalizedPeerUrl === senderPeerUrl;
            if (this.#rememberPeerUrl(peerUrl)) {
                discoveredNewUrl = true;
            }
            if (!isSenderUrl) {
                this.connect(peerUrl, "discovered");
            }
        }

        if (Array.isArray(message.inventory)) {
            this.inventorySnapshots.set(message.sender_peer_id, {
                inventory: message.inventory,
                received_at: new Date().toISOString()
            });
            this.#emit("inventory_response", {
                peer_id: message.sender_peer_id,
                inventory: message.inventory
            });
        }

        if (!socket.p2p.helloSent) {
            this.#sendHello(socket);
        }
        if (discoveredNewUrl || previousPeerId !== message.sender_peer_id) {
            this.#broadcastHello(socket);
        }
        if (previousPeerId !== message.sender_peer_id) {
            const initiatedLocally = ["manual", "configured"].includes(
                socket.p2p.connectionSource
            );
            this.#emit("peer_connected", {
                peer_id: message.sender_peer_id,
                direction: initiatedLocally ? "outgoing" : "incoming",
                peer_url: socket.p2p.outboundUrl || null
            });
        }
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
            this.#emit("search_stopped", {
                query_id: message.query_id,
                sticker_id: message.sticker_id,
                ttl: message.ttl,
                reason: "ttl_expired",
                from_peer_id: socket.p2p.peerId || message.sender_peer_id
            });
            return;
        }

        for (const neighbor of this.#openSockets()) {
            if (neighbor === socket || !neighbor.p2p.peerId) {
                continue;
            }
            const nextTtl = message.ttl - 1;
            this.#send(neighbor, createMessage("SEARCH", {
                origin_peer_id: message.origin_peer_id,
                origin_peer_ip: message.origin_peer_ip,
                sender_peer_id: this.config.peer_id,
                receiver_peer_id: neighbor.p2p.peerId,
                query_id: message.query_id,
                ttl: nextTtl,
                sticker_id: message.sticker_id
            }));
            this.#emit("search_forwarded", {
                query_id: message.query_id,
                sticker_id: message.sticker_id,
                from_peer_id: socket.p2p.peerId || message.sender_peer_id,
                to_peer_id: neighbor.p2p.peerId,
                previous_ttl: message.ttl,
                ttl: nextTtl
            });
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
                    this.connect(message.peer_url, "discovered");
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
        const trade = this.#findOutgoingTradeForResponse(message);
        if (!trade || trade.status !== "pending" || trade.peer_id !== message.sender_peer_id) {
            return;
        }
        if (this.store.quantity(trade.offer_sticker_id) < 1) {
            this.store.updateTrade(trade.trade_id, { status: "failed" }, "outgoing");
            throw new Error(`Sem disponibilidade de ${trade.offer_sticker_id}`);
        }

        this.store.applyTrade(
            trade.offer_sticker_id,
            trade.want_sticker_id,
            message.offer_image_url || message.want_image_url || ""
        );
        this.store.updateTrade(trade.trade_id, { status: "completed" }, "outgoing");

        const confirmation = createMessage("TRANSFER_CONFIRM", {
            trade_id: trade.trade_id,
            origin_peer_id: this.config.peer_id,
            sender_peer_id: this.config.peer_id,
            receiver_peer_id: trade.peer_id,
            offer_sticker_id: trade.offer_sticker_id,
            want_sticker_id: trade.want_sticker_id,
            offer_image_url: this.#imageUrl(trade.offer_sticker_id),
            want_image_url: this.#imageUrl(trade.want_sticker_id)
        });
        this.#sendToPeer(trade.peer_id, confirmation);
        this.#emit("trade_updated", this.store.findTrade(trade.trade_id, "outgoing"));
        this.#emit("inventory_updated", { inventory: this.store.inventoryList() });
    }

    #handleTradeReject(message) {
        if (message.receiver_peer_id !== this.config.peer_id) {
            return;
        }
        const trade = this.#findOutgoingTradeForResponse(message);
        if (!trade || trade.status !== "pending") {
            return;
        }
        this.store.updateTrade(trade.trade_id, { status: "rejected" }, "outgoing");
        this.#emit("trade_updated", this.store.findTrade(trade.trade_id, "outgoing"));
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

    #findOutgoingTradeForResponse(message) {
        const tradeId = message.trade_id || message.message_id;
        const byId = this.store.findTrade(tradeId, "outgoing");
        if (byId) {
            return byId;
        }

        return this.store.state.trades.find((trade) => {
            if (trade.direction !== "outgoing" || trade.status !== "pending") {
                return false;
            }
            if (![message.sender_peer_id, message.origin_peer_id].includes(trade.peer_id)) {
                return false;
            }
            const sameDirection = message.offer_sticker_id === trade.offer_sticker_id &&
                message.want_sticker_id === trade.want_sticker_id;
            const invertedDirection = message.offer_sticker_id === trade.want_sticker_id &&
                message.want_sticker_id === trade.offer_sticker_id;
            return sameDirection || invertedDirection;
        });
    }

    #sendHello(socket, force = false) {
        if (socket.readyState !== OPEN || (!force && socket.p2p.helloSent)) {
            return;
        }
        this.#send(socket, createMessage("HELLO", {
            sender_peer_id: this.config.peer_id,
            peer_url: this.config.advertised_url,
            peers: this.#peerUrlsForHello()
        }));
        socket.p2p.helloSent = true;
    }

    #broadcastHello(exceptSocket = null) {
        for (const socket of this.#openSockets()) {
            if (socket !== exceptSocket && socket.p2p.peerId) {
                this.#sendHello(socket, true);
            }
        }
    }

    #peerUrlsForHello() {
        const peers = [...this.knownPeerUrls];
        if (this.config.advertised_url) {
            peers.unshift(normalizePeerUrl(this.config.advertised_url));
        }
        return [...new Set(peers)];
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

    #rememberPeerUrl(rawUrl, allowBlocked = false) {
        let url;
        try {
            url = normalizePeerUrl(rawUrl);
        } catch {
            return false;
        }
        if (url === normalizePeerUrl(this.config.advertised_url)) {
            return false;
        }
        if (this.manuallyDisconnectedPeerUrls.has(url) && !allowBlocked) {
            return false;
        }
        if (allowBlocked) {
            this.manuallyDisconnectedPeerUrls.delete(url);
        }
        const previousSize = this.knownPeerUrls.size;
        this.knownPeerUrls.add(url);
        return this.knownPeerUrls.size > previousSize;
    }

    #forgetPeerUrl(rawUrl, block = false) {
        let url;
        try {
            url = normalizePeerUrl(rawUrl);
        } catch {
            return false;
        }
        this.knownPeerUrls.delete(url);
        if (block) {
            this.manuallyDisconnectedPeerUrls.add(url);
        }
        const timer = this.reconnectTimers.get(url);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(url);
        }
        const socket = this.outboundSockets.get(url);
        if (socket) {
            socket.p2p.canceling = true;
            this.outboundSockets.delete(url);
        }
        return true;
    }

    #imageUrl(stickerId) {
        return this.store.state.inventory[stickerId]?.image_url || "";
    }

    #detach(socket, code = 1006, reason = "") {
        const peerId = socket.p2p?.peerId;
        const peerUrl = socket.p2p?.outboundUrl;
        this.sockets.delete(socket);
        if (peerUrl && this.outboundSockets.get(peerUrl) === socket) {
            this.outboundSockets.delete(peerUrl);
            this.#scheduleReconnect(
                peerUrl,
                socket.p2p.connectionSource
            );
        }
        if (peerId) {
            const peers = this.peerSockets.get(peerId);
            peers?.delete(socket);
            if (peers?.size === 0) {
                this.peerSockets.delete(peerId);
                this.#emit("peer_disconnected", {
                    peer_id: peerId,
                    peer_url: peerUrl,
                    code,
                    reason: reason || websocketCloseReason(code)
                });
            }
        } else if (!this.stopped && !socket.p2p?.canceling && code !== 1000) {
            this.#emit("connection_error", {
                peer_url: peerUrl,
                code,
                message: `WebSocket encerrado antes do HELLO: ${reason || websocketCloseReason(code)}`
            });
        }
    }

    #scheduleReconnect(url, connectionSource = "manual") {
        if (this.stopped || !this.knownPeerUrls.has(url) ||
            this.manuallyDisconnectedPeerUrls.has(url) ||
            this.reconnectTimers.has(url)) {
            return;
        }
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(url);
            if (!this.knownPeerUrls.has(url) || this.manuallyDisconnectedPeerUrls.has(url)) {
                return;
            }
            this.connect(url, connectionSource);
        }, 3000);
        timer.unref();
        this.reconnectTimers.set(url, timer);
    }

    #cancelOutboundConnection(url, socket) {
        this.knownPeerUrls.delete(url);
        const timer = this.reconnectTimers.get(url);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(url);
        }
        if (this.outboundSockets.get(url) === socket) {
            this.outboundSockets.delete(url);
        }
        if (socket) {
            socket.p2p.canceling = true;
            socket.p2p.outboundUrl = null;
            if ([OPEN, CONNECTING].includes(socket.readyState)) {
                socket.terminate();
            }
        }
    }

    #expirePendingTrades() {
        const expired = this.store.expirePendingTrades();
        for (const trade of expired) {
            this.#emit("trade_updated", trade);
        }
        if (expired.length) {
            this.#emit("inventory_updated", { inventory: this.store.inventoryList() });
        }
        return expired;
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
  return parsed.toString();
}

function looksLikePeerUrl(value) {
    const candidate = String(value || "").trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ||
        candidate.includes(".") ||
        candidate.includes(":") ||
        candidate.toLowerCase() === "localhost";
}

function isDiscoverablePeerUrl(rawUrl) {
    let hostname;
    try {
        hostname = new URL(normalizePeerUrl(rawUrl)).hostname.toLowerCase();
    } catch {
        return false;
    }
    return hostname === "localhost" || net.isIP(hostname) !== 0;
}

function originPeerAddress(advertisedUrl) {
    try {
        return new URL(advertisedUrl).hostname;
    } catch {
        return String(advertisedUrl || "");
    }
}

function websocketCloseReason(code) {
    const reasons = {
        1000: "encerramento normal",
        1001: "o servidor remoto foi encerrado",
        1002: "erro de protocolo",
        1003: "tipo de mensagem não suportado",
        1006: "conexão perdida sem confirmação do servidor remoto",
        1008: "mensagem rejeitada pelo servidor remoto",
        1011: "erro interno no servidor remoto",
        1012: "servidor remoto reiniciado"
    };
    return reasons[code] || `código WebSocket ${code}`;
}

module.exports = { P2PNode, normalizePeerUrl, originPeerAddress };
