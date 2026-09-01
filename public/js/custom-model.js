import { addCustomCartItem } from "./cart.js";
import { state, setCart, onCatalogLoaded } from "./state.js";
import { api } from "./api.js";
import { euroFormatter } from "./format.js";
import { createColorOption } from "./colors.js";
import { getViewerModule } from "./viewer-loader.js";
import { setCartFeedback } from "./cart-ui.js";

const MAX_MODEL_FILE_SIZE = 500 * 1024 * 1024;

export function initCustomModel() {
  const customForm = document.querySelector("#custom-model-form");
  const customSourceInputs = document.querySelectorAll('input[name="custom-source"]');
  const customFilePanel = document.querySelector("#custom-file-panel");
  const customLinkPanel = document.querySelector("#custom-link-panel");
  const customFileInput = document.querySelector("#custom-file");
  const customFileName = document.querySelector("#custom-file-name");
  const customLinkInput = document.querySelector("#custom-link");
  const customPreviewButton = document.querySelector("#custom-preview");
  const customQuoteButton = document.querySelector("#custom-quote");
  const customQuotePanel = document.querySelector("#custom-quote-panel");
  const quoteGrams = document.querySelector("#quote-grams");
  const quoteHours = document.querySelector("#quote-hours");
  const quoteUnit = document.querySelector("#quote-unit");
  const quoteTotal = document.querySelector("#quote-total");
  const quotePlatesPanel = document.querySelector("#quote-plates");
  const quotePlatesList = document.querySelector("#quote-plates-list");
  const customColorOptions = document.querySelector("#custom-color-options");
  const customQuantityInput = document.querySelector("#custom-quantity");
  const customSubmitButton = document.querySelector("#custom-submit");
  const customFeedback = document.querySelector("#custom-feedback");

  let inspectedUpload;
  let uploadGeneration = 0;
  let currentQuote;

  function getCustomSource() {
    return customForm.elements.namedItem("custom-source").value;
  }

  function discardQuote() {
    currentQuote = undefined;
    customQuotePanel.hidden = true;
  }

  function discardInspectedUpload() {
    uploadGeneration += 1;
    if (inspectedUpload) fetch(`/api/custom-models/${inspectedUpload.id}`, { method: "DELETE" }).catch(console.error);
    inspectedUpload = undefined;
    discardQuote();
  }

  function renderQuote() {
    if (!currentQuote) {
      customQuotePanel.hidden = true;
      return;
    }
    const quantity = Number(customQuantityInput.value) || 1;
    quoteGrams.textContent = `${currentQuote.grams} g / pezzo`;
    quoteHours.textContent = `~${currentQuote.hours} h / pezzo`;
    quoteUnit.textContent = `${euroFormatter.format(currentQuote.unitPriceCents / 100)} / cad.`;
    quoteTotal.textContent = euroFormatter.format((currentQuote.unitPriceCents * quantity) / 100);
    if (currentQuote.plates && currentQuote.plates.length > 1) {
      quotePlatesList.replaceChildren();
      for (const plate of currentQuote.plates) {
        const item = document.createElement("li");
        item.textContent = `Piatto ${plate.id}: ${euroFormatter.format(plate.unitPriceCents / 100)} / cad. (${plate.grams} g, ~${plate.hours} h)`;
        quotePlatesList.append(item);
      }
      quotePlatesPanel.hidden = false;
    } else {
      quotePlatesPanel.hidden = true;
    }
    customQuotePanel.hidden = false;
  }

  function updateCustomFormReadiness() {
    const source = getCustomSource();
    const hasModel = source === "file"
      ? !!customFileInput.files[0]
      : customLinkInput.value.trim().length > 0;
    customForm.classList.toggle("is-ready", hasModel);
    customSubmitButton.disabled = !hasModel || state.colors.length === 0;
  }

  function updateCustomSource() {
    const source = getCustomSource();
    const usesFile = source === "file";
    customFilePanel.hidden = !usesFile;
    customLinkPanel.hidden = usesFile;
    customFileInput.required = usesFile;
    customLinkInput.required = !usesFile;
    if (!usesFile) discardInspectedUpload();
    customFeedback.textContent = "";
    customFeedback.classList.remove("custom-feedback--error");
  }

  function validateSelectedFile() {
    const file = customFileInput.files[0];
    if (!file) {
      throw new Error("Seleziona un file 3MF.");
    }
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".gcode.3mf")) {
      throw new Error("I file .gcode.3mf non sono supportati.");
    }
    if (!lowerName.endsWith(".3mf")) {
      throw new Error("Il file deve avere estensione .3mf.");
    }
    if (file.size === 0) {
      throw new Error("Il file modello e vuoto.");
    }
    if (file.size > MAX_MODEL_FILE_SIZE) {
      throw new Error("Il file modello non puo superare 500 MB.");
    }
    return file;
  }

  function uploadMatchesFile(upload, file) {
    return upload?.sourceFileName === file.name && upload.sourceFileSize === file.size && upload.sourceFileModified === file.lastModified;
  }

  async function uploadModel(file) {
    const uploadData = new FormData();
    uploadData.append("model", file);
    const upload = await api("/api/custom-models/upload", { method: "POST", body: uploadData });
    return { ...upload, sourceFileName: file.name, sourceFileSize: file.size, sourceFileModified: file.lastModified };
  }

  async function inspectedModelFor(file) {
    if (uploadMatchesFile(inspectedUpload, file)) return inspectedUpload;
    const generation = uploadGeneration;
    const upload = await uploadModel(file);
    const currentFile = customFileInput.files[0];
    if (generation !== uploadGeneration || getCustomSource() !== "file" || !currentFile || !uploadMatchesFile(upload, currentFile)) {
      fetch(`/api/custom-models/${upload.id}`, { method: "DELETE" }).catch(console.error);
      throw new Error("Il file selezionato e cambiato durante il controllo.");
    }
    inspectedUpload = upload;
    return upload;
  }

  customSourceInputs.forEach((input) => input.addEventListener("change", () => {
    updateCustomSource();
    updateCustomFormReadiness();
  }));

  customFileInput.addEventListener("change", () => {
    discardInspectedUpload();
    const file = customFileInput.files[0];
    customFileName.textContent = file?.name ?? "Nessun file selezionato";
    customPreviewButton.disabled = !file;
    customQuoteButton.disabled = !file;
    customFeedback.textContent = "";
    updateCustomFormReadiness();
  });

  customLinkInput.addEventListener("input", () => {
    customFeedback.textContent = "";
    updateCustomFormReadiness();
  });

  customPreviewButton.addEventListener("click", async () => {
    try {
      const file = validateSelectedFile();
      const { openModelViewer } = await getViewerModule();
      const customColorId = Number(customForm.elements.namedItem("custom-color").value);
      const customColor = state.colorsById.get(customColorId);
      const colorHex = customColor?.hexValue ?? "#ffffff";
      customPreviewButton.disabled = true;
      customFeedback.textContent = "Controllo del progetto 3MF...";
      inspectedUpload = await inspectedModelFor(file);
      await openModelViewer(inspectedUpload, colorHex, state.colors);
      customFeedback.textContent = "";
    } catch (error) {
      customFeedback.textContent = error.message;
      customFeedback.classList.add("custom-feedback--error");
    } finally {
      customPreviewButton.disabled = !customFileInput.files[0];
    }
  });

  customQuoteButton.addEventListener("click", async () => {
    try {
      const file = validateSelectedFile();
      customQuoteButton.disabled = true;
      customQuoteButton.textContent = "Calcolo...";
      customFeedback.textContent = "";
      customFeedback.classList.remove("custom-feedback--error");
      const upload = await inspectedModelFor(file);
      const quote = await api(`/api/custom-models/${upload.id}/quote`);
      currentQuote = { uploadId: upload.id, ...quote };
      renderQuote();
    } catch (error) {
      discardQuote();
      customFeedback.textContent = error.message;
      customFeedback.classList.add("custom-feedback--error");
    } finally {
      customQuoteButton.disabled = !customFileInput.files[0];
      customQuoteButton.textContent = "Calcola stima costo";
    }
  });

  customQuantityInput.addEventListener("input", () => renderQuote());

  customForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sourceType = getCustomSource();
    const colorId = Number(customForm.elements.namedItem("custom-color").value);
    const quantity = Number(customQuantityInput.value);
    let uploadedId;

    customSubmitButton.disabled = true;
    customSubmitButton.textContent = sourceType === "file" ? "Controllo modello..." : "Controllo link...";
    customFeedback.textContent = "";
    customFeedback.classList.remove("custom-feedback--error");

    try {
      let customModel;
      if (sourceType === "file") {
        const file = validateSelectedFile();
        customModel = await inspectedModelFor(file);
        uploadedId = customModel.id;
      } else {
        customModel = await api("/api/custom-models/link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: customLinkInput.value }),
        });
      }

      const { sourceFileName: _sourceFileName, sourceFileSize: _sourceFileSize, sourceFileModified: _sourceFileModified, ...modelData } = customModel;
      const quoteData = currentQuote?.uploadId === customModel.id
        ? {
            quoteUnitPriceCents: currentQuote.unitPriceCents,
            quoteGrams: currentQuote.grams,
            quoteHours: currentQuote.hours,
          }
        : {};
      setCart(addCustomCartItem(state.cart, {
        ...modelData,
        ...quoteData,
        sourceType,
        colorId,
        quantity,
      }));
      customForm.reset();
      customFileName.textContent = "Nessun file selezionato";
      customPreviewButton.disabled = true;
      customQuoteButton.disabled = true;
      updateCustomSource();
      setCartFeedback(
        customFeedback,
        "Richiesta aggiunta al ",
        quoteData.quoteUnitPriceCents
          ? `. Stima ${euroFormatter.format(quoteData.quoteUnitPriceCents / 100)} al pezzo.`
          : ". Prezzo da definire.",
      );
      inspectedUpload = undefined;
      discardQuote();
      uploadedId = undefined;
    } catch (error) {
      if (uploadedId) {
        fetch(`/api/custom-models/${uploadedId}`, { method: "DELETE" }).catch(console.error);
        if (inspectedUpload?.id === uploadedId) inspectedUpload = undefined;
      }
      customFeedback.textContent = error.message;
      customFeedback.classList.add("custom-feedback--error");
    } finally {
      customSubmitButton.disabled = state.colors.length === 0;
      customSubmitButton.textContent = "Aggiungi al carrello";
    }
  });

  onCatalogLoaded(() => {
    state.colors.forEach((color, index) => {
      customColorOptions.append(createColorOption(color, "custom-color", index === 0));
    });
    customSubmitButton.disabled = false;
  });

  updateCustomSource();
  updateCustomFormReadiness();
}
