export function initAuth({ api, onAuthenticated }) {
  const loginView = document.querySelector("#login-view");
  const loginForm = document.querySelector("#login-form");
  const loginFeedback = document.querySelector("#login-feedback");
  const dashboardView = document.querySelector("#dashboard-view");
  const logoutButton = document.querySelector("#logout-button");
  const settingsDialog = document.querySelector("#settings-dialog");

  function showLogin(message) {
    if (settingsDialog.open) settingsDialog.close();
    dashboardView.hidden = true;
    loginView.hidden = false;
    loginForm.reset();
    if (message) {
      loginFeedback.textContent = message;
      loginFeedback.classList.remove("admin-feedback--error");
    }
  }

  async function showDashboard() {
    loginView.hidden = true;
    dashboardView.hidden = false;
    await onAuthenticated?.();
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector("button");
    button.disabled = true;
    loginFeedback.textContent = "";
    loginFeedback.classList.remove("admin-feedback--error");
    try {
      const formData = new FormData(loginForm);
      await api("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
      });
      await showDashboard();
    } catch (error) {
      loginFeedback.textContent = error.message;
      loginFeedback.classList.add("admin-feedback--error");
    } finally {
      button.disabled = false;
    }
  });

  logoutButton.addEventListener("click", async () => {
    if (settingsDialog.open) settingsDialog.close();
    await api("/api/admin/logout", { method: "POST" });
    showLogin();
  });

  function boot() {
    api("/api/admin/session")
      .then(showDashboard)
      .catch(() => showLogin());
  }

  return { showLogin, boot };
}
