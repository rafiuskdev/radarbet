// RadarBet — Scraper (bet365)

let myTabId = null;

chrome.runtime.sendMessage({ action: 'getTabId' }, (res) => {
  if (!res) return;
  myTabId = res.tabId;
  scrape();
  setInterval(scrape, 2000);
});

// ─── Navegação automática para o jogo ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'navigateToGame' && msg.teams) {
    tryNavigateToGame(msg.teams);
    sendResponse({ ok: true });
  }
});

function normalizeStr(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function fuzzyTeamMatch(haystack, needle) {
  const h = normalizeStr(haystack), n = normalizeStr(needle);
  if (h.includes(n)) return true;
  return n.split(/\s+/).some(w => w.length >= 4 && h.includes(w));
}

function simulateClick(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

function dismissCookieBanner() {
  const selectors = [
    '[class*="CookieConsent"] button',
    '[id*="cookie"] button',
    '[class*="cookie"] button',
    '[class*="Cookie"] button',
    '[class*="gdpr"] button',
    '[class*="consent"] button',
    'button[id*="accept"]',
    'button[id*="agree"]',
  ];
  for (const sel of selectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (/accept|agree|ok|allow|got it|entend/i.test(btn.textContent)) {
        btn.click();
        return true;
      }
    }
  }
  return false;
}

function tryNavigateToGame(teams) {
  const { team1, team2 } = teams;
  let tries = 0;

  const attempt = () => {
    tries++;

    dismissCookieBanner();

    // Estratégia 0: estrutura ovm-FixtureDetailsTwoWay da bet365 In-Play
    // O container raiz (sem underscore) é o elemento clicável — é um <div>, não <a>
    for (const wrapper of document.querySelectorAll('[class*="TeamsWrapper"]')) {
      const text = wrapper.textContent;
      if (!fuzzyTeamMatch(text, team1) || !fuzzyTeamMatch(text, team2)) continue;
      // Sobe pelo DOM até encontrar o container raiz (classe exacta "ovm-FixtureDetailsTwoWay")
      let fixture = wrapper.parentElement;
      while (fixture) {
        if (fixture.classList?.contains('ovm-FixtureDetailsTwoWay')) break;
        fixture = fixture.parentElement;
      }
      simulateClick(fixture || wrapper);
      return;
    }

    // Estratégia 1: links âncora com EV no href (SPA da bet365)
    for (const a of document.querySelectorAll('a[href*="EV"], a[href*="/IP/"]')) {
      const text = a.textContent;
      if (fuzzyTeamMatch(text, team1) && fuzzyTeamMatch(text, team2)) {
        simulateClick(a);
        return;
      }
    }

    // Estratégia 2: seletores de fixture genéricos (classes com Fixture/Event/Coupon)
    const candidates = document.querySelectorAll(
      '[class*="Fixture"], [class*="Coupon"], [class*="MarketGroup"], [class*="Event"]'
    );
    for (const el of candidates) {
      if (el.textContent.length > 500) continue;
      const text = el.textContent;
      if (fuzzyTeamMatch(text, team1) && fuzzyTeamMatch(text, team2)) {
        const clickable = el.closest('a') || el.querySelector('a') || el;
        simulateClick(clickable);
        return;
      }
    }

    // Estratégia 3: fallback — qualquer <a> ou [role=link] com ambas as equipas
    for (const el of document.querySelectorAll('a, [role="link"]')) {
      if (el.textContent.length > 500) continue;
      const text = el.textContent;
      if (fuzzyTeamMatch(text, team1) && fuzzyTeamMatch(text, team2)) {
        simulateClick(el);
        return;
      }
    }

    if (tries < 20) setTimeout(attempt, 2000);
  };

  attempt();
}

function scrape() {
  if (!myTabId) return;
  chrome.storage.local.set({
    [`radar_${myTabId}`]: {
      tabId:     myTabId,
      time:      readGameTime(),
      score:     readTotalGoals(),    // total de golos no placar
      goals:     readGoalsMarket(),   // Golos (1ª Parte ou Encontro)
      nextGoal:  readNextGoalOdds(),  // 1.° Golo (Nx1 / Nx2)
      updatedAt: Date.now(),
    }
  });
}

// ─── Placar (total de golos) ──────────────────────────────────────────────────

function readTotalGoals() {
  // Estratégia 1: placar combinado num único elemento
  const combined = [
    '.lv-ScoreBasedScore',
    '.lv-ScoreBoard_Score',
    '[class*="ScoreBasedScore"]',
    '[class*="InPlayScore"]',
  ];
  for (const sel of combined) {
    for (const el of document.querySelectorAll(sel)) {
      const m = el.textContent.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (m) return parseInt(m[1]) + parseInt(m[2]);
    }
  }

  // Estratégia 2: home e away em elementos separados
  const homeSels = ['[class*="Score_VSHome"]', '[class*="Score_Home"]', '[class*="HomeScore"]'];
  const awaySels = ['[class*="Score_VSAway"]', '[class*="Score_Away"]', '[class*="AwayScore"]'];
  for (let i = 0; i < homeSels.length; i++) {
    const h = document.querySelector(homeSels[i]);
    const a = document.querySelector(awaySels[i]);
    if (h && a) {
      const hv = parseInt(h.textContent), av = parseInt(a.textContent);
      if (!isNaN(hv) && !isNaN(av)) return hv + av;
    }
  }

  return null;
}

// ─── Tempo do jogo ────────────────────────────────────────────────────────────

function readGameTime() {
  const selectors = [
    '.lv-ScoreBasedClockPart',
    '.lv-ClockBasedTime_Clocks',
    '[class*="lv-ClockBased"]',
    '[class*="ScoreClock"]',
    '[class*="lsb-ScoreBasedClockPart"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

// ─── Mercado de Golos (1ª Parte > Encontro) ───────────────────────────────────

function readGoalsMarket() {
  const labelEls = document.querySelectorAll(
    '.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text'
  );

  let halfContainer  = null; // 1ª Parte - Golos (prioridade)
  let matchContainer = null; // Encontro - Golos

  for (const el of labelEls) {
    const text = el.textContent.trim();
    const isGoals = /gol[os]|goal/i.test(text);
    if (!isGoals) continue;

    const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup');
    if (!pod) continue;

    if (/parte|half/i.test(text)) {
      halfContainer = { pod, label: text };
    } else if (!halfContainer && !matchContainer && /encontro|match|game/i.test(text)) {
      matchContainer = { pod, label: text };
    }
  }

  const target = halfContainer || matchContainer;
  if (!target) return null;

  return parseGoalsPod(target.pod, target.label);
}

function parseGoalsPod(pod, label) {
  // Labels de linha: 0.5 / 1.5 / 2.5 / 3.5
  const lineEls = pod.querySelectorAll('.srb-ParticipantLabelCentered_Name');
  const lines   = Array.from(lineEls).map(el => parseFloat(el.textContent));

  let overOdds = [], underOdds = [];

  // Colunas com cabeçalho "Mais de" / "Menos de"
  const cols = pod.querySelectorAll('.gl-Market_General-columnheader');
  for (const col of cols) {
    const header = col.querySelector('.gl-MarketColumnHeader');
    if (!header) continue;
    const h = header.textContent.trim().toLowerCase();
    const odds = Array.from(col.querySelectorAll('.gl-ParticipantOddsOnly_Odds'))
                     .map(el => parseFloat(el.textContent));
    if (/mais|over/i.test(h))  overOdds  = odds;
    if (/menos|under/i.test(h)) underOdds = odds;
  }

  if (!lines.length || !overOdds.length) return null;

  return {
    label,
    isHalf: /parte|half/i.test(label),
    lines: lines
      .map((line, i) => ({ line, over: overOdds[i] ?? null, under: underOdds[i] ?? null }))
      .filter(l => l.over !== null && !isNaN(l.line))
      .sort((a, b) => a.line - b.line),
  };
}

// ─── Próximo Gol (Nx1 / Nx2) ─────────────────────────────────────────────────

function readNextGoalOdds() {
  const labelEls = document.querySelectorAll(
    '.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text'
  );
  for (const el of labelEls) {
    const text = el.textContent.toLowerCase();
    if (!text.includes('golo') && !text.includes('próximo gol') && !text.includes('next goal')) continue;

    const pod   = el.closest('.gl-MarketGroupPod, .sip-MarketGroup');
    if (!pod) continue;

    const names = pod.querySelectorAll('.gl-ParticipantBorderless_Name');
    const odds  = pod.querySelectorAll('.gl-ParticipantBorderless_Odds');

    if (names.length >= 3 && odds.length >= 3) {
      return {
        team1:  { name: names[0].textContent.trim(), odd: parseFloat(odds[0].textContent) },
        noGoal: { name: names[1].textContent.trim(), odd: parseFloat(odds[1].textContent) },
        team2:  { name: names[2].textContent.trim(), odd: parseFloat(odds[2].textContent) },
      };
    }
  }
  return null;
}
