import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import yazl from "yazl";
import { createApp } from "../src/app.js";
import { createAuthService } from "../src/auth-service.js";
import {
  cleanupExpiredUploads,
  MAX_UPLOAD_FILE_SIZE,
  UPLOAD_TTL_MS,
} from "../src/custom-model-routes.js";
import { migrateDatabase, openDatabase, seedDatabase } from "../src/database.js";
import { createEmailService } from "../src/email-service.js";
import { create3mfCubeBuffer, createInvalid3mfBuffer } from "./helpers/3mf.js";

let server;
let baseUrl;
let database;
let uploadDirectory;
let orderFileDirectory;
let catalogDirectory;
let sentEmails;
let rejectEmails;
let emailService;

before(async () => {
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "pixel-print-lab-test-"));
  orderFileDirectory = await mkdtemp(path.join(tmpdir(), "pixel-print-lab-orders-"));
  catalogDirectory = await mkdtemp(path.join(tmpdir(), "pixel-print-lab-catalog-"));
  sentEmails = [];
  rejectEmails = false;
  emailService = {
    configured: true,
    recipient: "ordini@example.test",
    async sendOrderEmail(message) {
      if (rejectEmails) throw new Error("SMTP non disponibile");
      sentEmails.push(message);
    },
  };
  database = openDatabase(":memory:");
  seedDatabase(database);
  server = createApp({
    database,
    uploadDirectory,
    orderFileDirectory,
    catalogDirectory,
    adminEmail: "admin@example.test",
    adminPassword: "test-admin-password",
    emailService,
    uploadRateLimit: false,
    orderRateLimit: false,
    disableAuthRateLimits: true,
  }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  database.close();
  await Promise.all(
    [uploadDirectory, orderFileDirectory, catalogDirectory].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function authenticateAdmin() {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "test-admin-password" }),
  });
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function create3mfBuffer({ bambu = false, gcode = false, malformedModel = false, modelOverride, secondaryModel, firstSize = [20, 30, 40], repeatFirstObject = false, secondTransform = "1 0 0 0 1 0 0 0 1 250 0 0" } = {}) {
  const secondBuildObjectId = repeatFirstObject ? 1 : 2;
  const model = modelOverride ?? (malformedModel ? "<model><broken>" : `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Progetto di test</metadata>
  <resources>
    <object id="1" type="model"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="${firstSize[0]}" y="0" z="0"/>
      <vertex x="0" y="${firstSize[1]}" z="0"/><vertex x="0" y="0" z="${firstSize[2]}"/>
    </vertices><triangles>
      <triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/>
      <triangle v1="0" v2="2" v3="3"/><triangle v1="1" v2="2" v3="3"/>
    </triangles></mesh></object>
    <object id="2" type="model"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="200" y="0" z="0"/>
      <vertex x="0" y="200" z="0"/><vertex x="0" y="0" z="200"/>
    </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
  </resources>
  <build><item objectid="1"/><item objectid="${secondBuildObjectId}" transform="${secondTransform}"/></build>
</model>`);
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(contentTypes), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(relationships), "_rels/.rels");
  zip.addBuffer(Buffer.from(model), "3D/3dmodel.model");
  if (secondaryModel) zip.addBuffer(Buffer.from(secondaryModel), "3D/Objects/secondary.model");
  if (bambu) {
    const plateConfig = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Primo"/>
    <model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="1"/></model_instance>
  </plate>
  <plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Secondo"/>
    <model_instance><metadata key="object_id" value="${secondBuildObjectId}"/><metadata key="instance_id" value="${repeatFirstObject ? 2 : 1}"/></model_instance>
  </plate>
</config>`;
    zip.addBuffer(Buffer.from(plateConfig), "Metadata/model_settings.config");
    zip.addBuffer(Buffer.from(JSON.stringify({
      printer_settings_id: "Profilo conservato nel file originale",
      printer_model: "Stampante non usata dalla validazione",
    })), "Metadata/project_settings.config");
  }
  if (gcode) zip.addBuffer(Buffer.from("G1 X0 Y0"), "Metadata/plate_1.gcode");
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

const DEFAULT_PRICING = {
  filamentPriceCentsPerKg: 2000,
  filamentDensityGCm3: 1.24,
  effectiveFillPercent: 25,
  printerPowerWatts: 150,
  energyPriceCentsPerKwh: 30,
  machineHourlyCostCents: 50,
  extrusionRateMm3PerSecond: 8,
  overheadMinutes: 15,
  materialCorrectionFactor: 2.4,
  timeCorrectionFactor: 2.1,
  markupPercent: 20,
  minQuoteCents: 500,
};

test("espone lo stato di salute del server", async () => {
  const response = await fetch(`${baseUrl}/api/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("serve la pagina pubblica con un catalogo accessibile", async () => {
  const response = await fetch(baseUrl);
  const page = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(page, /<html lang="it">/);
  assert.match(page, /<main id="contenuto">/);
  assert.match(page, /<h1 id="titolo-principale">/);
  assert.match(page, /Vai al contenuto/);
  assert.match(page, /id="product-list"/);
  assert.match(page, /id="stato-ordini"/);
  assert.match(page, /id="request-list"/);
  assert.match(page, /id="request-template"/);
  assert.match(page, /href="#stato-ordini"/);
  assert.ok(page.indexOf('id="stato-ordini"') < page.indexOf('id="product-list"'));
  assert.match(page, /id="product-template"/);
  assert.match(page, /id="cart-dialog"/);
  assert.match(page, /id="cart-item-template"/);
  assert.match(page, /id="viewer-dialog"/);
  assert.match(page, /id="custom-model-form"/);
  assert.match(page, /id="custom-file"/);
  assert.match(page, /id="custom-link"/);
  assert.match(page, /id="checkout-dialog"/);
  assert.match(page, /id="checkout-form"/);
  assert.match(page, /id="guest-order-dialog"/);
  assert.match(page, /id="guest-order-continue"/);
  assert.match(page, /id="guest-order-account"/);
  assert.match(page, /<textarea id="order-comment" name="comment"[^>]*maxlength="500"/);
  assert.match(page, /<input id="register-email" name="email" type="email"[^>]*maxlength="254"/);
  assert.match(page, /<input id="login-email" name="email" type="email"[^>]*maxlength="254"/);
  assert.doesNotMatch(page, /id="register-username"/);
  assert.match(page, /id="account-email-verification-form"/);
  assert.match(page, /autocomplete="one-time-code"/);
  assert.match(page, /id="account-email-notifications" type="checkbox"/);
  assert.match(page, /id="account-password-forgot"/);
  assert.match(page, /id="account-password-reset-form"/);
  assert.match(page, /id="confirmation-code"/);
  assert.match(page, /type="importmap"/);
  assert.match(page, /<script type="module" src="\/app.js(\?v=[^"]+)?"><\/script>/);
});

test("serve gli asset pubblici", async () => {
  const paths = [
    "/images/vaso-orbitale.svg",
    "/images/supporto-controller.svg",
    "/app.js",
    "/js/cart.js",
    "/js/viewer.js",
    "/vendor/three/build/three.module.js",
    "/vendor/three/examples/jsm/loaders/3MFLoader.js",
    "/admin.html",
    "/admin.css",
    "/admin.js",
  ];
  const responses = await Promise.all(paths.map((path) => fetch(`${baseUrl}${path}`)));

  for (const response of responses) {
    assert.equal(response.status, 200);
  }
});

test("mostra i dettagli amministrativi dell'ordine in sola lettura", async () => {
  const page = await (await fetch(`${baseUrl}/admin.html`)).text();

  assert.match(page, /<strong id="order-first-name"><\/strong>/);
  assert.match(page, /<strong id="order-last-name"><\/strong>/);
  assert.match(page, /<p id="order-comment"><\/p>/);
  assert.doesNotMatch(page, /id="add-catalog-item"/);
  assert.doesNotMatch(page, /id="save-order"/);
  assert.doesNotMatch(page, /data-field="remove-item"/);
  assert.match(page, /id="settings-button"/);
  assert.match(page, /id="settings-dialog"/);
  assert.match(page, /id="email-notifications-enabled"/);
  assert.match(page, /id="admin-email" name="email" type="email"/);
  assert.match(page, /id="credentials-email" name="email" type="email"/);
});

test("riconosce e usa una configurazione SMTP completa", async () => {
  assert.equal(createEmailService({}).configured, false);
  assert.equal(createEmailService({ SMTP_HOST: "smtp.example.test" }).configured, false);
  let transportOptions;
  let sentMessage;
  const service = createEmailService({
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_FROM: "noreply@example.test",
    SMTP_TO: "ordini@example.test",
  }, (options) => {
    transportOptions = options;
    return { async sendMail(message) { sentMessage = message; } };
  });
  assert.equal(service.configured, true);
  assert.equal(service.recipient, "ordini@example.test");
  assert.equal(transportOptions.secure, true);
  await service.sendOrderEmail({ subject: "Nuovo ordine", text: "Dettagli" });
  assert.deepEqual(sentMessage, {
    from: "noreply@example.test",
    to: "ordini@example.test",
    subject: "Nuovo ordine",
    text: "Dettagli",
  });
  await service.sendOrderEmail({ to: "cliente@example.test", subject: "Stato ordine", text: "In lavorazione" });
  assert.deepEqual(sentMessage, {
    from: "noreply@example.test",
    to: "cliente@example.test",
    subject: "Stato ordine",
    text: "In lavorazione",
  });
});

test("espone i prodotti visibili ordinati", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.data[0].code, "0001");
  assert.equal(body.data[0].priceCents, 1200);
  assert.equal(body.data[1].code, "0002");
});

test("espone il dettaglio di un prodotto", async () => {
  const response = await fetch(`${baseUrl}/api/products/1`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.code, "0001");
  assert.equal(body.data.name, "Vaso Orbitale");
});

test("valida l'identificativo del prodotto", async () => {
  const invalidResponse = await fetch(`${baseUrl}/api/products/non-numerico`);
  const missingResponse = await fetch(`${baseUrl}/api/products/999`);

  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, "INVALID_PRODUCT_ID");
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, "PRODUCT_NOT_FOUND");
});

test("espone i colori attivi", async () => {
  const response = await fetch(`${baseUrl}/api/colors`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 4);
  assert.deepEqual(body.data[0], { id: 1, name: "Nero", hexValue: "#17201A" });
});

test("il seed puo essere eseguito piu volte senza duplicare dati", () => {
  seedDatabase(database);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM colors").get().count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 22);
  assert.ok(database.prepare("SELECT email_verified_at FROM user_accounts LIMIT 1"));
  assert.equal(database.prepare("SELECT email_notifications_enabled FROM app_settings WHERE id = 1").get().email_notifications_enabled, 0);
});

test("migra un catalogo esistente senza perdere dati e impedisce il riuso degli ID", () => {
  const legacyDatabase = new Database(":memory:");
  try {
    legacyDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_migrations (version, name) VALUES
        (1, 'create_catalog'), (2, 'add_demo_model_urls'), (3, 'create_orders');
      CREATE TABLE products (
        id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0), image_url TEXT NOT NULL,
        image_alt TEXT NOT NULL, dimension_label TEXT NOT NULL, dimension_value TEXT NOT NULL,
        material TEXT NOT NULL, model_url TEXT, visible INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE colors (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, hex_value TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX products_visible_sort_idx ON products (visible, sort_order, id);
      CREATE INDEX colors_active_sort_idx ON colors (active, sort_order, id);
      CREATE TABLE order_items (
        id INTEGER PRIMARY KEY, item_type TEXT NOT NULL, model_filename TEXT
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL,
        last_name TEXT NOT NULL, catalog_total_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO products VALUES (
        7, 'LEGACY', 'legacy', 'Legacy', 'Test', 'Dato esistente', 500,
        '/images/legacy.png', 'Legacy', 'Lato', '5 cm', 'PLA', NULL, 1, 10,
        '2025-01-01 10:00:00', '2025-02-01 10:00:00'
      );
      INSERT INTO colors VALUES (
        9, 'Legacy', '#123456', 1, 10, '2025-01-01 10:00:00', '2025-02-01 10:00:00'
      );
      INSERT INTO order_items (id, item_type, model_filename) VALUES (1, 'custom_file', 'legacy.stl');
      INSERT INTO orders (id, code, first_name, last_name, catalog_total_cents)
      VALUES (1, 'LEGACY-ORDER', 'Nome', 'Storico', 0);
    `);

    const productBefore = legacyDatabase.prepare("SELECT id, code, name, description, price_cents, image_url, material, model_url, visible, created_at, updated_at FROM products").get();
    const colorBefore = legacyDatabase.prepare("SELECT * FROM colors").get();
    migrateDatabase(legacyDatabase);

    assert.deepEqual(legacyDatabase.prepare("SELECT id, code, name, description, price_cents, image_url, material, model_url, visible, created_at, updated_at FROM products").get(), productBefore);
    assert.deepEqual(legacyDatabase.prepare("SELECT * FROM colors").get(), colorBefore);
    assert.match(legacyDatabase.prepare("SELECT sql FROM sqlite_master WHERE name = 'products'").get().sql, /AUTOINCREMENT/);
    assert.match(legacyDatabase.prepare("SELECT sql FROM sqlite_master WHERE name = 'colors'").get().sql, /AUTOINCREMENT/);
    assert.equal(legacyDatabase.prepare("SELECT model_format FROM order_items WHERE id = 1").get().model_format, "stl");
    assert.equal(legacyDatabase.prepare("SELECT status FROM orders WHERE id = 1").get().status, "in_attesa");
    assert.equal(legacyDatabase.prepare("SELECT comment FROM orders WHERE id = 1").get().comment, null);
    assert.equal(legacyDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 22);
    assert.equal(legacyDatabase.prepare("SELECT COUNT(*) AS count FROM email_verification_tokens").get().count, 0);
    assert.equal(legacyDatabase.prepare("SELECT email_notifications_enabled FROM app_settings WHERE id = 1").get().email_notifications_enabled, 0);
    assert.equal(legacyDatabase.prepare("SELECT admin_username FROM app_settings WHERE id = 1").get().admin_username, null);
      legacyDatabase.prepare("DELETE FROM products WHERE id = 7").run();
      const nextId = Number(legacyDatabase.prepare(`
        INSERT INTO products (code, name, description, price_cents, image_url, material)
        VALUES ('NEXT', 'Next', 'Next', 1, '/next.png', 'PLA')
      `).run().lastInsertRowid);
    assert.ok(nextId > 7);
  } finally {
    legacyDatabase.close();
  }
});

test("rimuove i vecchi account cliente conservando gli ordini come ospite", () => {
  const previousDatabase = openDatabase(":memory:");
  try {
    seedDatabase(previousDatabase);
    const accountId = Number(previousDatabase.prepare(`
      INSERT INTO user_accounts (username, password_hash, first_name, last_name)
      VALUES ('vecchio.cliente', 'hash', 'Vecchio', 'Cliente')
    `).run().lastInsertRowid);
    const orderId = Number(previousDatabase.prepare(`
      INSERT INTO orders (code, first_name, last_name, catalog_total_cents, user_account_id)
      VALUES ('PPL-LEGACY-ACCOUNT', 'Vecchio', 'Cliente', 1200, ?)
    `).run(accountId).lastInsertRowid);
    previousDatabase.exec(`
      DROP INDEX user_accounts_email_idx;
      DELETE FROM schema_migrations WHERE version = 20;
    `);

    migrateDatabase(previousDatabase);

    assert.equal(previousDatabase.prepare("SELECT COUNT(*) AS count FROM user_accounts WHERE auth_source = 'local'").get().count, 0);
    assert.equal(previousDatabase.prepare("SELECT user_account_id FROM orders WHERE id = ?").get(orderId).user_account_id, null);
    assert.ok(previousDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'user_accounts_email_idx'").get());
  } finally {
    previousDatabase.close();
  }
});

test("carica, serve ed elimina un file 3MF valido", async () => {
  const model3mf = await create3mfCubeBuffer(10);
  const form = new FormData();
  form.append("model", new Blob([model3mf], { type: "model/3mf" }), "prova.3mf");

  const uploadResponse = await fetch(`${baseUrl}/api/custom-models/upload`, {
    method: "POST",
    body: form,
  });
  const upload = await uploadResponse.json();

  assert.equal(uploadResponse.status, 201);
  assert.equal(upload.data.name, "prova.3mf");
  assert.match(upload.data.id, /^[0-9a-f-]{36}$/);
  assert.match(upload.data.modelUrl, /^\/uploads\/[0-9a-f-]{36}\.3mf$/);

  const modelResponse = await fetch(`${baseUrl}${upload.data.modelUrl}`);
  assert.equal(modelResponse.status, 200);
  assert.equal(modelResponse.headers.get("content-type"), "model/3mf");
  assert.deepEqual(Buffer.from(await modelResponse.arrayBuffer()), model3mf);

  const deleteResponse = await fetch(`${baseUrl}/api/custom-models/${upload.data.id}`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal((await fetch(`${baseUrl}${upload.data.modelUrl}`)).status, 404);
});

test("ispeziona, serve ed elimina un archivio 3MF generico", async () => {
  const archive = await create3mfBuffer();
  const form = new FormData();
  form.append("model", new Blob([archive], { type: "model/3mf" }), "progetto.3mf");
  const response = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.modelFormat, "3mf");
  assert.equal(body.data.inspection.projectType, "generic");
  assert.equal(body.data.inspection.plateCount, 1);
  assert.deepEqual(body.data.inspection.previewBuildItemIndexes, [0, 1]);
  assert.deepEqual(body.data.inspection.boundsMm.size, [450, 200, 40]);
  assert.equal(body.data.inspection.compatibility.status, "incompatible");
  assert.deepEqual(body.data.inspection.referencePlate.volumeMm, [256, 256, 256]);
  const fileResponse = await fetch(`${baseUrl}${body.data.modelUrl}`);
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get("content-type"), "model/3mf");
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), archive);
  assert.equal((await fetch(`${baseUrl}/api/custom-models/${body.data.id}`, { method: "DELETE" })).status, 204);
});

test("accetta un singolo pezzo distribuito in piu parti modello 3MF", async () => {
  const rootModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><components><component objectid="3"/></components></object></resources>
  <build><item objectid="1"/></build>
</model>`;
  const secondaryModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="3" type="model"><mesh><vertices>
    <vertex x="0" y="0" z="0"/><vertex x="12" y="0" z="0"/><vertex x="0" y="14" z="0"/>
  </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
</model>`;
  const form = new FormData();
  form.append("model", new Blob([await create3mfBuffer({ modelOverride: rootModel, secondaryModel })]), "multipart.3mf");
  const response = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  const model = (await response.json()).data;
  assert.equal(response.status, 201);
  assert.deepEqual(model.inspection.boundsMm.size, [12, 14, 0]);
  await fetch(`${baseUrl}/api/custom-models/${model.id}`, { method: "DELETE" });
});

test("rifiuta G-code 3MF e documenti XML non validi senza lasciare upload", async () => {
  const generic = await create3mfBuffer();
  const namedGcode = new FormData();
  namedGcode.append("model", new Blob([generic]), "progetto.gcode.3mf");
  const namedResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: namedGcode });
  assert.equal(namedResponse.status, 400);
  assert.equal((await namedResponse.json()).error.code, "GCODE_3MF_NOT_SUPPORTED");

  const embeddedGcode = new FormData();
  embeddedGcode.append("model", new Blob([await create3mfBuffer({ gcode: true })]), "rinominato.3mf");
  const embeddedResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: embeddedGcode });
  assert.equal(embeddedResponse.status, 400);
  assert.equal((await embeddedResponse.json()).error.code, "GCODE_3MF_NOT_SUPPORTED");

  const malformed = new FormData();
  malformed.append("model", new Blob([await create3mfBuffer({ malformedModel: true })]), "rotto.3mf");
  const malformedResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: malformed });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).error.code, "INVALID_3MF_XML");
  assert.equal((await readdir(uploadDirectory)).length, 0);
});

test("usa un unico piatto standard come riferimento informativo", async () => {
  for (const scenario of [
    { size: 250, expectedStatus: "compatible" },
    { size: 260, expectedStatus: "incompatible" },
    { size: 256.0004, expectedStatus: "incompatible" },
  ]) {
    const archive = await create3mfBuffer({
      bambu: true,
      firstSize: [scenario.size, 30, 40],
    });
    const form = new FormData();
    form.append("model", new Blob([archive]), `standard-${scenario.size}.3mf`);
    const response = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
    const model = (await response.json()).data;
    assert.equal(response.status, 201);
    assert.equal(model.inspection.compatibility.status, scenario.expectedStatus);
    assert.equal(model.inspection.compatibility.target, "Piatto standard");
    if (scenario.expectedStatus === "incompatible") {
      assert.equal(model.inspection.compatibility.warnings[0].message, "Il modello potrebbe essere troppo grande: forse dovremo ridurlo o separarlo in piu parti.");
    }
    await fetch(`${baseUrl}/api/custom-models/${model.id}`, { method: "DELETE" });
  }
});

test("rifiuta grafi di componenti 3MF ciclici", async () => {
  const cyclicModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model"><components><component objectid="2"/></components></object>
    <object id="2" type="model"><components><component objectid="1"/></components></object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;
  const form = new FormData();
  form.append("model", new Blob([await create3mfBuffer({ modelOverride: cyclicModel })]), "ciclo.3mf");
  const response = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_3MF_COMPONENTS");
  assert.equal((await readdir(uploadDirectory)).length, 0);
});

test("seleziona l'istanza esatta quando due piatti Bambu riusano lo stesso oggetto", async () => {
  const form = new FormData();
  form.append("model", new Blob([await create3mfBuffer({ bambu: true, repeatFirstObject: true })]), "istanze.3mf");
  const response = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  const model = (await response.json()).data;
  assert.equal(response.status, 201);
  assert.deepEqual(model.inspection.previewBuildItemIndexes, [0]);
  assert.deepEqual(model.inspection.boundsMm.size, [20, 30, 40]);
  await fetch(`${baseUrl}/api/custom-models/${model.id}`, { method: "DELETE" });
});

test("rifiuta estensioni e contenuti 3MF non validi", async () => {
  const wrongExtension = new FormData();
  wrongExtension.append("model", new Blob(["solid test"]), "prova.txt");
  const extensionResponse = await fetch(`${baseUrl}/api/custom-models/upload`, {
    method: "POST",
    body: wrongExtension,
  });

  const invalidContent = new FormData();
  invalidContent.append("model", new Blob([createInvalid3mfBuffer()]), "prova.3mf");
  const contentResponse = await fetch(`${baseUrl}/api/custom-models/upload`, {
    method: "POST",
    body: invalidContent,
  });

  assert.equal(extensionResponse.status, 400);
  assert.equal((await extensionResponse.json()).error.code, "INVALID_MODEL_EXTENSION");
  assert.equal(contentResponse.status, 400);
  assert.equal((await contentResponse.json()).error.code, "INVALID_3MF_ARCHIVE");
  assert.equal((await readdir(uploadDirectory)).length, 0);
  assert.equal(MAX_UPLOAD_FILE_SIZE, 500 * 1024 * 1024);
});

test("rifiuta un file che supera 500 MB", async () => {
  const form = new FormData();
  form.append("model", new Blob([new Uint8Array(MAX_UPLOAD_FILE_SIZE + 1)]), "troppo-grande.3mf");

  const response = await fetch(`${baseUrl}/api/custom-models/upload`, {
    method: "POST",
    body: form,
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.error.code, "MODEL_TOO_LARGE");
  assert.equal((await readdir(uploadDirectory)).length, 0);
});

test("accetta soltanto link HTTPS da MakerWorld", async () => {
  const allowedResponse = await fetch(`${baseUrl}/api/custom-models/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://makerworld.com/en/models/123-prova" }),
  });
  const deceptiveResponse = await fetch(`${baseUrl}/api/custom-models/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://makerworld.com.example.org/en/models/123" }),
  });
  const httpResponse = await fetch(`${baseUrl}/api/custom-models/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://makerworld.com/en/models/123" }),
  });

  const allowed = await allowedResponse.json();
  assert.equal(allowedResponse.status, 201);
  assert.equal(allowed.data.sourceName, "MakerWorld");
  assert.equal(deceptiveResponse.status, 400);
  assert.equal((await deceptiveResponse.json()).error.code, "LINK_NOT_ALLOWED");
  assert.equal(httpResponse.status, 400);
  assert.equal((await httpResponse.json()).error.code, "INVALID_LINK");
});

test("elimina gli upload temporanei scaduti", async () => {
  const expiredFile = path.join(uploadDirectory, "expired.3mf");
  await writeFile(expiredFile, "questo non e un 3mf valido");
  const expiredDate = new Date(Date.now() - UPLOAD_TTL_MS - 1000);
  await utimes(expiredFile, expiredDate, expiredDate);

  await cleanupExpiredUploads(uploadDirectory);

  await assert.rejects(stat(expiredFile), { code: "ENOENT" });
});

test("conserva progetto Bambu 3MF, primo piatto e metadati nell'ordine", async () => {
  const archive = await create3mfBuffer({ bambu: true });
  const uploadForm = new FormData();
  uploadForm.append("model", new Blob([archive], { type: "model/3mf" }), "bambu-a1-mini.3mf");
  const uploadResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: uploadForm });
  const upload = (await uploadResponse.json()).data;
  assert.equal(uploadResponse.status, 201);
  assert.equal(upload.inspection.projectType, "bambu");
  assert.equal(upload.inspection.plateCount, 2);
  assert.deepEqual(upload.inspection.previewBuildItemIndexes, [0]);
  assert.deepEqual(upload.inspection.boundsMm.size, [20, 30, 40]);
  assert.deepEqual(upload.inspection.referencePlate.volumeMm, [256, 256, 256]);
  assert.equal(upload.inspection.compatibility.status, "compatible");

  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Ada",
      lastName: "Bambu",
      items: [{
        type: "custom",
        sourceType: "file",
        id: upload.id,
        name: upload.name,
        modelFormat: "3mf",
        colorId: 1,
        quantity: 1,
      }],
    }),
  });
  const code = (await orderResponse.json()).data.code;
  assert.equal(orderResponse.status, 201);
  const order = database.prepare("SELECT * FROM orders WHERE code = ?").get(code);
  const storedItem = database.prepare("SELECT * FROM order_items WHERE order_id = ?").get(order.id);
  assert.equal(storedItem.model_format, "3mf");
  assert.equal(JSON.parse(storedItem.model_metadata_json).plateCount, 2);
  assert.deepEqual(await readFile(path.join(orderFileDirectory, storedItem.model_filename)), archive);
  assert.equal((await fetch(`${baseUrl}${upload.modelUrl}`)).status, 404);

  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  const detail = (await (await adminFetch(`/api/admin/orders/${order.id}`)).json()).data;
  assert.equal(detail.items[0].modelFormat, "3mf");
  assert.equal(detail.items[0].modelMetadata.previewPlate, 1);
  const download = await adminFetch(`/api/admin/orders/${order.id}/items/${detail.items[0].id}/model`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "model/3mf");
  assert.match(download.headers.get("content-disposition"), /bambu-a1-mini\.3mf/i);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), archive);

  const update = await adminFetch(`/api/admin/orders/${order.id}`, {
    method: "PUT",
  });
  assert.equal(update.status, 404);
  assert.equal((await adminFetch(`/api/admin/orders/${order.id}`, { method: "DELETE" })).status, 204);
  await assert.rejects(stat(path.join(orderFileDirectory, storedItem.model_filename)), { code: "ENOENT" });
});

test("crea una richiesta mista con snapshot e file permanente senza email automatica", async () => {
  const model3mf = await create3mfCubeBuffer(10);
  const uploadForm = new FormData();
  uploadForm.append("model", new Blob([model3mf], { type: "model/3mf" }), "ordine-personale.3mf");
  const uploadResponse = await fetch(`${baseUrl}/api/custom-models/upload`, {
    method: "POST",
    body: uploadForm,
  });
  const upload = (await uploadResponse.json()).data;

  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "  Mauro ",
      lastName: " Rossi  ",
      comment: "  Vorrei la superficie liscia.\r\nGrazie.  ",
      items: [
        { type: "catalog", productId: 1, colorId: 1, quantity: 2, priceCents: 1 },
        {
          type: "custom",
          sourceType: "file",
          id: upload.id,
          name: upload.name,
          colorId: 2,
          quantity: 1,
        },
        {
          type: "custom",
          sourceType: "link",
          externalUrl: "https://www.makerworld.com/en/models/123-test",
          colorId: 3,
          quantity: 4,
        },
      ],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(body.data), ["code"]);
  assert.match(body.data.code, /^[A-Z]{2}-\d{4}$/);

  const order = database.prepare("SELECT * FROM orders WHERE code = ?").get(body.data.code);
  const items = database
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY position")
    .all(order.id);
  assert.equal(order.first_name, "Mauro");
  assert.equal(order.last_name, "Rossi");
  assert.equal(order.comment, "Vorrei la superficie liscia.\nGrazie.");
  assert.equal(order.catalog_total_cents, 2400);
  assert.equal(order.status, "in_attesa");
  assert.equal(order.user_account_id, null);
  assert.equal(items.length, 3);
  assert.equal(items[0].product_name, "Vaso Orbitale");
  assert.equal(items[0].unit_price_cents, 1200);
  assert.equal(items[0].color_name, "Nero");
  assert.equal(items[1].item_type, "custom_file");
  assert.equal(items[1].original_name, "ordine-personale.3mf");
  assert.equal(JSON.parse(items[1].quote_json).grams, 0.7);
  assert.equal(items[2].item_type, "custom_link");
  assert.equal(items[2].source_name, "MakerWorld");

  const cookie = await authenticateAdmin();
  const orderDetail = (await (await fetch(`${baseUrl}/api/admin/orders/${order.id}`, {
    headers: { cookie },
  })).json()).data;
  assert.equal(orderDetail.comment, "Vorrei la superficie liscia.\nGrazie.");
  const actualResponse = await fetch(`${baseUrl}/api/admin/orders/${order.id}/items/${items[1].id}/actual-quote`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ grams: 4.53, hours: 22.6 / 60 }),
  });
  const actual = (await actualResponse.json()).data;
  assert.equal(actualResponse.status, 200);
  assert.equal(actual.actualGrams, 4.53);
  assert.equal(actual.actualQuote.unitPriceCents, 500);
  assert.equal(database.prepare("SELECT unit_price_cents FROM order_items WHERE id = ?").get(items[1].id).unit_price_cents, 500);

  await stat(path.join(orderFileDirectory, items[1].model_filename));
  assert.equal((await fetch(`${baseUrl}${upload.modelUrl}`)).status, 404);
  assert.equal(sentEmails.length, 0);
});

test("gestisce l'invio SMTP opzionale dalle impostazioni amministrative", async () => {
  assert.equal((await fetch(`${baseUrl}/api/admin/settings`)).status, 401);
  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  const initial = (await (await adminFetch("/api/admin/settings")).json()).data;
  assert.deepEqual(initial, {
    emailNotificationsEnabled: false,
    smtpConfigured: true,
    smtpRecipient: "ordini@example.test",
    adminEmail: "admin@example.test",
    adminCredentialsCustomized: false,
    pricing: DEFAULT_PRICING,
  });

  const invalid = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: "true" }),
  });
  assert.equal(invalid.status, 400);

  emailService.configured = false;
  const unavailable = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: true }),
  });
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).error.code, "SMTP_NOT_CONFIGURED");
  emailService.configured = true;

  const enabled = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.equal(database.prepare("SELECT email_notifications_enabled FROM app_settings WHERE id = 1").get().email_notifications_enabled, 1);

  const createOrder = (firstName) => fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName,
      lastName: "Email",
      comment: "Consegnare nel pomeriggio.",
      items: [{ type: "catalog", productId: 2, colorId: 4, quantity: 1 }],
    }),
  });
  const sentResponse = await createOrder("Invio");
  const sentCode = (await sentResponse.json()).data.code;
  assert.equal(sentResponse.status, 201);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].subject, `Nuova richiesta ${sentCode}`);
  assert.match(sentEmails[0].text, /Nome: Invio/);
  assert.match(sentEmails[0].text, /Commento: Consegnare nel pomeriggio\./);
  assert.match(sentEmails[0].text, /Dock Controller/);

  rejectEmails = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  let failedResponse;
  try {
    failedResponse = await createOrder("Errore");
  } finally {
    console.error = originalConsoleError;
    rejectEmails = false;
  }
  const failedCode = (await failedResponse.json()).data.code;
  assert.equal(failedResponse.status, 201);
  assert.ok(database.prepare("SELECT id FROM orders WHERE code = ?").get(failedCode));

  const disabled = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: false }),
  });
  assert.equal(disabled.status, 200);
  database.prepare("DELETE FROM orders WHERE code IN (?, ?)").run(sentCode, failedCode);
});

test("stima il costo di un modello 3MF dal volume misurato", async () => {
  const form = new FormData();
  form.append("model", new Blob([await create3mfCubeBuffer(10)], { type: "model/3mf" }), "cubo.3mf");
  const uploadResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  const upload = (await uploadResponse.json()).data;
  assert.equal(uploadResponse.status, 201);

  const quoteResponse = await fetch(`${baseUrl}/api/custom-models/${upload.id}/quote`);
  const quote = (await quoteResponse.json()).data;
  assert.equal(quoteResponse.status, 200);
  assert.equal(quote.id, upload.id);
  assert.equal(quote.modelFormat, "3mf");
  assert.equal(quote.volumeMm3, 1000);
  assert.equal(quote.grams, 0.7);
  assert.equal(quote.hours, 0.54);
  assert.deepEqual(quote.breakdown, { materialCents: 1, energyCents: 2, wearCents: 27 });
  assert.equal(quote.unitPriceCents, 500);
  assert.equal(quote.estimateOnly, true);
  assert.equal(quote.plates.length, 1);
  assert.equal(quote.plates[0].id, 1);
  assert.equal(quote.plates[0].volumeMm3, 1000);
  assert.equal(quote.plates[0].unitPriceCents, 500);
  await fetch(`${baseUrl}/api/custom-models/${upload.id}`, { method: "DELETE" });
});

test("stima il costo di un modello 3MF dal volume misurato", async () => {
  const form = new FormData();
  form.append("model", new Blob([await create3mfBuffer()], { type: "model/3mf" }), "tetra.3mf");
  const uploadResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  const upload = (await uploadResponse.json()).data;
  assert.equal(uploadResponse.status, 201);

  const quoteResponse = await fetch(`${baseUrl}/api/custom-models/${upload.id}/quote`);
  const quote = (await quoteResponse.json()).data;
  assert.equal(quoteResponse.status, 200);
  assert.equal(quote.modelFormat, "3mf");
  assert.equal(quote.volumeMm3, 4000);
  assert.equal(quote.grams, 3);
  assert.equal(quote.unitPriceCents, 500);
  assert.equal(quote.plates.length, 1);
  assert.equal(quote.plates[0].id, 1);
  assert.equal(quote.plates[0].volumeMm3, 4000);
  assert.equal(quote.plates[0].unitPriceCents, 500);
  await fetch(`${baseUrl}/api/custom-models/${upload.id}`, { method: "DELETE" });
});

test("stima il progetto Bambu sommando i volumi dei piatti", async () => {
  const form = new FormData();
  form.append("model", new Blob([await create3mfBuffer({
    bambu: true,
    repeatFirstObject: true,
    secondTransform: "1 0 0 0 1 0 0 0 1 0 0 0",
  })], { type: "model/3mf" }), "multi-piatto.3mf");
  const uploadResponse = await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form });
  const upload = (await uploadResponse.json()).data;
  assert.equal(uploadResponse.status, 201);
  assert.equal(upload.inspection.plateCount, 2);
  assert.equal(upload.inspection.totalVolumeMm3, 8000);
  assert.equal(upload.inspection.plates.length, 2);
  assert.equal(upload.inspection.plates[0].volumeMm3, 4000);
  assert.equal(upload.inspection.plates[1].volumeMm3, 4000);

  const quoteResponse = await fetch(`${baseUrl}/api/custom-models/${upload.id}/quote`);
  const quote = (await quoteResponse.json()).data;
  assert.equal(quoteResponse.status, 200);
  assert.equal(quote.volumeMm3, 8000);
  assert.equal(quote.grams, 6);
  assert.equal(quote.unitPriceCents, 1000);
  assert.equal(quote.plates.length, 2);
  assert.equal(quote.plates[0].id, 1);
  assert.equal(quote.plates[0].volumeMm3, 4000);
  assert.equal(quote.plates[0].unitPriceCents, 500);
  assert.equal(quote.plates[1].id, 2);
  assert.equal(quote.plates[1].volumeMm3, 4000);
  assert.equal(quote.plates[1].unitPriceCents, 500);
  await fetch(`${baseUrl}/api/custom-models/${upload.id}`, { method: "DELETE" });
});

test("risponde 404 alla stima di un upload inesistente e 400 a un identificativo non valido", async () => {
  const missing = await fetch(`${baseUrl}/api/custom-models/${crypto.randomUUID()}/quote`);
  assert.equal(missing.status, 404);
  const invalid = await fetch(`${baseUrl}/api/custom-models/non-un-uuid/quote`);
  assert.equal(invalid.status, 400);
});

test("aggiorna i parametri di costo dalle impostazioni e li applica alle stime", async () => {
  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });

  const invalidPricing = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: false, pricing: { ...DEFAULT_PRICING, markupPercent: -5 } }),
  });
  assert.equal(invalidPricing.status, 400);

  const customPricing = { ...DEFAULT_PRICING, filamentPriceCentsPerKg: 30000, minQuoteCents: 0, markupPercent: 0 };
  const updated = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: false, pricing: customPricing }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).data.pricing, customPricing);

  const form = new FormData();
  form.append("model", new Blob([await create3mfCubeBuffer(10)], { type: "model/3mf" }), "cubo-prezzo.3mf");
  const upload = (await (await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: form })).json()).data;
  const quote = (await (await fetch(`${baseUrl}/api/custom-models/${upload.id}/quote`)).json()).data;
  assert.equal(quote.unitPriceCents, 52);
  assert.equal(quote.breakdown.materialCents, 22);
  await fetch(`${baseUrl}/api/custom-models/${upload.id}`, { method: "DELETE" });

  const restored = await adminFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: false, pricing: DEFAULT_PRICING }),
  });
  assert.equal(restored.status, 200);
});

test("rispetta il limite di 15 ordini in lavorazione", async () => {
  const maxOpenOrders = 15;
  const existingOpenOrders = database.prepare("SELECT COUNT(*) AS count FROM orders WHERE status != 'completato'").get().count;
  const ordersToInsert = Math.max(0, maxOpenOrders - existingOpenOrders);

  const insertOrder = database.prepare(`
    INSERT INTO orders (code, first_name, last_name, catalog_total_cents, status)
    VALUES (@code, 'Limite', 'Test', 0, 'in_attesa')
  `);
  for (let i = 0; i < ordersToInsert; i += 1) {
    insertOrder.run({ code: `CAP-${String(i).padStart(3, "0")}` });
  }

  try {
    const fullResponse = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Pieno",
        lastName: "Test",
        items: [{ type: "catalog", productId: 2, colorId: 4, quantity: 1 }],
      }),
    });
    assert.equal(fullResponse.status, 503);
    const fullBody = await fullResponse.json();
    assert.equal(fullBody.error.code, "ORDER_CAPACITY_REACHED");

    if (ordersToInsert > 0) {
      database.prepare("UPDATE orders SET status = 'completato' WHERE code = 'CAP-000'").run();

      const retryResponse = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Libero",
          lastName: "Test",
          items: [{ type: "catalog", productId: 2, colorId: 4, quantity: 1 }],
        }),
      });
      assert.equal(retryResponse.status, 201);
      const retryCode = (await retryResponse.json()).data.code;
      database.prepare("DELETE FROM orders WHERE code = ?").run(retryCode);
    }
  } finally {
    database.prepare("DELETE FROM orders WHERE code LIKE 'CAP-%'").run();
  }
});

test("archivia gli ordini consegnati e li esclude dalla homepage", async () => {
  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Archivia",
      lastName: "Test",
      items: [{ type: "catalog", productId: 2, colorId: 4, quantity: 1 }],
    }),
  });
  assert.equal(orderResponse.status, 201);
  const { code } = (await orderResponse.json()).data;
  const order = database.prepare("SELECT * FROM orders WHERE code = ?").get(code);

  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });

  const statusResponse = await adminFetch(`/api/admin/orders/${order.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "consegnato" }),
  });
  assert.equal(statusResponse.status, 200);

  const publicOrders = (await (await fetch(`${baseUrl}/api/orders`)).json()).data;
  assert.equal(publicOrders.some((o) => o.code === code), false);

  const activeOrders = (await (await adminFetch("/api/admin/orders")).json()).data;
  assert.equal(activeOrders.some((o) => o.code === code), false);

  const archiveOrders = (await (await adminFetch("/api/admin/orders/archive")).json()).data;
  assert.equal(archiveOrders.some((o) => o.code === code), true);

  database.prepare("DELETE FROM orders WHERE code = ?").run(code);
});


test("gestisce il cambio delle credenziali amministrative", async () => {
  assert.equal((await fetch(`${baseUrl}/api/admin/credentials`, { method: "PUT" })).status, 401);
  const cookie = await authenticateAdmin();
  const putCredentials = (body, sessionCookie = cookie) => fetch(`${baseUrl}/api/admin/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify(body),
  });
  const loginAdmin = (email, password) => fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const wrongPassword = await putCredentials({ currentPassword: "password-sbagliata", password: "nuova-password-1" });
  assert.equal(wrongPassword.status, 401);
  assert.equal((await wrongPassword.json()).error.code, "INVALID_CREDENTIALS");

  const invalidEmail = await putCredentials({ currentPassword: "test-admin-password", email: "NO!" });
  assert.equal(invalidEmail.status, 400);
  assert.equal((await invalidEmail.json()).error.code, "INVALID_EMAIL");

  const shortPassword = await putCredentials({ currentPassword: "test-admin-password", password: "corta" });
  assert.equal(shortPassword.status, 400);
  assert.equal((await shortPassword.json()).error.code, "INVALID_PASSWORD");

  const noChanges = await putCredentials({ currentPassword: "test-admin-password" });
  assert.equal(noChanges.status, 400);
  assert.equal((await noChanges.json()).error.code, "INVALID_CREDENTIALS_UPDATE");

  database.prepare(`
    INSERT INTO user_accounts (username, password_hash, first_name, last_name, email)
    VALUES ('cliente.esistente@example.test', 'hash-fittizio', 'Carlo', 'Rossi', 'cliente.esistente@example.test')
  `).run();
  const conflict = await putCredentials({ currentPassword: "test-admin-password", email: "cliente.esistente@example.test" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "EMAIL_UNAVAILABLE");

  const changed = await putCredentials({
    currentPassword: "test-admin-password",
    email: "nuovo.admin@example.test",
    password: "nuova-password-segreta",
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).data.email, "nuovo.admin@example.test");

  const staleSession = await fetch(`${baseUrl}/api/admin/settings`, { headers: { cookie } });
  assert.equal(staleSession.status, 401);
  assert.equal((await loginAdmin("admin@example.test", "test-admin-password")).status, 401);

  const newLogin = await loginAdmin("nuovo.admin@example.test", "nuova-password-segreta");
  assert.equal(newLogin.status, 201);
  const newCookie = newLogin.headers.get("set-cookie").split(";", 1)[0];
  const settings = (await (await fetch(`${baseUrl}/api/admin/settings`, { headers: { cookie: newCookie } })).json()).data;
  assert.equal(settings.adminEmail, "nuovo.admin@example.test");
  assert.equal(settings.adminCredentialsCustomized, true);

  const freshAuth = createAuthService({ database, adminEmail: "admin@example.test", adminPassword: "test-admin-password" });
  freshAuth.resetAdminCredentials();
  const overrideRow = database.prepare("SELECT admin_username, admin_password_hash FROM app_settings WHERE id = 1").get();
  assert.equal(overrideRow.admin_username, null);
  assert.equal(overrideRow.admin_password_hash, null);
  assert.equal((await loginAdmin("admin@example.test", "test-admin-password")).status, 201);
  database.prepare("DELETE FROM user_accounts WHERE username = 'cliente.esistente@example.test'").run();
});

test("espone pubblicamente soltanto codice e stato in ordine recente", async () => {
  const insert = database.prepare(`
    INSERT INTO orders (code, first_name, last_name, catalog_total_cents, status, created_at)
    VALUES (?, 'Privato', 'Nascosto', 9999, ?, '2099-01-01 10:00:00')
  `);
  const firstId = Number(insert.run("PPL-PUBLIC-OLDER", "completato").lastInsertRowid);
  const secondId = Number(insert.run("PPL-PUBLIC-NEWER", "in_lavorazione").lastInsertRowid);

  const response = await fetch(`${baseUrl}/api/orders`);
  const body = await response.json();
  assert.equal(response.status, 200);
  const newerIndex = body.data.findIndex((order) => order.code === "PPL-PUBLIC-NEWER");
  const olderIndex = body.data.findIndex((order) => order.code === "PPL-PUBLIC-OLDER");
  assert.ok(newerIndex > -1 && olderIndex > -1);
  assert.ok(newerIndex > olderIndex, "L'ordine piu recente deve apparire dopo quello piu vecchio");
  for (const order of body.data) {
    assert.deepEqual(Object.keys(order), ["code", "status"]);
  }
  assert.doesNotMatch(JSON.stringify(body), /Privato|Nascosto|9999|created_at|first_name|items/i);
  assert.throws(
    () => database.prepare("UPDATE orders SET status = 'non_valido' WHERE id = ?").run(firstId),
    /CHECK constraint failed/,
  );

  database.prepare("DELETE FROM orders WHERE id IN (?, ?)").run(firstId, secondId);
});

test("rifiuta richieste manipolate senza creare record", async () => {
  const initialCount = database.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  const requests = [
    {
      firstName: "",
      lastName: "Rossi",
      items: [{ type: "catalog", productId: 1, colorId: 1, quantity: 1 }],
      expectedCode: "INVALID_CUSTOMER",
    },
    {
      firstName: "Mauro",
      lastName: "Rossi",
      comment: "x".repeat(501),
      items: [{ type: "catalog", productId: 1, colorId: 1, quantity: 1 }],
      expectedCode: "INVALID_ORDER_COMMENT",
    },
    {
      firstName: "Mauro",
      lastName: "Rossi",
      items: [{ type: "catalog", productId: 1, colorId: 1, quantity: 100 }],
      expectedCode: "INVALID_QUANTITY",
    },
    {
      firstName: "Mauro",
      lastName: "Rossi",
      items: [
        {
          type: "custom",
          sourceType: "file",
          id: "123e4567-e89b-42d3-a456-426614174000",
          name: "mancante.3mf",
          colorId: 1,
          quantity: 1,
        },
      ],
      expectedCode: "UPLOAD_NOT_FOUND",
    },
    {
      firstName: "Mauro",
      lastName: "Rossi",
      items: [
        {
          type: "custom",
          sourceType: "link",
          externalUrl: "https://makerworld.com.example.org/model/1",
          colorId: 1,
          quantity: 1,
        },
      ],
      expectedCode: "INVALID_LINK",
    },
  ];

  for (const request of requests) {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json();
    assert.ok(response.status >= 400);
    assert.equal(body.error.code, request.expectedCode);
  }

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, initialCount);
});

test("gestisce prodotti, asset e colori senza alterare gli snapshot degli ordini", async () => {
  assert.equal((await fetch(`${baseUrl}/api/admin/catalog`)).status, 401);
  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

  function productForm(overrides = {}) {
    const values = {
      name: "Prodotto Test",
      description: "Prodotto creato dai test amministrativi.",
      priceCents: "1234",
      material: "PLA",
      visible: "true",
      ...overrides,
    };
    const form = new FormData();
    Object.entries(values).forEach(([key, value]) => form.append(key, value));
    return form;
  }

  const invalidUpload = productForm();
  invalidUpload.append("image", new Blob([png], { type: "image/png" }), "valida.png");
  invalidUpload.append("unexpected", new Blob(["file non previsto"]), "extra.txt");
  const invalidResponse = await adminFetch("/api/admin/products", { method: "POST", body: invalidUpload });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await readdir(catalogDirectory)).length, 0);

  const fakeJpeg = Buffer.alloc(107);
  fakeJpeg.set([0xff, 0xd8, 0xff], 0);
  fakeJpeg.set([0xff, 0xd9], fakeJpeg.length - 2);
  const malformedImage = productForm();
  malformedImage.append("image", new Blob([fakeJpeg], { type: "image/jpeg" }), "falso.jpg");
  const malformedResponse = await adminFetch("/api/admin/products", { method: "POST", body: malformedImage });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).error.code, "INVALID_CATALOG_IMAGE");
  assert.equal((await readdir(catalogDirectory)).length, 0);

  const createForm = productForm();
  createForm.append("image", new Blob([png], { type: "image/png" }), "prodotto.png");
  createForm.append("model", new Blob([await create3mfBuffer()], { type: "model/3mf" }), "prodotto.3mf");
  const createResponse = await adminFetch("/api/admin/products", { method: "POST", body: createForm });
  const created = (await createResponse.json()).data;
  assert.equal(createResponse.status, 201);
  assert.match(created.imageUrl, /^\/catalog-assets\/[0-9a-f-]+\.png$/);
  assert.match(created.modelUrl, /^\/catalog-assets\/[0-9a-f-]+\.3mf$/);
  assert.equal((await fetch(`${baseUrl}${created.imageUrl}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}${created.modelUrl}`)).status, 200);

  const colorResponse = await adminFetch("/api/admin/colors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Verde Test", hexValue: "#12AB34", active: true, sortOrder: 90 }),
  });
  const color = (await colorResponse.json()).data;
  assert.equal(colorResponse.status, 201);

  const orderId = Number(database.prepare(`
    INSERT INTO orders (code, first_name, last_name, catalog_total_cents)
    VALUES ('SNAPSHOT-TEST', 'Test', 'Storico', 1234)
  `).run().lastInsertRowid);
  database.prepare(`
    INSERT INTO order_items (
      order_id, position, item_type, product_id, product_code, product_name,
      unit_price_cents, color_id, color_name, color_hex, quantity
    ) VALUES (?, 1, 'catalog', ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(orderId, created.id, created.code, created.name, created.priceCents, color.id, color.name, color.hexValue);
  const snapshotQuery = database.prepare(`
    SELECT product_id, product_code, product_name, unit_price_cents, color_id, color_name, color_hex
    FROM order_items WHERE order_id = ?
  `);
  const originalSnapshot = snapshotQuery.get(orderId);

  const updateResponse = await adminFetch(`/api/admin/products/${created.id}`, {
    method: "PUT",
    body: productForm({ name: "Prodotto Aggiornato", priceCents: "9999", visible: "false" }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).data.visible, false);
  const colorUpdate = await adminFetch(`/api/admin/colors/${color.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Verde Storico", hexValue: "#229944", active: false, sortOrder: 90 }),
  });
  assert.equal(colorUpdate.status, 200);
  assert.equal(database.prepare("SELECT catalog_total_cents FROM orders WHERE id = ?").get(orderId).catalog_total_cents, 1234);
  assert.deepEqual(snapshotQuery.get(orderId), originalSnapshot);
  assert.equal((await fetch(`${baseUrl}/api/products/${created.id}`)).status, 404);

  const blockedDelete = await adminFetch(`/api/admin/colors/${color.id}`, { method: "DELETE" });
  assert.equal(blockedDelete.status, 409);
  assert.equal((await blockedDelete.json()).error.code, "COLOR_IN_USE");

  const catalog = (await (await adminFetch("/api/admin/catalog")).json()).data;
  const reversedColorIds = catalog.colors.map(({ id }) => id).reverse();
  const reorderResponse = await adminFetch("/api/admin/colors/order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: reversedColorIds }),
  });
  assert.equal(reorderResponse.status, 200);
  assert.deepEqual((await reorderResponse.json()).data.map(({ id }) => id), reversedColorIds);

  const imagePath = path.join(catalogDirectory, path.basename(created.imageUrl));
  const modelPath = path.join(catalogDirectory, path.basename(created.modelUrl));
  assert.equal((await adminFetch(`/api/admin/products/${created.id}`, { method: "DELETE" })).status, 204);
  await assert.rejects(stat(imagePath), { code: "ENOENT" });
  await assert.rejects(stat(modelPath), { code: "ENOENT" });
  assert.deepEqual(snapshotQuery.get(orderId), originalSnapshot);

  const replacementForm = productForm({ name: "Prodotto Successivo" });
  replacementForm.append("image", new Blob([png], { type: "image/png" }), "successivo.png");
  const replacementResponse = await adminFetch("/api/admin/products", { method: "POST", body: replacementForm });
  const replacement = (await replacementResponse.json()).data;
  assert.ok(replacement.id > created.id);
  assert.equal((await adminFetch(`/api/admin/products/${replacement.id}`, { method: "DELETE" })).status, 204);

  await adminFetch("/api/admin/colors/order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: catalog.colors.map(({ id }) => id) }),
  });
  database.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
  const deleteColorResponse = await adminFetch(`/api/admin/colors/${color.id}`, { method: "DELETE" });
  assert.equal(deleteColorResponse.status, 200);
  assert.equal((await deleteColorResponse.json()).data.some((c) => c.id === color.id), false);
});

test("accetta un modello 3MF per i prodotti del catalogo", async () => {
  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const productValues = {
    name: "Prodotto 3MF",
    description: "Prodotto con modello 3MF.", priceCents: "1500", material: "PLA",
    visible: "true",
  };
  const buildForm = () => {
    const form = new FormData();
    Object.entries(productValues).forEach(([key, value]) => form.append(key, value));
    form.append("image", new Blob([png], { type: "image/png" }), "prodotto-3mf.png");
    return form;
  };

  const createForm = buildForm();
  createForm.append("model", new Blob([await create3mfBuffer()], { type: "model/3mf" }), "prodotto.3mf");
  const createResponse = await adminFetch("/api/admin/products", { method: "POST", body: createForm });
  const created = (await createResponse.json()).data;
  assert.equal(createResponse.status, 201);
  assert.match(created.modelUrl, /^\/catalog-assets\/[0-9a-f-]+\.3mf$/);
  assert.equal((await fetch(`${baseUrl}${created.modelUrl}`)).status, 200);

  const malformedForm = buildForm();
  malformedForm.append("model", new Blob(["non un archivio"]), "rotto.3mf");
  const malformedResponse = await adminFetch("/api/admin/products", { method: "POST", body: malformedForm });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).error.code, "INVALID_CATALOG_MODEL");

  assert.equal((await adminFetch(`/api/admin/products/${created.id}`, { method: "DELETE" })).status, 204);
  await assert.rejects(stat(path.join(catalogDirectory, path.basename(created.modelUrl))), { code: "ENOENT" });
});

test("gestisce account, storico personale e accesso amministrativo unificato", async () => {
  assert.equal((await fetch(`${baseUrl}/api/account/orders`)).status, 401);

  const missingEmailRegistration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "password-molto-sicura",
      firstName: "Admin",
      lastName: "Cliente",
    }),
  });
  assert.equal(missingEmailRegistration.status, 400);
  assert.equal((await missingEmailRegistration.json()).error.code, "INVALID_EMAIL");

  const reservedAdminEmailRegistration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "password-molto-sicura",
      firstName: "Falso",
      lastName: "Admin",
      email: "ADMIN@example.test",
    }),
  });
  assert.equal(reservedAdminEmailRegistration.status, 409);
  assert.equal((await reservedAdminEmailRegistration.json()).error.code, "EMAIL_UNAVAILABLE");

  const invalidEmailRegistration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "password-molto-sicura",
      firstName: "Email",
      lastName: "Non valida",
      email: "primo@example.test,secondo@example.test",
    }),
  });
  assert.equal(invalidEmailRegistration.status, 400);
  assert.equal((await invalidEmailRegistration.json()).error.code, "INVALID_EMAIL");

  const registration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "password-molto-sicura",
      firstName: "Cliente",
      lastName: "Test",
      email: "Cliente@Example.Test",
    }),
  });
  const registeredAccount = await registration.json();
  const accountCookie = registration.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(registration.status, 201);
  assert.equal(registeredAccount.data.role, "customer");
  assert.equal(registeredAccount.data.email, "cliente@example.test");
  assert.equal(registeredAccount.data.username, "cliente@example.test");
  assert.equal(registeredAccount.data.emailNotificationsEnabled, true);
  assert.equal(registeredAccount.data.emailVerified, false);
  const firstVerificationEmail = sentEmails.at(-1);
  assert.equal(firstVerificationEmail.to, "cliente@example.test");
  assert.match(firstVerificationEmail.subject, /Verifica/);
  const firstVerificationCode = firstVerificationEmail.text.match(/[A-F0-9]{16}/)?.[0];
  assert.ok(firstVerificationCode);
  const duplicateEmailRegistration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "altra-password-molto-sicura",
      firstName: "Cliente",
      lastName: "Duplicato",
      email: "CLIENTE@example.test",
    }),
  });
  assert.equal(duplicateEmailRegistration.status, 409);
  assert.equal((await duplicateEmailRegistration.json()).error.code, "EMAIL_UNAVAILABLE");
  assert.equal(database.prepare("SELECT password_hash FROM user_accounts WHERE username = ?").get("cliente@example.test").password_hash.includes("password-molto-sicura"), false);

  const accountFetch = (pathName, options = {}) =>
    fetch(`${baseUrl}${pathName}`, {
      ...options,
      headers: { cookie: accountCookie, ...(options.headers ?? {}) },
    });
  const session = await accountFetch("/api/account/session");
  assert.equal(session.status, 200);
  const sessionAccount = (await session.json()).data;
  assert.equal(sessionAccount.username, "cliente@example.test");
  assert.equal(sessionAccount.email, "cliente@example.test");
  assert.equal(sessionAccount.emailVerified, false);
  assert.equal((await accountFetch("/api/admin/session")).status, 403);

  const orderResponse = await accountFetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Cliente",
      lastName: "Test",
      comment: "Lasciare il supporto attaccato.",
      items: [{ type: "catalog", productId: 1, colorId: 1, quantity: 2 }],
    }),
  });
  const order = (await orderResponse.json()).data;
  assert.equal(orderResponse.status, 201);
  const savedOrder = database.prepare("SELECT * FROM orders WHERE code = ?").get(order.code);
  assert.equal(savedOrder.user_account_id, registeredAccount.data.id);

  const historyResponse = await accountFetch("/api/account/orders");
  const history = (await historyResponse.json()).data;
  assert.equal(historyResponse.status, 200);
  assert.equal(history.length, 1);
  assert.equal(history[0].code, order.code);
  assert.equal(history[0].comment, "Lasciare il supporto attaccato.");
  assert.equal(history[0].totalPriceCents, 2400);
  assert.equal(history[0].priceStatus, "confirmed");
  assert.equal(history[0].items[0].productName, "Vaso Orbitale");
  assert.equal(history[0].items[0].unitPriceCents, 1200);
  assert.equal(history[0].items[0].lineTotalCents, 2400);
  assert.equal(history[0].items[0].priceStatus, "confirmed");

  const customForm = new FormData();
  customForm.append("model", new Blob([await create3mfCubeBuffer(10)], { type: "model/3mf" }), "storico-personale.3mf");
  const customUpload = (await (await fetch(`${baseUrl}/api/custom-models/upload`, { method: "POST", body: customForm })).json()).data;
  const customOrderResponse = await accountFetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Cliente",
      lastName: "Test",
      items: [{
        type: "custom",
        sourceType: "file",
        id: customUpload.id,
        name: customUpload.name,
        modelFormat: customUpload.modelFormat,
        colorId: 1,
        quantity: 1,
      }],
    }),
  });
  const customOrder = (await customOrderResponse.json()).data;
  assert.equal(customOrderResponse.status, 201);
  const savedCustomOrder = database.prepare("SELECT * FROM orders WHERE code = ?").get(customOrder.code);
  const savedCustomItem = database.prepare("SELECT * FROM order_items WHERE order_id = ?").get(savedCustomOrder.id);

  const estimatedHistory = (await (await accountFetch("/api/account/orders")).json()).data;
  const estimatedCustom = estimatedHistory.find((entry) => entry.code === customOrder.code);
  assert.equal(estimatedCustom.totalPriceCents, 500);
  assert.equal(estimatedCustom.priceStatus, "estimated");
  assert.equal(estimatedCustom.items[0].unitPriceCents, 500);
  assert.equal(estimatedCustom.items[0].priceStatus, "estimated");
  assert.equal(estimatedCustom.items[0].estimatedQuote.unitPriceCents, 500);

  const adminCookieForQuote = await authenticateAdmin();
  const notificationCountBeforeVerification = sentEmails.length;
  const unverifiedInProgressResponse = await fetch(`${baseUrl}/api/admin/orders/${savedOrder.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ status: "in_lavorazione" }),
  });
  assert.equal(unverifiedInProgressResponse.status, 200);
  assert.equal(sentEmails.length, notificationCountBeforeVerification);
  await fetch(`${baseUrl}/api/admin/orders/${savedOrder.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ status: "in_attesa" }),
  });

  const resendVerification = await accountFetch("/api/account/email/resend", { method: "POST" });
  assert.equal(resendVerification.status, 204);
  const resentVerificationCode = sentEmails.at(-1).text.match(/[A-F0-9]{16}/)?.[0];
  assert.ok(resentVerificationCode);
  assert.notEqual(resentVerificationCode, firstVerificationCode);
  const staleVerification = await accountFetch("/api/account/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: firstVerificationCode }),
  });
  assert.equal(staleVerification.status, 400);
  assert.equal((await staleVerification.json()).error.code, "INVALID_EMAIL_CODE");
  database.prepare("UPDATE email_verification_tokens SET expires_at = 0 WHERE user_account_id = ?").run(registeredAccount.data.id);
  const expiredVerification = await accountFetch("/api/account/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: resentVerificationCode }),
  });
  assert.equal(expiredVerification.status, 410);
  assert.equal((await expiredVerification.json()).error.code, "EMAIL_CODE_EXPIRED");
  assert.equal((await accountFetch("/api/account/email/resend", { method: "POST" })).status, 204);
  const validVerificationCode = sentEmails.at(-1).text.match(/[A-F0-9]{16}/)?.[0];
  const validVerification = await accountFetch("/api/account/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: validVerificationCode.toLowerCase() }),
  });
  assert.equal(validVerification.status, 200);
  assert.equal((await validVerification.json()).data.emailVerified, true);
  assert.ok(database.prepare("SELECT email_verified_at FROM user_accounts WHERE id = ?").get(registeredAccount.data.id).email_verified_at);

  const invalidPreference = await accountFetch("/api/account/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: "false" }),
  });
  assert.equal(invalidPreference.status, 400);
  assert.equal((await invalidPreference.json()).error.code, "INVALID_EMAIL_PREFERENCE");
  const disableNotifications = await accountFetch("/api/account/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: false }),
  });
  assert.equal(disableNotifications.status, 200);
  assert.equal((await disableNotifications.json()).data.emailNotificationsEnabled, false);
  const disabledNotificationCount = sentEmails.length;
  await fetch(`${baseUrl}/api/admin/orders/${savedOrder.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ status: "in_lavorazione" }),
  });
  assert.equal(sentEmails.length, disabledNotificationCount);
  await fetch(`${baseUrl}/api/admin/orders/${savedOrder.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ status: "in_attesa" }),
  });
  const enableNotifications = await accountFetch("/api/account/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailNotificationsEnabled: true }),
  });
  assert.equal(enableNotifications.status, 200);
  assert.equal((await enableNotifications.json()).data.emailNotificationsEnabled, true);

  const notificationCount = sentEmails.length;
  const inProgressResponse = await fetch(`${baseUrl}/api/admin/orders/${savedOrder.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ status: "in_lavorazione" }),
  });
  assert.equal(inProgressResponse.status, 200);
  assert.equal(sentEmails.length, notificationCount + 1);
  assert.equal(sentEmails.at(-1).to, "cliente@example.test");
  assert.match(sentEmails.at(-1).subject, new RegExp(savedOrder.code));
  const repeatedStatusResponse = await fetch(`${baseUrl}/api/admin/orders/${savedOrder.id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ status: "in_lavorazione" }),
  });
  assert.equal(repeatedStatusResponse.status, 200);
  assert.equal(sentEmails.length, notificationCount + 1);
  const confirmedQuoteResponse = await fetch(`${baseUrl}/api/admin/orders/${savedCustomOrder.id}/items/${savedCustomItem.id}/actual-quote`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ grams: 4.53, hours: 22.6 / 60 }),
  });
  assert.equal(confirmedQuoteResponse.status, 200);
  const confirmedHistory = (await (await accountFetch("/api/account/orders")).json()).data;
  const confirmedCustom = confirmedHistory.find((entry) => entry.code === customOrder.code);
  assert.equal(confirmedCustom.totalPriceCents, 500);
  assert.equal(confirmedCustom.priceStatus, "confirmed");
  assert.equal(confirmedCustom.items[0].unitPriceCents, 500);
  assert.equal(confirmedCustom.items[0].priceStatus, "confirmed");
  assert.equal(confirmedCustom.items[0].actualQuote.unitPriceCents, 500);

  const linkOrderResponse = await accountFetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Cliente",
      lastName: "Test",
      items: [{
        type: "custom",
        sourceType: "link",
        externalUrl: "https://makerworld.com/en/models/456-storico",
        colorId: 1,
        quantity: 2,
      }],
    }),
  });
  const linkOrder = (await linkOrderResponse.json()).data;
  assert.equal(linkOrderResponse.status, 201);
  const savedLinkOrder = database.prepare("SELECT * FROM orders WHERE code = ?").get(linkOrder.code);
  const savedLinkItem = database.prepare("SELECT * FROM order_items WHERE order_id = ?").get(savedLinkOrder.id);

  const pendingLinkHistory = (await (await accountFetch("/api/account/orders")).json()).data;
  const pendingLink = pendingLinkHistory.find((entry) => entry.code === linkOrder.code);
  assert.equal(pendingLink.totalPriceCents, 0);
  assert.equal(pendingLink.priceStatus, "partial");
  assert.equal(pendingLink.items[0].unitPriceCents, null);
  assert.equal(pendingLink.items[0].lineTotalCents, null);
  assert.equal(pendingLink.items[0].priceStatus, "pending");
  assert.equal(pendingLink.items[0].estimatedQuote, null);

  const confirmedLinkQuoteResponse = await fetch(`${baseUrl}/api/admin/orders/${savedLinkOrder.id}/items/${savedLinkItem.id}/actual-quote`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: adminCookieForQuote },
    body: JSON.stringify({ grams: 22.68, hours: 103 / 60 }),
  });
  assert.equal(confirmedLinkQuoteResponse.status, 200);
  const confirmedLinkHistory = (await (await accountFetch("/api/account/orders")).json()).data;
  const confirmedLink = confirmedLinkHistory.find((entry) => entry.code === linkOrder.code);
  assert.equal(confirmedLink.totalPriceCents, 1000);
  assert.equal(confirmedLink.priceStatus, "confirmed");
  assert.equal(confirmedLink.items[0].unitPriceCents, 500);
  assert.equal(confirmedLink.items[0].lineTotalCents, 1000);
  assert.equal(confirmedLink.items[0].priceStatus, "confirmed");
  assert.equal(confirmedLink.items[0].actualQuote.unitPriceCents, 500);

  const logout = await accountFetch("/api/account/logout", { method: "POST" });
  assert.equal(logout.status, 204);
  assert.equal((await accountFetch("/api/account/session")).status, 401);

  const orderCountBeforeExpiredSession = database.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  const expiredSessionOrder = await accountFetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Cliente",
      lastName: "Test",
      items: [{ type: "catalog", productId: 1, colorId: 1, quantity: 1 }],
    }),
  });
  assert.equal(expiredSessionOrder.status, 401);
  assert.equal((await expiredSessionOrder.json()).error.code, "SESSION_EXPIRED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, orderCountBeforeExpiredSession);

  const login = await fetch(`${baseUrl}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cliente@example.test", password: "password-molto-sicura" }),
  });
  assert.equal(login.status, 201);
  assert.equal((await login.json()).data.role, "customer");

  const secondRegistration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "seconda-password-sicura",
      firstName: "Altro",
      lastName: "Cliente",
      email: "altro@example.test",
    }),
  });
  const secondAccount = await secondRegistration.json();
  const secondCookie = secondRegistration.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(secondRegistration.status, 201);
  assert.equal(secondAccount.data.email, "altro@example.test");
  const secondHistory = await fetch(`${baseUrl}/api/account/orders`, { headers: { cookie: secondCookie } });
  assert.deepEqual((await secondHistory.json()).data, []);

  const adminLogin = await fetch(`${baseUrl}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "test-admin-password" }),
  });
  const adminAccount = await adminLogin.json();
  const adminCookie = adminLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(adminLogin.status, 201);
  assert.equal(adminAccount.data.role, "admin");
  assert.equal(adminAccount.data.email, "admin@example.test");
  assert.equal(adminAccount.data.emailVerified, true);
  assert.equal((await fetch(`${baseUrl}/api/admin/session`, { headers: { cookie: adminCookie } })).status, 200);
  await fetch(`${baseUrl}/api/account/logout`, { method: "POST", headers: { cookie: adminCookie } });

  database.prepare("DELETE FROM user_accounts WHERE id = ?").run(registeredAccount.data.id);
  assert.equal(database.prepare("SELECT user_account_id FROM orders WHERE id = ?").get(savedOrder.id).user_account_id, null);
  database.prepare("DELETE FROM orders WHERE id = ?").run(savedOrder.id);
  await rm(path.join(orderFileDirectory, savedCustomItem.model_filename), { force: true });
  database.prepare("DELETE FROM orders WHERE id = ?").run(savedCustomOrder.id);
  database.prepare("DELETE FROM orders WHERE id = ?").run(savedLinkOrder.id);
  database.prepare("DELETE FROM user_accounts WHERE id = ?").run(secondAccount.data.id);
});

test("recupera la password senza rivelare gli account registrati", async () => {
  const neutralEmailCount = sentEmails.length;
  for (const email of ["sconosciuto@example.test", "admin@example.test"]) {
    const response = await fetch(`${baseUrl}/api/account/password/forgot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    assert.equal(response.status, 204);
  }
  assert.equal(sentEmails.length, neutralEmailCount);

  const registration = await fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "recupero@example.test",
      password: "password-iniziale-sicura",
      firstName: "Recupero",
      lastName: "Password",
    }),
  });
  const account = (await registration.json()).data;
  const originalCookie = registration.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(registration.status, 201);

  const forgot = await fetch(`${baseUrl}/api/account/password/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "RECUPERO@example.test" }),
  });
  assert.equal(forgot.status, 204);
  const firstResetEmail = sentEmails.at(-1);
  assert.equal(firstResetEmail.to, "recupero@example.test");
  assert.match(firstResetEmail.subject, /Recupera la password/);
  const firstCode = firstResetEmail.text.match(/[A-F0-9]{16}/)?.[0];
  assert.ok(firstCode);

  const invalidReset = await fetch(`${baseUrl}/api/account/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "recupero@example.test",
      code: "0000000000000000",
      password: "password-nuova-sicura",
    }),
  });
  assert.equal(invalidReset.status, 400);
  assert.equal((await invalidReset.json()).error.code, "INVALID_PASSWORD_RESET");

  database.prepare("UPDATE password_reset_tokens SET expires_at = 0 WHERE user_account_id = ?").run(account.id);
  const expiredReset = await fetch(`${baseUrl}/api/account/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "recupero@example.test",
      code: firstCode,
      password: "password-nuova-sicura",
    }),
  });
  assert.equal(expiredReset.status, 410);
  assert.equal((await expiredReset.json()).error.code, "PASSWORD_RESET_EXPIRED");

  await fetch(`${baseUrl}/api/account/password/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "recupero@example.test" }),
  });
  const validCode = sentEmails.at(-1).text.match(/[A-F0-9]{16}/)?.[0];
  const validReset = await fetch(`${baseUrl}/api/account/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "recupero@example.test",
      code: validCode.toLowerCase(),
      password: "password-nuova-sicura",
    }),
  });
  assert.equal(validReset.status, 204);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_account_id = ?").get(account.id).count, 0);
  assert.ok(database.prepare("SELECT email_verified_at FROM user_accounts WHERE id = ?").get(account.id).email_verified_at);
  assert.equal((await fetch(`${baseUrl}/api/account/session`, { headers: { cookie: originalCookie } })).status, 401);

  const oldPasswordLogin = await fetch(`${baseUrl}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "recupero@example.test", password: "password-iniziale-sicura" }),
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await fetch(`${baseUrl}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "recupero@example.test", password: "password-nuova-sicura" }),
  });
  assert.equal(newPasswordLogin.status, 201);
  database.prepare("DELETE FROM user_accounts WHERE id = ?").run(account.id);
});

test("protegge le API amministrative e gestisce il ciclo completo di un ordine", async () => {
  const unauthorized = await fetch(`${baseUrl}/api/admin/orders`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/orders/1/status`, { method: "PATCH" })).status, 401);

  const wrongLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "errata" }),
  });
  assert.equal(wrongLogin.status, 401);

  const wrongEmail = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "altro.admin@example.test", password: "test-admin-password" }),
  });
  assert.equal(wrongEmail.status, 401);
  assert.equal((await wrongEmail.json()).error.code, "INVALID_ADMIN_CREDENTIALS");

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "test-admin-password" }),
  });
  const setCookie = login.headers.get("set-cookie");
  const cookie = setCookie.split(";", 1)[0];
  assert.equal(login.status, 201);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const adminFetch = (pathName, options = {}) =>
    fetch(`${baseUrl}${pathName}`, {
      ...options,
      headers: { cookie, ...(options.headers ?? {}) },
    });
  assert.equal((await adminFetch("/api/admin/session")).status, 200);

  const listResponse = await adminFetch("/api/admin/orders");
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  const inProgressOrder = list.data.find((order) => order.status === "in_attesa" && order.itemCount === 3);
  assert.ok(inProgressOrder, "Non trovato un ordine in attesa con 3 elementi");
  assert.equal(inProgressOrder.status, "in_attesa");
  const orderId = inProgressOrder.id;

  const detailResponse = await adminFetch(`/api/admin/orders/${orderId}`);
  const detail = (await detailResponse.json()).data;
  const customFile = detail.items.find((item) => item.itemType === "custom_file");
  assert.equal(detail.status, "in_attesa");
  assert.equal(detail.items.length, 3);
  assert.equal(
    (await fetch(`${baseUrl}/api/admin/orders/${orderId}/items/${customFile.id}/model`)).status,
    401,
  );

  const invalidStatus = await adminFetch(`/api/admin/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "inventato" }),
  });
  assert.equal(invalidStatus.status, 400);
  assert.equal((await invalidStatus.json()).error.code, "INVALID_ORDER_STATUS");
  assert.equal((await adminFetch(`/api/admin/orders/${orderId}junk/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "in_attesa" }),
  })).status, 404);

  const statusUpdate = await adminFetch(`/api/admin/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "in_lavorazione" }),
  });
  assert.equal(statusUpdate.status, 200);
  const publicOrders = (await (await fetch(`${baseUrl}/api/orders`)).json()).data;
  assert.equal(publicOrders.find((order) => order.code === detail.code).status, "in_lavorazione");
  assert.equal(
    (await adminFetch(`/api/admin/orders/${orderId}/items/${customFile.id}/model`)).status,
    200,
  );

  const updateResponse = await adminFetch(`/api/admin/orders/${orderId}`, {
    method: "PUT",
  });
  assert.equal(updateResponse.status, 404);

  const updated = (await (await adminFetch(`/api/admin/orders/${orderId}`)).json()).data;
  assert.equal(updated.firstName, "Mauro");
  assert.equal(updated.lastName, "Rossi");
  assert.equal(updated.catalogTotalCents, 2400);
  assert.equal(updated.status, "in_lavorazione");
  assert.equal(updated.items.length, 3);
  assert.equal(updated.items[0].productName, "Vaso Orbitale");
  assert.equal(updated.items.some((item) => item.itemType === "custom_link"), true);

  const updatedCustomFile = updated.items.find((item) => item.itemType === "custom_file");
  assert.equal(
    (await adminFetch(`/api/admin/orders/${orderId}/items/${updatedCustomFile.id}/model`)).status,
    200,
  );
  const deleteResponse = await adminFetch(`/api/admin/orders/${orderId}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
  assert.equal((await readdir(orderFileDirectory)).length, 0);
  assert.equal((await (await fetch(`${baseUrl}/api/orders`)).json()).data.some((order) => order.code === detail.code), false);

  const logout = await adminFetch("/api/admin/logout", { method: "POST" });
  assert.equal(logout.status, 204);
  assert.equal((await adminFetch("/api/admin/session")).status, 401);
});

test("applica un unico rate limit concorrente alle credenziali amministrative", async () => {
  const tempUploadDirectory = await mkdtemp(path.join(tmpdir(), "pixel-print-lab-rate-limit-uploads-"));
  const tempOrderFileDirectory = await mkdtemp(path.join(tmpdir(), "pixel-print-lab-rate-limit-orders-"));
  const tempCatalogDirectory = await mkdtemp(path.join(tmpdir(), "pixel-print-lab-rate-limit-catalog-"));
  const tempDatabase = openDatabase(":memory:");
  seedDatabase(tempDatabase);
  const tempEmailService = { configured: false };
  const tempServer = createApp({
    database: tempDatabase,
    uploadDirectory: tempUploadDirectory,
    orderFileDirectory: tempOrderFileDirectory,
    catalogDirectory: tempCatalogDirectory,
    adminEmail: "admin@example.test",
    adminPassword: "test-admin-password",
    emailService: tempEmailService,
    uploadRateLimit: false,
    orderRateLimit: false,
    disableAuthRateLimits: false,
  }).listen(0);
  await new Promise((resolve) => tempServer.once("listening", resolve));
  const tempUrl = `http://127.0.0.1:${tempServer.address().port}`;
  try {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_value, index) =>
        fetch(`${tempUrl}${index % 2 === 0 ? "/api/account/login" : "/api/admin/login"}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "admin@example.test", password: `errata-${index}` }),
        })
      ),
    );
    assert.equal(attempts.filter(({ status }) => status === 429).length, 1);
    assert.equal(attempts.filter(({ status }) => status === 401).length, 5);
  } finally {
    await new Promise((resolve, reject) => tempServer.close((error) => (error ? reject(error) : resolve())));
    tempDatabase.close();
    await rm(tempUploadDirectory, { recursive: true, force: true });
    await rm(tempOrderFileDirectory, { recursive: true, force: true });
    await rm(tempCatalogDirectory, { recursive: true, force: true });
  }
});

test("permette all'amministratore di eliminare tutti gli ordini", async () => {
  const createOrder = (firstName) => fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName,
      lastName: "Bulk",
      items: [{ type: "catalog", productId: 2, colorId: 4, quantity: 1 }],
    }),
  });
  const order1 = (await (await createOrder("Uno")).json()).data;
  const order2 = (await (await createOrder("Due")).json()).data;
  assert.ok(database.prepare("SELECT * FROM orders WHERE code = ?").get(order1.code));
  assert.ok(database.prepare("SELECT * FROM orders WHERE code = ?").get(order2.code));

  const cookie = await authenticateAdmin();
  const adminFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie, ...(options.headers ?? {}) },
  });
  const deleteAll = await adminFetch("/api/admin/orders", { method: "DELETE" });
  assert.equal(deleteAll.status, 204);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 0);
});

test("permette all'utente di eliminare un proprio ordine ma non quelli altrui", async () => {
  const register = (email) => fetch(`${baseUrl}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password-molto-sicura",
      firstName: "Elimina",
      lastName: "Test",
    }),
  });

  const firstRegistration = await register("utente.elimina@example.test");
  assert.equal(firstRegistration.status, 201);
  const firstCookie = firstRegistration.headers.get("set-cookie").split(";", 1)[0];
  const firstFetch = (pathName, options = {}) => fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { cookie: firstCookie, ...(options.headers ?? {}) },
  });

  const orderResponse = await firstFetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Elimina",
      lastName: "Test",
      items: [{ type: "catalog", productId: 2, colorId: 4, quantity: 1 }],
    }),
  });
  const order = (await orderResponse.json()).data;
  assert.equal(orderResponse.status, 201);

  const secondRegistration = await register("altro.elimina@example.test");
  assert.equal(secondRegistration.status, 201);
  const secondCookie = secondRegistration.headers.get("set-cookie").split(";", 1)[0];
  const otherDelete = await fetch(`${baseUrl}/api/account/orders/${encodeURIComponent(order.code)}`, {
    method: "DELETE",
    headers: { cookie: secondCookie },
  });
  assert.equal(otherDelete.status, 404);

  const ownDelete = await firstFetch(`/api/account/orders/${encodeURIComponent(order.code)}`, { method: "DELETE" });
  assert.equal(ownDelete.status, 204);

  const history = await firstFetch("/api/account/orders");
  assert.equal((await history.json()).data.length, 0);
});
