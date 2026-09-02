const pricingCentsFields = new Set(["filamentPriceCentsPerKg", "energyPriceCentsPerKwh", "machineHourlyCostCents", "minQuoteCents"]);

export function initSettings({ api }) {
  const settingsButton = document.querySelector("#settings-button");
  const settingsDialog = document.querySelector("#settings-dialog");
  const settingsDialogBackdrop = document.querySelector("#settings-dialog-backdrop");
  const settingsForm = document.querySelector("#settings-form");
  const emailNotificationsInput = document.querySelector("#email-notifications-enabled");
  const smtpStatus = document.querySelector("#smtp-status");
  const settingsFeedback = document.querySelector("#settings-feedback");
  const pricingInputs = {
    filamentPriceCentsPerKg: document.querySelector("#pricing-filament-price"),
    filamentDensityGCm3: document.querySelector("#pricing-density"),
    effectiveFillPercent: document.querySelector("#pricing-fill"),
    printerPowerWatts: document.querySelector("#pricing-power"),
    energyPriceCentsPerKwh: document.querySelector("#pricing-energy"),
    machineHourlyCostCents: document.querySelector("#pricing-machine-hour"),
    extrusionRateMm3PerSecond: document.querySelector("#pricing-extrusion"),
    overheadMinutes: document.querySelector("#pricing-overhead"),
    materialCorrectionFactor: document.querySelector("#pricing-material-factor"),
    timeCorrectionFactor: document.querySelector("#pricing-time-factor"),
    markupPercent: document.querySelector("#pricing-markup"),
    minQuoteCents: document.querySelector("#pricing-min-quote"),
  };

  async function loadSettings() {
    settingsFeedback.textContent = "";
    settingsFeedback.classList.remove("admin-feedback--error");
    const settings = await api("/api/admin/settings");
    emailNotificationsInput.checked = settings.emailNotificationsEnabled;
    emailNotificationsInput.disabled = !settings.smtpConfigured && !settings.emailNotificationsEnabled;
    smtpStatus.textContent = settings.smtpConfigured
      ? `SMTP configurato. Destinatario: ${settings.smtpRecipient}`
      : "SMTP non configurato. Aggiungi le variabili richieste prima di attivare l'invio.";
    smtpStatus.dataset.configured = String(settings.smtpConfigured);
    for (const [field, input] of Object.entries(pricingInputs)) {
      const value = settings.pricing?.[field];
      input.value = pricingCentsFields.has(field) ? (value / 100).toFixed(2) : value;
    }
  }

  function readPricingForm() {
    const pricing = {};
    for (const [field, input] of Object.entries(pricingInputs)) {
      const value = Number(input.value);
      pricing[field] = pricingCentsFields.has(field) ? Math.round(value * 100) : value;
    }
    return pricing;
  }

  settingsButton.addEventListener("click", async () => {
    settingsDialogBackdrop.hidden = false;
    settingsDialog.show();
    try {
      await loadSettings();
    } catch (error) {
      settingsFeedback.textContent = error.message;
      settingsFeedback.classList.add("admin-feedback--error");
    }
  });

  settingsDialog.addEventListener("close", () => {
    settingsDialogBackdrop.hidden = true;
  });
  settingsDialogBackdrop.addEventListener("click", () => settingsDialog.close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsDialog.open) settingsDialog.close();
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = settingsForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    settingsFeedback.textContent = "";
    settingsFeedback.classList.remove("admin-feedback--error");
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailNotificationsEnabled: emailNotificationsInput.checked,
          pricing: readPricingForm(),
        }),
      });
      settingsFeedback.textContent = "Impostazioni salvate.";
      await loadSettings();
      settingsFeedback.textContent = "Impostazioni salvate.";
    } catch (error) {
      settingsFeedback.textContent = error.message;
      settingsFeedback.classList.add("admin-feedback--error");
    } finally {
      submitButton.disabled = false;
    }
  });
}
