const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { BotManager } = require('./src/botManager');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'bots.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
const recentLogs = [];

const addLog = (message) => {
  const entry = {
    id: Date.now() + Math.random(),
    message,
    time: new Date().toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  };
  recentLogs.unshift(entry);
  if (recentLogs.length > 30) recentLogs.pop();
};

const botManager = new BotManager(db, addLog);

const ensureSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.20.4',
      alt_server TEXT DEFAULT '',
      login TEXT DEFAULT '',
      password TEXT DEFAULT '',
      total_bots INTEGER DEFAULT 1,
      hours_played REAL DEFAULT 0,
      online INTEGER DEFAULT 0,
      last_seen TEXT DEFAULT '',
      radar_x INTEGER DEFAULT 0,
      radar_y INTEGER DEFAULT 0,
      radar_z INTEGER DEFAULT 0,
      scoreboard TEXT DEFAULT '[]',
      server_group TEXT DEFAULT 'Genel',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

ensureSchema();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeParseScoreboard(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

app.get('/api/summary', (req, res) => {
  const totalBots = db.prepare('SELECT COUNT(*) AS total FROM bots').get().total;
  const onlineBots = db.prepare('SELECT COUNT(*) AS total FROM bots WHERE online = 1').get().total;
  const offlineBots = totalBots - onlineBots;
  const totalHours = db.prepare('SELECT COALESCE(SUM(hours_played), 0) AS total FROM bots').get().total;
  const uniqueServers = db.prepare('SELECT COUNT(DISTINCT ip) AS total FROM bots').get().total;
  const totalConnections = db.prepare('SELECT COALESCE(SUM(total_bots), 0) AS total FROM bots').get().total;

  res.json({
    totalBots,
    onlineBots,
    offlineBots,
    totalHours,
    uniqueServers,
    totalConnections,
  });
});

app.get('/api/bots', (req, res) => {
  const rows = db.prepare('SELECT * FROM bots ORDER BY id DESC').all();
  const bots = rows.map((bot) => ({
    ...bot,
    online: !!bot.online,
    total_bots: Number(bot.total_bots || 1),
    hours_played: Number(bot.hours_played || 0),
    scoreboard: safeParseScoreboard(bot.scoreboard),
  }));

  res.json({ bots });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: recentLogs });
});

app.post('/api/bots', (req, res) => {
  const payload = req.body || {};
  const bot = {
    name: String(payload.name || '').trim(),
    ip: String(payload.ip || '').trim(),
    version: String(payload.version || '1.20.4').trim(),
    alt_server: String(payload.alt_server || payload.altServer || '').trim(),
    login: String(payload.login || '').trim(),
    password: String(payload.password || '').trim(),
    total_bots: Number(payload.total_bots || payload.totalBots || 1),
    hours_played: Number(payload.hours_played || payload.hoursPlayed || 0),
    radar_x: Number(payload.radar_x || payload.radarX || 0),
    radar_y: Number(payload.radar_y || payload.radarY || 0),
    radar_z: Number(payload.radar_z || payload.radarZ || 0),
    server_group: String(payload.server_group || payload.serverGroup || 'Genel').trim(),
    scoreboard: Array.isArray(payload.scoreboard)
      ? JSON.stringify(payload.scoreboard)
      : JSON.stringify([
          { label: 'Kilit', value: '0' },
          { label: 'Can', value: '20/20' },
          { label: 'Para', value: '0' },
          { label: 'İsim', value: 'AFK' },
        ]),
  };

  if (!bot.name || !bot.ip) {
    return res.status(400).json({ message: 'Bot adı ve IP alanı zorunludur.' });
  }

  const result = db.prepare(`
    INSERT INTO bots (
      name, ip, version, alt_server, login, password, total_bots, hours_played,
      radar_x, radar_y, radar_z, scoreboard, server_group
    ) VALUES (
      @name, @ip, @version, @alt_server, @login, @password, @total_bots, @hours_played,
      @radar_x, @radar_y, @radar_z, @scoreboard, @server_group
    )
  `).run(bot);

  const created = db.prepare('SELECT * FROM bots WHERE id = ?').get(result.lastInsertRowid);
  created.scoreboard = safeParseScoreboard(created.scoreboard);

  addLog(`Bot eklendi: ${created.name} (${created.ip})`);
  botManager.startBot(created);

  res.status(201).json({ bot: created });
});

app.patch('/api/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  const payload = req.body || {};
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);

  if (!row) {
    return res.status(404).json({ message: 'Bot bulunamadı.' });
  }

  const updates = {
    ...row,
    ...payload,
    alt_server: String(payload.alt_server ?? payload.altServer ?? row.alt_server ?? '').trim(),
    login: String(payload.login ?? row.login ?? '').trim(),
    password: String(payload.password ?? row.password ?? '').trim(),
    total_bots: Number(payload.total_bots ?? payload.totalBots ?? row.total_bots ?? 1),
    hours_played: Number(payload.hours_played ?? payload.hoursPlayed ?? row.hours_played ?? 0),
    radar_x: Number(payload.radar_x ?? payload.radarX ?? row.radar_x ?? 0),
    radar_y: Number(payload.radar_y ?? payload.radarY ?? row.radar_y ?? 0),
    radar_z: Number(payload.radar_z ?? payload.radarZ ?? row.radar_z ?? 0),
    online: payload.online !== undefined ? Number(payload.online) : row.online,
    server_group: String(payload.server_group ?? payload.serverGroup ?? row.server_group ?? 'Genel'),
    scoreboard: Array.isArray(payload.scoreboard)
      ? JSON.stringify(payload.scoreboard)
      : row.scoreboard,
  };

  db.prepare(`
    UPDATE bots SET
      name = @name,
      ip = @ip,
      version = @version,
      alt_server = @alt_server,
      login = @login,
      password = @password,
      total_bots = @total_bots,
      hours_played = @hours_played,
      online = @online,
      last_seen = @last_seen,
      radar_x = @radar_x,
      radar_y = @radar_y,
      radar_z = @radar_z,
      scoreboard = @scoreboard,
      server_group = @server_group
    WHERE id = @id
  `).run({ ...updates, id });

  const updated = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  updated.scoreboard = safeParseScoreboard(updated.scoreboard);

  addLog(`Bot güncellendi: ${updated.name}`);
  botManager.startBot(updated);

  res.json({ bot: updated });
});

app.post('/api/bots/:id/reconnect', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);

  if (!bot) {
    return res.status(404).json({ message: 'Bot bulunamadı.' });
  }

  botManager.startBot(bot);
  addLog(`Bot yeniden bağlanıyor: ${bot.name}`);
  res.json({ success: true, bot });
});

app.delete('/api/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);

  if (!row) {
    return res.status(404).json({ message: 'Bot bulunamadı.' });
  }

  db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  botManager.stopBot(id);
  addLog(`Bot silindi: ${row.name}`);

  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

botManager.startAll();
addLog('Minecraft AFK bot panel başlatıldı.');

app.listen(PORT, () => {
  console.log(`Minecraft AFK Bot Panel çalışıyor: http://localhost:${PORT}`);
});
