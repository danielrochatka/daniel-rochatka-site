# Daniel Rochatka Personal Site

Personal website for Daniel Edmund Rochatka at `https://daniel.rochatka.com`.

## Purpose

This site is Daniel's durable personal record: professional identity, selected projects, research, technical writing, and contact information.

It is intentionally separate from Procyonsoft:

- `daniel.rochatka.com` presents Daniel as the author, architect, engineer, and researcher.
- `procyonsoft.com` remains the company site for services, client engagement, corporate capabilities, and commercial contact.
- This repository must not modify the Procyonsoft site or its contact service.

## Content structure

- `/` - positioning, current focus, selected work, and site/company boundary
- `/projects/` - active, research, and incubation-stage projects
- `/research/` - publications and developing frameworks
- `/notes/` - future technical essays and design notes
- `/about/` - professional approach and working principles
- `/contact/` - direct personal contact and company-routing boundary

## Visual identity

The design is an editorial systems notebook rather than a SaaS marketing page:

- warm paper background and graphite typography
- blue for authored technical direction
- amber for numbering, state, and signal
- large serif statements paired with restrained system typography
- visible grids, rules, status labels, and numbered structures
- minimal client-side JavaScript; the initial site ships none

## Technology

- Astro static output
- Node.js 22.12 or newer
- directory-format routes
- trailing slashes
- `@astrojs/sitemap`
- static deployment through `rsync`
- Caddy document root: `/srv/www/daniel-rochatka`

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
sudo -u deploy env PUBLIC_SITE_ENV=production npm run build
```

Verify indexing and sitemap output:

```bash
grep -o '<meta name="robots"[^>]*>' dist/index.html
ls -l dist/robots.txt dist/sitemap-index.xml dist/sitemap-0.xml
```

Expected robots meta:

```html
<meta name="robots" content="index,follow">
```

## Server setup

```bash
sudo mkdir -p /opt/sites/daniel-rochatka
sudo chown -R deploy:deploy /opt/sites/daniel-rochatka
sudo mkdir -p /srv/www/daniel-rochatka
```

Clone as the deployment user:

```bash
sudo -u deploy git clone https://github.com/danielrochatka/daniel-rochatka-site.git /opt/sites/daniel-rochatka
```

## Deployment

```bash
cd /opt/sites/daniel-rochatka
sudo -u deploy npm install
sudo -u deploy env PUBLIC_SITE_ENV=production npm run build

sudo rsync -a --delete \
  /opt/sites/daniel-rochatka/dist/ \
  /srv/www/daniel-rochatka/
```

Static deployments do not require a Caddy reload.

## Public verification

```bash
curl -I https://daniel.rochatka.com/
curl -s https://daniel.rochatka.com/robots.txt
curl -I https://daniel.rochatka.com/sitemap-index.xml
```

## Contact-service boundary

The initial site uses a `mailto:` link and has no server-side contact service.

If a personal contact API is added later, it must use a distinct local port, service name, environment file, sender configuration, and Caddy route. It must not reuse `procyonsoft-contact.service` or port `8787`.
