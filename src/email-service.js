import nodemailer from "nodemailer";

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
