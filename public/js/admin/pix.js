export function initPix({ api }) {
  const profileCount = document.querySelector("#pix-profile-count");
  const totalPix = document.querySelector("#pix-total");
  const feedback = document.querySelector("#pix-feedback");
  const profileList = document.querySelector("#pix-profile-list");
  const profileTemplate = document.querySelector("#pix-profile-template");
  const refreshButton = document.querySelector("#pix-refresh");

  function renderProfiles(profiles) {
    profileCount.textContent = String(profiles.length).padStart(2, "0");
    totalPix.textContent = profiles.reduce((total, profile) => total + profile.pixBalance, 0);
    profileList.replaceChildren(...profiles.map((profile) => {
      const card = profileTemplate.content.firstElementChild.cloneNode(true);
      card.querySelector('[data-field="pix-name"]').textContent = `${profile.firstName} ${profile.lastName}`;
      card.querySelector('[data-field="pix-email"]').textContent = profile.email;
      card.querySelector('[data-field="pix-balance"]').textContent = profile.pixBalance;
      return card;
    }));
    feedback.textContent = profiles.length ? "" : "Nessun profilo registrato.";
  }

  async function loadPix() {
    feedback.textContent = "Caricamento profili...";
    feedback.classList.remove("admin-feedback--error");
    try {
      renderProfiles(await api("/api/admin/pix"));
    } catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add("admin-feedback--error");
    }
  }

  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    await loadPix();
    refreshButton.disabled = false;
  });

  return { loadPix };
}
