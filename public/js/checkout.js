import { state, setCart } from "./state.js";
import { api } from "./api.js";

function serializeOrderItem(item) {
  if (item.type === "catalog") {
    return {
      type: "catalog",
      productId: item.productId,
      colorId: item.colorId,
      quantity: item.quantity,
    };
  }
  if (item.sourceType === "file") {
    return {
      type: "custom",
      sourceType: "file",
      id: item.id,
      name: item.name,
      modelFormat: item.modelFormat ?? "3mf",
      colorId: item.colorId,
      quantity: item.quantity,
    };
  }
  return {
    type: "custom",
    sourceType: "link",
    externalUrl: item.externalUrl,
    colorId: item.colorId,
    quantity: item.quantity,
  };
}

export function initCheckout({ onOrderCreated, onSessionExpired } = {}) {
  const cartDialog = document.querySelector("#cart-dialog");
  const checkoutOpenButton = document.querySelector("#checkout-open");
  const checkoutDialog = document.querySelector("#checkout-dialog");
  const checkoutDialogBackdrop = document.querySelector("#checkout-dialog-backdrop");
  const checkoutFormView = document.querySelector("#checkout-form-view");
  const checkoutForm = document.querySelector("#checkout-form");
  const firstNameField = checkoutForm.elements.firstName.closest("label");
  const lastNameField = checkoutForm.elements.lastName.closest("label");
  const checkoutFeedback = document.querySelector("#checkout-feedback");
  const checkoutSubmitButton = document.querySelector("#checkout-submit");
  const orderConfirmation = document.querySelector("#order-confirmation");
  const confirmationCode = document.querySelector("#confirmation-code");
  const guestOrderDialog = document.querySelector("#guest-order-dialog");
  const guestOrderContinueButton = document.querySelector("#guest-order-continue");
  const guestOrderAccountButton = document.querySelector("#guest-order-account");

  checkoutOpenButton.addEventListener("click", () => {
    checkoutForm.reset();
    const authenticated = Boolean(state.currentAccount);
    firstNameField.hidden = authenticated;
    lastNameField.hidden = authenticated;
    if (authenticated) {
      checkoutForm.elements.firstName.value = state.currentAccount.firstName;
      checkoutForm.elements.lastName.value = state.currentAccount.lastName;
    }
    checkoutFeedback.textContent = "";
    checkoutFeedback.classList.remove("checkout-feedback--error");
    checkoutFormView.hidden = false;
    orderConfirmation.hidden = true;
    confirmationCode.textContent = "";
    cartDialog.close();
    checkoutDialogBackdrop.hidden = false;
    checkoutDialog.show();
    (authenticated ? checkoutForm.elements.comment : checkoutForm.elements.firstName).focus();
  });
  checkoutDialog.addEventListener("close", () => {
    checkoutDialogBackdrop.hidden = true;
  });
  checkoutDialogBackdrop.addEventListener("click", () => checkoutDialog.close());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !checkoutDialog.open) return;
    if (document.querySelector("dialog:modal")) return;
    checkoutDialog.close();
  });

  async function submitOrder() {
    const formData = new FormData(checkoutForm);
    checkoutSubmitButton.disabled = true;
    checkoutSubmitButton.textContent = "Invio in corso...";
    checkoutFeedback.textContent = "";
    checkoutFeedback.classList.remove("checkout-feedback--error");

    try {
      const order = await api("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: formData.get("firstName"),
          lastName: formData.get("lastName"),
          comment: formData.get("comment"),
          items: state.cart.map(serializeOrderItem),
        }),
      });
      setCart([]);
      checkoutFormView.hidden = true;
      orderConfirmation.hidden = false;
      confirmationCode.textContent = order.code;
      onOrderCreated?.(order);
    } catch (error) {
      if (error.code === "SESSION_EXPIRED") {
        onSessionExpired?.();
      }
      checkoutFeedback.textContent = error.message;
      checkoutFeedback.classList.add("checkout-feedback--error");
    } finally {
      checkoutSubmitButton.disabled = false;
      checkoutSubmitButton.textContent = "Conferma e invia";
    }
  }

  checkoutForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.currentAccount) {
      guestOrderDialog.showModal();
      guestOrderContinueButton.focus();
      return;
    }
    submitOrder();
  });

  guestOrderContinueButton.addEventListener("click", () => {
    guestOrderDialog.close();
    submitOrder();
  });

  guestOrderAccountButton.addEventListener("click", () => {
    guestOrderDialog.close();
    checkoutDialog.close();
    document.querySelector("#account-open").click();
  });
}
