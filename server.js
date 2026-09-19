/**
 * VELTEX ADS — backend server
 * Zero external dependencies: runs with plain `node server.js`.
 *
 * Storage:
 *  - data/db.json   -> sites, ads (metadata), events (impressions/clicks)
 *  - uploads/        -> actual video files
 *
 * NOTE: this stores data on the local disk. Most free PaaS hosts (Render,
 * Railway free tier, etc.) wipe local disk on every redeploy/restart unless
 * you attach a persistent volume. See README.md for notes on that, and on
 * moving to real object storage (S3 / R2) when you outgrow this.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const ROOT = __dirname;
// STORAGE_DIR can be pointed at a mounted persistent disk (e.g. Render Disks
// mount at /var/data). Defaults to a local "storage" folder for local runs.
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(ROOT, 'storage');
const DATA_FILE = path.join(STORAGE_DIR, 'db.json');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024; // 80MB per request (video is base64-encoded, ~33% bigger than the file)

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { sites: [], ads: [], events: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('db.json was corrupt, resetting it:', e.message);
    const initial = { sites: [], ads: [], events: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error('Upload too large (max ~60MB video)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ico': 'image/x-icon',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function safeJoin(baseDir, unsafePath) {
  const target = path.join(baseDir, unsafePath);
  if (!target.startsWith(baseDir)) return null; // block path traversal
  return target;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // ---------- Pages ----------
    if (req.method === 'GET' && pathname === '/') {
      return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    }
    if (req.method === 'GET' && pathname === '/embed') {
      return serveFile(res, path.join(PUBLIC_DIR, 'embed.html'));
    }
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
      const fp = safeJoin(UPLOADS_DIR, path.basename(pathname));
      if (!fp) { res.writeHead(400); return res.end('Bad path'); }
      return serveFile(res, fp);
    }

    // ---------- API: sites ----------
    if (pathname === '/api/sites' && req.method === 'GET') {
      return sendJSON(res, 200, loadDB().sites);
    }
    if (pathname === '/api/sites' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.url) return sendJSON(res, 400, { error: 'url is required' });
      const db = loadDB();
      const site = { id: makeId('site'), name: body.name || body.url, url: body.url, createdAt: Date.now() };
      db.sites.push(site);
      saveDB(db);
      return sendJSON(res, 201, site);
    }
    let m = pathname.match(/^\/api\/sites\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const db = loadDB();
      db.sites = db.sites.filter((s) => s.id !== m[1]);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- API: ads ----------
    if (pathname === '/api/ads' && req.method === 'GET') {
      const db = loadDB();
      return sendJSON(res, 200, db.ads.map((a) => ({ ...a, url: '/uploads/' + a.filename })));
    }
    if (pathname === '/api/ads' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8'));
      if (!body.name || !body.dataBase64) {
        return sendJSON(res, 400, { error: 'name and dataBase64 are required' });
      }
      const mimeExt = (body.mimetype || '').split('/')[1] || 'mp4';
      const ext = '.' + mimeExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || '.mp4';
      const adId = makeId('ad');
      const filename = adId + ext;
      const buffer = Buffer.from(body.dataBase64, 'base64');
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
      const db = loadDB();
      const ad = {
        id: adId,
        name: body.name,
        cta: body.cta || '',
        filename,
        mimetype: body.mimetype || 'video/mp4',
        createdAt: Date.now(),
      };
      db.ads.push(ad);
      saveDB(db);
      return sendJSON(res, 201, { ...ad, url: '/uploads/' + filename });
    }
    m = pathname.match(/^\/api\/ads\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const db = loadDB();
      const ad = db.ads.find((a) => a.id === m[1]);
      if (ad) {
        const fp = path.join(UPLOADS_DIR, ad.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      db.ads = db.ads.filter((a) => a.id !== m[1]);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- API: events ----------
    if (pathname === '/api/events' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.type) return sendJSON(res, 400, { error: 'type is required' });
      const db = loadDB();
      db.events.push({
        id: makeId('ev'),
        siteId: body.siteId || null,
        adId: body.adId || null,
        type: body.type,
        ts: Date.now(),
      });
      saveDB(db);
      return sendJSON(res, 201, { ok: true });
    }

    // ---------- API: stats ----------
    if (pathname === '/api/stats' && req.method === 'GET') {
      const db = loadDB();
      const impressions = db.events.filter((e) => e.type === 'impression').length;
      const clicks = db.events.filter((e) => e.type === 'click').length;
      const perAd = db.ads
        .map((a) => ({
          id: a.id,
          name: a.name,
          impressions: db.events.filter((e) => e.adId === a.id && e.type === 'impression').length,
          clicks: db.events.filter((e) => e.adId === a.id && e.type === 'click').length,
        }))
        .sort((a, b) => b.impressions - a.impressions);
      const perSite = db.sites.map((s) => ({
        id: s.id,
        name: s.name,
        impressions: db.events.filter((e) => e.siteId === s.id && e.type === 'impression').length,
        clicks: db.events.filter((e) => e.siteId === s.id && e.type === 'click').length,
      }));
      return sendJSON(res, 200, { sites: db.sites.length, ads: db.ads.length, impressions, clicks, perAd, perSite });
    }

    // ---------- Static fallback (favicon etc.) ----------
    const staticPath = safeJoin(PUBLIC_DIR, pathname.replace(/^\//, ''));
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      return serveFile(res, staticPath);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`VELTEX Ads server running at http://localhost:${PORT}`);
});
