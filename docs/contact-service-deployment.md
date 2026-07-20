# Contact service deployment

The site is a static Astro build served by Caddy. The contact form posts JSON to a same-origin `/api/contact` endpoint that Caddy reverse-proxies to a small local Node.js service.

The normal contact flow is:

1. The browser completes a Cloudflare Turnstile challenge in the contact form.
2. The browser submits the contact fields plus `cf-turnstile-response` to `/api/contact`.
3. The Node contact service validates the token with Cloudflare Siteverify.
4. Only after successful Siteverify validation does the service send one internal Resend notification to Daniel.
5. No acknowledgement email is sent to the visitor, and there is no email-ownership confirmation workflow.

Turnstile validates the browser challenge. It does not prove ownership of the visitor's submitted email address.

This service is fully separate from the Procyonsoft contact service. It uses Daniel-specific environment variable names, a different port, a different systemd unit, and a different OS user.

## Environment variables

Store runtime service variables in `/opt/sites/daniel-rochatka-site/.env` — loaded by systemd, never committed to git.

Required by the Node contact service:

```sh
DANIEL_RESEND_API_KEY=re_replace_me
DANIEL_CONTACT_FROM="Daniel Rochatka Website <forms@daniel.rochatka.com>"
DANIEL_CONTACT_TO=destination@example.com
TURNSTILE_SECRET_KEY=replace_me
```

Required at Astro build time for the public widget:

```sh
PUBLIC_TURNSTILE_SITE_KEY=replace_me
```

`PUBLIC_TURNSTILE_SITE_KEY` is intentionally public and is embedded into the built contact page. `TURNSTILE_SECRET_KEY` is secret and is used only by the Node contact service at runtime for Siteverify.

Optional:

```sh
DANIEL_CONTACT_HOST=127.0.0.1
DANIEL_CONTACT_PORT=8788
DANIEL_ALLOWED_ORIGINS=https://daniel.rochatka.com,https://www.daniel.rochatka.com
DANIEL_MIN_SUBMIT_SECONDS=2
DANIEL_IP_RATE_LIMIT=3
DANIEL_GLOBAL_BURST_LIMIT=20
DANIEL_DUPLICATE_WINDOW_HOURS=24
DANIEL_ACK_ENABLED=false
```

The normal Turnstile-gated contact path does not require `DANIEL_CONTACT_DATA_DIR`, `DANIEL_RESEND_WEBHOOK_SECRET`, or `DANIEL_EMAIL_ACK_LIMIT`. Acknowledgement emails and webhook tracking are disabled for the normal contact path.

The service exits during startup if required service variables are missing. Do not expose secret values in HTML, JavaScript, logs, or committed files.

## Start locally

```sh
npm run contact:start
```

## systemd unit

Install the unit from the repository:

```sh
sudo cp deploy/daniel-rochatka-contact.service /etc/systemd/system/daniel-rochatka-contact.service
sudo systemctl daemon-reload
sudo systemctl enable --now daniel-rochatka-contact.service
sudo systemctl status daniel-rochatka-contact.service
sudo journalctl -u daniel-rochatka-contact.service -f
```

The unit runs as the `daniel-rochatka` OS user. Create that user if it does not exist:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin daniel-rochatka
```

Ensure the user can read the `.env` file:

```sh
sudo chown daniel-rochatka:daniel-rochatka /opt/sites/daniel-rochatka-site/.env
sudo chmod 600 /opt/sites/daniel-rochatka-site/.env
```

## Caddy integration

Add the following inside the `daniel.rochatka.com` site block, **before** the static-file handler:

```caddyfile
daniel.rochatka.com {
  @contact path /api/contact
  reverse_proxy @contact 127.0.0.1:8788

  root * /srv/www/daniel-rochatka
  file_server
  try_files {path} {path}index.html
}
```

The `/api/contact` matcher must appear before `file_server` so Caddy does not try to serve the API path as a static file.

Validate and reload:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Production build and static sync

Run the production build and sync the output to the static web root:

```sh
cd /opt/sites/daniel-rochatka-site
npm ci
PUBLIC_SITE_ENV=production PUBLIC_TURNSTILE_SITE_KEY=replace_me npm run build
sudo rsync -a --delete dist/ /srv/www/daniel-rochatka/
```

## Smoke tests

Health check from the server:

```sh
curl -i http://127.0.0.1:8788/healthz
```

Contact submissions require a fresh browser Turnstile token. Do not use production credentials in documentation examples. For local browser fixtures only, Cloudflare's public test site key may be used: `1x00000000000000000000AA`.

## Automatic deployment

**The Procyonsoft repository contains no GitHub Actions workflows or post-receive hooks.** The `.deploy-trigger` file is a policy statement only. The actual deployment mechanism for both sites must be confirmed against the live server configuration before automating it. Do not implement a post-receive hook or CI workflow until the existing Procyonsoft server-side mechanism has been inspected.

When ready, the steps above (npm ci, build, rsync) can be wrapped in a deploy script and triggered from whatever mechanism is in place.

## Separation from Procyonsoft

| Attribute | Procyonsoft | daniel.rochatka.com |
|---|---|---|
| Service name | `procyonsoft-contact` | `daniel-rochatka-contact` |
| Port | 8787 | 8788 |
| OS user | `procyonsoft` | `daniel-rochatka` |
| Working dir | `/opt/procyonsoft` | `/opt/sites/daniel-rochatka-site` |
| Env file | `/opt/procyonsoft/.env` | `/opt/sites/daniel-rochatka-site/.env` |
| Env var prefix | `PROCYONSOFT_*` | `DANIEL_*` |
| Static root | `/opt/procyonsoft/dist` | `/srv/www/daniel-rochatka` |

## Troubleshooting

- **Missing env vars:** `journalctl -u daniel-rochatka-contact.service` shows startup failure. Confirm `.env` has the required Daniel and Turnstile service variables and is readable by `daniel-rochatka`.
- **Turnstile failure:** The service returns a generic retry message and logs safe `turnstile_failed` metadata. Confirm the runtime secret, build-time public site key, and Cloudflare-approved hostnames.
- **Resend failure (502):** Check service logs for `notification_failure` category. May indicate invalid API key or unverified sender domain in Resend.
- **Service not listening:** Run `ss -ltnp | grep 8788` on the server. Check `DANIEL_CONTACT_HOST` and `DANIEL_CONTACT_PORT` match the Caddy reverse proxy target.
- **Caddy 502:** Confirm the Node service is running on `127.0.0.1:8788` and the reverse-proxy matcher appears before static-file handling.
- **Rate-limit (429):** More than the configured number of submissions from the same IP within 10 minutes. Wait for the window to expire.
