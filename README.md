# Pixel Print Lab

[![Test](https://github.com/Moffoletta/pixel-print-lab/actions/workflows/test.yml/badge.svg)](https://github.com/Moffoletta/pixel-print-lab/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/Moffoletta/pixel-print-lab)](https://github.com/Moffoletta/pixel-print-lab/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A personal app for collecting 3D print requests.**  
Friends can pick a model from the catalog or upload a 3MF file, choose color and quantity, and submit a request. You manage everything from the Control Room.

> **Note:** this repository page and documentation are in English, but the application interface is currently available only in Italian.

## Table of contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Run with Docker](#run-with-docker)
- [Configuration](#configuration)
- [Persistence and backup](#persistence-and-backup)
- [Publish with Cloudflare Tunnel](#publish-with-cloudflare-tunnel)
- [Local API](#local-api)
- [Documentation](#documentation)
- [Release and license](#release-and-license)

## Features

- **Public catalog** with products, colors, and a 3D viewer for 3MF models.
- **Guest or account requests**: users can order immediately or create an account to keep a personal history.
- **Custom model upload**: 3MF files up to 500 MB, or MakerWorld links.
- **Public tracking**: every request gets a unique code and a visible status (`pending`, `in progress`, `completed`, `delivered`).
- **Control Room**: admin panel for managing orders, catalog, colors, and settings.
- **Email notifications**: optional SMTP alert for every new order.
- **Basic security**: session-based authentication, rate limiting, security headers, and CSP.

## Screenshots

![Pixel Print Lab home page](screenshots/home.jpg)

*The public home page with printer status, catalog access, and order tracking.*

![Custom 3MF model request](screenshots/modello-personale.jpg)

*The custom model form with 3MF upload, cost estimate, color selection, and quantity.*

![Pixel Print Lab Control Room](screenshots/control-room.jpg)

*The Control Room for viewing requests, updating their status, and reviewing production details.*

## Quick start

Requirements: Node.js 22+, npm, Git.

```powershell
npm.cmd install
npm.cmd run db:setup
npm.cmd run dev
```

Open `http://localhost:3000`. The admin panel is at `http://localhost:3000/admin.html`.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the local `.env` file before opening the Control Room.

## Tests

```powershell
npm.cmd test
```

## Run with Docker

Docker Engine with Compose or Docker Desktop is required.

Copy the example environment file:

```sh
cp .env.example .env
```

Edit `.env` and set at least `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then start:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

The first run applies SQLite migrations and inserts the demo catalog. The app is available at `http://localhost:3000`.

## Configuration

The Compose file loads environment variables from `.env` via `env_file`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_EMAIL` | none | Initial admin email, considered verified |
| `ADMIN_PASSWORD` | none | Initial admin password |
| `TRUST_PROXY` | `false` | Set to `true` behind a trusted HTTPS reverse proxy |
| `PORT` | `3000` | Internal container port |
| `DATABASE_PATH` | `/app/data/pixel-print-lab.db` | SQLite path inside the container |
| `UPLOAD_DIRECTORY` | `/app/storage/uploads` | Temporary uploads |
| `ORDER_FILE_DIRECTORY` | `/app/storage/orders` | Order model files |
| `CATALOG_DIRECTORY` | `/app/storage/catalog` | Admin catalog assets |
| `SMTP_HOST` | empty | SMTP server host |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | `true` for direct TLS, usually on port 465 |
| `SMTP_USER` | empty | Optional SMTP user |
| `SMTP_PASSWORD` | empty | SMTP password, required if user is set |
| `SMTP_FROM` | empty | Notification sender |
| `SMTP_TO` | empty | Order notification recipient |

Email sending is disabled by default. After configuring SMTP, open the Control Room, click the settings gear, and enable "Email on new orders". An SMTP error is logged but does not cancel an already saved order.

## Persistence and backup

Named volumes `pixel-print-lab-data` and `pixel-print-lab-storage` keep the database, orders, and assets. Data persists after `docker compose down` or container rebuild.

Consistent backup:

```sh
docker compose stop
docker compose run --rm --no-deps --entrypoint tar app -czf - -C /app data storage > pixel-print-lab-backup.tar.gz
docker compose start
```

To update:

```sh
git pull
docker compose pull
docker compose up -d
```

## Publish with Cloudflare Tunnel

`compose.cloudflare.yml` exposes the app through a Cloudflare Tunnel without publishing port 3000 on the NAS. `TRUST_PROXY` is enabled automatically.

1. Add a domain to Cloudflare and create a tunnel.
2. Configure a public HTTPS hostname with origin service `http://app:3000`.
3. Copy `.env.cloudflare.example` to `.env`, set strong admin credentials, and fill `TUNNEL_TOKEN`.
4. Start:

   ```sh
   docker compose -f compose.cloudflare.yml pull
   docker compose -f compose.cloudflare.yml up -d
   ```

## Local API

- `GET /api/products`: visible products.
- `GET /api/products/:id`: product detail.
- `GET /api/colors`: active colors.
- `POST /api/custom-models/upload`: temporary upload and inspection of a 3MF file.
- `POST /api/custom-models/link`: validation of an external link.
- `DELETE /api/custom-models/:id`: delete a temporary upload.
- `POST /api/orders`: create a persistent request.
- `GET /api/orders`: public list limited to request code and status.
- `/api/account/*`: registration, login, logout, session, personal history, and password change.
- `/api/admin/*`: authentication and protected management of requests, products, assets, colors, settings, and admin credentials.

## Documentation

- [`CHANGELOG.md`](CHANGELOG.md): changes included in each release.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to contribute.
- [`SECURITY.md`](SECURITY.md): how to report security issues.

## Release and license

Stable releases are published on the [Releases](https://github.com/FOX3L/pixel-print-lab/releases) page. Tags follow semantic versioning and automatically build the Docker image on `ghcr.io/fox3l/pixel-print-lab`.

This project is distributed under the [MIT](LICENSE) license.
