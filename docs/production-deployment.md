# Production deployment

Every push to `main` triggers a GitHub Actions workflow that SSHes to the production server as the `deploy` user and runs a root-owned deployment script. No build occurs inside GitHub Actions. The server fetches, builds, validates, and rsyncs the site.

## Architecture

```
GitHub push to main
    → GitHub Actions (ubuntu-latest)
    → SSH as deploy (forced command in authorized_keys)
    → sudo /usr/local/sbin/deploy-daniel-rochatka-site
    → git fetch + reset, npm ci, astro build, validate, rsync
```

## Files

| File | Purpose |
|---|---|
| `.github/workflows/deploy-production.yml` | Workflow: SSH trigger only |
| `deploy/deploy-site.sh` | Deployment logic (installed to `/usr/local/sbin/`) |
| `docs/production-deployment.md` | This file |

---

## Required repository secrets

Set these in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | Production server hostname or IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_PRIVATE_KEY` | Private key whose public half is in `/home/deploy/.ssh/authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | The server's host key entry (one verified line — see below) |

### Generating and verifying `DEPLOY_KNOWN_HOSTS`

Run `ssh-keyscan` to capture the server's host key:

```sh
ssh-keyscan -H <server-hostname-or-ip>
```

Do not trust the scanned output blindly. Before storing it as the secret, verify the Ed25519 fingerprint against the key on the server itself:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Compare the fingerprint in that output to the fingerprint of the `ssh-ed25519` line returned by `ssh-keyscan`. Only store the entry in `DEPLOY_KNOWN_HOSTS` after confirming they match.

---

## SSH key directions

There are two separate SSH relationships. Do not assume one key serves both.

### 1. GitHub Actions → server (inbound SSH as `deploy`)

The GitHub Actions runner SSHes to the production server. The private key is stored in `DEPLOY_SSH_PRIVATE_KEY`. Its public counterpart must be in `/home/deploy/.ssh/authorized_keys` on the server, with a forced command that restricts the key to running only the deployment script.

Generate a dedicated deploy key:

```sh
ssh-keygen -t ed25519 -C "github-actions-deploy@daniel.rochatka.com" -f ~/.ssh/deploy_daniel_rochatka
```

Add the public key to the server with the `restrict,command=` prefix (OpenSSH 7.2+):

```
restrict,command="sudo /usr/local/sbin/deploy-daniel-rochatka-site" ssh-ed25519 PUBLIC_KEY github-actions-deploy
```

If the server's OpenSSH predates `restrict`, use the explicit option list instead:

```
command="sudo /usr/local/sbin/deploy-daniel-rochatka-site",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 PUBLIC_KEY github-actions-deploy
```

With this configuration the key cannot open an interactive shell, forward ports, or run any command other than the deploy script. Any SSH connection using this key runs the deploy script and exits.

Store the private key content as `DEPLOY_SSH_PRIVATE_KEY` in GitHub Secrets.

### 2. Server → GitHub (outbound fetch as `deploy`)

The deployment script runs `git fetch origin main` as the `deploy` user. This requires the server to be able to authenticate to GitHub to pull the repository.

The server already has a GitHub repository deployment key configured. Verify the current state before assuming any changes are needed:

```sh
sudo -u deploy git -C /opt/sites/daniel-rochatka-site remote -v
sudo -u deploy git -C /opt/sites/daniel-rochatka-site fetch --prune origin main
```

If both commands succeed, retain the existing remote and deploy key as-is. No additional configuration is required.

---

## Server setup

### Existing server (Daniel's current setup)

The `deploy` user, repository clone at `/opt/sites/daniel-rochatka-site`, and GitHub deployment key already exist. Verify they are intact:

```sh
# Confirm deploy user exists
id deploy

# Confirm repository and remote
sudo -u deploy git -C /opt/sites/daniel-rochatka-site remote -v

# Confirm outbound fetch works
sudo -u deploy git -C /opt/sites/daniel-rochatka-site fetch --prune origin main
```

If these succeed, proceed directly to installing the deployment script and sudoers rule below.

### Fresh server (reference only)

If setting up from scratch on a new server:

```sh
# OS user
sudo useradd --system --home-dir /home/deploy --create-home --shell /bin/bash deploy

# Repository checkout (HTTPS for public repo; no GitHub SSH key required)
sudo -u deploy git clone https://github.com/danielrochatka/daniel-rochatka-site.git \
  /opt/sites/daniel-rochatka-site

# Environment file
sudo -u deploy install -m 600 /dev/null /opt/sites/daniel-rochatka-site/.env
sudo -u deploy nano /opt/sites/daniel-rochatka-site/.env
# See .env.example for required variable names.

# Static web root
sudo install -d -o deploy -g deploy -m 755 /srv/www/daniel-rochatka
```

### Install deployment script

The deployment script in `deploy/deploy-site.sh` must be installed to `/usr/local/sbin/` for the `deploy` user's sudoers rule to invoke it. The workflow calls the installed copy, not the in-repo file.

```sh
sudo install -o root -g root -m 0755 \
  /opt/sites/daniel-rochatka-site/deploy/deploy-site.sh \
  /usr/local/sbin/deploy-daniel-rochatka-site
```

**After any commit that modifies `deploy/deploy-site.sh`**, this command must be rerun on the server before the next deployment. The workflow does not reinstall it automatically.

### Sudoers rule

```sh
sudo visudo -f /etc/sudoers.d/deploy-daniel-rochatka-site
```

Add:

```sudoers
deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-daniel-rochatka-site
```

Validate:

```sh
sudo visudo -c
```

### Node.js

Confirm Node.js ≥ 22.12.0 is available to the `deploy` user:

```sh
sudo -u deploy node --version
```

---

## Manual first deployment

Run the deployment script manually on the server to verify the full pipeline before relying on GitHub Actions:

```sh
# Install the script
sudo install -o root -g root -m 0755 \
  /opt/sites/daniel-rochatka-site/deploy/deploy-site.sh \
  /usr/local/sbin/deploy-daniel-rochatka-site

# Run it (the deploy user must have the sudoers rule in place)
sudo -u deploy sudo /usr/local/sbin/deploy-daniel-rochatka-site

# Or run directly as root for first-time setup:
sudo /usr/local/sbin/deploy-daniel-rochatka-site
```

Check the result:

```sh
curl -I https://daniel.rochatka.com/
curl https://daniel.rochatka.com/robots.txt
curl https://daniel.rochatka.com/sitemap-index.xml
```

---

## What the deployment script does

1. Acquires a nonblocking `flock`. Fails immediately if another deployment is running.
2. Confirms `/opt/sites/daniel-rochatka-site/.git` exists.
3. Runs `git fetch --prune origin main` as `deploy`.
4. Runs `git reset --hard origin/main` as `deploy`, then `git clean -ffdx --exclude=.env` as `deploy`. The clean removes all untracked and gitignored files (stale build artifacts, leftover experiment files) so the build reflects exactly the committed tree. `.env` is excluded because it is untracked by design.
5. Runs `npm ci` as `deploy`.
6. Runs `PUBLIC_SITE_ENV=production npm run build` as `deploy` (generates social image, then builds the Astro site).
7. Validates required build artifacts: `dist/index.html`, `dist/robots.txt`, `dist/sitemap-index.xml`.
8. Confirms `<meta name="robots" content="index,follow">` is present in `dist/index.html`.
9. Fails if `daniel@rochatka.com` appears anywhere in `dist/`.
10. All validation must pass before any file is written to the live web root.
11. Rsyncs `dist/` to `/srv/www/daniel-rochatka/`.
12. Restarts `daniel-rochatka-contact.service`. **Fails if the unit is not installed** — the contact form is always present on the published site, so the service must be running. Never touches `procyonsoft-contact.service`.
13. Verifies HTTP 200 from three public URLs. Sends a honeypot POST to `https://daniel.rochatka.com/api/contact` (the `website` field is set, so no email is sent) — a non-200 response means the service is down or Caddy is not routing `/api/contact` correctly, and the deploy fails.
14. Prints the deployed commit SHA.

---

## Rollback procedure

Push a revert commit to `main`:

```sh
git revert HEAD --no-edit
git push origin main
```

GitHub Actions triggers automatically and deploys the reverted state. There is no other rollback path: the deployment script always resets to `origin/main`, so manually resetting the server checkout to an older SHA before invoking the script would be immediately overwritten by the script's own `git reset --hard origin/main`.

---

## Updating the deployment script

If `deploy/deploy-site.sh` is modified, reinstall it to `/usr/local/sbin/` before the next deployment:

```sh
sudo install -o root -g root -m 0755 \
  /opt/sites/daniel-rochatka-site/deploy/deploy-site.sh \
  /usr/local/sbin/deploy-daniel-rochatka-site
```

This step is not automated. The workflow always calls the installed script, not the in-repo version.

---

## Separation from Procyonsoft

This workflow and script are entirely independent from the Procyonsoft deployment:

- Different repository (`danielrochatka/daniel-rochatka-site`)
- Different server path (`/opt/sites/daniel-rochatka-site`)
- Different web root (`/srv/www/daniel-rochatka`)
- Different service (`daniel-rochatka-contact.service`)
- Different lock file (`/var/lock/deploy-daniel-rochatka-site.lock`)
- Different sudoers rule (`/etc/sudoers.d/deploy-daniel-rochatka-site`)
- Different installed script (`/usr/local/sbin/deploy-daniel-rochatka-site`)

The deployment script explicitly never interacts with `procyonsoft-contact.service`.
