import { state } from "./state.js";
import { api } from "./api.js";
import {
  dateFormatter,
  euroFormatter,
  priceStatusLabel,
  publicStatusLabels,
} from "./format.js";

export function initAccount() {
  const accountOpenButton = document.querySelector("#account-open");
  const accountDialog = document.querySelector("#account-dialog");
  const accountDialogBackdrop = document.querySelector("#account-dialog-backdrop");
  const accountGuestView = document.querySelector("#account-guest-view");
  const accountUserView = document.querySelector("#account-user-view");
  const accountLoginForm = document.querySelector("#account-login-form");
  const accountRegisterForm = document.querySelector("#account-register-form");
  const accountAccessGrid = document.querySelector("#account-access-grid");
  const accountPasswordForgot = document.querySelector("#account-password-forgot");
  const accountPasswordResetForm = document.querySelector("#account-password-reset-form");
  const accountPasswordCodeRequest = document.querySelector("#account-password-code-request");
  const accountPasswordResetCancel = document.querySelector("#account-password-reset-cancel");
  const accountPasswordResetFeedback = document.querySelector("#account-password-reset-feedback");
  const resetEmailInput = document.querySelector("#reset-email");
  const accountGuestFeedback = document.querySelector("#account-guest-feedback");
  const accountDisplayName = document.querySelector("#account-display-name");
  const accountUsername = document.querySelector("#account-username");
  const accountEmail = document.querySelector("#account-email");
  const accountNotificationToggle = document.querySelector("#account-notification-toggle");
  const accountEmailNotifications = document.querySelector("#account-email-notifications");
  const accountPreferencesFeedback = document.querySelector("#account-preferences-feedback");
  const accountEmailVerification = document.querySelector("#account-email-verification");
  const accountEmailVerificationForm = document.querySelector("#account-email-verification-form");
  const accountEmailResend = document.querySelector("#account-email-resend");
  const accountEmailFeedback = document.querySelector("#account-email-feedback");
  const accountAdminLink = document.querySelector("#account-admin-link");
  const accountDeleteOpen = document.querySelector("#account-delete-open");
  const accountDeleteSection = document.querySelector("#account-delete");
  const accountDeleteForm = document.querySelector("#account-delete-form");
  const accountDeleteCancel = document.querySelector("#account-delete-cancel");
  const accountDeleteFeedback = document.querySelector("#account-delete-feedback");
  const accountLogoutButton = document.querySelector("#account-logout");
  const accountOrdersRefresh = document.querySelector("#account-orders-refresh");
  const accountOrdersStatus = document.querySelector("#account-orders-status");
  const accountOrderList = document.querySelector("#account-order-list");
  const accountOrderTemplate = document.querySelector("#account-order-template");
  const checkoutCustomerNote = document.querySelector("#checkout-customer-note");

  let accountStateVersion = 0;
  let accountAuthPending = false;
  function renderAccount() {
    const authenticated = Boolean(state.currentAccount);
    accountGuestView.hidden = authenticated;
    accountUserView.hidden = !authenticated;
    accountOpenButton.textContent = authenticated ? state.currentAccount.firstName : "Accedi";
    checkoutCustomerNote.textContent = authenticated
      ? "La richiesta verra salvata nel tuo storico personale."
      : "Puoi inviare la richiesta come ospite. Accordi e consegna avverranno privatamente.";
    if (!authenticated) {
      accountOrderList.replaceChildren();
      return;
    }
    accountDisplayName.textContent = `${state.currentAccount.firstName} ${state.currentAccount.lastName}`;
    accountUsername.textContent = state.currentAccount.email;
    accountEmail.hidden = !state.currentAccount.email;
    accountEmail.textContent = state.currentAccount.role === "admin"
      ? "Email amministrativa verificata"
      : state.currentAccount.email
        ? `${!state.currentAccount.emailVerified
          ? "Email da verificare"
          : state.currentAccount.emailNotificationsEnabled
            ? "Notifiche attive"
            : "Notifiche disattivate"}`
        : "";
    accountNotificationToggle.hidden = !state.currentAccount.email || state.currentAccount.role === "admin";
    accountEmailNotifications.checked = state.currentAccount.emailNotificationsEnabled;
    accountEmailVerification.hidden = !state.currentAccount.email || state.currentAccount.emailVerified;
    accountAdminLink.hidden = state.currentAccount.role !== "admin";
    accountDeleteOpen.hidden = state.currentAccount.role === "admin";
  }

  function renderAccountOrders(orders) {
    const elements = orders.map((order) => {
      const element = accountOrderTemplate.content.firstElementChild.cloneNode(true);
      const date = new Date(`${order.createdAt.replace(" ", "T")}Z`);
      element.querySelector('[data-field="account-order-date"]').textContent = Number.isNaN(date.valueOf())
        ? order.createdAt
        : dateFormatter.format(date);
      element.querySelector('[data-field="account-order-code"]').textContent = order.code;
      element.querySelector('[data-field="account-order-status"]').textContent = publicStatusLabels[order.status] ?? order.status;
      element.querySelector('[data-field="account-order-total-label"]').textContent = priceStatusLabel(order.priceStatus);
      element.querySelector('[data-field="account-order-total"]').textContent = euroFormatter.format((order.totalPriceCents ?? order.catalogTotalCents) / 100);
      const comment = element.querySelector('[data-field="account-order-comment"]');
      comment.hidden = !order.comment;
      comment.textContent = order.comment ? `Commento: ${order.comment}` : "";
      const deleteButton = element.querySelector('[data-field="account-order-delete"]');
      deleteButton.addEventListener("click", () => deleteAccountOrder(order.code));
      const itemList = element.querySelector('[data-field="account-order-items"]');
      order.items.forEach((item) => {
        const listItem = document.createElement("li");
        const name = document.createElement("span");
        const detail = document.createElement("span");
        const unitPrice = item.unitPriceCents === null
          ? "prezzo da definire"
          : `${priceStatusLabel(item.priceStatus).toLowerCase()} ${euroFormatter.format(item.unitPriceCents / 100)} / cad.`;
        const lineTotal = item.lineTotalCents === null
          ? ""
          : ` - totale ${euroFormatter.format(item.lineTotalCents / 100)}`;
        name.textContent = item.productName;
        detail.textContent = `${item.colorName} / ${item.quantity} pz. / ${unitPrice}${lineTotal}`;
        listItem.append(name, detail);
        itemList.append(listItem);
      });
      return element;
    });
    accountOrderList.replaceChildren(...elements);
    accountOrdersStatus.textContent = orders.length ? "" : "Non hai ancora inviato ordini con questo account.";
  }

  async function deleteAccountOrder(code) {
    if (!confirm(`Eliminare definitivamente l'ordine ${code}?`)) return;
    try {
      await api(`/api/account/orders/${encodeURIComponent(code)}`, { method: "DELETE" });
      accountOrdersStatus.textContent = "Ordine eliminato.";
      accountOrdersStatus.classList.remove("account-feedback--error");
      await loadAccountOrders();
    } catch (error) {
      accountOrdersStatus.textContent = error.message;
      accountOrdersStatus.classList.add("account-feedback--error");
    }
  }

  async function loadAccountOrders() {
    if (!state.currentAccount) return;
    const version = accountStateVersion;
    const accountId = state.currentAccount.id;
    accountOrdersRefresh.disabled = true;
    accountOrdersStatus.textContent = "Caricamento storico...";
    try {
      const orders = await api("/api/account/orders", { cache: "no-store" });
      if (version !== accountStateVersion || state.currentAccount?.id !== accountId) return;
      renderAccountOrders(orders);
    } catch (error) {
      if (version !== accountStateVersion || state.currentAccount?.id !== accountId) return;
      if (error.status === 401) {
        clearSession();
      }
      accountOrdersStatus.textContent = error.message;
    } finally {
      if (version === accountStateVersion) accountOrdersRefresh.disabled = false;
    }
  }

  async function loadAccountSession() {
    const version = accountStateVersion;
    let account;
    try {
      account = await api("/api/account/session", { cache: "no-store" });
    } catch (error) {
      if (version !== accountStateVersion) return;
      if (error.status !== 401) console.error(error);
      account = undefined;
    }
    if (version !== accountStateVersion) return;
    state.currentAccount = account;
    renderAccount();
  }

  async function submitAccountForm(form, endpoint) {
    if (accountAuthPending) return;
    accountAuthPending = true;
    const buttons = [
      accountLoginForm.querySelector('[type="submit"]'),
      accountRegisterForm.querySelector('[type="submit"]'),
    ];
    const formData = new FormData(form);
    buttons.forEach((button) => { button.disabled = true; });
    accountGuestFeedback.textContent = "";
    accountGuestFeedback.classList.remove("account-feedback--error");
    const version = ++accountStateVersion;
    try {
      const account = await api(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      if (version !== accountStateVersion) return;
      state.currentAccount = account;
      form.reset();
      renderAccount();
      accountDisplayName.focus();
      await loadAccountOrders();
    } catch (error) {
      if (version !== accountStateVersion) return;
      accountGuestFeedback.textContent = error.message;
      accountGuestFeedback.classList.add("account-feedback--error");
    } finally {
      accountAuthPending = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function clearSession() {
    state.currentAccount = undefined;
    accountStateVersion += 1;
    renderAccount();
  }

  accountOpenButton.addEventListener("click", () => {
    accountGuestFeedback.textContent = "";
    accountDialogBackdrop.hidden = false;
    accountDialog.show();
    if (!accountGuestView.hidden) document.querySelector("#login-email").focus();
    if (state.currentAccount) loadAccountOrders();
  });
  accountDialog.addEventListener("close", () => {
    accountDialogBackdrop.hidden = true;
  });
  accountDialogBackdrop.addEventListener("click", () => accountDialog.close());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !accountDialog.open) return;
    if (document.querySelector("dialog:modal")) return;
    accountDialog.close();
  });
  accountLoginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAccountForm(accountLoginForm, "/api/account/login");
  });
  accountRegisterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAccountForm(accountRegisterForm, "/api/account/register");
  });
  accountPasswordForgot.addEventListener("click", () => {
    resetEmailInput.value = document.querySelector("#login-email").value;
    accountAccessGrid.hidden = true;
    accountPasswordResetForm.hidden = false;
    accountGuestFeedback.textContent = "";
    resetEmailInput.focus();
  });
  accountPasswordResetCancel.addEventListener("click", () => {
    accountPasswordResetForm.hidden = true;
    accountAccessGrid.hidden = false;
    accountPasswordResetFeedback.textContent = "";
    document.querySelector("#login-email").focus();
  });
  accountPasswordCodeRequest.addEventListener("click", async () => {
    if (!resetEmailInput.reportValidity()) return;
    accountPasswordCodeRequest.disabled = true;
    accountPasswordResetFeedback.textContent = "Invio in corso...";
    accountPasswordResetFeedback.classList.remove("account-feedback--error");
    try {
      await api("/api/account/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: resetEmailInput.value }),
      });
      accountPasswordResetFeedback.textContent = "Se l'email e registrata, riceverai un codice entro pochi minuti.";
      document.querySelector("#reset-code").focus();
    } catch (error) {
      accountPasswordResetFeedback.textContent = error.message;
      accountPasswordResetFeedback.classList.add("account-feedback--error");
    } finally {
      accountPasswordCodeRequest.disabled = false;
    }
  });
  accountPasswordResetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = accountPasswordResetForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    accountPasswordResetFeedback.textContent = "Aggiornamento password...";
    accountPasswordResetFeedback.classList.remove("account-feedback--error");
    try {
      const values = Object.fromEntries(new FormData(accountPasswordResetForm));
      await api("/api/account/password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      accountPasswordResetForm.reset();
      accountPasswordResetForm.hidden = true;
      accountAccessGrid.hidden = false;
      document.querySelector("#login-email").value = values.email;
      accountGuestFeedback.textContent = "Password aggiornata. Ora puoi accedere.";
      accountGuestFeedback.classList.remove("account-feedback--error");
      document.querySelector("#login-password").focus();
    } catch (error) {
      accountPasswordResetFeedback.textContent = error.message;
      accountPasswordResetFeedback.classList.add("account-feedback--error");
    } finally {
      submitButton.disabled = false;
    }
  });
  accountEmailVerificationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = accountEmailVerificationForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    accountEmailFeedback.textContent = "Verifica in corso...";
    accountEmailFeedback.classList.remove("account-feedback--error");
    try {
      state.currentAccount = await api("/api/account/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(accountEmailVerificationForm))),
      });
      accountEmailVerificationForm.reset();
      renderAccount();
    } catch (error) {
      accountEmailFeedback.textContent = error.message;
      accountEmailFeedback.classList.add("account-feedback--error");
    } finally {
      submitButton.disabled = false;
    }
  });
  accountEmailResend.addEventListener("click", async () => {
    accountEmailResend.disabled = true;
    accountEmailFeedback.textContent = "Invio in corso...";
    accountEmailFeedback.classList.remove("account-feedback--error");
    try {
      await api("/api/account/email/resend", { method: "POST" });
      accountEmailFeedback.textContent = "Nuovo codice inviato. Controlla anche la cartella spam.";
    } catch (error) {
      accountEmailFeedback.textContent = error.message;
      accountEmailFeedback.classList.add("account-feedback--error");
    } finally {
      accountEmailResend.disabled = false;
    }
  });
  accountEmailNotifications.addEventListener("change", async () => {
    accountEmailNotifications.disabled = true;
    accountPreferencesFeedback.textContent = "Salvataggio...";
    accountPreferencesFeedback.classList.remove("account-feedback--error");
    try {
      state.currentAccount = await api("/api/account/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailNotificationsEnabled: accountEmailNotifications.checked }),
      });
      renderAccount();
      accountPreferencesFeedback.textContent = "Preferenza salvata.";
    } catch (error) {
      accountEmailNotifications.checked = state.currentAccount.emailNotificationsEnabled;
      accountPreferencesFeedback.textContent = error.message;
      accountPreferencesFeedback.classList.add("account-feedback--error");
    } finally {
      accountEmailNotifications.disabled = false;
    }
  });
  accountDeleteOpen.addEventListener("click", () => {
    accountDeleteForm.reset();
    accountDeleteFeedback.textContent = "";
    accountDeleteSection.hidden = false;
    document.querySelector("#account-delete-password").focus();
  });
  accountDeleteCancel.addEventListener("click", () => {
    accountDeleteForm.reset();
    accountDeleteFeedback.textContent = "";
    accountDeleteSection.hidden = true;
  });
  accountDeleteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!confirm("Eliminare definitivamente il profilo? L'operazione non puo essere annullata.")) return;
    const submitButton = accountDeleteForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    accountDeleteFeedback.textContent = "Eliminazione in corso...";
    accountDeleteFeedback.classList.remove("account-feedback--error");
    try {
      await api("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(accountDeleteForm))),
      });
      state.currentAccount = undefined;
      accountStateVersion += 1;
      accountDeleteForm.reset();
      accountDeleteSection.hidden = true;
      renderAccount();
      accountGuestFeedback.textContent = "Profilo eliminato. Gli ordini precedenti restano conservati come ordini ospite.";
      accountGuestFeedback.classList.remove("account-feedback--error");
      document.querySelector("#login-email").focus();
    } catch (error) {
      accountDeleteFeedback.textContent = error.message;
      accountDeleteFeedback.classList.add("account-feedback--error");
    } finally {
      submitButton.disabled = false;
    }
  });
  accountLogoutButton.addEventListener("click", async () => {
    accountLogoutButton.disabled = true;
    const version = ++accountStateVersion;
    try {
      const response = await fetch("/api/account/logout", { method: "POST" });
      if (!response.ok) throw new Error("Disconnessione non riuscita.");
      if (version !== accountStateVersion) return;
      state.currentAccount = undefined;
      renderAccount();
      document.querySelector("#login-email").focus();
    } catch (error) {
      if (version === accountStateVersion) accountOrdersStatus.textContent = error.message;
    } finally {
      if (version === accountStateVersion) accountLogoutButton.disabled = false;
    }
  });

  accountOrdersRefresh.addEventListener("click", loadAccountOrders);

  return { loadAccountSession, loadAccountOrders, clearSession };
}
