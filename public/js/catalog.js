import { addCartItem, reconcileCart } from "./cart.js";
import { state, setCart, notifyCatalogLoaded } from "./state.js";
import { euroFormatter } from "./format.js";
import { createColorOption } from "./colors.js";
import { getViewerModule } from "./viewer-loader.js";
import { setCartFeedback } from "./cart-ui.js";

const MAX_DESCRIPTION_LENGTH = 120;

function setText(element, field, value) {
  element.querySelector(`[data-field="${field}"]`).textContent = value;
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text ?? "";
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

async function reconcileUploadedFiles(items) {
  const checks = await Promise.all(
    items.map(async (item) => {
      if (item.type !== "custom" || item.sourceType !== "file") {
        return true;
      }
      try {
        const response = await fetch(item.modelUrl, { method: "HEAD" });
        return response.status !== 404;
      } catch {
        return true;
      }
    }),
  );
  return items.filter((_item, index) => checks[index]);
}

export function initCatalog() {
  const productList = document.querySelector("#product-list");
  const productTemplate = document.querySelector("#product-template");
  const catalogStatus = document.querySelector("#catalog-status");
  const catalogScrollIndicator = document.querySelector("#catalog-scroll-indicator");
  const catalogPrevButton = document.querySelector("#catalog-prev");
  const catalogNextButton = document.querySelector("#catalog-next");

  function createProductCard(product, index) {
    const card = productTemplate.content.firstElementChild.cloneNode(true);
    const image = card.querySelector('[data-field="image"]');
    const form = card.querySelector('[data-field="config-form"]');
    const colorOptions = card.querySelector('[data-field="color-options"]');
    const quantityInput = card.querySelector('[data-field="quantity"]');
    const feedback = card.querySelector('[data-field="feedback"]');
    const viewModelButton = card.querySelector('[data-field="view-model"]');

    card.dataset.product = product.slug;
    if (index % 2 === 1) {
      card.classList.add("product-card--blue");
    }

    setText(card, "code", product.code);
    setText(card, "name", product.name);
    setText(card, "description", truncateText(product.description, MAX_DESCRIPTION_LENGTH));
    setText(card, "material", product.material);

    image.src = product.imageUrl;
    image.alt = product.name;
    card.querySelectorAll('[data-field="price"]').forEach((priceEl) => {
      priceEl.value = (product.priceCents / 100).toFixed(2);
      priceEl.textContent = euroFormatter.format(product.priceCents / 100);
    });
    state.colors.forEach((color, colorIndex) => {
      colorOptions.append(createColorOption(color, `product-${product.id}-color`, colorIndex === 0));
    });

    if (!product.modelUrl) {
      viewModelButton.hidden = true;
    } else {
      viewModelButton.addEventListener("click", async () => {
        viewModelButton.disabled = true;
        viewModelButton.textContent = "...";
        try {
          const { openModelViewer } = await getViewerModule();
          const selectedColorId = Number(new FormData(form).get(`product-${product.id}-color`));
          const selectedColor = state.colorsById.get(selectedColorId);
          await openModelViewer(product, selectedColor?.hexValue ?? "#ffffff", state.colors);
        } catch (error) {
          console.error(error);
          feedback.textContent = "Impossibile aprire il modello 3D.";
        } finally {
          viewModelButton.disabled = false;
          viewModelButton.textContent = "3D";
        }
      });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const colorId = Number(formData.get(`product-${product.id}-color`));
      const quantity = Number(quantityInput.value);
      const existingItem = state.cart.find(
        (item) => item.productId === product.id && item.colorId === colorId,
      );

      setCart(addCartItem(state.cart, { productId: product.id, colorId, quantity }));
      setCartFeedback(
        feedback,
        existingItem ? "Quantita aggiornata nel " : "Aggiunto al ",
      );
    });

    const detailsToggle = card.querySelector('[data-field="details-toggle"]');
    if (detailsToggle) {
      detailsToggle.addEventListener("click", () => {
        const expanded = card.classList.toggle("is-expanded");
        detailsToggle.setAttribute("aria-expanded", String(expanded));
        detailsToggle.querySelector("span").textContent = expanded ? "-" : "+";
        detailsToggle.childNodes[0].textContent = expanded ? "Chiudi " : "Dettagli ";
      });
    }

    return card;
  }

  function updateCatalogIndicator() {
    if (!catalogScrollIndicator || !productList) return;
    const cards = productList.querySelectorAll(".product-card");
    const maxScroll = productList.scrollWidth - productList.clientWidth;
    const singlePage = cards.length <= 1 || maxScroll <= 2;
    catalogScrollIndicator.hidden = singlePage;
    if (catalogPrevButton) catalogPrevButton.disabled = singlePage || productList.scrollLeft <= 2;
    if (catalogNextButton) catalogNextButton.disabled = singlePage || productList.scrollLeft >= maxScroll - 2;
    if (singlePage) {
      cards.forEach((card) => card.classList.add("is-active"));
      return;
    }

    const style = getComputedStyle(productList);
    const gap = parseFloat(style.gap) || 0;
    const cardStep = cards[0].offsetWidth + gap;
    const pageCount = cards.length;
    const activeStart = Math.min(
      pageCount - 1,
      Math.max(0, Math.round(productList.scrollLeft / cardStep)),
    );

    cards.forEach((card, index) => card.classList.toggle("is-active", index === activeStart || index === activeStart + 1));

    const dots = catalogScrollIndicator.querySelectorAll("span");
    if (dots.length !== pageCount) {
      catalogScrollIndicator.innerHTML = "";
      for (let i = 0; i < pageCount; i += 1) {
        const dot = document.createElement("span");
        dot.setAttribute("aria-hidden", "true");
        catalogScrollIndicator.appendChild(dot);
      }
    }
    catalogScrollIndicator.querySelectorAll("span").forEach((dot, index) => {
      dot.classList.toggle("active", index === activeStart);
    });
  }

  function scrollCatalogByPage(direction) {
    if (!productList) return;
    const cards = productList.querySelectorAll(".product-card");
    if (!cards.length) return;
    const style = getComputedStyle(productList);
    const gap = parseFloat(style.gap) || 0;
    const cardStep = cards[0].offsetWidth + gap;
    productList.scrollBy({ left: direction * cardStep, behavior: "smooth" });
  }

  async function loadCatalog() {
    try {
      const [productsResponse, colorsResponse] = await Promise.all([
        fetch("/api/products"),
        fetch("/api/colors"),
      ]);
      if (!productsResponse.ok || !colorsResponse.ok) {
        throw new Error(
          `Richiesta catalogo fallita: prodotti ${productsResponse.status}, colori ${colorsResponse.status}`,
        );
      }

      ({ data: state.products } = await productsResponse.json());
      ({ data: state.colors } = await colorsResponse.json());
      state.productsById = new Map(state.products.map((product) => [product.id, product]));
      state.colorsById = new Map(state.colors.map((color) => [color.id, color]));
      setCart(await reconcileUploadedFiles(reconcileCart(state.cart, state.products, state.colors)));

      if (state.colors.length === 0) {
        throw new Error("Nessun colore disponibile.");
      }

      notifyCatalogLoaded();

      if (state.products.length === 0) {
        catalogStatus.textContent = "Nessun modello disponibile al momento.";
        return;
      }

      const cards = document.createDocumentFragment();
      state.products.forEach((product, index) => cards.append(createProductCard(product, index)));
      productList.append(cards);
      catalogStatus.hidden = true;
      updateCatalogIndicator();
    } catch (error) {
      console.error(error);
      catalogStatus.textContent = "Catalogo non disponibile. Riprova tra poco.";
      catalogStatus.classList.add("catalog-status--error");
    } finally {
      productList.setAttribute("aria-busy", "false");
    }
  }

  if (productList && catalogScrollIndicator) {
    productList.addEventListener("scroll", updateCatalogIndicator, { passive: true });
    window.addEventListener("resize", () => {
      window.requestAnimationFrame(updateCatalogIndicator);
    });
  }

  if (catalogPrevButton) {
    catalogPrevButton.addEventListener("click", () => scrollCatalogByPage(-1));
  }
  if (catalogNextButton) {
    catalogNextButton.addEventListener("click", () => scrollCatalogByPage(1));
  }

  return { loadCatalog };
}
