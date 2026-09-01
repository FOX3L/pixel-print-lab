import {
  calculateCartTotal,
  getCartItemCount,
  removeCartItem,
  updateCartQuantity,
} from "./cart.js";
import { state, setCart, onCartChange, onCatalogLoaded } from "./state.js";
import { euroFormatter } from "./format.js";
import { getViewerModule } from "./viewer-loader.js";

function setText(element, field, value) {
  element.querySelector(`[data-field="${field}"]`).textContent = value;
}

export function setCartFeedback(element, prefix, suffix = ".") {
  const link = document.createElement("a");
  link.href = "#cart-dialog";
  link.className = "cart-feedback-link";
  link.textContent = "carrello";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    document.querySelector("#cart-open").click();
  });
  element.replaceChildren(prefix, link, suffix);
}

export function initCartUI() {
  const cartOpenButton = document.querySelector("#cart-open");
  const cartCount = document.querySelector("#cart-count");
  const cartDialog = document.querySelector("#cart-dialog");
  const cartItems = document.querySelector("#cart-items");
  const cartItemTemplate = document.querySelector("#cart-item-template");
  const cartEmpty = document.querySelector("#cart-empty");
  const cartSummaryCount = document.querySelector("#cart-summary-count");
  const cartTotal = document.querySelector("#cart-total");
  const checkoutOpenButton = document.querySelector("#checkout-open");
  const checkoutCount = document.querySelector("#checkout-count");
  const checkoutCustomCount = document.querySelector("#checkout-custom-count");
  const checkoutTotal = document.querySelector("#checkout-total");

  function createCartItem(item) {
    const color = state.colorsById.get(item.colorId);
    const element = cartItemTemplate.content.firstElementChild.cloneNode(true);
    const swatch = element.querySelector('[data-field="cart-swatch"]');
    const quantityInput = element.querySelector('[data-field="cart-quantity"]');
    const removeButton = element.querySelector('[data-field="cart-remove"]');
    const viewButton = element.querySelector('[data-field="cart-view"]');
    const externalLink = element.querySelector('[data-field="cart-link"]');
    let itemName;

    if (item.type === "custom") {
      itemName = item.name;
      setText(
        element,
        "cart-code",
        item.sourceType === "file" ? `${(item.modelFormat ?? "3mf").toUpperCase()} personale` : `Link / ${item.sourceName}`,
      );
      setText(element, "cart-name", item.name);
      if (item.quoteUnitPriceCents) {
        setText(element, "cart-unit-price", `Stima ${euroFormatter.format(item.quoteUnitPriceCents / 100)} / cad.`);
        setText(element, "cart-line-total", `Stima ${euroFormatter.format((item.quoteUnitPriceCents * item.quantity) / 100)}`);
      } else {
        setText(element, "cart-unit-price", "Prezzo da definire");
        setText(element, "cart-line-total", "Preventivo");
      }
      if (item.sourceType === "file") {
        viewButton.hidden = false;
        viewButton.addEventListener("click", async () => {
          try {
            const { openModelViewer } = await getViewerModule();
            await openModelViewer(item, color?.hexValue ?? "#ffffff", state.colors);
          } catch (error) {
            console.error(error);
          }
        });
      } else {
        externalLink.hidden = false;
        externalLink.href = item.externalUrl;
      }
    } else {
      const product = state.productsById.get(item.productId);
      itemName = product.name;
      setText(element, "cart-code", product.code);
      setText(element, "cart-name", product.name);
      setText(element, "cart-unit-price", `${euroFormatter.format(product.priceCents / 100)} / cad.`);
      setText(
        element,
        "cart-line-total",
        euroFormatter.format((product.priceCents * item.quantity) / 100),
      );
    }

    setText(element, "cart-color", color.name);
    swatch.style.backgroundColor = color.hexValue;
    quantityInput.value = item.quantity;
    quantityInput.setAttribute("aria-label", `Quantita per ${itemName}, colore ${color.name}`);

    quantityInput.addEventListener("change", () => {
      const quantity = Number(quantityInput.value);
      if (!quantityInput.checkValidity() || !Number.isInteger(quantity)) {
        quantityInput.value = item.quantity;
        quantityInput.reportValidity();
        return;
      }
      setCart(updateCartQuantity(state.cart, item.key, quantity));
    });

    removeButton.addEventListener("click", () => {
      const nextCart = removeCartItem(state.cart, item.key);
      const uploadStillUsed = nextCart.some(
        (cartItem) => cartItem.type === "custom" && cartItem.id === item.id,
      );
      if (item.type === "custom" && item.sourceType === "file" && !uploadStillUsed) {
        fetch(`/api/custom-models/${item.id}`, { method: "DELETE" }).catch(console.error);
      }
      setCart(nextCart);
    });

    return element;
  }

  function renderCart() {
    const count = getCartItemCount(state.cart);
    const customCount = state.cart.reduce(
      (total, item) => (item.type === "custom" ? total + item.quantity : total),
      0,
    );
    const total = calculateCartTotal(state.cart, state.productsById);
    cartCount.textContent = String(count).padStart(2, "0");
    cartOpenButton.setAttribute(
      "aria-label",
      `Apri il carrello, ${count} ${count === 1 ? "elemento" : "elementi"}`,
    );
    cartItems.replaceChildren(...state.cart.map(createCartItem));
    cartEmpty.hidden = state.cart.length > 0;
    cartSummaryCount.textContent = count;
    cartTotal.textContent = euroFormatter.format(total / 100);
    checkoutCount.textContent = count;
    checkoutCustomCount.textContent = customCount;
    checkoutTotal.textContent = euroFormatter.format(total / 100);
    checkoutOpenButton.disabled = state.cart.length === 0;
  }

  onCartChange(renderCart);
  onCatalogLoaded(() => {
    cartOpenButton.disabled = false;
  });

  cartOpenButton.addEventListener("click", () => cartDialog.showModal());

  return { renderCart };
}
