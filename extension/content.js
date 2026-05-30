// RadarBet — Widget

// ─── Estado ───────────────────────────────────────────────────────────────────
let visible      = false;
let widget       = null;
let oddsTable    = null;
let pollInterval = null;
let linkedTabId  = null;
let retryTimer   = null;

// Rastreamento de mudanças de odd
const prevOdds  = {};  // id → valor anterior
const changedAt = {};  // id → timestamp da última mudança
let timerInterval  = null;
let bet365Opened   = false; // evita abrir múltiplas abas

// ─── Entry point ─────────────────────────────────────────────────────────────

if (!window.__radarbet_loaded) {
  window.__radarbet_loaded = true;
  init();
}

function init() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'toggleRadar') { toggle(); sendResponse({ ok: true }); }
    if (msg.action === 'showRadar')   { showRadarNow(); sendResponse({ ok: true }); }
    return true;
  });
  if (isStreamPage()) startRadarAuto();
}

function isStreamPage() {
  return window.location.hostname.includes('rushflows.vip') &&
         window.location.pathname.startsWith('/watch/');
}

async function startRadarAuto() { await showRadarNow(); }

async function showRadarNow() {
  if (!oddsTable) oddsTable = await loadOddsTable();
  if (!widget) buildWidget();
  widget.style.display = 'flex';
  visible = true;
  if (linkedTabId) startPolling();
  else fetchGames();
}

async function toggle() {
  if (visible) { hide(); return; }
  await showRadarNow();
}

function hide() {
  if (widget) widget.style.display = 'none';
  visible = false;
  stopPolling();
  clearTimeout(retryTimer);
}

// ─── Seleção de jogo ─────────────────────────────────────────────────────────

function fetchGames() {
  clearTimeout(retryTimer);
  showPanel('selector');
  renderGameList(null);

  chrome.runtime.sendMessage({ action: 'getBet365Games' }, (res) => {
    const games = res?.games || [];
    if (games.length === 0) {
      // Auto-abre bet365 na primeira vez que a stream abre sem jogo ligado
      if (isStreamPage() && !bet365Opened) {
        bet365Opened = true;
        chrome.runtime.sendMessage({ action: 'openBet365' });
      }
      renderGameList([]);
      retryTimer = setTimeout(fetchGames, 4000);
      return;
    }
    const matchedId = autoMatchGame(games);
    if (matchedId) { linkGame(matchedId); return; }
    if (games.length === 1) { linkGame(games[0].tabId); return; }
    renderGameList(games);
  });
}

function renderGameList(games) {
  const listEl = document.getElementById('rb-game-list');
  if (!listEl) return;
  if (games === null) {
    listEl.innerHTML = '<div class="rb-list-msg">Buscando jogos...</div>'; return;
  }
  if (games.length === 0) {
    listEl.innerHTML = `<div class="rb-list-msg">Abra o jogo ao vivo na bet365<span class="rb-list-sub">Tentando novamente em 4s...</span></div>`; return;
  }
  listEl.innerHTML = games.map(g => {
    const ng  = g.data.nextGoal;
    const lbl = ng ? `${ng.team1.name} × ${ng.team2.name}` : '(mercado não visível ainda)';
    return `<button class="rb-game-btn" data-tabid="${g.tabId}">
      <span class="rb-game-teams">${lbl}</span>
      <span class="rb-game-time">${g.data.time || '--'}'</span>
    </button>`;
  }).join('');
  listEl.querySelectorAll('.rb-game-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = parseInt(btn.dataset.tabid);
      chrome.runtime.sendMessage({ action: 'focusTab', tabId });
      linkGame(tabId);
    });
  });
}

function linkGame(tabId) {
  clearTimeout(retryTimer);
  linkedTabId = tabId;
  showPanel('radar');
  startPolling();
}

function switchGame() {
  linkedTabId = null;
  stopPolling();
  clearRadarDisplay();
  fetchGames();
}

function getTeamsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const title  = params.get('title');
  if (!title) return null;
  const parts = title.split(/\s*[xX×vs]\s*/i).map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? { team1: parts[0].toLowerCase(), team2: parts[parts.length - 1].toLowerCase() } : null;
}

function teamMatch(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return x.split(/\s+/).some(w => w.length >= 4 && y.includes(w));
}

function autoMatchGame(games) {
  const urlTeams = getTeamsFromUrl();
  if (!urlTeams) return null;
  for (const g of games) {
    if (!g.data.nextGoal) continue;
    const { team1, team2 } = g.data.nextGoal;
    if (teamMatch(urlTeams.team1, team1.name) && teamMatch(urlTeams.team2, team2.name)) return g.tabId;
    if (teamMatch(urlTeams.team1, team2.name) && teamMatch(urlTeams.team2, team1.name)) return g.tabId;
  }
  return null;
}

// ─── Polling ─────────────────────────────────────────────────────────────────

function poll() {
  if (!linkedTabId) return;
  chrome.storage.local.get(`radar_${linkedTabId}`, (res) => {
    const data = res[`radar_${linkedTabId}`];
    if (!data) {
      setStatus('⚠ Bet365 fechada — <a class="rb-link" id="rb-relink" href="#">relinkar</a>');
      document.getElementById('rb-relink')?.addEventListener('click', e => { e.preventDefault(); switchGame(); });
      return;
    }
    updateRadar(data, (Date.now() - data.updatedAt) > 10000);
  });
}

function startPolling() {
  poll();
  pollInterval = setInterval(poll, 2000);
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopPolling() {
  if (pollInterval)  { clearInterval(pollInterval);  pollInterval  = null; }
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ─── Atualização do radar ─────────────────────────────────────────────────────

async function loadOddsTable() {
  try { return await (await fetch(chrome.runtime.getURL('data/odds_justas.json'))).json(); }
  catch { return []; }
}

function getFairOdd(marketOdd) {
  if (!marketOdd || isNaN(marketOdd) || !oddsTable?.length) return null;
  let best = oddsTable[0], minDiff = Infinity;
  for (const row of oddsTable) {
    const d = Math.abs(marketOdd - row.mercado);
    if (d < minDiff) { minDiff = d; best = row; }
  }
  return best.justa;
}

function getAdjacentOdds(marketOdd) {
  if (!marketOdd || isNaN(marketOdd) || !oddsTable?.length) return { above: null, below: null };
  let idx = 0, minDiff = Infinity;
  for (let i = 0; i < oddsTable.length; i++) {
    const d = Math.abs(marketOdd - oddsTable[i].mercado);
    if (d < minDiff) { minDiff = d; idx = i; }
  }
  // Tabela é decrescente: idx-1 = odd maior, idx+1 = odd menor
  return {
    above: idx > 0                   ? oddsTable[idx - 1] : null,
    below: idx < oddsTable.length - 1 ? oddsTable[idx + 1] : null,
  };
}

function updateRadar(data, stale) {
  // Tempo
  setText('rb-time', data.time || '--:--');

  // Mercado de Golos
  if (data.goals?.lines?.length) {
    const isHalf = data.goals.isHalf;
    setText('rb-market-label', isHalf ? '1ª' : 'FT');

    // Seleciona a linha certa com base no placar atual
    // Em 0-1 (1 golo total) → Under 1.5; em 0-0 → Under 0.5; etc.
    const totalGoals = typeof data.score === 'number' ? data.score : 0;
    const targetLine = totalGoals + 0.5;
    const line1 = data.goals.lines.find(l => l.line >= targetLine) || data.goals.lines[0];
    const line2 = data.goals.lines.find(l => l.line > line1.line) || null;

    setText('rb-g1-line', `U${line1.line}`);
    setGoalsOdd('rb-g1', line1.under);
    if (line2) setGoalsOdd('rb-g2', line2.under);
    else { setText('rb-g2-odd', ''); setText('rb-g2-fair', ''); }
  } else {
    setText('rb-market-label', '?');
    setText('rb-g1-line', '');
    setText('rb-g1-odd', '—'); setText('rb-g1-fair', '—');
    setText('rb-g2-odd', ''); setText('rb-g2-fair', '');
  }

  // Nx1 / Nx2
  if (data.nextGoal) {
    setNx('rb-nx1', data.nextGoal.team1.odd);
    setNx('rb-nx2', data.nextGoal.team2.odd);
  }

  const ts = new Date(data.updatedAt).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  setStatus(stale ? `⚠ Dados antigos (${ts})` : ts);
}

// ─── Flash + Timer ────────────────────────────────────────────────────────────

function trackOdd(id, newVal, flash = false) {
  const rounded = newVal ? +newVal.toFixed(2) : null;
  const isFirst = !(id in prevOdds);

  if (!isFirst && prevOdds[id] !== rounded && rounded !== null) {
    if (flash) flashWidget();
    changedAt[id] = Date.now();
  }
  if (isFirst) changedAt[id] = Date.now();
  prevOdds[id] = rounded;
}

function flashWidget() {
  const w = document.getElementById('radarbet-widget');
  if (!w) return;
  w.classList.remove('rb-flashing');
  void w.offsetWidth;
  w.classList.add('rb-flashing');
  setTimeout(() => w.classList.remove('rb-flashing'), 900);
}

function updateTimerDisplay() {
  const el   = document.getElementById('rb-g1-timer');
  const icon = document.getElementById('rb-g1-timer-icon');
  if (!el) return;
  const since = changedAt['rb-g1-odd'];
  if (!since) { el.textContent = ''; return; }
  const s = Math.floor((Date.now() - since) / 1000);
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const color = s >= 120 ? '#f08030' : s >= 60 ? '#e8c030' : '';
  el.style.color            = color;
  if (icon) icon.style.color = color;
}

// ─── Atualização das odds ─────────────────────────────────────────────────────

function setGoalsOdd(prefix, marketOdd) {
  // Flash apenas na odd principal (Under g1 da bet365)
  trackOdd(`${prefix}-odd`, marketOdd, prefix === 'rb-g1');

  const fair = getFairOdd(marketOdd);
  setText(`${prefix}-odd`, marketOdd ? marketOdd.toFixed(2) : '—');
  if (fair) {
    const isValue = marketOdd >= fair;
    const el = document.getElementById(`${prefix}-arr`);
    if (el) { el.textContent = isValue ? '▲' : '▼'; el.className = `rb-arr ${isValue ? 'rb-value-text' : ''}`; }
    setText(`${prefix}-fair`, fair.toFixed(2));
    const fairEl = document.getElementById(`${prefix}-fair`);
    if (fairEl) fairEl.style.color = isValue ? '#00d472' : '';
  } else {
    setText(`${prefix}-arr`, ''); setText(`${prefix}-fair`, '—');
  }

  // Adjacentes na tabela (só para a odd principal g1)
  if (prefix === 'rb-g1') {
    const adj = getAdjacentOdds(marketOdd);
    setText('rb-adj-above-mkt', adj.above ? adj.above.mercado.toFixed(2) : '—');
    setText('rb-adj-above-jst', adj.above ? adj.above.justa.toFixed(2)   : '—');
    setText('rb-adj-below-mkt', adj.below ? adj.below.mercado.toFixed(2) : '—');
    setText('rb-adj-below-jst', adj.below ? adj.below.justa.toFixed(2)   : '—');
  }
}

function setNx(prefix, marketOdd) {
  trackOdd(`${prefix}-odd`, marketOdd);

  const fair = getFairOdd(marketOdd);
  setText(`${prefix}-odd`, marketOdd ? marketOdd.toFixed(2) : '—');
  const indEl = document.getElementById(`${prefix}-ind`);
  if (indEl && fair) {
    const isValue = marketOdd >= fair;
    indEl.textContent = isValue ? '▲' : '─';
    indEl.className = `rb-nx-ind ${isValue ? 'rb-nx-value' : ''}`;
  } else if (indEl) {
    indEl.textContent = '●'; indEl.className = 'rb-nx-ind';
  }
}

function clearRadarDisplay() {
  ['rb-g1-odd','rb-g1-fair','rb-g1-arr','rb-g2-odd','rb-g2-fair',
   'rb-nx1-odd','rb-nx2-odd','rb-nx1-ind','rb-nx2-ind'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = id.includes('odd') ? '—' : '●';
  });
  setText('rb-time', '--:--');
  setText('rb-g1-timer', '');
  // Limpa rastreamento ao trocar de jogo
  Object.keys(prevOdds).forEach(k  => delete prevOdds[k]);
  Object.keys(changedAt).forEach(k => delete changedAt[k]);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setStatus(html) {
  const el = document.getElementById('rb-status');
  if (el) el.innerHTML = html;
}

function showPanel(name) {
  document.getElementById('rb-panel-selector').style.display = name === 'selector' ? 'block' : 'none';
  document.getElementById('rb-panel-radar').style.display    = name === 'radar'    ? 'block' : 'none';
  document.getElementById('rb-panel-settings').style.display = name === 'settings' ? 'block' : 'none';
}

// ─── Build Widget ─────────────────────────────────────────────────────────────

function buildWidget() {
  if (widget) return;
  widget = document.createElement('div');
  widget.id = 'radarbet-widget';
  const logo365 = chrome.runtime.getURL('icons/logo-bet365.jpg');
  const logoBF  = chrome.runtime.getURL('icons/logo-betfair.png');

  widget.innerHTML = `

    <!-- Panel: seletor de jogo -->
    <div id="rb-panel-selector">
      <div class="rb-sel-header" id="rb-drag-handle">
        <span class="rb-title">RADARBET</span>
        <button class="rb-close" id="rb-close">×</button>
      </div>
      <div class="rb-sel-body">
        <div class="rb-section-label">SELECIONAR JOGO</div>
        <div id="rb-game-list"></div>
        <button class="rb-btn-refresh" id="rb-refresh">↻ Atualizar</button>
      </div>
    </div>

    <!-- Panel: radar compacto -->
    <div id="rb-panel-radar" style="display:none">

      <!-- overlay branco para flash -->
      <div id="rb-flash-overlay"></div>

      <!-- Barra de info + botões -->
      <div class="rb-topbar">
        <span class="rb-mkt-tag" id="rb-market-label">—</span>
        <span class="rb-line-tag" id="rb-g1-line"></span>
        <span class="rb-topbar-time" id="rb-time">--:--</span>
        <span class="rb-row-spacer"></span>
        <span class="rb-g2-pair">
          <span class="rb-g2-odd" id="rb-g2-odd"></span>
          <span class="rb-g2-fair" id="rb-g2-fair"></span>
        </span>
        <button class="rb-btn-switch" id="rb-settings-btn" title="Configurações">⚙</button>
        <button class="rb-btn-switch" id="rb-switch" title="Trocar jogo">⇄</button>
        <button class="rb-close" id="rb-close2" title="Fechar">×</button>
      </div>

      <!-- Cards: bet365 (verde) | betfair (dourado) — adjacentes dentro do card -->
      <div class="rb-cards-row">
        <div class="rb-card rb-card-365">
          <img class="rb-card-logo" src="${logo365}" alt="bet365">
          <span class="rb-card-adj" id="rb-adj-above-mkt">—</span>
          <span class="rb-card-main" id="rb-g1-odd">—</span>
          <span class="rb-card-adj" id="rb-adj-below-mkt">—</span>
        </div>
        <div class="rb-card rb-card-bf">
          <img class="rb-card-logo" src="${logoBF}" alt="betfair">
          <span class="rb-card-adj" id="rb-adj-above-jst">—</span>
          <span class="rb-card-main" id="rb-g1-fair">—</span>
          <span class="rb-card-adj" id="rb-adj-below-jst">—</span>
        </div>
      </div>

      <!-- Timer -->
      <div class="rb-row rb-row-timer">
        <span class="rb-timer-icon" id="rb-g1-timer-icon">⊙</span>
        <span class="rb-timer" id="rb-g1-timer">0:00</span>
      </div>

      <!-- Nx1 / Nx2 -->
      <div class="rb-row rb-row-nx">
        <span class="rb-nx-label">Nx1</span>
        <span class="rb-nx-odd" id="rb-nx1-odd">—</span>
        <span class="rb-nx-ind" id="rb-nx1-ind">●</span>
        <span class="rb-nx-spacer"></span>
        <span class="rb-nx-label">Nx2</span>
        <span class="rb-nx-odd" id="rb-nx2-odd">—</span>
        <span class="rb-nx-ind" id="rb-nx2-ind">●</span>
      </div>

      <div class="rb-status" id="rb-status"></div>
      <div id="rb-resize-handle" title="Redimensionar"></div>
    </div>

    <!-- Panel: configurações -->
    <div id="rb-panel-settings" style="display:none">
      <div class="rb-sel-header">
        <span class="rb-title">CONFIGURAÇÕES</span>
        <button class="rb-close" id="rb-settings-close" title="Voltar">×</button>
      </div>
      <div class="rb-sel-body">
        <div class="rb-list-msg" style="padding:20px 0;">
          Em breve...
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(widget);

  makeDraggable(widget, document.getElementById('rb-drag-handle'));
  makeDraggable(widget, document.getElementById('rb-panel-radar'));
  makeDraggable(widget, document.getElementById('rb-panel-settings'));
  makeResizable(widget, document.getElementById('rb-resize-handle'));

  document.getElementById('rb-close')?.addEventListener('click', hide);
  document.getElementById('rb-close2')?.addEventListener('click', hide);
  document.getElementById('rb-refresh')?.addEventListener('click', fetchGames);
  document.getElementById('rb-switch')?.addEventListener('click', switchGame);
  document.getElementById('rb-settings-btn')?.addEventListener('click', () => showPanel('settings'));
  document.getElementById('rb-settings-close')?.addEventListener('click', () => showPanel('radar'));
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

function makeDraggable(el, handle) {
  if (!handle) return;
  let dragging = false, sx, sy, sl, st;
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button') || e.target.id === 'rb-resize-handle') return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); sl = r.left; st = r.top;
    document.body.style.cursor = 'grabbing'; e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    el.style.left = `${sl + (e.clientX - sx)}px`; el.style.top = `${st + (e.clientY - sy)}px`;
    el.style.right = 'auto'; el.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
}

function makeResizable(el, handle) {
  if (!handle) return;
  let resizing = false, sx, sy, sw, sh;
  handle.addEventListener('mousedown', e => {
    resizing = true;
    sx = e.clientX; sy = e.clientY;
    sw = el.offsetWidth; sh = el.offsetHeight;
    document.body.style.cursor = 'se-resize';
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    el.style.width  = `${Math.max(200, sw + (e.clientX - sx))}px`;
    el.style.height = `${Math.max(100, sh + (e.clientY - sy))}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
  });
}
