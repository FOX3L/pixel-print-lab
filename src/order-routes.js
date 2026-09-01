import { constants as fileConstants, mkdirSync } from "node:fs";
import { copyFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultUploadDirectory,
  UPLOAD_TTL_MS,
  validateExternalModelUrl,
} from "./custom-model-routes.js";
import {
  inspectModelFile,
  measureModelFile,
  MODEL_FORMATS,
  ModelFileError,
  modelExtension,
  sanitizeOriginalModelName,
} from "./model-files.js";
import { calculateProjectQuote, readPricingSettings } from "./pricing.js";

import { RateLimiter, rateLimitMiddleware } from "./rate-limiter.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultOrderFileDirectory = path.join(currentDirectory, "..", "storage", "orders");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ORDER_ITEMS = 100;
const MAX_OPEN_ORDERS = 15;
const MAX_ORDER_COMMENT_LENGTH = 500;
export const ORDER_STATUSES = new Set(["in_attesa", "in_lavorazione", "completato", "consegnato"]);

class OrderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sendError(response, error) {
  if (error instanceof OrderError || error instanceof ModelFileError) {
    return response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
  }
  console.error(error);
  return response.status(500).json({
    error: { code: "ORDER_FAILED", message: "Impossibile salvare la richiesta." },
  });
}

export function validatePersonName(value, fieldName) {
  if (typeof value !== "string") {
    throw new OrderError("INVALID_CUSTOMER", `${fieldName} e obbligatorio.`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length < 1 ||
    normalized.length > 60 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new OrderError("INVALID_CUSTOMER", `${fieldName} deve contenere da 1 a 60 caratteri.`);
  }
  return normalized;
}

export function validateQuantity(value) {
  if (!Number.isInteger(value) || value < 1 || value > 99) {
    throw new OrderError("INVALID_QUANTITY", "La quantita deve essere compresa tra 1 e 99.");
  }
  return value;
}

export function validateOrderComment(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new OrderError("INVALID_ORDER_COMMENT", "Il commento non e valido.");
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  if (
    normalized.length > MAX_ORDER_COMMENT_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new OrderError(
      "INVALID_ORDER_COMMENT",
      `Il commento puo contenere al massimo ${MAX_ORDER_COMMENT_LENGTH} caratteri.`,
    );
  }
  return normalized;
}

function createOrderCode(database, firstName, lastName) {
  const initialFirst = (firstName?.trim()?.[0] ?? "X").toUpperCase();
  const initialLast = (lastName?.trim()?.[0] ?? "X").toUpperCase();
  const initials = `${initialFirst}${initialLast}`;
  const findOrderByCode = database.prepare("SELECT code FROM orders WHERE code = ?");
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const code = `${initials}-${suffix}`;
    if (!findOrderByCode.get(code)) return code;
  }
  throw new OrderError("CODE_COLLISION", "Impossibile generare un codice ordine univoco.");
}

function formatEuro(cents) {
  return `${(cents / 100).toFixed(2).replace(".", ",")} EUR`;
}

export function buildEmail({ code, firstName, lastName, comment, items, catalogTotalCents }) {
  const lines = [
    `Codice: ${code}`,
    `Nome: ${firstName}`,
    `Cognome: ${lastName}`,
  ];
  if (comment) lines.push(`Commento: ${comment}`);
  lines.push("", "Dettagli:");

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.productName}`);
    lines.push(`   Tipo: ${item.itemType}`);
    lines.push(`   Colore: ${item.colorName} (${item.colorHex})`);
    lines.push(`   Quantita: ${item.quantity}`);
    if (item.unitPriceCents !== null) {
      lines.push(`   Prezzo unitario: ${formatEuro(item.unitPriceCents)}`);
      lines.push(`   Totale riga: ${formatEuro(item.unitPriceCents * item.quantity)}`);
    } else {
      lines.push("   Prezzo: da definire");
    }
    if (item.originalName) lines.push(`   File: ${item.originalName}`);
    if (item.modelFormat) lines.push(`   Formato: ${item.modelFormat.toUpperCase()}`);
    if (item.modelMetadata?.printerProfile?.target) lines.push(`   Profilo: ${item.modelMetadata.printerProfile.target}`);
    if (item.modelMetadata?.compatibility?.status) lines.push(`   Verifica piatto standard: ${item.modelMetadata.compatibility.status}`);
    if (item.externalUrl) lines.push(`   Link: ${item.externalUrl}`);
  });

  lines.push("", `Totale catalogo: ${formatEuro(catalogTotalCents)}`, "");
  return `${lines.join("\n")}\n`;
}

export function registerOrderRoutes(
  app,
  {
    database,
    uploadDirectory = defaultUploadDirectory,
    orderFileDirectory = defaultOrderFileDirectory,
    emailService,
    optionalAccount = (_request, _response, next) => next(),
    orderRateLimit = { windowMs: 60 * 60 * 1000, max: 20 },
  } = {},
) {
  mkdirSync(orderFileDirectory, { recursive: true });

  const orderRateLimiter = new RateLimiter(orderRateLimit);
  const orderRateLimitMiddleware = rateLimitMiddleware(orderRateLimiter, {
    message: "Ti stai divertendo a caricare tutti questi ordini vero ? facciamo che ti fermi per po' ;)",
  });

  const findProduct = database.prepare(`
    SELECT id, code, name, price_cents
    FROM products
    WHERE id = ? AND visible = 1
  `);
  const findColor = database.prepare(`
    SELECT id, name, hex_value
    FROM colors
    WHERE id = ? AND active = 1
  `);
  const listPublicOrders = database.prepare(`
    SELECT code, status
    FROM orders
    WHERE status != 'consegnato'
    ORDER BY created_at ASC, id ASC
  `);
  const getSettings = database.prepare(`
    SELECT email_notifications_enabled FROM app_settings WHERE id = 1
  `);
  const countOpenOrders = database.prepare(`
    SELECT COUNT(*) AS count FROM orders WHERE status NOT IN ('completato', 'consegnato')
  `);
  const insertOrder = database.prepare(`
    INSERT INTO orders (code, first_name, last_name, comment, catalog_total_cents, user_account_id)
    VALUES (@code, @firstName, @lastName, @comment, @catalogTotalCents, @userAccountId)
  `);
  const insertItem = database.prepare(`
    INSERT INTO order_items (
      order_id, position, item_type, product_id, product_code, product_name,
      unit_price_cents, color_id, color_name, color_hex, quantity,
      original_name, source_name, external_url, model_filename,
      model_format, model_metadata_json, quote_json
    ) VALUES (
      @orderId, @position, @itemType, @productId, @productCode, @productName,
      @unitPriceCents, @colorId, @colorName, @colorHex, @quantity,
      @originalName, @sourceName, @externalUrl, @modelFilename,
      @modelFormat, @modelMetadataJson, @quoteJson
    )
  `);
  const saveOrder = database.transaction((order) => {
    const result = insertOrder.run(order);
    order.items.forEach((item, index) => {
      insertItem.run({ ...item, orderId: result.lastInsertRowid, position: index + 1 });
    });
  });

  app.get("/api/orders", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ data: listPublicOrders.all() });
  });

  app.post("/api/orders", optionalAccount, orderRateLimitMiddleware, async (request, response) => {
    const copiedFiles = [];
    try {
      const firstName = validatePersonName(request.body?.firstName, "Il nome");
      const lastName = validatePersonName(request.body?.lastName, "Il cognome");
      const comment = validateOrderComment(request.body?.comment);
      if (
        !Array.isArray(request.body?.items) ||
        request.body.items.length < 1 ||
        request.body.items.length > MAX_ORDER_ITEMS
      ) {
        throw new OrderError(
          "INVALID_ORDER_ITEMS",
          `La richiesta deve contenere da 1 a ${MAX_ORDER_ITEMS} elementi.`,
        );
      }

      const seenItems = new Set();
      const colorCache = new Map();
      const validatedItems = [];
      for (const item of request.body.items) {
        const quantity = validateQuantity(item?.quantity);
        if (!Number.isInteger(item?.colorId)) {
          throw new OrderError("COLOR_UNAVAILABLE", "Il colore selezionato non e valido.");
        }
        let color = colorCache.get(item.colorId);
        if (!color) {
          color = findColor.get(item.colorId);
          if (!color) {
            throw new OrderError("COLOR_UNAVAILABLE", "Il colore selezionato non e disponibile.");
          }
          colorCache.set(item.colorId, color);
        }

        if (item.type === "catalog") {
          if (!Number.isInteger(item.productId)) {
            throw new OrderError("PRODUCT_UNAVAILABLE", "Il prodotto selezionato non e valido.");
          }
          const uniqueKey = `catalog:${item.productId}:${item.colorId}`;
          if (seenItems.has(uniqueKey)) {
            throw new OrderError("DUPLICATE_ITEM", "La richiesta contiene elementi duplicati.");
          }
          seenItems.add(uniqueKey);
          const product = findProduct.get(item.productId);
          if (!product) {
            throw new OrderError("PRODUCT_UNAVAILABLE", "Un prodotto non e piu disponibile.");
          }
          validatedItems.push({
            itemType: "catalog",
            productId: product.id,
            productCode: product.code,
            productName: product.name,
            unitPriceCents: product.price_cents,
            colorId: color.id,
            colorName: color.name,
            colorHex: color.hex_value,
            quantity,
            originalName: null,
            sourceName: null,
            externalUrl: null,
            modelFilename: null,
            modelFormat: null,
            modelMetadataJson: null,
            quoteJson: null,
          });
          continue;
        }

        if (item.type !== "custom") {
          throw new OrderError("INVALID_ITEM_TYPE", "Il tipo di elemento non e valido.");
        }

        if (item.sourceType === "file") {
          if (typeof item.id !== "string" || !UUID_PATTERN.test(item.id)) {
            throw new OrderError("UPLOAD_NOT_FOUND", "Il file modello temporaneo non e valido.");
          }
          const modelFormat = item.modelFormat ?? "3mf";
          if (!MODEL_FORMATS.has(modelFormat)) throw new OrderError("UNSUPPORTED_MODEL_FORMAT", "Il formato del modello non e supportato.");
          const uniqueKey = `file:${item.id}:${item.colorId}`;
          if (seenItems.has(uniqueKey)) {
            throw new OrderError("DUPLICATE_ITEM", "La richiesta contiene elementi duplicati.");
          }
          seenItems.add(uniqueKey);
          const temporaryFilename = path.join(uploadDirectory, `${item.id}${modelExtension(modelFormat)}`);
          let fileStats;
          try {
            fileStats = await stat(temporaryFilename);
          } catch (error) {
            if (error.code === "ENOENT") {
              throw new OrderError("UPLOAD_NOT_FOUND", "Un file modello non esiste piu.", 410);
            }
            throw error;
          }
          if (Date.now() - fileStats.mtimeMs > UPLOAD_TTL_MS) {
            throw new OrderError("UPLOAD_EXPIRED", "Un file modello temporaneo e scaduto.", 410);
          }
          const modelMetadata = await inspectModelFile(temporaryFilename, modelFormat);
          const measurements = await measureModelFile(temporaryFilename, modelFormat);
          const quote = measurements.volumeMm3 > 0
            ? calculateProjectQuote(measurements.plates ?? [measurements], readPricingSettings(database))
            : null;
          const originalName = sanitizeOriginalModelName(item.name, modelFormat);
          validatedItems.push({
            itemType: "custom_file",
            productId: null,
            productCode: null,
            productName: originalName,
            unitPriceCents: null,
            colorId: color.id,
            colorName: color.name,
            colorHex: color.hex_value,
            quantity,
            originalName,
            sourceName: null,
            externalUrl: null,
            modelFilename: null,
            modelFormat,
            modelMetadata,
            modelMetadataJson: modelMetadata ? JSON.stringify(modelMetadata) : null,
            quoteJson: quote ? JSON.stringify({ ...quote, volumeMm3: measurements.totalVolumeMm3 }) : null,
            uploadId: item.id,
            temporaryFilename,
          });
          continue;
        }

        if (item.sourceType === "link") {
          let link;
          try {
            link = validateExternalModelUrl(item.externalUrl);
          } catch (error) {
            throw new OrderError("INVALID_LINK", error.message);
          }
          const uniqueKey = `link:${link.externalUrl}:${item.colorId}`;
          if (seenItems.has(uniqueKey)) {
            throw new OrderError("DUPLICATE_ITEM", "La richiesta contiene elementi duplicati.");
          }
          seenItems.add(uniqueKey);
          validatedItems.push({
            itemType: "custom_link",
            productId: null,
            productCode: null,
            productName: `Modello da ${link.sourceName}`,
            unitPriceCents: null,
            colorId: color.id,
            colorName: color.name,
            colorHex: color.hex_value,
            quantity,
            originalName: null,
            sourceName: link.sourceName,
            externalUrl: link.externalUrl,
            modelFilename: null,
            modelFormat: null,
            modelMetadataJson: null,
            quoteJson: null,
          });
          continue;
        }

        throw new OrderError("INVALID_ITEM_TYPE", "La sorgente del modello personale non e valida.");
      }

      const openOrders = countOpenOrders.get()?.count ?? 0;
      if (openOrders >= MAX_OPEN_ORDERS) {
        throw new OrderError(
          "ORDER_CAPACITY_REACHED",
          "Siamo al completo di lavoro al momento. Riprova piu tardi.",
          503,
        );
      }

      const code = createOrderCode(database, firstName, lastName);
      const copiedByUpload = new Map();
      for (const item of validatedItems.filter(({ itemType }) => itemType === "custom_file")) {
        let permanentFilename = copiedByUpload.get(item.uploadId);
        if (!permanentFilename) {
          permanentFilename = `${code}-${item.uploadId}${modelExtension(item.modelFormat)}`;
          const destination = path.join(orderFileDirectory, permanentFilename);
          await copyFile(item.temporaryFilename, destination, fileConstants.COPYFILE_EXCL);
          copiedFiles.push(destination);
          copiedByUpload.set(item.uploadId, permanentFilename);
        }
        item.modelFilename = permanentFilename;
      }

      const catalogTotalCents = validatedItems.reduce(
        (total, item) =>
          item.unitPriceCents === null ? total : total + item.unitPriceCents * item.quantity,
        0,
      );
      const order = {
        code,
        firstName,
        lastName,
        comment,
        catalogTotalCents,
        userAccountId: request.userAccount?.id ?? null,
        items: validatedItems,
      };
      saveOrder(order);

      const temporaryFiles = new Set(
        validatedItems
          .filter(({ itemType }) => itemType === "custom_file")
          .map(({ temporaryFilename }) => temporaryFilename),
      );
      await Promise.all([...temporaryFiles].map((filename) => unlink(filename).catch(console.error)));

      if (getSettings.get().email_notifications_enabled) {
        try {
          if (!emailService?.configured) throw new Error("SMTP non configurato.");
          await emailService.sendOrderEmail({
            subject: `Nuova richiesta ${code}`,
            text: buildEmail(order),
          });
        } catch (error) {
          console.error(`Email non inviata per ${code}.`, error);
        }
      }

      return response.status(201).json({ data: { code } });
    } catch (error) {
      await Promise.all(copiedFiles.map((filename) => unlink(filename).catch(() => {})));
      return sendError(response, error);
    }
  });
}
