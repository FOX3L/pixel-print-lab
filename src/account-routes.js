import { unlink } from "node:fs/promises";
import path from "node:path";
import { AuthError } from "./auth-service.js";
import { EmailDailyLimitError } from "./email-service.js";
import { defaultOrderFileDirectory } from "./order-routes.js";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS = 5;
const EMAIL_VERIFICATION_WINDOW_MS = 15 * 60 * 1000;
const MAX_EMAIL_VERIFICATION_ATTEMPTS = 10;
const EMAIL_RESEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_EMAIL_RESENDS = 5;
const PASSWORD_RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const MAX_PASSWORD_RESET_REQUESTS = 5;
const PASSWORD_RESET_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_RESET_ATTEMPTS = 10;

function sendAuthError(response, error) {
  if (error instanceof AuthError) {
    return response.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  console.error(error);
  return response.status(500).json({
    error: { code: "AUTH_FAILED", message: "Operazione account non riuscita." },
  });
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function serializeItem(item) {
  const estimatedQuote = parseJson(item.quote_json);
  const actualQuote = parseJson(item.actual_quote_json);
  const estimatedUnitPriceCents = estimatedQuote?.unitPriceCents ?? null;
  const unitPriceCents = item.unit_price_cents ?? estimatedUnitPriceCents;
  const priceStatus = item.unit_price_cents !== null
    ? "confirmed"
    : estimatedUnitPriceCents !== null
      ? "estimated"
      : "pending";
  return {
    id: item.id,
    itemType: item.item_type,
    productName: item.product_name,
    colorName: item.color_name,
    colorHex: item.color_hex,
    quantity: item.quantity,
    unitPriceCents,
    lineTotalCents: unitPriceCents === null ? null : unitPriceCents * item.quantity,
    priceStatus,
    estimatedQuote,
    actualQuote,
    originalName: item.original_name,
    sourceName: item.source_name,
  };
}

function serializeOrder(order, items) {
  const serializedItems = items.map(serializeItem);
  const totalPriceCents = serializedItems.reduce(
    (total, item) => total + (item.lineTotalCents ?? 0),
    0,
  );
  const priceStatus = serializedItems.some((item) => item.priceStatus === "pending")
    ? "partial"
    : serializedItems.some((item) => item.priceStatus === "estimated")
      ? "estimated"
      : "confirmed";
  return {
    id: order.id,
    code: order.code,
    firstName: order.first_name,
    lastName: order.last_name,
    comment: order.comment,
    catalogTotalCents: order.catalog_total_cents,
    totalPriceCents,
    priceStatus,
    status: order.status,
    createdAt: order.created_at,
    items: serializedItems,
  };
}

export function registerAccountRoutes(
  app,
  { database, auth, orderFileDirectory = defaultOrderFileDirectory, emailService, disableRateLimits = false },
) {
  const accountLoginAttempts = new Map();
  const adminLoginAttempts = new Map();
  const registrationAttempts = new Map();
  const emailVerificationAttempts = new Map();
  const emailResendAttempts = new Map();
  const passwordResetRequests = new Map();
  const passwordResetAttempts = new Map();
  const listOrders = database.prepare(`
    SELECT * FROM orders
    WHERE user_account_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const listItems = database.prepare(`
    SELECT * FROM order_items WHERE order_id = ? ORDER BY position
  `);
  const findOrderByCode = database.prepare(`
    SELECT * FROM orders WHERE code = ? AND user_account_id = ?
  `);
  const deleteOrderById = database.prepare("DELETE FROM orders WHERE id = ?");
  const orderModelFiles = database.prepare(`
    SELECT DISTINCT model_filename FROM order_items
    WHERE order_id = ? AND model_filename IS NOT NULL
  `);

  function checkRateLimit(attempts, key, maximum, message) {
    const now = Date.now();
    for (const [entryKey, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(entryKey);
    }
    const attempt = attempts.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= maximum) {
      throw new AuthError("RATE_LIMITED", message, 429);
    }
    return { key, now, attempt };
  }

  function recordAttempt(attempts, { key, now, attempt }, windowMs) {
    const current = attempt && attempt.resetAt > now
      ? attempt
      : { count: 0, resetAt: now + windowMs };
    attempts.set(key, { ...current, count: current.count + 1 });
  }

  async function sendEmailVerification(accountId) {
    if (!emailService?.configured) {
      throw new AuthError("EMAIL_UNAVAILABLE", "Invio email temporaneamente non disponibile.", 503);
    }
    const { account, code } = auth.createEmailVerification(accountId);
    try {
      await emailService.sendOrderEmail({
        to: account.email,
        subject: "Verifica il tuo indirizzo email PIX3LLAB",
        text: [
          `Il tuo codice di verifica e: ${code}`,
          "",
          "Inseriscilo nella tua area account entro 24 ore.",
          "Se non hai richiesto tu questa verifica, puoi ignorare il messaggio.",
          "",
        ].join("\n"),
      });
    } catch (error) {
      if (error instanceof EmailDailyLimitError) {
        throw new AuthError(
          "EMAIL_DAILY_LIMIT",
          "Limite giornaliero di email raggiunto. Riprova domani.",
          429,
        );
      }
      throw error;
    }
  }

  async function handleLogin(request, response, adminOnly = false) {
    let rateLimit;
    let attempts;
    try {
      if (adminOnly && !auth.adminConfigured) {
        throw new AuthError(
          "ADMIN_NOT_CONFIGURED",
          "Imposta ADMIN_EMAIL e ADMIN_PASSWORD prima di usare il pannello amministrativo.",
          503,
        );
      }
      const credential = request.body?.email;
      const username = typeof credential === "string" ? credential.trim().toLowerCase() : "";
      if (!disableRateLimits) {
        attempts = adminOnly || auth.isAdminEmail(username) ? adminLoginAttempts : accountLoginAttempts;
        rateLimit = checkRateLimit(
          attempts,
          `${request.ip}:${username}`,
          MAX_LOGIN_ATTEMPTS,
          "Troppi tentativi. Riprova piu tardi.",
        );
        recordAttempt(attempts, rateLimit, LOGIN_WINDOW_MS);
      }
      const account = await auth.login(credential, request.body?.password, { adminOnly });
      if (!disableRateLimits && attempts && rateLimit) attempts.delete(rateLimit.key);
      return response.status(201).json({ data: auth.createSession(request, response, account) });
    } catch (error) {
      if (error instanceof AuthError && error.code === "INVALID_CREDENTIALS" && adminOnly) {
        error.code = "INVALID_ADMIN_CREDENTIALS";
      }
      return sendAuthError(response, error);
    }
  }

  app.post("/api/account/register", async (request, response) => {
    try {
      if (!disableRateLimits) {
        const rateLimit = checkRateLimit(
          registrationAttempts,
          request.ip,
          MAX_REGISTRATIONS,
          "Troppe registrazioni. Riprova piu tardi.",
        );
        recordAttempt(registrationAttempts, rateLimit, REGISTRATION_WINDOW_MS);
      }
      const account = await auth.register(request.body ?? {});
      if (account.email && emailService?.configured) {
        try {
          await sendEmailVerification(account.id);
        } catch (error) {
          console.error(`Email di verifica non inviata per @${account.username}.`, error);
        }
      }
      return response.status(201).json({ data: auth.createSession(request, response, account) });
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.post("/api/account/login", (request, response) => handleLogin(request, response));

  app.post("/api/account/password/forgot", async (request, response) => {
    try {
      const email = typeof request.body?.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "";
      if (!disableRateLimits) {
        const rateLimit = checkRateLimit(
          passwordResetRequests,
          `${request.ip}:${email}`,
          MAX_PASSWORD_RESET_REQUESTS,
          "Hai richiesto troppi codici. Riprova piu tardi.",
        );
        recordAttempt(passwordResetRequests, rateLimit, PASSWORD_RESET_REQUEST_WINDOW_MS);
      }
      const reset = auth.createPasswordReset(request.body?.email);
      if (reset && emailService?.configured) {
        try {
          await emailService.sendOrderEmail({
            to: reset.account.email,
            subject: "Recupera la password PIX3LLAB",
            text: [
              `Il tuo codice di recupero e: ${reset.code}`,
              "",
              "Inseriscilo nella schermata di recupero entro 30 minuti.",
              "Se non hai richiesto tu il reset, puoi ignorare il messaggio.",
              "",
            ].join("\n"),
          });
        } catch (error) {
          console.error("Email di recupero password non inviata.", error);
        }
      }
      return response.status(204).end();
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.post("/api/account/password/reset", async (request, response) => {
    let rateLimit;
    try {
      const email = typeof request.body?.email === "string"
        ? request.body.email.trim().toLowerCase()
        : "";
      if (!disableRateLimits) {
        rateLimit = checkRateLimit(
          passwordResetAttempts,
          `${request.ip}:${email}`,
          MAX_PASSWORD_RESET_ATTEMPTS,
          "Troppi tentativi di recupero. Riprova piu tardi.",
        );
        recordAttempt(passwordResetAttempts, rateLimit, PASSWORD_RESET_WINDOW_MS);
      }
      await auth.resetPassword(request.body?.email, request.body?.code, request.body?.password);
      if (!disableRateLimits && rateLimit) passwordResetAttempts.delete(rateLimit.key);
      return response.status(204).end();
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.post("/api/account/logout", (request, response) => {
    auth.logout(request, response);
    return response.status(204).end();
  });

  app.get("/api/account/session", auth.requireAccount, (request, response) => {
    response.json({ data: auth.serializeAccount(request.userAccount) });
  });

  app.post("/api/account/email/verify", auth.requireAccount, (request, response) => {
    try {
      let rateLimit;
      if (!disableRateLimits) {
        rateLimit = checkRateLimit(
          emailVerificationAttempts,
          `${request.ip}:${request.userAccount.id}`,
          MAX_EMAIL_VERIFICATION_ATTEMPTS,
          "Troppi tentativi di verifica. Riprova piu tardi.",
        );
        recordAttempt(emailVerificationAttempts, rateLimit, EMAIL_VERIFICATION_WINDOW_MS);
      }
      const account = auth.confirmEmail(request.userAccount.id, request.body?.code);
      if (!disableRateLimits && rateLimit) emailVerificationAttempts.delete(rateLimit.key);
      return response.json({ data: auth.serializeAccount(account) });
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.post("/api/account/email/resend", auth.requireAccount, async (request, response) => {
    try {
      if (!disableRateLimits) {
        const rateLimit = checkRateLimit(
          emailResendAttempts,
          `${request.ip}:${request.userAccount.id}`,
          MAX_EMAIL_RESENDS,
          "Hai richiesto troppi codici. Riprova piu tardi.",
        );
        recordAttempt(emailResendAttempts, rateLimit, EMAIL_RESEND_WINDOW_MS);
      }
      await sendEmailVerification(request.userAccount.id);
      return response.status(204).end();
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.patch("/api/account/preferences", auth.requireAccount, (request, response) => {
    try {
      const account = auth.setEmailNotifications(
        request.userAccount.id,
        request.body?.emailNotificationsEnabled,
      );
      return response.json({ data: auth.serializeAccount(account) });
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.delete("/api/account", auth.requireAccount, async (request, response) => {
    let rateLimit;
    try {
      if (!disableRateLimits) {
        rateLimit = checkRateLimit(
          accountLoginAttempts,
          `delete:${request.ip}:${request.userAccount.id}`,
          MAX_LOGIN_ATTEMPTS,
          "Troppi tentativi. Riprova piu tardi.",
        );
        recordAttempt(accountLoginAttempts, rateLimit, LOGIN_WINDOW_MS);
      }
      await auth.deleteAccount(request.userAccount.id, request.body?.password);
      if (!disableRateLimits && rateLimit) accountLoginAttempts.delete(rateLimit.key);
      auth.logout(request, response);
      return response.status(204).end();
    } catch (error) {
      return sendAuthError(response, error);
    }
  });

  app.get("/api/account/orders", auth.requireAccount, (request, response) => {
    const orders = listOrders.all(request.userAccount.id).map((order) =>
      serializeOrder(order, listItems.all(order.id))
    );
    response.json({ data: orders, count: orders.length });
  });

  app.delete("/api/account/orders/:code", auth.requireAccount, async (request, response) => {
    try {
      const code = typeof request.params.code === "string" ? request.params.code.trim() : "";
      if (!code) {
        return response.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Ordine non trovato." } });
      }
      const order = findOrderByCode.get(code, request.userAccount.id);
      if (!order) {
        return response.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Ordine non trovato." } });
      }
      const filenames = orderModelFiles.pluck().all(order.id);
      deleteOrderById.run(order.id);
      await Promise.all(filenames.map((filename) =>
        unlink(path.join(orderFileDirectory, filename)).catch(console.error),
      ));
      return response.status(204).end();
    } catch (error) {
      console.error(error);
      return response.status(500).json({ error: { code: "ORDER_DELETE_FAILED", message: "Impossibile eliminare l'ordine." } });
    }
  });

  app.post("/api/admin/login", (request, response) => handleLogin(request, response, true));

  app.post("/api/admin/logout", auth.requireAdmin, (request, response) => {
    auth.logout(request, response);
    return response.status(204).end();
  });

  app.get("/api/admin/session", auth.requireAdmin, (request, response) => {
    response.json({ data: auth.serializeAccount(request.userAccount) });
  });
}
