import { createAuthService } from "./auth-service.js";
import { openDatabase } from "./database.js";

const database = openDatabase();

try {
  const auth = createAuthService({
    database,
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
  });
  auth.resetAdminCredentials();
  console.log("Credenziali personalizzate rimosse: valgono di nuovo ADMIN_EMAIL e ADMIN_PASSWORD.");
} finally {
  database.close();
}
