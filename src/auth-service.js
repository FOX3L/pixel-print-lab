import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "ppl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$KeZz9UqPc9MxmhAJcEbr5s8vLnEhZQGY8nGwjvP2mV8oMsqSx9yknajYdTBCpT7tJYwo4M5GsqTzSZsXj8L98A";

export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseCookies(request) {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) return [part, ""];
        try {
          return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
        } catch {
          return [part.slice(0, separator), ""];
        }
      }),
  );
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateName(value, label) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length < 1 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AuthError("INVALID_ACCOUNT_NAME", `${label} deve contenere da 1 a 60 caratteri.`);
  }
  return name;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) {
    throw new AuthError("INVALID_PASSWORD", "La password deve contenere da 10 a 128 caratteri.");
  }
  return value;
}

export function validateOptionalEmail(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AuthError("INVALID_EMAIL", "L'indirizzo email non e valido.");
  }
  const email = value.trim();
  if (!email) return null;
  if (
    email.length > 254 ||
    /[\u0000-\u001f\u007f,;]/.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new AuthError("INVALID_EMAIL", "L'indirizzo email non e valido.");
  }
  return email;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function verifyPassword(password, storedHash = DUMMY_PASSWORD_HASH) {
  const [algorithm, n, r, p, saltValue, keyValue] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltValue || !keyValue) return false;
  try {
    const expected = Buffer.from(keyValue, "base64url");
    const actual = await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function credentialMatches(candidate, configuredValue) {
  if (typeof candidate !== "string" || typeof configuredValue !== "string") return false;
  const candidateHash = crypto.createHash("sha256").update(candidate).digest();
  const configuredHash = crypto.createHash("sha256").update(configuredValue).digest();
  return crypto.timingSafeEqual(candidateHash, configuredHash);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function serializeAccount(account) {
  return {
    id: account.id,
    username: account.username,
    firstName: account.first_name,
    lastName: account.last_name,
    email: account.email,
    emailVerified: Boolean(account.email_verified_at),
    emailNotificationsEnabled: Boolean(account.email_notifications_enabled),
    pixBalance: account.pix_balance,
    role: account.role,
  };
}

export function createAuthService({ database, adminEmail, adminPassword }) {
  const configuredAdminEmail = validateOptionalEmail(adminEmail)?.toLowerCase() ?? "";
  const adminConfigured = configuredAdminEmail.length > 0 && typeof adminPassword === "string" && adminPassword.length > 0;
  const findAccountByUsername = database.prepare("SELECT * FROM user_accounts WHERE username = ? COLLATE NOCASE");
  const findEnvironmentAccount = database.prepare(`
    SELECT * FROM user_accounts WHERE auth_source = 'environment' ORDER BY id LIMIT 1
  `);
  const findSession = database.prepare(`
    SELECT user_accounts.*
    FROM user_sessions
    JOIN user_accounts ON user_accounts.id = user_sessions.user_account_id
    WHERE user_sessions.token_hash = ? AND user_sessions.expires_at > ?
  `);
  const insertLocalAccount = database.prepare(`
    INSERT INTO user_accounts (username, password_hash, first_name, last_name, email)
    VALUES (@username, @passwordHash, @firstName, @lastName, @email)
  `);
  const insertEnvironmentAdmin = database.prepare(`
    INSERT INTO user_accounts (
      username, password_hash, first_name, last_name, email, email_verified_at,
      role, auth_source
    )
    VALUES (@email, NULL, @firstName, 'Admin', @email, CURRENT_TIMESTAMP, 'admin', 'environment')
  `);
  const reactivateEnvironmentAdmin = database.prepare(`
    UPDATE user_accounts SET
      username = @email, first_name = @firstName, last_name = 'Admin', email = @email,
      email_verified_at = CURRENT_TIMESTAMP, role = 'admin', updated_at = CURRENT_TIMESTAMP
    WHERE id = @id AND auth_source = 'environment'
  `);
  const reactivateCurrentEnvironmentAdmin = database.prepare(`
    UPDATE user_accounts
    SET email = username, email_verified_at = CURRENT_TIMESTAMP,
      role = 'admin', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND auth_source = 'environment'
  `);
  const insertSession = database.prepare(`
    INSERT INTO user_sessions (token_hash, user_account_id, expires_at)
    VALUES (?, ?, ?)
  `);
  const deleteSession = database.prepare("DELETE FROM user_sessions WHERE token_hash = ?");
  const deleteExpiredSessions = database.prepare("DELETE FROM user_sessions WHERE expires_at <= ?");
  const findAccountById = database.prepare("SELECT * FROM user_accounts WHERE id = ?");
  const storeEmailVerification = database.prepare(`
    INSERT INTO email_verification_tokens (user_account_id, token_hash, expires_at)
    VALUES (@accountId, @tokenHash, @expiresAt)
    ON CONFLICT(user_account_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      expires_at = excluded.expires_at,
      created_at = CURRENT_TIMESTAMP
  `);
  const findEmailVerification = database.prepare(`
    SELECT * FROM email_verification_tokens WHERE user_account_id = ?
  `);
  const deleteEmailVerification = database.prepare(`
    DELETE FROM email_verification_tokens WHERE user_account_id = ?
  `);
  const verifyAccountEmail = database.prepare(`
    UPDATE user_accounts
    SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND email IS NOT NULL
  `);
  const updateAccountEmailNotifications = database.prepare(`
    UPDATE user_accounts
    SET email_notifications_enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND auth_source = 'local'
  `);
  const storePasswordReset = database.prepare(`
    INSERT INTO password_reset_tokens (user_account_id, token_hash, expires_at)
    VALUES (@accountId, @tokenHash, @expiresAt)
    ON CONFLICT(user_account_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      expires_at = excluded.expires_at,
      created_at = CURRENT_TIMESTAMP
  `);
  const findPasswordReset = database.prepare(`
    SELECT * FROM password_reset_tokens WHERE user_account_id = ?
  `);
  const deletePasswordReset = database.prepare(`
    DELETE FROM password_reset_tokens WHERE user_account_id = ?
  `);
  const updateAccountPassword = database.prepare(`
    UPDATE user_accounts SET
      password_hash = ?, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND auth_source = 'local'
  `);
  const deleteAccountSessions = database.prepare(`
    DELETE FROM user_sessions WHERE user_account_id = ?
  `);
  const deleteLocalAccount = database.prepare(`
    DELETE FROM user_accounts WHERE id = ? AND auth_source = 'local'
  `);
  const getCredentialsOverride = database.prepare(`
    SELECT admin_username AS username, admin_password_hash AS passwordHash
    FROM app_settings WHERE id = 1
  `);
  const storeCredentialsOverride = database.prepare(`
    UPDATE app_settings
    SET admin_username = @username, admin_password_hash = @passwordHash, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `);
  const clearCredentialsOverride = database.prepare(`
    UPDATE app_settings
    SET admin_username = NULL, admin_password_hash = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `);
  const deleteEnvironmentSessions = database.prepare(`
    DELETE FROM user_sessions
    WHERE user_account_id IN (
      SELECT id FROM user_accounts WHERE auth_source = 'environment'
    )
  `);

  database.exec(`
    DELETE FROM user_sessions
    WHERE user_account_id IN (
      SELECT id FROM user_accounts WHERE auth_source = 'environment'
    );
    UPDATE user_accounts
    SET role = 'customer', updated_at = CURRENT_TIMESTAMP
    WHERE auth_source = 'environment';
  `);

  function credentialsOverride() {
    const row = getCredentialsOverride.get();
    return row?.username && row?.passwordHash ? row : null;
  }

  function effectiveAdminEmail() {
    return credentialsOverride()?.username ?? configuredAdminEmail;
  }

  function environmentAdmin(adminEmail) {
    const existing = findAccountByUsername.get(adminEmail);
    if (existing && existing.auth_source !== "environment") {
      throw new AuthError(
        "ADMIN_ACCOUNT_CONFLICT",
        "L'email amministrativa coincide con un account cliente esistente. Configura un indirizzo diverso.",
        503,
      );
    }
    if (existing) {
      reactivateCurrentEnvironmentAdmin.run(existing.id);
      return findAccountByUsername.get(adminEmail);
    }
    const previousEnvironmentAccount = findEnvironmentAccount.get();
    if (previousEnvironmentAccount) {
      reactivateEnvironmentAdmin.run({
        id: previousEnvironmentAccount.id,
        email: adminEmail,
        firstName: adminEmail.split("@", 1)[0],
      });
      return findAccountByUsername.get(adminEmail);
    }
    const id = Number(insertEnvironmentAdmin.run({
      email: adminEmail,
      firstName: adminEmail.split("@", 1)[0],
    }).lastInsertRowid);
    return database.prepare("SELECT * FROM user_accounts WHERE id = ?").get(id);
  }

  function setSessionCookie(request, response, token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
    const secure = request.secure;
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`,
    );
  }

  function createSession(request, response, account) {
    deleteExpiredSessions.run(Date.now());
    const previousSession = accountFromRequest(request);
    if (previousSession) deleteSession.run(tokenHash(previousSession.token));
    const token = crypto.randomBytes(32).toString("base64url");
    insertSession.run(tokenHash(token), account.id, Date.now() + SESSION_TTL_MS);
    setSessionCookie(request, response, token);
    return serializeAccount(account);
  }

  function accountFromRequest(request) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (!token) return null;
    const account = findSession.get(tokenHash(token), Date.now());
    return { account: account ?? null, token };
  }

  function createEmailVerification(accountId) {
    const account = findAccountById.get(accountId);
    if (!account?.email) {
      throw new AuthError("EMAIL_NOT_AVAILABLE", "Questo account non ha un indirizzo email.", 409);
    }
    if (account.email_verified_at) {
      throw new AuthError("EMAIL_ALREADY_VERIFIED", "L'indirizzo email e gia verificato.", 409);
    }
    const code = crypto.randomBytes(8).toString("hex").toUpperCase();
    storeEmailVerification.run({
      accountId,
      tokenHash: tokenHash(code),
      expiresAt: Date.now() + EMAIL_VERIFICATION_TTL_MS,
    });
    return { account, code };
  }

  const applyEmailVerification = database.transaction((accountId) => {
    verifyAccountEmail.run(accountId);
    deleteEmailVerification.run(accountId);
    return findAccountById.get(accountId);
  });

  function confirmEmail(accountId, value) {
    const account = findAccountById.get(accountId);
    if (account?.email_verified_at) {
      throw new AuthError("EMAIL_ALREADY_VERIFIED", "L'indirizzo email e gia verificato.", 409);
    }
    const code = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!/^[A-F0-9]{16}$/.test(code)) {
      throw new AuthError("INVALID_EMAIL_CODE", "Il codice di verifica non e valido.");
    }
    const verification = findEmailVerification.get(accountId);
    if (!verification || verification.expires_at <= Date.now()) {
      if (verification) deleteEmailVerification.run(accountId);
      throw new AuthError("EMAIL_CODE_EXPIRED", "Il codice e scaduto. Richiedine uno nuovo.", 410);
    }
    const expected = Buffer.from(verification.token_hash, "hex");
    const actual = Buffer.from(tokenHash(code), "hex");
    if (!crypto.timingSafeEqual(expected, actual)) {
      throw new AuthError("INVALID_EMAIL_CODE", "Il codice di verifica non e valido.");
    }
    return applyEmailVerification(accountId);
  }

  function setEmailNotifications(accountId, enabled) {
    if (typeof enabled !== "boolean") {
      throw new AuthError("INVALID_EMAIL_PREFERENCE", "La preferenza delle notifiche non e valida.");
    }
    const result = updateAccountEmailNotifications.run(enabled ? 1 : 0, accountId);
    if (!result.changes) {
      throw new AuthError("ACCOUNT_NOT_AVAILABLE", "Account non disponibile.", 404);
    }
    return findAccountById.get(accountId);
  }

  function createPasswordReset(emailValue) {
    const email = validateOptionalEmail(emailValue)?.toLowerCase();
    if (!email) return null;
    const account = findAccountByUsername.get(email);
    if (!account || account.auth_source !== "local") return null;
    const code = crypto.randomBytes(8).toString("hex").toUpperCase();
    storePasswordReset.run({
      accountId: account.id,
      tokenHash: tokenHash(code),
      expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
    });
    return { account, code };
  }

  const applyPasswordReset = database.transaction((accountId, passwordHash) => {
    updateAccountPassword.run(passwordHash, accountId);
    deletePasswordReset.run(accountId);
    deleteEmailVerification.run(accountId);
    deleteAccountSessions.run(accountId);
  });

  async function resetPassword(emailValue, codeValue, passwordValue) {
    const email = validateOptionalEmail(emailValue)?.toLowerCase();
    const code = typeof codeValue === "string" ? codeValue.trim().toUpperCase() : "";
    const password = validatePassword(passwordValue);
    if (!email || !/^[A-F0-9]{16}$/.test(code)) {
      throw new AuthError("INVALID_PASSWORD_RESET", "Email o codice di recupero non validi.");
    }
    const account = findAccountByUsername.get(email);
    const reset = account?.auth_source === "local" ? findPasswordReset.get(account.id) : null;
    if (!reset) {
      throw new AuthError("INVALID_PASSWORD_RESET", "Email o codice di recupero non validi.");
    }
    if (reset.expires_at <= Date.now()) {
      deletePasswordReset.run(account.id);
      throw new AuthError("PASSWORD_RESET_EXPIRED", "Il codice e scaduto. Richiedine uno nuovo.", 410);
    }
    const expected = Buffer.from(reset.token_hash, "hex");
    const actual = Buffer.from(tokenHash(code), "hex");
    if (!crypto.timingSafeEqual(expected, actual)) {
      throw new AuthError("INVALID_PASSWORD_RESET", "Email o codice di recupero non validi.");
    }
    applyPasswordReset(account.id, await hashPassword(password));
  }

  async function deleteAccount(accountId, passwordValue) {
    const account = findAccountById.get(accountId);
    if (!account || account.auth_source !== "local" || account.role !== "customer") {
      throw new AuthError(
        "ACCOUNT_DELETE_FORBIDDEN",
        "Questo account non puo essere eliminato dal profilo.",
        403,
      );
    }
    const password = typeof passwordValue === "string" ? passwordValue : "";
    if (!await verifyPassword(password, account.password_hash)) {
      throw new AuthError("INVALID_PASSWORD", "La password non e corretta.", 401);
    }
    deleteLocalAccount.run(account.id);
  }

  async function register({ password: rawPassword, firstName, lastName, email: rawEmail }) {
    const email = validateOptionalEmail(rawEmail)?.toLowerCase();
    if (!email) throw new AuthError("INVALID_EMAIL", "L'indirizzo email e obbligatorio.");
    if (email === effectiveAdminEmail()) {
      throw new AuthError("EMAIL_UNAVAILABLE", "Esiste gia un account con questo indirizzo email.", 409);
    }
    if (findAccountByUsername.get(email)) {
      throw new AuthError("EMAIL_UNAVAILABLE", "Esiste gia un account con questo indirizzo email.", 409);
    }
    const password = validatePassword(rawPassword);
    const values = {
      username: email,
      passwordHash: await hashPassword(password),
      firstName: validateName(firstName, "Il nome"),
      lastName: validateName(lastName, "Il cognome"),
      email,
    };
    try {
      const id = Number(insertLocalAccount.run(values).lastInsertRowid);
      return database.prepare("SELECT * FROM user_accounts WHERE id = ?").get(id);
    } catch (error) {
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) {
        throw new AuthError("EMAIL_UNAVAILABLE", "Esiste gia un account con questo indirizzo email.", 409);
      }
      throw error;
    }
  }

  async function login(usernameValue, passwordValue, { adminOnly = false } = {}) {
    const username = normalizeUsername(usernameValue);
    const password = typeof passwordValue === "string" ? passwordValue : "";
    const override = credentialsOverride();
    if (override) {
      if (username === override.username && await verifyPassword(password, override.passwordHash)) {
        return environmentAdmin(override.username);
      }
    } else if (
      adminConfigured && username === configuredAdminEmail &&
      credentialMatches(password, adminPassword)
    ) {
      return environmentAdmin(configuredAdminEmail);
    }

    if (adminOnly) {
      throw new AuthError("INVALID_CREDENTIALS", "Credenziali non corrette.", 401);
    }
    const account = findAccountByUsername.get(username);
    const valid = account?.auth_source === "local"
      ? await verifyPassword(password, account.password_hash)
      : await verifyPassword(password);
    if (!valid) {
      throw new AuthError("INVALID_CREDENTIALS", "Email o password non corrette.", 401);
    }
    return account;
  }

  function optionalAccount(request, _response, next) {
    const session = accountFromRequest(request);
    if (session && !session.account) {
      setSessionCookie(request, _response, "", 0);
      _response.status(401).json({
        error: { code: "SESSION_EXPIRED", message: "La sessione e scaduta. Accedi di nuovo prima di inviare l'ordine." },
      });
      return;
    }
    request.userAccount = session?.account ?? null;
    request.userSessionToken = session?.token ?? null;
    next();
  }

  function requireAccount(request, response, next) {
    optionalAccount(request, response, () => {
      if (!request.userAccount) {
        response.status(401).json({
          error: { code: "AUTH_REQUIRED", message: "Accedi per continuare." },
        });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      next();
    });
  }

  function requireAdmin(request, response, next) {
    requireAccount(request, response, () => {
      if (request.userAccount.role !== "admin" || request.userAccount.auth_source !== "environment") {
        response.status(403).json({
          error: { code: "ADMIN_AUTH_REQUIRED", message: "Accesso amministrativo richiesto." },
        });
        return;
      }
      next();
    });
  }

  function logout(request, response) {
    const session = accountFromRequest(request);
    if (session) deleteSession.run(tokenHash(session.token));
    setSessionCookie(request, response, "", 0);
  }

  const applyCredentialsOverride = database.transaction((values) => {
    storeCredentialsOverride.run(values);
    deleteEnvironmentSessions.run();
  });

  async function changeAdminCredentials({ currentPassword, email: rawEmail, password: rawPassword }) {
    const override = credentialsOverride();
    if (!override && !adminConfigured) {
      throw new AuthError(
        "ADMIN_NOT_CONFIGURED",
        "Imposta ADMIN_EMAIL e ADMIN_PASSWORD prima di usare il pannello amministrativo.",
        503,
      );
    }
    const candidate = typeof currentPassword === "string" ? currentPassword : "";
    const currentPasswordValid = override
      ? await verifyPassword(candidate, override.passwordHash)
      : credentialMatches(candidate, adminPassword);
    if (!currentPasswordValid) {
      throw new AuthError("INVALID_CREDENTIALS", "La password attuale non e corretta.", 401);
    }
    const hasEmail = typeof rawEmail === "string" && rawEmail.trim().length > 0;
    const hasPassword = typeof rawPassword === "string" && rawPassword.length > 0;
    if (!hasEmail && !hasPassword) {
      throw new AuthError("INVALID_CREDENTIALS_UPDATE", "Indica una nuova email o una nuova password.");
    }
    const email = hasEmail
      ? validateOptionalEmail(rawEmail)?.toLowerCase()
      : override?.username ?? configuredAdminEmail;
    const conflictingAccount = findAccountByUsername.get(email);
    if (conflictingAccount && conflictingAccount.auth_source !== "environment") {
      throw new AuthError("EMAIL_UNAVAILABLE", "Esiste gia un account con questo indirizzo email.", 409);
    }
    let passwordHash;
    if (hasPassword) {
      passwordHash = await hashPassword(validatePassword(rawPassword));
    } else if (override) {
      passwordHash = override.passwordHash;
    } else {
      passwordHash = await hashPassword(candidate);
    }
    applyCredentialsOverride({ username: email, passwordHash });
    return { email };
  }

  function resetAdminCredentials() {
    database.transaction(() => {
      clearCredentialsOverride.run();
      deleteEnvironmentSessions.run();
    })();
  }

  return {
    get adminConfigured() {
      return adminConfigured || Boolean(credentialsOverride());
    },
    adminAccess: () => {
      const override = credentialsOverride();
      return { email: override?.username ?? configuredAdminEmail, customized: Boolean(override) };
    },
    changeAdminCredentials,
    createSession,
    login,
    logout,
    optionalAccount,
    register,
    requireAccount,
    requireAdmin,
    resetAdminCredentials,
    serializeAccount,
    createEmailVerification,
    confirmEmail,
    setEmailNotifications,
    createPasswordReset,
    resetPassword,
    deleteAccount,
    isAdminEmail: (username) => {
      const adminEmail = effectiveAdminEmail();
      return adminEmail.length > 0 && normalizeUsername(username) === adminEmail;
    },
  };
}
