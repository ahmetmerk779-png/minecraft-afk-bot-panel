const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { BotManager } = require('./src/botManager');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'bots.db');
const startupTime = Date.now();

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
const recentLogs = [];
const notifications = [];

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
  if (recentLogs.length > 50) recentLogs.pop();
};

const addNotification = (botId, type, message) => {
  const notification = {
    id: Date.now() + Math.random(),
    botId,
    type,
    message,
    timestamp: new Date().toISOString(),
    read: false,
  };
  notifications.unshift(notification);
  if (notifications.length > 100) notifications.pop();
};

const botManager = new BotManager(db, addLog);

function coerceBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const str = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(str)) return true;
  if (['0', 'false', 'no', 'off'].includes(str)) return false;
  return fallback;
}

function safeParseScoreboard(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
      enabled INTEGER DEFAULT 1,
      auto_reconnect INTEGER DEFAULT 1,
      retry_interval INTEGER DEFAULT 15,
      retry_count INTEGER DEFAULT 0,
      last_heartbeat TEXT DEFAULT '',
      last_error TEXT DEFAULT '',
      last_seen TEXT DEFAULT '',
      radar_x INTEGER DEFAULT 0,
      radar_y INTEGER DEFAULT 0,
      radar_z INTEGER DEFAULT 0,
      scoreboard TEXT DEFAULT '[]',
      server_group TEXT DEFAULT 'Genel',
      schedule_start TEXT DEFAULT '',
      schedule_end TEXT DEFAULT '',
      schedule_enabled INTEGER DEFAULT 0,
      avg_ping INTEGER DEFAULT 0,
      avg_tps REAL DEFAULT 20,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

ensureSchema();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/summary', (req, res) => {
  const totalBots = db.prepare('SELECT COUNT(*) AS total FROM bots').get().total;
  const onlineBots = db.prepare('SELECT COUNT(*) AS total FROM bots WHERE online = 1').get().total;
  const offlineBots = totalBots - onlineBots;
  const totalHours = db.prepare('SELECT COALESCE(SUM(hours_played), 0) AS total FROM bots').get().total;
  const uniqueServers = db.prepare('SELECT COUNT(DISTINCT ip) AS total FROM bots').get().total;
  const totalConnections = db.prepare('SELECT COALESCE(SUM(total_bots), 0) AS total FROM bots').get().total;
  const totalGroups = db.prepare('SELECT COUNT(DISTINCT server_group) AS total FROM bots').get().total;
  const avgHours = totalBots ? totalHours / totalBots : 0;
  const autoReconnectCount = db.prepare('SELECT COUNT(*) AS total FROM bots WHERE auto_reconnect = 1').get().total;
  const reconnectingCount = botManager.getReconnectStats().count;

  res.json({
    totalBots,
    onlineBots,
    offlineBots,
    totalHours,
    uniqueServers,
    totalConnections,
    totalGroups,
    avgHours,
    autoReconnectCount,
    reconnectingCount,
    uptime: process.uptime(),
  });
});

app.get('/api/system', (req, res) => {
  res.json({
    uptime: process.uptime(),
    startedAt: new Date(startupTime).toISOString(),
    now: new Date().toISOString(),
    reconnectingCount: botManager.getReconnectStats().count,
    activeBots: botManager.getClientsCount(),
  });
});

app.get('/api/bots', (req, res) => {
  const rows = db.prepare('SELECT * FROM bots ORDER BY id DESC').all();
  const bots = rows.map((bot) => ({
    ...bot,
    online: !!bot.online,
    enabled: coerceBoolean(bot.enabled, true),
    auto_reconnect: coerceBoolean(bot.auto_reconnect, true),
    schedule_enabled: coerceBoolean(bot.schedule_enabled, false),
    total_bots: Number(bot.total_bots || 1),
    hours_played: Number(bot.hours_played || 0),
    retry_interval: Number(bot.retry_interval || 15),
    retry_count: Number(bot.retry_count || 0),
    avg_ping: Number(bot.avg_ping || 0),
    avg_tps: Number(bot.avg_tps || 20),
    scoreboard: safeParseScoreboard(bot.scoreboard),
  }));

  res.json({ bots });
});

app.get('/api/bots/groups', (req, res) => {
  const groups = db.prepare(`
    SELECT server_group AS name,
           COUNT(*) AS total,
           SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online,
           COALESCE(AVG(hours_played), 0) AS avgHours
    FROM bots
    GROUP BY server_group
    ORDER BY total DESC
  `).all();

  res.json({ groups });
});

app.get('/api/bots/:id/metrics', (req, res) => {
  const botId = Number(req.params.id);
  const metrics = botManager.getMetrics(botId);
  res.json({ metrics });
});

app.get('/api/notifications', (req, res) => {
  const unread = notifications.filter((n) => !n.read);
  res.json({ notifications: unread, total: unread.length });
});

app.post('/api/notifications/:id/read', (req, res) => {
  const id = Number(req.params.id);
  const notification = notifications.find((n) => n.id === id);
  if (notification) notification.read = true;
  res.json({ success: true });
});

app.post('/api/bots/:id/schedule', (req, res) => {
  const botId = Number(req.params.id);
  const { startTime, endTime, enabled, recurring } = req.body;
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);

  if (!bot) return res.status(404).json({ message: 'Bot bulunamadı.' });

  db.prepare('UPDATE bots SET schedule_start = ?, schedule_end = ?, schedule_enabled = ? WHERE id = ?')
    .run(startTime, endTime, enabled ? 1 : 0, botId);

  botManager.scheduleBot(botId, { startTime, endTime, recurring: recurring || false });
  addLog(`Bot zamanlaması güncellendi: ${bot.name} (${startTime} - ${endTime})`);
  addNotification(botId, 'info', `Zamanlama güncellendi: ${startTime} - ${endTime}`);

  res.json({ success: true });
});

app.get('/api/schedules', (req, res) => {
  res.json({ schedules: botManager.getSchedules() });
});

app.get('/api/logs/export', (req, res) => {
  const format = req.query.format || 'json';
  if (format === 'csv') {
    const csv = recentLogs
      .map((log) => `"${log.time}","${log.message.replace(/"/g, '""')}"`)
      .join('\n');
    res.type('text/csv').send('Time,Message\n' + csv);
  } else if (format === 'txt') {
    const txt = recentLogs.map((log) => `[${log.time}] ${log.message}`).join('\n');
    res.type('text/plain').send(txt);
  } else {
    res.json({ logs: recentLogs });
  }
});

app.get('/api/bots/export/:format', (req, res) => {
  const format = req.params.format;
  const rows = db.prepare('SELECT * FROM bots ORDER BY id DESC').all();

  if (format === 'csv') {
    const headers = ['ID', 'Name', 'IP', 'Version', 'Status', 'Hours', 'Group', 'Online'];
    const csv = headers.join(',');
    const data = rows.map((bot) => `${bot.id},"${bot.name}","${bot.ip}","${bot.version}","${bot.online ? 'Online' : 'Offline'}",${bot.hours_played},"${bot.server_group}",${bot.online}`).join('\n');
    res.type('text/csv').send(csv + '\n' + data);
  } else {
    res.json(rows);
  }
});

app.post('/api/groups/distribute', (req, res) => {
  const { groupName, action, count } = req.body;
  const bots = db.prepare('SELECT * FROM bots WHERE server_group = ?').all(groupName);

  if (!bots.length) return res.status(404).json({ message: 'Grup bulunamadı veya bot yok.' });

  let processed = 0;
  for (const bot of bots.slice(0, count || bots.length)) {
    if (action === 'start') {
      botManager.startBot(bot);
      processed++;
    } else if (action === 'stop') {
      botManager.stopBot(bot.id);
      processed++;
    } else if (action === 'restart') {
      botManager.stopBot(bot.id);
      setTimeout(() => botManager.startBot(bot), 500);
      processed++;
    }
  }

  addLog(`Grup işlemi: ${action} (${groupName}) - ${processed} bot`);
  addNotification(null, 'info', `${action} işlemi ${groupName} grubunda ${processed} bota uygulandı`);
  res.json({ success: true, processed, total: bots.length });
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
    enabled: Number(coerceBoolean(payload.enabled, true) ? 1 : 0),
    auto_reconnect: Number(coerceBoolean(payload.auto_reconnect, true) ? 1 : 0),
    retry_interval: Number(payload.retry_interval || payload.retryInterval || 15),
    schedule_enabled: Number(coerceBoolean(payload.schedule_enabled, false) ? 1 : 0),
    schedule_start: String(payload.schedule_start || ''),
    schedule_end: String(payload.schedule_end || ''),
    retry_count: 0,
    last_error: '',
    avg_ping: 0,
    avg_tps: 20,
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
      radar_x, radar_y, radar_z, scoreboard, server_group, enabled, auto_reconnect,
      retry_interval, retry_count, last_error, schedule_enabled, schedule_start, schedule_end, avg_ping, avg_tps
    ) VALUES (
      @name, @ip, @version, @alt_server, @login, @password, @total_bots, @hours_played,
      @radar_x, @radar_y, @radar_z, @scoreboard, @server_group, @enabled, @auto_reconnect,
      @retry_interval, @retry_count, @last_error, @schedule_enabled, @schedule_start, @schedule_end, @avg_ping, @avg_tps
    )
  `).run(bot);

  const created = db.prepare('SELECT * FROM bots WHERE id = ?').get(result.lastInsertRowid);
  created.scoreboard = safeParseScoreboard(created.scoreboard);
  created.auto_reconnect = coerceBoolean(created.auto_reconnect, true);
  created.enabled = coerceBoolean(created.enabled, true);

  addLog(`Bot eklendi: ${created.name} (${created.ip})`);
  addNotification(created.id, 'success', `Bot oluşturuldu: ${created.name}`);
  if (coerceBoolean(created.enabled, true)) botManager.startBot(created);

  res.status(201).json({ bot: created });
});

app.patch('/api/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  const payload = req.body || {};
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);

  if (!row) return res.status(404).json({ message: 'Bot bulunamadı.' });

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
    enabled: Number(coerceBoolean(payload.enabled ?? row.enabled, true) ? 1 : 0),
    auto_reconnect: Number(coerceBoolean(payload.auto_reconnect ?? row.auto_reconnect, true) ? 1 : 0),
    retry_interval: Number(payload.retry_interval ?? payload.retryInterval ?? row.retry_interval ?? 15),
    schedule_enabled: Number(coerceBoolean(payload.schedule_enabled ?? row.schedule_enabled, false) ? 1 : 0),
    schedule_start: String(payload.schedule_start ?? row.schedule_start ?? ''),
    schedule_end: String(payload.schedule_end ?? row.schedule_end ?? ''),
    server_group: String(payload.server_group ?? payload.serverGroup ?? row.server_group ?? 'Genel'),
    scoreboard: Array.isArray(payload.scoreboard) ? JSON.stringify(payload.scoreboard) : row.scoreboard,
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
      enabled = @enabled,
      auto_reconnect = @auto_reconnect,
      retry_interval = @retry_interval,
      schedule_enabled = @schedule_enabled,
      schedule_start = @schedule_start,
      schedule_end = @schedule_end,
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
  updated.auto_reconnect = coerceBoolean(updated.auto_reconnect, true);
  updated.enabled = coerceBoolean(updated.enabled, true);

  addLog(`Bot güncellendi: ${updated.name}`);
  addNotification(updated.id, 'info', `Bot güncellendi: ${updated.name}`);
  if (coerceBoolean(updated.enabled, true)) botManager.startBot(updated);
  else botManager.stopBot(id);

  res.json({ bot: updated });
});

app.post('/api/bots/:id/reconnect', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).json({ message: 'Bot bulunamadı.' });

  botManager.forceReconnect(bot);
  addLog(`Bot yeniden bağlanıyor: ${bot.name}`);
  addNotification(id, 'info', 'Yeniden bağlanıyor...');
  res.json({ success: true, bot });
});

app.post('/api/bots/:id/restart', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).json({ message: 'Bot bulunamadı.' });

  botManager.stopBot(id);
  setTimeout(() => botManager.startBot(bot), 500);
  addLog(`Bot yeniden başlatıldı: ${bot.name}`);
  addNotification(id, 'info', 'Bot yeniden başlatılıyor...');
  res.json({ success: true, bot });
});

app.post('/api/bots/:id/toggle-auto-reconnect', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).json({ message: 'Bot bulunamadı.' });

  const enabled = !coerceBoolean(bot.auto_reconnect, true);
  db.prepare('UPDATE bots SET auto_reconnect = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  addLog(`Otomatik yeniden bağlanma ${enabled ? 'açıldı' : 'kapandı'}: ${bot.name}`);
  addNotification(id, 'info', `Otomatik yeniden bağlanma ${enabled ? 'açıldı' : 'kapandı'}`);

  if (!enabled) botManager.cancelReconnect(id);
  else botManager.startBot({ ...bot, auto_reconnect: enabled });

  res.json({ success: true, auto_reconnect: enabled });
});

app.delete('/api/bots/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Bot bulunamadı.' });

  db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  botManager.stopBot(id);
  botManager.cancelSchedule(id);
  addLog(`Bot silindi: ${row.name}`);
  addNotification(null, 'warning', `Bot silindi: ${row.name}`);
  res.json({ success: true });
});

app.delete('/api/bots/offline', (req, res) => {
  const rows = db.prepare('SELECT * FROM bots WHERE online = 0').all();
  rows.forEach((bot) => {
    db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
    botManager.stopBot(bot.id);
  });
  addLog(`${rows.length} offline bot temizlendi.`);
  addNotification(null, 'info', `${rows.length} offline bot temizlendi.`);
  res.json({ success: true, removed: rows.length });
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
