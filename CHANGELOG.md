# Changelog

All notable changes to this project are documented in this file.

## [1.12.1] - 2026-09-02

### Changed

- Aggiunto un helper accessibile sull'icona Pix e riordinati i vantaggi dell'account, evidenziando punti fedelta e premio esclusivo a 10 Pix.
- Rimossa dalla Control Room la modifica delle credenziali amministrative; la configurazione resta affidata alle variabili d'ambiente.

## [1.12.0] - 2026-09-02

### Added

- Sistema Pix che assegna una moneta al profilo cliente quando un suo ordine viene consegnato per la prima volta.
- Saldo Pix nel profilo cliente e nuova schermata Control Room con elenco profili, saldi e totale complessivo.
- Accredito atomico e idempotente, senza premi per ordini ospite o account amministrativi.

### Migration notes

- La migrazione database `24` aggiunge saldo e tracciamento degli accrediti, conteggiando anche gli ordini cliente gia consegnati.

## [1.11.0] - 2026-09-02

### Added

- Eliminazione definitiva del profilo cliente con conferma della password, revoca delle sessioni e conservazione degli ordini come richieste ospite.
- Limite globale persistente di 100 email al giorno, con ripristino della quota per gli invii SMTP falliti.
- Icona pixel art della moneta Pix tra gli asset del brand.

### Changed

- Nascosti nome e cognome nel checkout degli utenti autenticati, continuando a richiederli agli ospiti.

### Migration notes

- La migrazione database `23` aggiunge il contatore giornaliero persistente degli invii email.

## [1.10.0] - 2026-09-01

### Added

- Recupero password tramite codice monouso inviato via email, valido per 30 minuti e protetto da limiti su richieste e tentativi.
- Revoca automatica delle sessioni attive e verifica implicita dell'indirizzo email dopo un reset riuscito.

### Fixed

- Aggiornati i file Compose e i riferimenti di distribuzione al namespace `ghcr.io/fox3l/pixel-print-lab`.

## [1.9.1] - 2026-09-01

### Fixed

- Consentita la validazione di `compose.yml` senza un file `.env`, mantenendo `ADMIN_EMAIL` e `ADMIN_PASSWORD` configurabili esplicitamente tramite Compose.

## [1.9.0] - 2026-09-01

### Added

- Account cliente con email obbligatoria, storico personale degli ordini e dati anagrafici riutilizzati al checkout.
- Verifica email tramite codice monouso con scadenza, reinvio protetto e notifiche abilitate soltanto dopo la conferma.
- Preferenza nel profilo per attivare o disattivare gli avvisi email sullo stato degli ordini.
- Commento facoltativo nelle richieste, visibile nello storico cliente, nelle email e nella Control Room.
- Conferma dedicata agli ospiti prima dell'invio dell'ordine, con accesso rapido a login e registrazione.

### Changed

- L'email e l'unica credenziale degli account cliente; l'amministratore usa `ADMIN_EMAIL` e `ADMIN_PASSWORD` configurati tramite Docker Compose ed e considerato gia verificato.
- La transizione di un ordine a "in lavorazione" invia un solo avviso al cliente quando email e preferenza notifiche risultano attive.
- Migliorati i collegamenti contestuali al carrello e a MakerWorld nei flussi del catalogo e dei modelli personali.

### Migration notes

- La migrazione database `20` elimina gli account cliente precedenti e scollega i relativi ordini, che restano conservati come ordini ospite.

## [1.8.1] - 2026-09-01

### Fixed

- Aggiornato il namespace GitHub Container Registry dopo il trasferimento del repository a FOX3L.

## [1.8.0] - 2026-09-01

### Changed

- Ridisegnata l'illustrazione della stampante nella hero come blueprint tecnico animato, con griglia CAD, quote, callout e stato di avanzamento integrato.

## [1.7.0] - 2026-08-17

### Added

- Schermata "Palette" dedicata nella Control Room, separata dal Catalogo, con sidebar dei colori esistenti ed editor centrale per aggiungere, modificare, riordinare e rimuovere i colori della palette globale.

### Changed

- Sostituzione del modello 3D implicita: rimossa la checkbox "Rimuovi il modello attuale", caricando un nuovo modello si sostituisce quello precedente.
- Corretta la visualizzazione del pulsante "Salva modifiche" sui prodotti esistenti (il rilevamento delle modifiche ora considera correttamente i campi del form).
- Rimossi i contatori arancioni nelle intestazioni delle sidebar amministrative.

## [1.6.0] - 2026-08-16

### Added

- Visualizzatore 3D multi-piatto nel catalogo pubblico e nella Control Room, con selezione del piatto quando il modello ne contiene piu di uno.
- Serializzazione `inspection` (piatti e unta di misura) nelle API dei prodotti pubbliche e di amministrazione.
- Pannello asset del prodotto: immagine e modello 3D obbligatori quando mancano, nomi file correnti mostrati nelle label, pulsante "Visualizza modello 3D" omologato ai collegamenti "Apri immagine/3MF attuale" e allineato su una riga.
- Asset di brand PIX3LLAB (logo, favicon, token) e font (Bebas Neue, Dogica).

### Changed

- Rifattorizzazione del frontend in moduli `public/js/` e fogli di stile `public/css/`, con spostamento di `cart.js` e `viewer.js` sotto `public/js/`.

## [1.5.0] - 2026-08-13

### Added

- Catalog carousel on desktop: two highlighted models with the next one peeking in transparency, navigable via prev/next buttons and a dots indicator.
- Product price grouped with height and material inside the catalog card specs.

### Changed

- Fixed-height product description so catalog cards stay aligned regardless of text length.
- Mobile keeps its existing horizontal scroll carousel; the price no longer appears next to the product name.

## [1.4.0] - 2026-08-09

### Added

- Added support for inspecting and switching between plates in multi-plate Bambu Studio projects.
- Added per-plate volume, material, time, and price estimates with a combined project total.

### Changed

- Stored the complete multi-plate estimate with custom model orders.

## [1.3.3] - 2026-08-05

### Changed

- Added the fixed standard plate dimensions to the 3D viewer.

### Fixed

- Kept oversized models previewable without showing a compatibility message after loading.

## [1.3.2] - 2026-08-05

### Fixed

- Enlarged the mobile PIX3LLAB mark and restored full contrast for the empty cart control.
- Resized and reflowed mobile 3D viewer content to prevent horizontal overflow.

## [1.3.1] - 2026-08-05

### Fixed

- Ensured the PIX3LLAB mark remains visible in the mobile public header.
- Reduced the initial 3D model scale on mobile previews.

## [1.3.0] - 2026-08-05

### Changed

- Updated Docker Compose and documentation to pull images from the BravePix3l GitHub Container Registry namespace.

### Fixed

- Restored the logo and action label contrast in the mobile public header.
- Reduced the mobile 3D viewer dialog while retaining the desktop layout.

## [1.2.2] - 2026-08-04

### Fixed

- Updated the GitHub Container Registry namespace after the repository ownership transfer so release images can be published.

## [1.2.1] - 2026-08-04

### Changed

- Applied the PIX3LLAB visual identity with official logo assets, favicon, and a dark public header.
- Updated the Control Room sidebar headings with the Dogica display font.
- Replaced repository screenshots and added captions for the public home page, custom model flow, and Control Room.

## [1.2.0] - 2026-08-02

### Added

- Account order history now shows item prices, row totals, and total order price using estimated or confirmed custom model prices.
- MakerWorld link orders can move from pending pricing to confirmed pricing after the admin enters real slicer weight and time.

### Fixed

- Removed restrictive 3MF file picker filters that prevented selecting 3MF files on Safari mobile.

## [1.1.1] - 2026-08-02

### Fixed

- Updated admin asset cache-busting so the Control Room loads the JavaScript and CSS containing real slicer data fields.

### Changed

- Removed the temporary catalog copy that described the products as examples.

## [1.1.0] - 2026-08-02

### Added

- Material and time correction factors for the automatic 3MF estimate.
- Admin fields to enter Bambu Studio real weight and print time per custom order item.
- Confirmed custom item pricing based on real slicer data using the same pricing formula.

### Changed

- Stored the initial automatic estimate snapshot on custom file order items.
- The Control Room order total now includes confirmed custom item prices.

## [1.0.0] - 2026-08-02

### Changed

- Limited custom model uploads and catalog assets to 3MF files only.
- Limited external custom model links to MakerWorld.
- Removed demo STL model URLs from migrated catalog data.
- Updated public, cart, admin, viewer, and documentation copy to reflect the 3MF-only workflow.

### Fixed

- Updated tests and 3MF fixtures for the 3MF-only pricing and upload flow.

## [0.6.9] - 2026-07-25

### Added

- Mobile-only hero progress bar showing completed public orders with an animated striped fill, replacing the removed 3D printer animation on narrow screens.

## [0.6.8] - 2026-07-25

### Changed

- Renamed the public “Stato richieste” section to “Stato ordini” across navigation, headings, footer, and dynamic status messages.
- Collapsed the custom model form on mobile: only the two source buttons are visible initially; the rest expands after selection.
- Removed the 3D printer animation from the mobile hero section.

### Fixed

- Updated the public page test to match the new `stato-ordini` identifier.

## [0.6.7] - 2026-07-25

### Changed

- Hidden hero action buttons on mobile because the same links are available in the hamburger menu.

### Fixed

- Adjusted the 3D printer head animation so the extruder no longer intersects the growing printed object.
- Restored a missing `@keyframes viewer-layer` definition used by the 3D viewer loader.

## [0.6.6] - 2026-07-25

### Added

- Mobile product card details toggle: only image, name, and price are visible by default; tapping "Dettagli" expands description, specs, color, quantity, and add-to-cart.

### Changed

- Hidden secondary/explanatory texts on mobile: hero intro, catalog description, request tracker intro, custom model description, field hints, cart/checkout notes, account intro, registration hint, and password-change hint.

## [0.6.5] - 2026-07-25

### Added

- Mobile hamburger menu for the main navigation.
- Horizontal swipeable product catalog with scroll-snap and dot indicator on narrow screens.

### Changed

- Improved mobile readability: larger small text, looser headings, bigger touch targets, higher contrast for secondary text.
- Product specs and order headers now stack vertically on mobile.
- Dialog panels have extra bottom padding to avoid the on-screen keyboard.
- Relaxed `body` minimum width to prevent forced horizontal scroll on very small viewports.

## [0.6.4] - 2026-07-24

### Changed

- Translated README, CHANGELOG, CONTRIBUTING, CODE_OF_CONDUCT, and SECURITY to English.
- Translated comments and placeholder values in `compose.yml`, `compose.cloudflare.yml`, and `.env.cloudflare.example` to English.

### Fixed

- Added Docker build context to `compose.yml` and a stub `.env` file in CI workflows to fix `Test / docker` and release failures.

## [0.6.3] - 2026-07-24

### Changed

- Rewrote `README.md` with a cleaner structure, screenshots, and table of contents.
- Updated `compose.yml` and `compose.cloudflare.yml` to load environment variables from `.env` via `env_file`.

### Added

- `screenshots/` folder with images of the home page and the Control Room.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md`.

### Removed

- Local `docs/` folder and related references from `README.md`.

## [0.6.2] - 2026-07-24

### Added

- HTTP security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Strict-Transport-Security` (when the connection is HTTPS).
- Basic Content Security Policy (CSP) to limit external resource loading and mitigate XSS risks.

## [0.6.1] - 2026-07-24

### Added

- Cache-busting for public assets (`styles.css`, `admin.css`, `app.js`, `admin.js`) via versioned query strings.
- Animated stripe effect on the printer progress bar in the home page.

### Changed

- Home progress bar text now shows `Level <completed> / <total>` instead of `<completed> / <pending>`.

## [0.6.0] - 2026-07-24

### Added

- Rate limit for file uploads and order submissions (5 requests every 5 minutes).
- `delivered` order status and **Archive** section in the Control Room.
- Limit of 15 open orders (`pending`, `in progress`, `completed`) with a public warning.
- **Delete all** button in the Control Room to remove all orders and their files.
- **Delete** button in the user history to remove one's own order.
- `AGENTS.md` file with project conventions (local only).

### Fixed

- Undefined `orderSidebar` variable in `public/admin.js` that blocked navigation buttons after archiving an order.

## [0.5.1] - 2026-07-18

### Fixed

- Same Bitwarden issue in the checkout dialog (name/surname fields): made it non-modal with backdrop and close on Esc or outside click.
- Scrollability of account and checkout dialogs on mobile (`overflow: auto`) to prevent forms from being cut off or unsubmittable.

## [0.5.0] - 2026-07-18

### Fixed

- Conflict between Bitwarden's inline menu and native modal dialogs: account and admin settings popups now open as non-modal dialogs so Bitwarden's menu can overlap login and password fields.

## [0.4.1] - 2026-07-18

### Added

- Password change for authenticated users from the profile popup, with `PUT /api/account/password` API.
- 3D printer animation in the hero: extruder and filament move layer by layer while the object grows from bottom to top.
- "Level X / Y" bar and screen with the in-progress order code, linked to real orders.

## [0.4.0] - 2026-07-18

### Added

- Change of admin username and password from the Control Room settings popup, with verification of the current password.
- `admin:reset` command to restore credentials from environment variables.

### Changed

- Custom credentials stored in the database take precedence over environment ones; every change invalidates active admin sessions.

## [0.3.0] - 2026-07-17

### Added

- Optional accounts with registration, login, and personal order history.
- Unified login for the administrator and direct link to the Control Room.

### Changed

- Replaced Docker bind mounts with named volumes to avoid manual permission setup.
- Persisted customer sessions and optional account-to-order association in SQLite.

## [0.2.0] - 2026-07-17

### Added

- Optional SMTP sending for new orders.
- Admin settings popup opened from the gear icon.

### Changed

- Removed simulated email outbox and tutorial exercises.
- Simplified Docker Compose using bind mounts for `data` and `storage`.

## [0.1.0] - 2026-07-17

### Added

- Persistent catalog with products, colors, and STL/3MF viewer.
- Cart and order submission with custom files or links.
- Public tracking limited to code and status.
- Protected admin panel for orders, catalog, and colors.
- Safe inspection of STL, generic 3MF, and Bambu Studio projects.
- Self-hosted distribution with Docker Compose and persistent volumes.
- Automated tests and Docker build via GitHub Actions.

[0.6.4]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.4.1...v0.5.0
[0.4.0]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.3.0...v0.4.0
[0.4.1]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.4.0...v0.4.1
[0.3.0]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Moffoletta/pixel-print-lab/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Moffoletta/pixel-print-lab/releases/tag/v0.1.0
