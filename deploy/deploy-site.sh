#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR=/opt/sites/daniel-rochatka-site
DIST_DIR="${REPO_DIR}/dist"
WEB_ROOT=/srv/www/daniel-rochatka
LOCK_FILE=/var/lock/deploy-daniel-rochatka-site.lock
CONTACT_SERVICE=daniel-rochatka-contact.service

# Nonblocking lock: fail immediately if another deployment is already running
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "ERROR: Another deployment is already running. Exiting." >&2
  exit 1
fi

echo "=== Deployment started: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# Confirm repository checkout exists
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "ERROR: ${REPO_DIR}/.git not found. Initialize the repository first." >&2
  exit 1
fi

# Bring the checkout to exactly origin/main.
# reset --hard updates tracked files; clean removes untracked and ignored files
# so the build reflects the committed tree and nothing else. .env is excluded
# because it is untracked by design and must survive across deployments.
echo "--- Fetching origin/main ---"
runuser -u deploy -- git -C "${REPO_DIR}" fetch --prune origin main
runuser -u deploy -- git -C "${REPO_DIR}" reset --hard origin/main
runuser -u deploy -- git -C "${REPO_DIR}" clean -ffdx --exclude=.env

COMMIT_SHA=$(runuser -u deploy -- git -C "${REPO_DIR}" rev-parse HEAD)
echo "Commit: ${COMMIT_SHA}"

# Install dependencies from the lock file
echo "--- Installing dependencies ---"
runuser -u deploy -- bash -c "cd ${REPO_DIR} && npm ci"

# Production Astro build (social image generation + static output)
echo "--- Building site ---"
runuser -u deploy -- bash -c "cd ${REPO_DIR} && PUBLIC_SITE_ENV=production npm run build"

# Validate required artifacts before touching the live site
echo "--- Validating build artifacts ---"
for artifact in \
  "${DIST_DIR}/index.html" \
  "${DIST_DIR}/robots.txt" \
  "${DIST_DIR}/sitemap-index.xml"; do
  if [[ ! -f "${artifact}" ]]; then
    echo "ERROR: Required artifact missing: ${artifact}" >&2
    exit 1
  fi
done

# Require production robots meta tag
if ! grep -qF '<meta name="robots" content="index,follow">' "${DIST_DIR}/index.html"; then
  echo "ERROR: <meta name=\"robots\" content=\"index,follow\"> not found in dist/index.html" >&2
  exit 1
fi

# Fail if private email address appears anywhere in dist output
if grep -rqF 'daniel@rochatka.com' "${DIST_DIR}"; then
  echo "ERROR: Private email address found in dist output:" >&2
  grep -rlF 'daniel@rochatka.com' "${DIST_DIR}" >&2
  exit 1
fi

echo "--- Build validation passed ---"

# Sync built output to web root
echo "--- Syncing to ${WEB_ROOT} ---"
rsync -a --delete "${DIST_DIR}/" "${WEB_ROOT}/"
echo "--- Sync complete ---"

# Restart contact service. Fails if the unit is not installed: the contact form
# is always published to the live site, so the service must be running.
echo "--- Restarting ${CONTACT_SERVICE} ---"
systemctl restart "${CONTACT_SERVICE}"

# Post-deploy verification
echo "--- Post-deploy verification ---"
FAILED=0

check_url() {
  local label="$1"
  local url="$2"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${url}" 2>/dev/null || echo "000")
  if [[ "${status}" == "200" ]]; then
    echo "  OK    ${label} (${status})"
  else
    echo "  FAIL  ${label} — expected 200, got ${status}: ${url}" >&2
    FAILED=1
  fi
}

check_url "homepage"   "https://daniel.rochatka.com/"
check_url "robots.txt" "https://daniel.rochatka.com/robots.txt"
check_url "sitemap"    "https://daniel.rochatka.com/sitemap-index.xml"

# Verify the contact API is reachable through the public Caddy route.
# The website field (honeypot) is set, so the service returns 200 without
# sending email. A non-200 response means the service is down or Caddy is
# not routing /api/contact correctly — both are deploy blockers.
contact_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST \
  -d 'name=deploy-check&email=deploy%40example.com&message=deployment+smoke+test&website=bot' \
  'https://daniel.rochatka.com/api/contact' 2>/dev/null || echo "000")
if [[ "${contact_status}" == "200" ]]; then
  echo "  OK    contact API honeypot (${contact_status})"
else
  echo "  FAIL  contact API honeypot — expected 200, got ${contact_status}" >&2
  FAILED=1
fi

if [[ "${FAILED}" -ne 0 ]]; then
  echo "ERROR: Post-deploy verification failed" >&2
  exit 1
fi

echo "=== Deployment complete: ${COMMIT_SHA} ==="
