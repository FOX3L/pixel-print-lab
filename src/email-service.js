import nodemailer from "nodemailer";

export const DEFAULT_DAILY_EMAIL_LIMIT = 100;

export class EmailDailyLimitError extends Error {
  constructor() {
    super("Limite giornaliero di email raggiunto.");
    this.code = "EMAIL_DAILY_LIMIT";
  }
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseSecure(value) {
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  return null;
}

export function createEmailService(
  environment = process.env,
  createTransport = (options) => nodemailer.createTransport(options),
) {
  const host = optionalText(environment.SMTP_HOST);
  const from = optionalText(environment.SMTP_FROM);
  const recipient = optionalText(environment.SMTP_TO);
  const user = optionalText(environment.SMTP_USER);
  const password = optionalText(environment.SMTP_PASSWORD);
  const port = environment.SMTP_PORT === undefined || environment.SMTP_PORT === ""
    ? 587
    : Number(environment.SMTP_PORT);
  const secure = parseSecure(environment.SMTP_SECURE);
  const configured = Boolean(
    host && from && recipient &&
    Number.isInteger(port) && port > 0 && port <= 65535 &&
    secure !== null && Boolean(user) === Boolean(password)
  );

  const transport = configured
    ? createTransport({
        host,
        port,
        secure,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        ...(user ? { auth: { user, pass: password } } : {}),
      })
    : null;

  return Object.freeze({
    configured,
    recipient,
    async sendOrderEmail({ to = recipient, subject, text }) {
      if (!transport) throw new Error("SMTP non configurato.");
      if (!to) throw new Error("Destinatario email non configurato.");
      await transport.sendMail({ from, to, subject, text });
    },
  });
}

export function createDailyLimitedEmailService(
  database,
  emailService,
  dailyLimit = DEFAULT_DAILY_EMAIL_LIMIT,
) {
  if (!database) throw new TypeError("createDailyLimitedEmailService richiede una connessione al database");
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
    throw new TypeError("Il limite giornaliero delle email deve essere un intero positivo");
  }
  const reserveSend = database.prepare(`
    INSERT INTO email_daily_usage (usage_date, sent_count)
    VALUES (?, 1)
    ON CONFLICT(usage_date) DO UPDATE SET
      sent_count = sent_count + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE sent_count < ?
  `);
  const releaseSend = database.prepare(`
    UPDATE email_daily_usage
    SET sent_count = MAX(0, sent_count - 1), updated_at = CURRENT_TIMESTAMP
    WHERE usage_date = ?
  `);
  const deleteOldUsage = database.prepare(`
    DELETE FROM email_daily_usage WHERE usage_date < ?
  `);

  return Object.freeze({
    get configured() {
      return Boolean(emailService?.configured);
    },
    get recipient() {
      return emailService?.recipient ?? null;
    },
    async sendOrderEmail(message) {
      const usageDate = new Date().toISOString().slice(0, 10);
      deleteOldUsage.run(usageDate);
      if (!reserveSend.run(usageDate, dailyLimit).changes) throw new EmailDailyLimitError();
      try {
        await emailService.sendOrderEmail(message);
      } catch (error) {
        releaseSend.run(usageDate);
        throw error;
      }
    },
  });
}
