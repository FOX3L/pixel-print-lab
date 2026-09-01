import { state } from "./state.js";
import { euroFormatter, formatDate, formatQuoteSummary, orderStatusLabels } from "./format.js";

export function initOrders({ api, loadPix }) {
  const orderCount = document.querySelector("#order-count");
  const orderListStatus = document.querySelector("#order-list-status");
  const orderList = document.querySelector("#order-list");
  const orderListTemplate = document.querySelector("#order-list-template");
  const orderEmpty = document.querySelector("#order-empty");
  const orderForm = document.querySelector("#order-form");
  const orderDate = document.querySelector("#order-date");
  const orderCode = document.querySelector("#order-code");
  const orderTotal = document.querySelector("#order-total");
  const orderStatusSelect = document.querySelector("#order-status");
  const saveOrderStatusButton = document.querySelector("#save-order-status");
  const firstNameValue = document.querySelector("#order-first-name");
  const lastNameValue = document.querySelector("#order-last-name");
  const orderCommentPanel = document.querySelector("#order-comment-panel");
  const orderComment = document.querySelector("#order-comment");
  const adminItems = document.querySelector("#admin-items");
  const adminItemTemplate = document.querySelector("#admin-item-template");
  const orderFeedback = document.querySelector("#order-feedback");
  const deleteOrderButton = document.querySelector("#delete-order");
  const deleteAllOrdersButton = document.querySelector("#delete-all-orders");
  const ordersView = document.querySelector("#orders-view");
  const orderSidebar = document.querySelector("#order-sidebar");
  const archiveSidebar = document.querySelector("#archive-sidebar");
  const archiveList = document.querySelector("#archive-list");
  const archiveListStatus = document.querySelector("#archive-list-status");
  const archiveCount = document.querySelector("#archive-count");
  const catalogView = document.querySelector("#catalog-view");
  const paletteView = document.querySelector("#palette-view");
  const pixView = document.querySelector("#pix-view");
  const navigationButtons = document.querySelectorAll("[data-view]");

  function renderOrderList() {
    orderList.replaceChildren();
    orderCount.textContent = String(state.orders.length).padStart(2, "0");
    orderListStatus.hidden = state.orders.length > 0;
    orderListStatus.textContent = state.orders.length ? "" : "Nessuna richiesta presente.";
    const fragment = document.createDocumentFragment();
    state.orders.forEach((order, index) => {
      const button = orderListTemplate.content.firstElementChild.cloneNode(true);
      button.dataset.orderId = order.id;
      button.querySelector('[data-field="list-order"]').textContent = String(index + 1).padStart(2, "0");
      button.querySelector('[data-field="list-code"]').textContent = order.code;
      button.querySelector('[data-field="list-name"]').textContent = `${order.firstName} ${order.lastName}`;
      button.querySelector('[data-field="list-status"]').textContent = orderStatusLabels[order.status] ?? order.status;
      button.querySelector('[data-field="list-status"]').dataset.status = order.status;
      button.querySelector('[data-field="list-pieces"]').textContent = order.pieceCount;
      button.querySelector('[data-field="list-date"]').textContent = formatDate(order.createdAt);
      button.classList.toggle("order-list-item--active", state.currentOrder?.id === order.id);
      button.addEventListener("click", () => loadOrder(order.id));
      fragment.append(button);
    });
    orderList.append(fragment);
  }

  async function loadOrders() {
    orderListStatus.hidden = false;
    orderListStatus.textContent = "Caricamento richieste...";
    const result = await api("/api/admin/orders");
    state.orders = [...result].reverse();
    renderOrderList();
    if (state.currentSection === "orders" && state.currentOrder && state.orders.some((order) => order.id === state.currentOrder.id)) {
      await loadOrder(state.currentOrder.id);
    } else if (state.currentSection === "orders" && state.orders.length > 0) {
      await loadOrder(state.orders[0].id);
    } else if (state.currentSection === "orders") {
      state.currentOrder = undefined;
      orderForm.hidden = true;
      orderEmpty.hidden = false;
    }
  }

  function renderArchiveList() {
    archiveList.replaceChildren();
    archiveCount.textContent = String(state.archive.length).padStart(2, "0");
    archiveListStatus.hidden = state.archive.length > 0;
    archiveListStatus.textContent = state.archive.length ? "" : "Nessun ordine consegnato.";
    const fragment = document.createDocumentFragment();
    state.archive.forEach((order, index) => {
      const button = orderListTemplate.content.firstElementChild.cloneNode(true);
      button.dataset.orderId = order.id;
      button.querySelector('[data-field="list-order"]').textContent = String(index + 1).padStart(2, "0");
      button.querySelector('[data-field="list-code"]').textContent = order.code;
      button.querySelector('[data-field="list-name"]').textContent = `${order.firstName} ${order.lastName}`;
      button.querySelector('[data-field="list-status"]').textContent = orderStatusLabels[order.status] ?? order.status;
      button.querySelector('[data-field="list-status"]').dataset.status = order.status;
      button.querySelector('[data-field="list-pieces"]').textContent = order.pieceCount;
      button.querySelector('[data-field="list-date"]').textContent = formatDate(order.createdAt);
      button.classList.toggle("order-list-item--active", state.currentOrder?.id === order.id);
      button.addEventListener("click", () => loadOrder(order.id));
      fragment.append(button);
    });
    archiveList.append(fragment);
  }

  async function loadArchive() {
    archiveListStatus.hidden = false;
    archiveListStatus.textContent = "Caricamento archivio...";
    const result = await api("/api/admin/orders/archive");
    state.archive = [...result].reverse();
    renderArchiveList();
    if (state.currentSection === "archive" && state.currentOrder && state.archive.some((order) => order.id === state.currentOrder.id)) {
      await loadOrder(state.currentOrder.id);
    } else if (state.currentSection === "archive" && state.archive.length > 0) {
      await loadOrder(state.archive[0].id);
    } else if (state.currentSection === "archive") {
      state.currentOrder = undefined;
      orderForm.hidden = true;
      orderEmpty.hidden = false;
    }
  }

  function createItemEditor(item) {
    const element = adminItemTemplate.content.firstElementChild.cloneNode(true);
    const productField = element.querySelector('[data-field="product-field"]');
    const modelLink = element.querySelector('[data-field="model-link"]');
    const externalLink = element.querySelector('[data-field="external-link"]');
    const quoteEditor = element.querySelector('[data-field="quote-editor"]');
    const actualGramsInput = element.querySelector('[data-field="actual-grams"]');
    const actualHoursInput = element.querySelector('[data-field="actual-hours"]');
    const actualMinutesInput = element.querySelector('[data-field="actual-minutes"]');
    const saveActualQuoteButton = element.querySelector('[data-field="save-actual-quote"]');
    const clearActualQuoteButton = element.querySelector('[data-field="clear-actual-quote"]');

    element.dataset.itemId = item.id ?? "";
    element.dataset.itemType = item.itemType;
    element.querySelector('[data-field="item-type"]').textContent = item.itemType.replace("_", " ");
    element.querySelector('[data-field="item-name"]').textContent = item.productName;
    element.querySelector('[data-field="color"]').textContent = item.colorName;
    element.querySelector('[data-field="quantity"]').textContent = item.quantity;

    if (item.itemType === "catalog") {
      element.querySelector('[data-field="product"]').textContent = item.productCode;
    } else {
      productField.hidden = true;
      quoteEditor.hidden = false;
      element.querySelector('[data-field="estimated-quote"]').textContent = formatQuoteSummary(item.estimatedQuote);
      element.querySelector('[data-field="actual-quote"]').textContent = item.actualQuote
        ? formatQuoteSummary(item.actualQuote)
        : "Da definire";
      actualGramsInput.value = item.actualGrams ?? "";
      const totalMinutes = Number.isFinite(item.actualHours) ? Math.round(item.actualHours * 60) : null;
      actualHoursInput.value = totalMinutes === null ? "" : Math.floor(totalMinutes / 60);
      actualMinutesInput.value = totalMinutes === null ? "" : totalMinutes % 60;
      saveActualQuoteButton.addEventListener("click", async () => {
        saveActualQuoteButton.disabled = true;
        orderFeedback.textContent = "";
        orderFeedback.classList.remove("admin-feedback--error");
        try {
          await api(`/api/admin/orders/${state.currentOrder.id}/items/${item.id}/actual-quote`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              grams: Number(actualGramsInput.value),
              hours: Number(actualHoursInput.value || 0) + Number(actualMinutesInput.value || 0) / 60,
            }),
          });
          await loadOrder(state.currentOrder.id);
          orderFeedback.textContent = "Dati reali slicer salvati.";
        } catch (error) {
          orderFeedback.textContent = error.message;
          orderFeedback.classList.add("admin-feedback--error");
        } finally {
          saveActualQuoteButton.disabled = false;
        }
      });
      clearActualQuoteButton.addEventListener("click", async () => {
        clearActualQuoteButton.disabled = true;
        orderFeedback.textContent = "";
        orderFeedback.classList.remove("admin-feedback--error");
        try {
          await api(`/api/admin/orders/${state.currentOrder.id}/items/${item.id}/actual-quote`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ clear: true }),
          });
          await loadOrder(state.currentOrder.id);
          orderFeedback.textContent = "Dati reali slicer rimossi.";
        } catch (error) {
          orderFeedback.textContent = error.message;
          orderFeedback.classList.add("admin-feedback--error");
        } finally {
          clearActualQuoteButton.disabled = false;
        }
      });
      if (item.itemType === "custom_file") {
        modelLink.hidden = false;
        modelLink.href = `/api/admin/orders/${state.currentOrder.id}/items/${item.id}/model`;
        modelLink.textContent = `Scarica ${(item.modelFormat ?? "3mf").toUpperCase()}`;
        modelLink.download = item.originalName ?? "modello";
        const compatibility = item.modelMetadata?.compatibility;
        if (compatibility) modelLink.title = `Verifica piatto standard: ${compatibility.status}`;
      }
      if (item.itemType === "custom_link") {
        externalLink.hidden = false;
        externalLink.href = item.externalUrl;
      }
    }

    return element;
  }

  async function loadOrder(id) {
    state.currentOrder = await api(`/api/admin/orders/${id}`);
    const orderItemsTotalCents = state.currentOrder.items.reduce(
      (total, item) => total + (item.unitPriceCents ?? 0) * item.quantity,
      0,
    );
    orderEmpty.hidden = true;
    orderForm.hidden = false;
    orderDate.textContent = formatDate(state.currentOrder.createdAt);
    orderCode.textContent = state.currentOrder.code;
    orderTotal.textContent = euroFormatter.format(orderItemsTotalCents / 100);
    orderStatusSelect.value = state.currentOrder.status;
    firstNameValue.textContent = state.currentOrder.firstName;
    lastNameValue.textContent = state.currentOrder.lastName;
    orderCommentPanel.hidden = !state.currentOrder.comment;
    orderComment.textContent = state.currentOrder.comment ?? "";
    adminItems.replaceChildren(...state.currentOrder.items.map(createItemEditor));
    orderFeedback.textContent = "";
    if (state.currentSection === "archive") renderArchiveList();
    else renderOrderList();
  }

  function showSection(name) {
    state.currentSection = name;
    ordersView.hidden = name !== "orders" && name !== "archive";
    catalogView.hidden = name !== "catalog";
    paletteView.hidden = name !== "palette";
    pixView.hidden = name !== "pix";
    orderSidebar.hidden = name !== "orders";
    archiveSidebar.hidden = name !== "archive";
    if (name === "archive" && state.archive.length === 0) loadArchive();
    if (name === "pix") loadPix();
    navigationButtons.forEach((button) => {
      const active = button.dataset.view === name;
      button.classList.toggle("admin-nav__button--active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
  }

  saveOrderStatusButton.addEventListener("click", async () => {
    if (!state.currentOrder) return;
    const orderId = state.currentOrder.id;
    const requestedStatus = orderStatusSelect.value;
    saveOrderStatusButton.disabled = true;
    orderFeedback.textContent = "";
    orderFeedback.classList.remove("admin-feedback--error");
    try {
      const result = await api(`/api/admin/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: requestedStatus }),
      });
      if (state.currentOrder?.id === orderId) state.currentOrder.status = result.status;
      const listOrder = state.orders.find((order) => order.id === orderId);
      if (listOrder) listOrder.status = result.status;
      const archiveOrder = state.archive.find((order) => order.id === orderId);
      if (archiveOrder) archiveOrder.status = result.status;
      await loadOrders();
      await loadArchive();
      if (result.status === "consegnato" && state.currentSection !== "archive") {
        showSection("archive");
        const archivedOrder = state.archive.find((order) => order.id === orderId);
        if (archivedOrder) await loadOrder(orderId);
        else if (state.archive.length > 0) await loadOrder(state.archive[0].id);
      } else if (result.status !== "consegnato" && state.currentSection === "archive") {
        showSection("orders");
        const restoredOrder = state.orders.find((order) => order.id === orderId);
        if (restoredOrder) await loadOrder(orderId);
        else if (state.orders.length > 0) await loadOrder(state.orders[0].id);
      }
      orderFeedback.textContent = "Stato pubblico aggiornato.";
    } catch (error) {
      orderFeedback.textContent = error.message;
      orderFeedback.classList.add("admin-feedback--error");
    } finally {
      saveOrderStatusButton.disabled = false;
    }
  });

  navigationButtons.forEach((button) => {
    button.addEventListener("click", () => showSection(button.dataset.view));
  });

  deleteAllOrdersButton.addEventListener("click", async () => {
    if (!confirm("Eliminare definitivamente TUTTE le richieste? Questa azione non e reversibile.")) return;
    deleteAllOrdersButton.disabled = true;
    try {
      await api("/api/admin/orders", { method: "DELETE" });
      state.orders = [];
      state.archive = [];
      state.currentOrder = undefined;
      orderForm.hidden = true;
      orderEmpty.hidden = false;
      renderOrderList();
      renderArchiveList();
      orderFeedback.textContent = "Tutte le richieste sono state eliminate.";
      orderFeedback.classList.remove("admin-feedback--error");
    } catch (error) {
      orderFeedback.textContent = error.message;
      orderFeedback.classList.add("admin-feedback--error");
    } finally {
      deleteAllOrdersButton.disabled = false;
    }
  });

  deleteOrderButton.addEventListener("click", async () => {
    if (!confirm(`Eliminare definitivamente ${state.currentOrder.code}?`)) return;
    deleteOrderButton.disabled = true;
    try {
      await api(`/api/admin/orders/${state.currentOrder.id}`, { method: "DELETE" });
      state.currentOrder = undefined;
      if (state.currentSection === "archive") await loadArchive();
      else await loadOrders();
    } catch (error) {
      orderFeedback.textContent = error.message;
      orderFeedback.classList.add("admin-feedback--error");
    } finally {
      deleteOrderButton.disabled = false;
    }
  });

  return { loadOrders, loadArchive, loadOrder, showSection };
}
