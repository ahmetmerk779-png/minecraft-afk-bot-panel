<!DOCTYPE html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Minecraft AFK Bot Panel</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-box">
          <div class="brand-mark">M</div>
          <div>
            <p class="eyebrow">Minecraft</p>
            <h1>AFK Panel</h1>
          </div>
        </div>

        <button class="primary-button" id="openFormBtn">+ Yeni Bot</button>

        <div class="sidebar-stats">
          <div class="mini-card">
            <span class="label">Toplam Bot</span>
            <strong id="totalBots">0</strong>
          </div>
          <div class="mini-card">
            <span class="label">Çevrimiçi</span>
            <strong id="onlineBots">0</strong>
          </div>
          <div class="mini-card">
            <span class="label">Oynanan Saat</span>
            <strong id="totalHours">0h</strong>
          </div>
        </div>

        <div class="filters-box">
          <div class="filters-head">Filtreler</div>
          <input id="searchInput" type="text" placeholder="Bot ara..." />
          <select id="groupFilter">
            <option value="all">Tüm gruplar</option>
          </select>
          <select id="statusFilter">
            <option value="all">Tüm durumlar</option>
            <option value="online">Çevrimiçi</option>
            <option value="offline">Offline</option>
          </select>
          <button id="offlineCleanupBtn" class="secondary-button small">Offline botları temizle</button>
        </div>
      </aside>

      <main class="main-panel">
        <header class="topbar">
          <div>
            <p class="eyebrow">Kontrol Merkezi</p>
            <h2>Bot Yönetim Dashboard</h2>
          </div>
          <div class="top-actions">
            <span class="pill">Sunucu Sayısı: <strong id="serverCount">0</strong></span>
          </div>
        </header>

        <section id="summaryGrid" class="stats-grid"></section>

        <section class="panel-box compact-panel">
          <div class="panel-header">
            <h3>Sunucu Grupları</h3>
          </div>
          <div id="groupOverview" class="group-overview"></div>
        </section>

        <section class="panel-box">
          <div class="panel-header">
            <h3>Bot Listesi</h3>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>İsim</th>
                  <th>IP</th>
                  <th>Versiyon</th>
                  <th>Alt Sunucu</th>
                  <th>Grup</th>
                  <th>Login</th>
                  <th>Toplam Bot</th>
                  <th>Oynama Saati</th>
                  <th>Durum</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody id="botTableBody"></tbody>
            </table>
          </div>
        </section>

        <section class="bot-grid" id="botGrid"></section>

        <section class="logs-panel">
          <div class="panel-header">
            <h3>İşlem Logları</h3>
          </div>
          <ul id="logList" class="log-list"></ul>
        </section>
      </main>
    </div>

    <div id="botModal" class="modal hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3>Bot Ekle / Düzenle</h3>
          <button type="button" id="closeModalBtn" class="close-btn">×</button>
        </div>

        <form id="botForm">
          <input type="hidden" name="id" id="botId" />
          <div class="fields-grid">
            <label>
              Bot Adı
              <input name="name" type="text" placeholder="Bot-01" required />
            </label>
            <label>
              Sunucu IP
              <input name="ip" type="text" placeholder="play.example.com:25565" required />
            </label>
            <label>
              Versiyon
              <input name="version" type="text" value="1.20.4" />
            </label>
            <label>
              Alt Sunucu Geçişi
              <input name="alt_server" type="text" placeholder="Lobby / SkyBlock" />
            </label>
            <label>
              Sunucu Grubu
              <input name="server_group" type="text" placeholder="PvP / Public / Hub" />
            </label>
            <label>
              Login
              <input name="login" type="text" placeholder="kullanici_adi" />
            </label>
            <label>
              Şifre
              <input name="password" type="password" placeholder="••••••••" />
            </label>
            <label>
              Toplam Bot Sayısı
              <input name="total_bots" type="number" min="1" value="1" />
            </label>
            <label>
              Oynama Saati
              <input name="hours_played" type="number" min="0" step="0.1" value="0" />
            </label>
          </div>

          <div class="form-footer">
            <button type="button" id="cancelBtn" class="secondary-button">İptal</button>
            <button type="submit" class="primary-button">Kaydet</button>
          </div>
        </form>
      </div>
    </div>

    <script src="/app.js"></script>
  </body>
</html>
