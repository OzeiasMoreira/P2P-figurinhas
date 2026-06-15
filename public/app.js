"use strict";

const state = {
  status: null,
  searchResults: [],
  events: []
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
  if (!inventory.length) {
    container.className = "stickers empty";
    container.textContent = "Nenhuma figurinha cadastrada.";
    return;
  }
  container.className = "stickers";
  container.innerHTML = inventory.map((item) => `
    <article class="sticker">
      <div class="sticker-image">
        ${item.image_url
          ? `<img src="${escapeHtml(item.image_url)}" alt="${item.sticker_id}">`
          : `<span>${item.sticker_id.slice(-2)}</span>`}
      </div>
      <div class="sticker-info">
        <strong>${item.sticker_id}</strong>
        <span>×${item.quantity}</span>
      </div>
    </article>
  `).join("");
}

function renderPeers(peers) {
  const container = $("#peers");
  if (!peers.length) {
    container.innerHTML = '<p class="empty">Nenhum vizinho conectado.</p>';
    return;
  }
  container.innerHTML = peers.map((peer) => `
    <div class="feed-item">
      <strong>${peer.peer_id}</strong>
      <span class="status completed">online</span>
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
    return `
      <article class="trade">
        <div>
          <p><strong>${trade.peer_id}</strong> · ${trade.direction === "incoming" ? "recebida" : "enviada"}</p>
          <span class="muted">Oferece ${trade.offer_sticker_id} por ${trade.want_sticker_id}</span>
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

function renderSearchResults() {
  const container = $("#search-results");
  if (!state.searchResults.length) {
    container.innerHTML = '<p class="empty">Os resultados aparecerão aqui.</p>';
    return;
  }
  container.innerHTML = state.searchResults.map((result) => `
    <div class="feed-item">
      <div>
        <strong>${result.sticker_id}</strong>
        <div class="muted">Encontrada em ${result.peer_id}</div>
      </div>
      <span class="status completed">encontrada</span>
    </div>
  `).join("");
}

function addEvent(event) {
  state.events.unshift(event);
  state.events = state.events.slice(0, 80);
  $("#events").innerHTML = state.events.map((item) => `
    <div>${new Date(item.timestamp || Date.now()).toLocaleTimeString()} ·
      ${escapeHtml(item.type)}${item.message ? ` · ${escapeHtml(item.message)}` : ""}
    </div>
  `).join("");
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
bindForm("#sticker-form", "/api/stickers", "Inventário atualizado.", (body) => ({
  ...body,
  quantity: Number(body.quantity)
}));

$("#sticker-form").addEventListener("submit", () => {
  setTimeout(() => $("#sticker-dialog").close(), 150);
});

document.addEventListener("click", async (event) => {
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
            <span>×${item.quantity}</span>
          </div>
        `).join("") || '<p class="empty">Inventário vazio.</p>'}
      </div>
    `;
  }
  if (["peer_connected", "peer_disconnected", "trade_offer", "trade_updated",
    "inventory_updated", "search_hit"].includes(event.type)) {
    await refresh();
  } else {
    renderSearchResults();
  }
  if (event.type === "connection_error" || event.type === "protocol_error") {
    notice(event.message || "Falha na conexão com o colega.", true);
  }
};
events.onerror = () => notice("A conexão de eventos será restabelecida automaticamente.", true);

function translateStatus(status) {
  return {
    accepted: "aceita",
    completed: "concluída",
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

refresh().catch((error) => notice(error.message, true));
