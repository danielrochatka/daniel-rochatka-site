# Production deployment

Every push to `main` triggers a GitHub Actions workflow that SSHes to the production server as the `deploy` user and runs a root-owned deployment script. No build occurs inside GitHub Actions. The server fetches, builds, validates, and rsyncs the site.

## Architecture

```
GitHub push to main
    → GitHub Actions (ubuntu-latest)
    → SSH as deploy
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
| `DEPLOY_KNOWN_HOSTS` | The server's host key entry (one line, from `ssh-keyscan`) |

Generate the known-hosts entry on the server:
```sh
ssh-keyscan -H <server-hostname-or-ip>
```
Copy the output into the `DEPLOY_KNOWN_HOSTS` secret.

---

## SSH key directions

There are two separate SSH relationships. Do not assume one key serves both.

### 1. GitHub Actions → server (inbound SSH as `deploy`)

The GitHub Actions runner SSHes to the production server. The private key is stored in `DEPLOY_SSH_PRIVATE_KEY`. Its public counterpart must be in `/home/deploy/.ssh/authorized_keys` on the server.

Generate a dedicated deploy key:
```sh
ssh-keygen -t ed25519 -C "github-actions-deploy@daniel.rochatka.com" -f ~/.ssh/deploy_daniel_rochatka
```

Add the public key to the server:
```sh
# On the server:
sudo -u deploy install -m 700 -d /home/deploy/.ssh
echo "<public-key-content>" | sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Store the private key content as `DEPLOY_SSH_PRIVATE_KEY` in GitHub Secrets.

### 2. Server → GitHub (outbound fetch as `deploy`)

The deployment script runs `git fetch origin main` as the `deploy` user. This requires the server to be able to authenticate to GitHub to pull the repository.

Verify the current state:
```sh
sudo -u deploy git -C /opt/sites/daniel-rochatka-site remote -v
sudo -u deploy git -C /opt/sites/daniel-rochatka-site fetch --prune origin main
```

If the repository is cloned via HTTPS, no additional key setup is required (public repository). If cloned via SSH, a GitHub deploy key must be installed in `/home/deploy/.ssh/` and registered in the GitHub repository's Settings → Deploy keys (read-only access is sufficient).

---

## Server setup

### OS user

```sh
sudo useradd --system --home-dir /home/deploy --create-home --shell /bin/bash deploy
```

### Repository checkout

```sh
sudo -u deploy git clone git@github.com:danielrochatka/daniel-rochatka-site.git \
  /opt/sites/daniel-rochatka-site
```

Or clone via HTTPS if no GitHub SSH key is set up:
```sh
sudo -u deploy git clone https://github.com/danielrochatka/daniel-rochatka-site.git \
  /opt/sites/daniel-rochatka-site
```

### Environment file

```sh
sudo -u deploy install -m 600 /dev/null /opt/sites/daniel-rochatka-site/.env
# Then edit to add real values:
sudo -u deploy nano /opt/sites/daniel-rochatka-site/.env
```

See `.env.example` for the required variable names. The `.env` file is gitignored and never committed.

### Static web root

```sh
sudo install -d -o deploy -g deploy -m 755 /srv/www/daniel-rochatka
```

### Install deployment script

After each pull that changes `deploy/deploy-site.sh`, reinstall it:

```sh
sudo install -o root -g root -m 0755 \
  /opt/sites/daniel-rochatka-site/deploy/deploy-site.sh \
  /usr/local/sbin/deploy-daniel-rochatka-site
```

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
sudo -u deploy sudo /usr/local/sbin/deploy-daniel-rochatka-site --help 2>&1 || true
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
4. Runs `git reset --hard origin/main` as `deploy`. Does **not** run `git clean`. The `.env` file (untracked, gitignored) is preserved.
5. Runs `npm ci` as `deploy`.
6. Runs `PUBLIC_SITE_ENV=production npm run build` as `deploy` (generates social image, then builds the Astro site).
7. Validates required build artifacts: `dist/index.html`, `dist/robots.txt`, `dist/sitemap-index.xml`.
8. Confirms `<meta name="robots" content="index,follow">` is present in `dist/index.html`.
9. Fails if `daniel@rochatka.com` appears anywhere in `dist/`.
10. All validation must pass before any file is written to the live web root.
11. Rsyncs `dist/` to `/srv/www/daniel-rochatka/`.
12. Restarts `daniel-rochatka-contact.service` if the unit is installed. Never touches `procyonsoft-contact.service`.
13. Verifies HTTP 200 from the health endpoint and three public URLs.
14. Prints the deployed commit SHA.

---

## Rollback procedure

### Preferred: push a revert commit to main

```sh
git revert HEAD --no-edit
git push origin main
```

GitHub Actions triggers automatically and deploys the reverted state.

### Manual: redeploy from a specific commit

If you need to deploy a prior state without creating a revert commit:

```sh
# On the server:
sudo -u deploy git -C /opt/sites/daniel-rochatka-site fetch --prune origin
sudo -u deploy git -C /opt/sites/daniel-rochatka-site reset --hard <target-sha>
sudo /usr/local/sbin/deploy-daniel-rochatka-site
```

Note: the automated deploy script resets to `origin/main`. After a manual rollback, the next push to main will automatically advance to the current HEAD again.

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
