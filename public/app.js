"use strict";

const state = {
  status: null,
  searchResults: [],
  searchTrace: [],
  events: [],
  inventoryOpen: false
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Erro HTTP ${response.status}`);
  }
  return data;
}

async function refresh() {
  state.status = await api("/api/status");
  render();
}

function render() {
  const status = state.status;
  if (!status) {
    return;
  }

  $("#peer-id").textContent = status.peer_id;
  $("#peer-url").textContent = status.advertised_url;
  $("#sticker-total").textContent = status.inventory.reduce(
    (total, item) => total + item.quantity,
    0
  );
  $("#peer-total").textContent = status.peers.length;
  $("#trade-total").textContent = status.trades.filter(
    (trade) => trade.status === "completed"
  ).length;

  renderInventory(status.inventory);
  renderPeers(status.peers);
  renderTrades(status.trades);
  renderSearchResults();
}

function renderInventory(inventory) {
  const container = $("#inventory");
  const inventoryById = new Map(inventory.map((item) => [item.sticker_id, item]));
  const ownedSlots = Array.from({ length: 28 }, (_, index) => {
    const stickerId = `FIG-${String(index + 1).padStart(2, "0")}`;
    return (inventoryById.get(stickerId)?.quantity || 0) > 0;
  }).filter(Boolean).length;
  const albumSlots = Array.from({ length: 28 }, (_, index) => {
    const stickerId = `FIG-${String(index + 1).padStart(2, "0")}`;
    const item = inventoryById.get(stickerId);
    const quantity = item?.quantity || 0;
    return `
    <article class="sticker ${quantity > 0 ? "owned" : "missing"}">
      <div class="sticker-image">
        ${item?.image_url
          ? `<img src="${escapeHtml(item.image_url)}" alt="${item.sticker_id}">`
          : `<span>${String(index + 1).padStart(2, "0")}</span>`}
      </div>
      <div class="sticker-info">
        <strong>Figurinha ${String(index + 1).padStart(2, "0")}</strong>
        <span>${quantity > 0 ? `x${quantity}` : "faltando"}</span>
      </div>
    </article>
  `;
  });

  container.className = "stickers album-page";
  container.hidden = !state.inventoryOpen;
  container.innerHTML = albumSlots.join("");
  $("#inventory-summary").textContent = state.inventoryOpen
    ? `${ownedSlots} de 28 figurinhas no álbum.`
    : `${ownedSlots} de 28 figurinhas. Abra o inventário para ver a página do álbum.`;

  const toggleButton = $("[data-toggle-inventory]");
  toggleButton.textContent = state.inventoryOpen ? "Fechar inventário" : "Abrir inventário";
  toggleButton.setAttribute("aria-expanded", String(state.inventoryOpen));
}

function renderPeers(peers) {
  renderPeerGroup(
    "#outgoing-peers",
    peers.filter((peer) => peer.outgoing),
    "Voce ainda nao iniciou conexoes."
  );
  renderPeerGroup(
    "#incoming-peers",
    peers.filter((peer) => peer.incoming),
    "Nenhum colega conectou com voce."
  );
}

function renderPeerGroup(selector, peers, emptyMessage) {
  const container = $(selector);
  if (!peers.length) {
    container.innerHTML = `<p class="empty">${emptyMessage}</p>`;
    return;
  }

  container.innerHTML = peers.map((peer) => `
    <div class="feed-item">
      <div class="peer-card">
        <strong>${peer.peer_id}</strong>
        <span class="peer-meta">${escapeHtml(peer.urls[0] || "conexao recebida")}</span>
      </div>
      <div class="peer-actions">
        <span class="status completed">online</span>
        <button class="small reject" type="button" data-disconnect-peer="${peer.peer_id}">
          Desconectar
        </button>
      </div>
    </div>
  `).join("");
}

function renderTrades(trades) {
  const container = $("#trades");
  if (!trades.length) {
    container.className = "trade-list empty";
    container.textContent = "Nenhuma troca registrada.";
    return;
  }

  container.className = "trade-list";
  container.innerHTML = trades.map((trade) => {
    const incomingPending = trade.direction === "incoming" && trade.status === "pending";
    const summary = tradeSummary(trade);
    return `
      <article class="trade">
        <div>
          <p><strong>${trade.peer_id}</strong> - ${trade.direction === "incoming" ? "recebida" : "enviada"}</p>
          <span class="muted">${summary}</span>
        </div>
        <div class="trade-actions">
          ${incomingPending ? `
            <button data-trade="${trade.trade_id}" data-accept="true">Aceitar</button>
            <button class="reject" data-trade="${trade.trade_id}" data-accept="false">Rejeitar</button>
          ` : `<span class="status ${trade.status}">${translateStatus(trade.status)}</span>`}
        </div>
      </article>
    `;
  }).join("");
}

function tradeSummary(trade) {
  if (trade.direction === "incoming") {
    return `Voce recebe ${trade.offer_sticker_id} e envia ${trade.want_sticker_id}`;
  }
  return `Voce envia ${trade.offer_sticker_id} e recebe ${trade.want_sticker_id}`;
}

function renderSearchResults() {
  const container = $("#search-results");
  if (!state.searchResults.length && !state.searchTrace.length) {
    container.innerHTML = '<p class="empty">Os resultados aparecerao aqui.</p>';
    return;
  }

  const trace = state.searchTrace.map((event) => `
    <div class="feed-item search-step">
      <div>
        <strong>${escapeHtml(searchTraceTitle(event))}</strong>
        <div class="muted">${escapeHtml(searchTraceDetail(event))}</div>
      </div>
      <span class="status ${event.type === "search_stopped" ? "failed" : "pending"}">
        ttl ${event.ttl}
      </span>
    </div>
  `).join("");

  const results = state.searchResults.map((result) => `
    <div class="feed-item">
      <div>
        <strong>${result.sticker_id}</strong>
        <div class="muted">Encontrada em ${result.peer_id}</div>
      </div>
      <span class="status completed">encontrada</span>
    </div>
  `).join("");

  container.innerHTML = trace + results;
}

function searchTraceTitle(event) {
  if (event.type === "search_started") {
    return `Buscando ${event.sticker_id}`;
  }
  if (event.type === "search_forwarded") {
    return `${event.sticker_id} repassada`;
  }
  if (event.type === "search_stopped") {
    return `${event.sticker_id} parada`;
  }
  return event.sticker_id || "Busca";
}

function searchTraceDetail(event) {
  if (event.type === "search_started") {
    return `Busca iniciada com TTL ${event.ttl}.`;
  }
  if (event.type === "search_forwarded") {
    return `${event.from_peer_id} -> ${event.to_peer_id}, TTL ${event.previous_ttl} -> ${event.ttl}.`;
  }
  if (event.type === "search_stopped") {
    return `TTL chegou em ${event.ttl}; este nó nao repassou mais.`;
  }
  return "";
}

function addEvent(event) {
  if (!eventMessage(event)) {
    return;
  }

  state.events.unshift(event);
  state.events = state.events.slice(0, 20);
  renderEvents();
}

function renderEvents() {
  const container = $("#events");
  if (!state.events.length) {
    container.innerHTML = '<p class="empty">Nenhuma atividade recente.</p>';
    return;
  }

  container.innerHTML = state.events.map((event) => `
    <div class="event-item">
      <span class="event-time">${new Date(event.timestamp || Date.now()).toLocaleTimeString()}</span>
      <span class="event-message ${isErrorEvent(event) ? "error" : ""}">
        ${escapeHtml(eventMessage(event))}
      </span>
    </div>
  `).join("");
}

function eventMessage(event) {
  const messages = {
    peer_connected: event.direction === "incoming"
      ? `${event.peer_id} conectou com voce`
      : `Voce conectou com ${event.peer_id}`,
    peer_disconnected: `${event.peer_id} desconectou: ${event.reason || "motivo não informado"}`,
    peer_url_ignored: `URL ignorada de ${event.peer_id}: ${event.peer_url}`,
    self_connection_ignored: `Conexao comigo mesmo ignorada: ${event.peer_url || event.peer_id}`,
    search_started: `Buscando ${event.sticker_id} na rede`,
    search_forwarded: `${event.sticker_id} repassada para ${event.to_peer_id}: ttl ${event.previous_ttl} -> ${event.ttl}`,
    search_stopped: `${event.sticker_id} parou porque o ttl chegou em ${event.ttl}`,
    search_hit: `${event.sticker_id} encontrada em ${event.peer_id}`,
    trade_offer: `Nova proposta de ${event.peer_id}: voce recebe ${event.offer_sticker_id} e envia ${event.want_sticker_id}`,
    trade_updated: `Troca com ${event.peer_id} esta ${translateStatus(event.status)}`,
    inventory_response: `Inventario de ${event.peer_id} recebido`,
    connection_error: event.message || "Falha ao conectar com um vizinho",
    protocol_error: event.message || "Mensagem de protocolo invalida",
    history_cleared: "Historico limpo"
  };
  return messages[event.type] || "";
}

function isErrorEvent(event) {
  return event.type === "connection_error" || event.type === "protocol_error" ||
    event.status === "failed";
}

function notice(message, error = false) {
  const element = $("#notice");
  element.textContent = message;
  element.className = `visible${error ? " error" : ""}`;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => {
    element.className = "";
  }, 5000);
}

function bindForm(selector, path, successMessage, transform = (body) => body) {
  $(selector).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = transform(Object.fromEntries(new FormData(form)));
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      notice(successMessage);
      await refresh();
    } catch (error) {
      notice(error.message, true);
    }
  });
}

bindForm("#search-form", "/api/search", "Busca iniciada.", (body) => ({
  ...body,
  ttl: Number(body.ttl)
}));
bindForm("#neighbor-form", "/api/neighbors", "Vizinho conectado com sucesso.");
bindForm("#trade-form", "/api/trades", "Proposta enviada.");
bindForm("#inventory-query-form", "/api/inventory/query", "Consulta enviada.");

document.addEventListener("click", async (event) => {
  const clearEventsButton = event.target.closest("[data-clear-events]");
  if (clearEventsButton) {
    state.events = [];
    renderEvents();
    return;
  }

  const clearHistoryButton = event.target.closest("[data-clear-history]");
  if (clearHistoryButton) {
    const scope = clearHistoryButton.dataset.clearHistory;
    try {
      await api("/api/history", {
        method: "DELETE",
        body: JSON.stringify({ scopes: [scope] })
      });
      if (scope === "searches") {
        state.searchResults = [];
        state.searchTrace = [];
      }
      notice(scope === "trades"
        ? "Trocas encerradas removidas."
        : "Historico de buscas removido.");
      await refresh();
    } catch (error) {
      notice(error.message, true);
    }
    return;
  }

  const inventoryToggle = event.target.closest("[data-toggle-inventory]");
  if (inventoryToggle) {
    state.inventoryOpen = !state.inventoryOpen;
    renderInventory(state.status.inventory);
    return;
  }

  const disconnectButton = event.target.closest("[data-disconnect-peer]");
  if (disconnectButton) {
    try {
      await api(`/api/neighbors/${encodeURIComponent(disconnectButton.dataset.disconnectPeer)}`, {
        method: "DELETE"
      });
      notice(`${disconnectButton.dataset.disconnectPeer} desconectado.`);
      await refresh();
    } catch (error) {
      notice(error.message, true);
    }
    return;
  }

  const openButton = event.target.closest("[data-dialog]");
  if (openButton) {
    $(`#${openButton.dataset.dialog}`).showModal();
    return;
  }

  if (event.target.closest("[data-close]")) {
    event.target.closest("dialog").close();
    return;
  }

  const tradeButton = event.target.closest("[data-trade]");
  if (tradeButton) {
    try {
      await api(`/api/trades/${encodeURIComponent(tradeButton.dataset.trade)}/respond`, {
        method: "POST",
        body: JSON.stringify({ accept: tradeButton.dataset.accept === "true" })
      });
      notice("Resposta enviada.");
      await refresh();
    } catch (error) {
      notice(error.message, true);
    }
  }
});

const events = new EventSource("/api/events");
events.onmessage = async ({ data }) => {
  const event = JSON.parse(data);
  addEvent(event);

  if (["search_started", "search_forwarded", "search_stopped"].includes(event.type)) {
    state.searchTrace.unshift(event);
    state.searchTrace = state.searchTrace.slice(0, 12);
  }

  if (event.type === "search_hit") {
    state.searchResults.unshift(event);
  }

  if (event.type === "inventory_response") {
    $("#remote-inventory").innerHTML = `
      <h3>${event.peer_id}</h3>
      <div class="feed">
        ${event.inventory.map((item) => `
          <div class="feed-item">
            <strong>${item.sticker_id}</strong>
            <span>x${item.quantity}</span>
          </div>
        `).join("") || '<p class="empty">Inventario vazio.</p>'}
      </div>
    `;
  }

  if (["peer_connected", "peer_disconnected", "trade_offer", "trade_updated",
    "inventory_updated", "search_hit", "history_cleared"].includes(event.type)) {
    await refresh();
  } else {
    renderSearchResults();
  }

  if (isErrorEvent(event)) {
    notice(event.message || "Falha na conexao com o colega.", true);
  }
};
events.onerror = () => notice(
  "A conexao de eventos sera restabelecida automaticamente.",
  true
);

function translateStatus(status) {
  return {
    accepted: "aceita",
    completed: "concluida",
    expired: "expirada",
    failed: "falhou",
    pending: "pendente",
    rejected: "rejeitada"
  }[status] || status;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

renderEvents();
refresh().catch((error) => notice(error.message, true));
