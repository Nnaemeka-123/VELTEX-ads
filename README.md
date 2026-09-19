# VELTEX Ads — backend

A real, working video ad server: register your web app, upload video ad
creatives, get an embed code, and any visitor to your web app will be served
a real ad — tracked with impressions and clicks.

No external packages required — it's plain Node.js.

## Run it locally first (2 minutes)

```
node server.js
```

Then open **http://localhost:3000** — that's your VELTEX Ads dashboard.
Register a site, upload a video ad, grab the embed code from "Sites & Embed",
and paste it into any test HTML page to confirm it plays.

## Put it on the internet (so real visitors can see ads)

Right now it only works on your own machine. To make the embed code work on
your actual live web app, this server needs a public URL. Pick one:

**Render.com (free tier, easiest)**
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: (leave blank) · Start command: `node server.js`
4. Deploy — you'll get a URL like `https://veltex-ads.onrender.com`

**Railway.app** — similar: New Project → Deploy from GitHub → it auto-detects
`npm start`.

**A basic VPS (DigitalOcean, Hetzner, etc.)** — install Node 18+, copy this
folder over, run `node server.js` behind a process manager like `pm2`, and
put Nginx or Caddy in front for HTTPS.

Once deployed, your embed codes will automatically use that live domain
(the dashboard reads `location.origin`, so no code changes needed).

## ⚠️ Important: persistent storage

This server stores everything on local disk:
- `data/db.json` — your sites, ads' metadata, and stats
- `uploads/` — the actual video files

**Most free hosting tiers wipe local disk on every restart or redeploy.**
For anything beyond testing:
- On Render: attach a **Persistent Disk** and mount it at this project's
  `data` and `uploads` folders.
- On Railway: attach a **Volume**.
- On a VPS: this isn't an issue — the disk is already persistent.

If you outgrow single-disk storage (many advertisers, lots of traffic), the
next real upgrade is moving video storage to an object store like
Cloudflare R2 or AWS S3, and the JSON file to a real database like
Postgres or SQLite. Ask me and I'll wire that in — the API and dashboard
won't need to change from your side.

## How it's structured

```
server.js          the entire backend (routing, API, file storage) — zero deps
public/admin.html  your dashboard (register sites, upload ads, view stats)
public/embed.html  the ad player — this is what the <iframe> embed loads
data/db.json        sites, ads metadata, impression/click events
uploads/            the actual video files
```

## API reference

| Method | Path              | Purpose                          |
|--------|-------------------|-----------------------------------|
| GET    | `/api/sites`       | list registered sites            |
| POST   | `/api/sites`       | `{url, name}` → register a site  |
| DELETE | `/api/sites/:id`   | remove a site                    |
| GET    | `/api/ads`         | list ads                          |
| POST   | `/api/ads`         | `{name, cta, mimetype, dataBase64}` → upload an ad |
| DELETE | `/api/ads/:id`     | remove an ad                      |
| POST   | `/api/events`      | `{siteId, adId, type}` → log an impression/click |
| GET    | `/api/stats`       | totals + per-ad + per-site stats |
| GET    | `/embed?site=ID`   | the ad player page (what you iframe) |
