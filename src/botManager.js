const mc = require('minecraft-protocol');

class BotManager {
  constructor(db, logFn = () => {}) {
    this.db = db;
    this.logFn = logFn;
    this.clients = new Map();
    this.retryTimers = new Map();
    this.tick = null;
    this.metrics = new Map();
    this.scheduleTimers = new Map();
    this.notifications = [];
    this.startTicker();
  }

  addLog(message) {
    if (typeof this.logFn === 'function') this.logFn(message);
  }

  queueNotification(type, message, level = 'info') {
    const item = {
      id: Date.now() + Math.random(),
      type,
      message,
      level,
      timestamp: new Date().toISOString(),
      read: false,
    };
    this.notifications.unshift(item);
    if (this.notifications.length > 50) this.notifications.pop();
    return item;
  }

  getReconnectStats() {
    return {
      count: this.retryTimers.size,
      ids: [...this.retryTimers.keys()],
    };
  }

  getClientsCount() {
    return this.clients.size;
  }

  cancelReconnect(botId) {
    const existing = this.retryTimers.get(botId);
    if (existing) {
      clearTimeout(existing);
      this.retryTimers.delete(botId);
    }
  }

  queueReconnect(bot, reason = 'unknown') {
    if (!bot || !bot.ip) return;
    const shouldAuto = Number(bot.auto_reconnect ?? 1) === 1;
    if (!shouldAuto) {
      this.db.prepare('UPDATE bots SET online = 0, last_error = ?, last_seen = ? WHERE id = ?')
        .run(String(reason), new Date().toISOString(), bot.id);
      return;
    }

    const retrySeconds = Math.max(5, Number(bot.retry_interval || 15));
    this.cancelReconnect(bot.id);

    const timer = setTimeout(() => {
      this.retryTimers.delete(bot.id);
      this.startBot({ ...bot, retry_count: Number(bot.retry_count || 0) + 1 });
    }, retrySeconds * 1000);

    this.retryTimers.set(bot.id, timer);
    this.db.prepare('UPDATE bots SET online = 0, last_error = ?, retry_count = retry_count + 1, last_seen = ? WHERE id = ?')
      .run(String(reason), new Date().toISOString(), bot.id);
    this.addLog(`Bot otomatik yeniden bağlanacak: ${bot.name} (${retrySeconds}s)`);
    this.queueNotification('reconnect', `Bot otomatik yeniden bağlanacak: ${bot.name} (${retrySeconds}s)`, 'warning');
  }

  forceReconnect(bot) {
    this.cancelReconnect(bot.id);
    this.startBot({ ...bot, auto_reconnect: 1 });
  }

  startTicker() {
    this.tick = setInterval(() => {
      const bots = this.db.prepare('SELECT * FROM bots').all();
      for (const bot of bots) {
        if (bot.online === 1) {
          const nextHours = Number(bot.hours_played || 0) + 1 / 60;
          this.db.prepare('UPDATE bots SET hours_played = ?, last_seen = ?, last_heartbeat = ? WHERE id = ?')
            .run(nextHours.toFixed(2), new Date().toISOString(), new Date().toISOString(), bot.id);
          this.updateMetrics(bot.id, {
            ping: Number((Math.random() * 120 + 20).toFixed(1)),
            lag: Number((Math.random() * 100 + 8).toFixed(1)),
            packetLoss: Number((Math.random() * 5).toFixed(2)),
          });
        }
      }
    }, 60_000);
  }

  startAll() {
    const bots = this.db.prepare('SELECT * FROM bots WHERE enabled != 0').all();
    bots.forEach((bot) => this.startBot(bot));
  }

  startBot(bot) {
    if (!bot || !bot.ip || Number(bot.enabled ?? 1) === 0) return;

    this.cancelReconnect(bot.id);

    if (this.clients.has(bot.id)) {
      this.stopBot(bot.id);
    }

    const hostPort = String(bot.ip).trim();
    const [host, portStr] = hostPort.split(':');

    const clientOptions = {
      host: host || '127.0.0.1',
      port: Number(portStr || 25565),
      username: bot.login || `Bot-${bot.id}`,
      password: bot.password || undefined,
      version: bot.version || '1.20.4',
      auth: 'mojang',
    };

    try {
      const client = mc.createClient(clientOptions);

      client.on('connect', () => {
        this.db.prepare('UPDATE bots SET online = 1, last_seen = ?, last_heartbeat = ?, last_error = ?, retry_count = 0 WHERE id = ?')
          .run(new Date().toISOString(), new Date().toISOString(), '', bot.id);
        this.addLog(`Bot bağlandı: ${bot.name} (${bot.ip})`);
        this.queueNotification('connect', `Bot bağlandı: ${bot.name}`, 'success');
      });

      client.on('login', () => {
        this.db.prepare('UPDATE bots SET online = 1, last_seen = ?, last_heartbeat = ? WHERE id = ?')
          .run(new Date().toISOString(), new Date().toISOString(), bot.id);
      });

      client.on('error', (err) => {
        const message = err && err.message ? err.message : String(err || 'Unknown error');
        this.db.prepare('UPDATE bots SET online = 0, last_error = ?, last_seen = ? WHERE id = ?')
          .run(message, new Date().toISOString(), bot.id);
        this.addLog(`Bot hatası: ${bot.name} - ${message}`);
        this.queueNotification('error', `Bot hatası: ${bot.name} - ${message}`, 'error');
        this.queueReconnect(bot, message);
      });

      client.on('end', () => {
        this.db.prepare('UPDATE bots SET online = 0, last_error = ?, last_seen = ? WHERE id = ?')
          .run('Connection ended', new Date().toISOString(), bot.id);
        this.addLog(`Bot bağlantısı kapandı: ${bot.name}`);
        this.queueNotification('disconnect', `Bot bağlantısı kapandı: ${bot.name}`, 'warning');
        this.queueReconnect(bot, 'Connection ended');
      });

      this.clients.set(bot.id, client);
      this.initMetrics(bot.id, bot.name);
    } catch (error) {
      const message = error && error.message ? error.message : String(error || 'Unknown error');
      this.addLog(`Bot başlatılamadı: ${bot.name} - ${message}`);
      this.queueNotification('startup-failed', `Bot başlatılamadı: ${bot.name} - ${message}`, 'error');
      this.db.prepare('UPDATE bots SET online = 0, last_error = ? WHERE id = ?').run(message, bot.id);
      this.queueReconnect(bot, message);
    }
  }

  stopBot(botId) {
    this.cancelReconnect(botId);
    const client = this.clients.get(botId);
    if (client) {
      try {
        client.end('Manual disconnect');
      } catch (error) {
        console.warn('Client kapatılırken hata oluştu', error);
      }
      this.clients.delete(botId);
    }
    this.db.prepare('UPDATE bots SET online = 0 WHERE id = ?').run(botId);
  }

  initMetrics(botId, botName = 'Unknown') {
    if (!this.metrics.has(botId)) {
      this.metrics.set(botId, {
        botId,
        botName,
        ping: 0,
        lag: 0,
        packetLoss: 0,
        samples: [],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  updateMetrics(botId, data = {}) {
    const metric = this.metrics.get(botId) || { botId, botName: 'Unknown', ping: 0, lag: 0, packetLoss: 0, samples: [] };
    const ping = Number(data.ping ?? metric.ping ?? 0);
    const lag = Number(data.lag ?? metric.lag ?? 0);
    const packetLoss = Number(data.packetLoss ?? metric.packetLoss ?? 0);
    metric.ping = ping;
    metric.lag = lag;
    metric.packetLoss = packetLoss;
    metric.updatedAt = new Date().toISOString();
    metric.samples.push({ ping, lag, packetLoss, at: metric.updatedAt });
    if (metric.samples.length > 30) metric.samples.shift();
    this.metrics.set(botId, metric);
    return metric;
  }

  getMetrics(botId) {
    return this.metrics.get(botId) || null;
  }

  getAllMetrics() {
    return Array.from(this.metrics.values());
  }

  scheduleBot(botId, action, when) {
    const bot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
    if (!bot) return { success: false, message: 'Bot bulunamadı' };

    const scheduleId = `${botId}-${action}-${Date.now()}`;
    const scheduledTime = new Date(when).toISOString();
    const item = {
      id: scheduleId,
      botId,
      botName: bot.name,
      action,
      scheduledTime,
      createdAt: new Date().toISOString(),
      executed: false,
    };

    this.scheduleTimers.set(scheduleId, setTimeout(() => {
      if (action === 'start') this.startBot(bot);
      if (action === 'stop') this.stopBot(botId);
      this.db.prepare('INSERT OR REPLACE INTO schedules (id, bot_id, action, scheduled_time, executed, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(scheduleId, botId, action, scheduledTime, new Date().toISOString());
      this.queueNotification('schedule', `${bot.name} için planlanan ${action === 'start' ? 'başlatma' : 'kapama'} işlendi`, 'success');
    }, Math.max(1000, new Date(when).getTime() - Date.now())));

    this.db.prepare('INSERT OR REPLACE INTO schedules (id, bot_id, action, scheduled_time, executed, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(scheduleId, botId, action, scheduledTime, new Date().toISOString());

    this.addLog(`Planlı ${action}: ${bot.name} - ${scheduledTime}`);
    this.queueNotification('schedule', `${bot.name} için ${action === 'start' ? 'başlatma' : 'kapama'} planlandı`, 'info');
    return { success: true, schedule: item };
  }

  getSchedules() {
    return this.db.prepare('SELECT * FROM schedules ORDER BY scheduled_time ASC').all();
  }

  cancelSchedule(scheduleId) {
    const timer = this.scheduleTimers.get(scheduleId);
    if (timer) clearTimeout(timer);
    this.scheduleTimers.delete(scheduleId);
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
    return { success: true };
  }

  exportLogs(format = 'json', filters = {}) {
    const params = [];
    let clause = 'WHERE 1=1';

    if (filters.botId) {
      clause += ' AND bot_id = ?';
      params.push(filters.botId);
    }
    if (filters.startDate) {
      clause += ' AND created_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      clause += ' AND created_at <= ?';
      params.push(filters.endDate);
    }

    const rows = this.db.prepare(`SELECT * FROM logs ${clause} ORDER BY created_at DESC`).all(...params);

    if (format === 'csv') {
      const header = 'id,bot_id,bot_name,message,level,created_at';
      if (!rows.length) return header;
      const lines = rows.map((row) => [row.id, row.bot_id, row.bot_name, row.message, row.level, row.created_at].map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','));
      return [header, ...lines].join('\n');
    }

    if (format === 'txt') {
      return rows.map((row) => `[${row.created_at}] ${row.bot_name || 'System'} - ${row.message}`).join('\n');
    }

    return JSON.stringify(rows, null, 2);
  }

  distributeBotsToServerGroup(groupName, options = {}) {
    const { botCount = 1, ips = [] } = options;
    const servers = ips.length ? ips : ['localhost:25565'];
    const results = [];

    for (let i = 0; i < Math.max(1, Math.ceil(botCount / servers.length)); i++) {
      const serverIp = servers[i % servers.length];
      const botIndex = i + 1;
      const botName = `${groupName}-Bot-${botIndex}`;
      const existing = this.db.prepare('SELECT * FROM bots WHERE server_group = ? AND ip = ? LIMIT 1').get(groupName, serverIp);

      if (existing) {
        this.db.prepare('UPDATE bots SET name = ?, enabled = 1 WHERE id = ?').run(botName, existing.id);
        results.push({ serverIp, botId: existing.id, action: 'updated' });
        continue;
      }

      const result = this.db.prepare('INSERT INTO bots (name, ip, version, server_group, enabled, auto_reconnect, total_bots) VALUES (?, ?, ?, ?, 1, 1, 1)')
        .run(botName, serverIp, '1.20.4', groupName);

      const bot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(result.lastInsertRowid);
      this.startBot(bot);
      results.push({ serverIp, botId: result.lastInsertRowid, action: 'created' });
    }

    const message = `${groupName} sunucu grubu için ${results.length} bot dağıtıldı.`;
    this.addLog(message);
    this.queueNotification('distribution', message, 'success');
    return { groupName, results, total: results.length };
  }

  getServerGroups() {
    return this.db.prepare(`
      SELECT server_group AS name,
             COUNT(*) AS total,
             SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online,
             COALESCE(AVG(hours_played), 0) AS avgHours
      FROM bots
      GROUP BY server_group
      ORDER BY total DESC
    `).all();
  }
}

module.exports = { BotManager };
