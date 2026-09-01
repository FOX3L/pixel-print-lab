import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultDatabasePath = path.join(currentDirectory, "..", "data", "pixel-print-lab.db");

const migrations = [
  {
    version: 1,
    name: "create_catalog",
    sql: `
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
        image_url TEXT NOT NULL,
        image_alt TEXT NOT NULL,
        dimension_label TEXT NOT NULL,
        dimension_value TEXT NOT NULL,
        material TEXT NOT NULL,
        model_url TEXT,
        visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE colors (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        hex_value TEXT NOT NULL CHECK (hex_value GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX products_visible_sort_idx ON products (visible, sort_order, id);
      CREATE INDEX colors_active_sort_idx ON colors (active, sort_order, id);
    `,
  },
  {
    version: 2,
    name: "add_demo_model_urls",
    sql: `
      UPDATE products
      SET model_url = '/models/vaso-orbitale.stl', updated_at = CURRENT_TIMESTAMP
      WHERE slug = 'vaso-orbitale' AND model_url IS NULL;

      UPDATE products
      SET model_url = '/models/supporto-controller.stl', updated_at = CURRENT_TIMESTAMP
      WHERE slug = 'supporto-controller' AND model_url IS NULL;
    `,
  },
  {
    version: 3,
    name: "create_orders",
    sql: `
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        catalog_total_cents INTEGER NOT NULL CHECK (catalog_total_cents >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('catalog', 'custom_file', 'custom_link')),
        product_id INTEGER,
        product_code TEXT,
        product_name TEXT NOT NULL,
        unit_price_cents INTEGER CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
        color_id INTEGER NOT NULL,
        color_name TEXT NOT NULL,
        color_hex TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
        original_name TEXT,
        source_name TEXT,
        external_url TEXT,
        model_filename TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        UNIQUE (order_id, position)
      );

      CREATE INDEX orders_created_at_idx ON orders (created_at DESC, id DESC);
      CREATE INDEX order_items_order_idx ON order_items (order_id, position);
    `,
  },
  {
    version: 4,
    name: "prevent_catalog_id_reuse",
    sql: `
      DROP INDEX products_visible_sort_idx;
      DROP INDEX colors_active_sort_idx;

      ALTER TABLE products RENAME TO products_legacy;
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
        image_url TEXT NOT NULL,
        image_alt TEXT NOT NULL,
        dimension_label TEXT NOT NULL,
        dimension_value TEXT NOT NULL,
        material TEXT NOT NULL,
        model_url TEXT,
        visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO products SELECT * FROM products_legacy;
      DROP TABLE products_legacy;

      ALTER TABLE colors RENAME TO colors_legacy;
      CREATE TABLE colors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        hex_value TEXT NOT NULL CHECK (hex_value GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO colors SELECT * FROM colors_legacy;
      DROP TABLE colors_legacy;

      CREATE INDEX products_visible_sort_idx ON products (visible, sort_order, id);
      CREATE INDEX colors_active_sort_idx ON colors (active, sort_order, id);
    `,
  },
  {
    version: 5,
    name: "add_model_file_metadata",
    sql: `
      ALTER TABLE order_items
      ADD COLUMN model_format TEXT
      CHECK (model_format IS NULL OR model_format IN ('stl', '3mf'));

      ALTER TABLE order_items
      ADD COLUMN model_metadata_json TEXT;

      UPDATE order_items
      SET model_format = 'stl'
      WHERE item_type = 'custom_file' AND model_format IS NULL;
    `,
  },
  {
    version: 6,
    name: "add_order_status",
    sql: `
      ALTER TABLE orders
      ADD COLUMN status TEXT NOT NULL DEFAULT 'in_attesa'
      CHECK (status IN ('in_attesa', 'in_lavorazione', 'completato'));
    `,
  },
  {
    version: 7,
    name: "add_app_settings",
    sql: `
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email_notifications_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (email_notifications_enabled IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO app_settings (id, email_notifications_enabled) VALUES (1, 0);
    `,
  },
  {
    version: 8,
    name: "add_user_accounts",
    sql: `
      CREATE TABLE user_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'customer'
          CHECK (role IN ('customer', 'admin')),
        auth_source TEXT NOT NULL DEFAULT 'local'
          CHECK (auth_source IN ('local', 'environment')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (auth_source = 'environment' OR password_hash IS NOT NULL)
      );

      CREATE TABLE user_sessions (
        token_hash TEXT PRIMARY KEY,
        user_account_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_account_id) REFERENCES user_accounts(id) ON DELETE CASCADE
      );

      ALTER TABLE orders
      ADD COLUMN user_account_id INTEGER
      REFERENCES user_accounts(id) ON DELETE SET NULL;

      CREATE INDEX user_sessions_expiry_idx ON user_sessions (expires_at);
      CREATE INDEX user_sessions_account_idx ON user_sessions (user_account_id);
      CREATE INDEX orders_account_created_idx
        ON orders (user_account_id, created_at DESC, id DESC);
    `,
  },
  {
    version: 9,
    name: "add_admin_credentials_override",
    sql: `
      ALTER TABLE app_settings
      ADD COLUMN admin_username TEXT;

      ALTER TABLE app_settings
      ADD COLUMN admin_password_hash TEXT;
    `,
  },
  {
    version: 10,
    name: "add_delivered_order_status",
    sql: `
      CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        catalog_total_cents INTEGER NOT NULL CHECK (catalog_total_cents >= 0),
        status TEXT NOT NULL DEFAULT 'in_attesa'
          CHECK (status IN ('in_attesa', 'in_lavorazione', 'completato', 'consegnato')),
        user_account_id INTEGER REFERENCES user_accounts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO orders_new
        SELECT id, code, first_name, last_name, catalog_total_cents, status, user_account_id, created_at
        FROM orders;

      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;

      CREATE INDEX orders_created_at_idx ON orders (created_at DESC, id DESC);
      CREATE INDEX orders_account_created_idx ON orders (user_account_id, created_at DESC, id DESC);
    `,
  },
  {
    version: 11,
    name: "add_pricing_settings",
    sql: `
      ALTER TABLE app_settings
      ADD COLUMN price_filament_cents_per_kg INTEGER NOT NULL DEFAULT 2000
        CHECK (price_filament_cents_per_kg >= 0);

      ALTER TABLE app_settings
      ADD COLUMN price_filament_density_g_cm3 REAL NOT NULL DEFAULT 1.24
        CHECK (price_filament_density_g_cm3 > 0);

      ALTER TABLE app_settings
      ADD COLUMN price_effective_fill_percent REAL NOT NULL DEFAULT 25
        CHECK (price_effective_fill_percent BETWEEN 1 AND 100);

      ALTER TABLE app_settings
      ADD COLUMN price_printer_power_watts INTEGER NOT NULL DEFAULT 150
        CHECK (price_printer_power_watts > 0);

      ALTER TABLE app_settings
      ADD COLUMN price_energy_cents_per_kwh INTEGER NOT NULL DEFAULT 30
        CHECK (price_energy_cents_per_kwh >= 0);

      ALTER TABLE app_settings
      ADD COLUMN price_machine_hourly_cents INTEGER NOT NULL DEFAULT 50
        CHECK (price_machine_hourly_cents >= 0);

      ALTER TABLE app_settings
      ADD COLUMN price_extrusion_mm3_per_second REAL NOT NULL DEFAULT 8
        CHECK (price_extrusion_mm3_per_second > 0);

      ALTER TABLE app_settings
      ADD COLUMN price_overhead_minutes INTEGER NOT NULL DEFAULT 15
        CHECK (price_overhead_minutes >= 0);

      ALTER TABLE app_settings
      ADD COLUMN price_markup_percent REAL NOT NULL DEFAULT 20
        CHECK (price_markup_percent >= 0);

      ALTER TABLE app_settings
      ADD COLUMN price_min_quote_cents INTEGER NOT NULL DEFAULT 500
        CHECK (price_min_quote_cents >= 0);
    `,
  },
  {
    version: 12,
    name: "add_order_item_quote",
    sql: `
      ALTER TABLE order_items
      ADD COLUMN quote_json TEXT;
    `,
  },
  {
    version: 13,
    name: "remove_demo_stl_model_urls",
    sql: `
      UPDATE products
      SET model_url = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE model_url IN ('/models/vaso-orbitale.stl', '/models/supporto-controller.stl');
    `,
  },
  {
    version: 14,
    name: "add_pricing_correction_factors",
    sql: `
      ALTER TABLE app_settings
      ADD COLUMN price_material_correction_factor REAL NOT NULL DEFAULT 2.4
        CHECK (price_material_correction_factor > 0);

      ALTER TABLE app_settings
      ADD COLUMN price_time_correction_factor REAL NOT NULL DEFAULT 2.1
        CHECK (price_time_correction_factor > 0);
    `,
  },
  {
    version: 15,
    name: "add_order_item_actual_quote",
    sql: `
      ALTER TABLE order_items
      ADD COLUMN actual_grams REAL
        CHECK (actual_grams IS NULL OR actual_grams > 0);

      ALTER TABLE order_items
      ADD COLUMN actual_hours REAL
        CHECK (actual_hours IS NULL OR actual_hours > 0);

      ALTER TABLE order_items
      ADD COLUMN actual_quote_json TEXT;
    `,
  },
  {
    version: 16,
    name: "drop_product_metadata_fields",
    sql: `
      DROP INDEX IF EXISTS products_visible_sort_idx;

      ALTER TABLE products RENAME TO products_legacy;
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
        image_url TEXT NOT NULL,
        material TEXT NOT NULL,
        model_url TEXT,
        visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO products (
        id, code, name, description, price_cents, image_url, material,
        model_url, visible, created_at, updated_at
      )
      SELECT
        id, code, name, description, price_cents, image_url, material,
        model_url, visible, created_at, updated_at
      FROM products_legacy;
      DROP TABLE products_legacy;

      CREATE INDEX products_visible_sort_idx ON products (visible, id);
    `,
  },
  {
    version: 17,
    name: "add_order_comment",
    sql: `
      ALTER TABLE orders
      ADD COLUMN comment TEXT;
    `,
  },
  {
    version: 18,
    name: "add_account_email",
    sql: `
      ALTER TABLE user_accounts
      ADD COLUMN email TEXT;
    `,
  },
  {
    version: 19,
    name: "add_email_verification",
    sql: `
      ALTER TABLE user_accounts
      ADD COLUMN email_verified_at TEXT;

      CREATE TABLE email_verification_tokens (
        user_account_id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_account_id) REFERENCES user_accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX email_verification_expiry_idx
        ON email_verification_tokens (expires_at);
    `,
  },
  {
    version: 20,
    name: "use_email_for_customer_accounts",
    sql: `
      DELETE FROM user_accounts WHERE auth_source = 'local';

      CREATE UNIQUE INDEX user_accounts_email_idx
        ON user_accounts (email COLLATE NOCASE)
      WHERE email IS NOT NULL;
    `,
  },
  {
    version: 21,
    name: "add_account_email_notification_preference",
    sql: `
      ALTER TABLE user_accounts
      ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 1
      CHECK (email_notifications_enabled IN (0, 1));
    `,
  },
  {
    version: 22,
    name: "add_password_reset_tokens",
    sql: `
      CREATE TABLE password_reset_tokens (
        user_account_id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_account_id) REFERENCES user_accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX password_reset_expiry_idx
        ON password_reset_tokens (expires_at);
    `,
  },
  {
    version: 23,
    name: "add_daily_email_usage",
    sql: `
      CREATE TABLE email_daily_usage (
        usage_date TEXT PRIMARY KEY,
        sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 24,
    name: "add_account_pix",
    sql: `
      ALTER TABLE user_accounts
      ADD COLUMN pix_balance INTEGER NOT NULL DEFAULT 0
      CHECK (pix_balance >= 0);

      ALTER TABLE orders
      ADD COLUMN pix_awarded_at TEXT;

      UPDATE user_accounts
      SET pix_balance = (
        SELECT COUNT(*)
        FROM orders
        WHERE orders.user_account_id = user_accounts.id
          AND orders.status = 'consegnato'
      )
      WHERE role = 'customer';

      UPDATE orders
      SET pix_awarded_at = COALESCE(created_at, CURRENT_TIMESTAMP)
      WHERE status = 'consegnato'
        AND user_account_id IN (
          SELECT id FROM user_accounts WHERE role = 'customer'
        );
    `,
  },
];

const products = [
  {
    code: "0001",
    name: "Vaso Orbitale",
    description: "Un piccolo vaso geometrico, pensato per fiori secchi e scrivanie con poco spazio.",
    priceCents: 1200,
    imageUrl: "/images/vaso-orbitale.svg",
    material: "PLA",
    modelUrl: null,
  },
  {
    code: "0002",
    name: "Dock Controller",
    description: "Supporto inclinato per tenere il controller visibile, stabile e sempre a portata di mano.",
    priceCents: 950,
    imageUrl: "/images/supporto-controller.svg",
    material: "PLA",
    modelUrl: null,
  },
];

const colors = [
  { name: "Nero", hexValue: "#17201A", sortOrder: 10 },
  { name: "Bianco", hexValue: "#F3F0E6", sortOrder: 20 },
  { name: "Arancione", hexValue: "#FF6534", sortOrder: 30 },
  { name: "Blu", hexValue: "#4277FF", sortOrder: 40 },
];

export function openDatabase(filename = process.env.DATABASE_PATH ?? defaultDatabasePath) {
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  migrateDatabase(database);
  return database;
}

export function migrateDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedVersions = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map(({ version }) => version),
  );
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      recordMigration.run(migration.version, migration.name);
    })();
  }
}

export function seedDatabase(database) {
  const insertProduct = database.prepare(`
    INSERT INTO products (
      code, name, description, price_cents, image_url, material, model_url
    ) VALUES (
      @code, @name, @description, @priceCents, @imageUrl, @material, @modelUrl
    )
    ON CONFLICT (code) DO NOTHING
  `);
  const insertColor = database.prepare(`
    INSERT INTO colors (name, hex_value, sort_order)
    VALUES (@name, @hexValue, @sortOrder)
    ON CONFLICT (name) DO NOTHING
  `);

  database.transaction(() => {
    for (const product of products) {
      insertProduct.run(product);
    }
    for (const color of colors) {
      insertColor.run(color);
    }
  })();
}
