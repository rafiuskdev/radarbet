// @ts-nocheck — scraper DOM code, tipos implícitos são aceitáveis
import { ipcRenderer } from 'electron'

// ─── IPC: recebe comando de navegação do main process ────────────────────────
ipcRenderer.on('navigateToGame', (_event, teams) => {
  tryNavigateToGame(teams)
})

// ─── Inicializa scraper quando DOM estiver pronto ────────────────────────────
function init() {
  scrape()
  setInterval(scrape, 2000)

  scrapeLiveGames()
  setInterval(scrapeLiveGames, 4000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

// ─── Coleta e envia dados para o main process ─────────────────────────────────
function scrape() {
  ipcRenderer.send('scraperData', {
    time:      readGameTime(),
    score:     readTotalGoals(),
    goals:     readGoalsMarket(),
    nextGoal:  readNextGoalOdds(),
    updatedAt: Date.now(),
  })
}

// ─── Navegação automática para o jogo ────────────────────────────────────────

function normalizeStr(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function fuzzyTeamMatch(haystack, needle) {
  const h = normalizeStr(haystack), n = normalizeStr(needle)
  if (h.includes(n)) return true
  return n.split(/\s+/).some(w => w.length >= 4 && h.includes(w))
}

function simulateClick(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
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
  ]
  for (const sel of selectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (/accept|agree|ok|allow|got it|entend/i.test(btn.textContent)) {
        btn.click()
        return true
      }
    }
  }
  return false
}

function tryNavigateToGame(teams) {
  const { team1, team2 } = teams
  let tries = 0

  const attempt = () => {
    tries++
    dismissCookieBanner()

    for (const wrapper of document.querySelectorAll('[class*="TeamsWrapper"]')) {
      const text = wrapper.textContent
      if (!fuzzyTeamMatch(text, team1) || !fuzzyTeamMatch(text, team2)) continue
      let fixture = wrapper.parentElement
      while (fixture) {
        if (fixture.classList?.contains('ovm-FixtureDetailsTwoWay')) break
        fixture = fixture.parentElement
      }
      simulateClick(fixture || wrapper)
      return
    }

    for (const a of document.querySelectorAll('a[href*="EV"], a[href*="/IP/"]')) {
      const text = a.textContent
      if (fuzzyTeamMatch(text, team1) && fuzzyTeamMatch(text, team2)) {
        simulateClick(a)
        return
      }
    }

    const candidates = document.querySelectorAll(
      '[class*="Fixture"], [class*="Coupon"], [class*="MarketGroup"], [class*="Event"]'
    )
    for (const el of candidates) {
      if (el.textContent.length > 500) continue
      const text = el.textContent
      if (fuzzyTeamMatch(text, team1) && fuzzyTeamMatch(text, team2)) {
        const clickable = el.closest('a') || el.querySelector('a') || el
        simulateClick(clickable)
        return
      }
    }

    for (const el of document.querySelectorAll('a, [role="link"]')) {
      if (el.textContent.length > 500) continue
      const text = el.textContent
      if (fuzzyTeamMatch(text, team1) && fuzzyTeamMatch(text, team2)) {
        simulateClick(el)
        return
      }
    }

    if (tries < 20) setTimeout(attempt, 2000)
  }

  attempt()
}

// ─── Placar (total de golos) ──────────────────────────────────────────────────

function readTotalGoals() {
  const combined = [
    '.lv-ScoreBasedScore',
    '.lv-ScoreBoard_Score',
    '[class*="ScoreBasedScore"]',
    '[class*="InPlayScore"]',
  ]
  for (const sel of combined) {
    for (const el of document.querySelectorAll(sel)) {
      const m = el.textContent.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/)
      if (m) return parseInt(m[1]) + parseInt(m[2])
    }
  }

  const homeSels = ['[class*="Score_VSHome"]', '[class*="Score_Home"]', '[class*="HomeScore"]']
  const awaySels = ['[class*="Score_VSAway"]', '[class*="Score_Away"]', '[class*="AwayScore"]']
  for (let i = 0; i < homeSels.length; i++) {
    const h = document.querySelector(homeSels[i])
    const a = document.querySelector(awaySels[i])
    if (h && a) {
      const hv = parseInt(h.textContent), av = parseInt(a.textContent)
      if (!isNaN(hv) && !isNaN(av)) return hv + av
    }
  }
  return null
}

// ─── Tempo do jogo ────────────────────────────────────────────────────────────

function readGameTime() {
  const selectors = [
    '.lv-ScoreBasedClockPart',
    '.lv-ClockBasedTime_Clocks',
    '[class*="lv-ClockBased"]',
    '[class*="ScoreClock"]',
    '[class*="lsb-ScoreBasedClockPart"]',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (el && el.textContent.trim()) return el.textContent.trim()
  }
  return null
}

// ─── Mercado de Golos ─────────────────────────────────────────────────────────

function readGoalsMarket() {
  const labelEls = document.querySelectorAll(
    '.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text'
  )

  let halfContainer = null
  let matchContainer = null

  for (const el of labelEls) {
    const text = el.textContent.trim()
    const isGoals = /gol[os]|goal/i.test(text)
    if (!isGoals) continue

    const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup')
    if (!pod) continue

    if (/parte|half/i.test(text)) {
      halfContainer = { pod, label: text }
    } else if (!halfContainer && !matchContainer && /encontro|match|game/i.test(text)) {
      matchContainer = { pod, label: text }
    }
  }

  const target = halfContainer || matchContainer
  if (!target) return null
  return parseGoalsPod(target.pod, target.label)
}

function parseGoalsPod(pod, label) {
  const lineEls = pod.querySelectorAll('.srb-ParticipantLabelCentered_Name')
  const lines = Array.from(lineEls).map(el => parseFloat(el.textContent))

  let overOdds = [], underOdds = []

  const cols = pod.querySelectorAll('.gl-Market_General-columnheader')
  for (const col of cols) {
    const header = col.querySelector('.gl-MarketColumnHeader')
    if (!header) continue
    const h = header.textContent.trim().toLowerCase()
    const odds = Array.from(col.querySelectorAll('.gl-ParticipantOddsOnly_Odds'))
      .map(el => parseFloat(el.textContent))
    if (/mais|over/i.test(h)) overOdds = odds
    if (/menos|under/i.test(h)) underOdds = odds
  }

  if (!lines.length || !overOdds.length) return null

  return {
    label,
    isHalf: /parte|half/i.test(label),
    lines: lines
      .map((line, i) => ({ line, over: overOdds[i] ?? null, under: underOdds[i] ?? null }))
      .filter(l => l.over !== null && !isNaN(l.line))
      .sort((a, b) => a.line - b.line),
  }
}

// ─── Próximo Golo ─────────────────────────────────────────────────────────────

function readNextGoalOdds() {
  const labelEls = document.querySelectorAll(
    '.sip-MarketGroupButton_Text, .gl-MarketGroupButton_Text'
  )
  for (const el of labelEls) {
    const text = el.textContent.toLowerCase()
    if (!text.includes('golo') && !text.includes('próximo gol') && !text.includes('next goal')) continue

    const pod = el.closest('.gl-MarketGroupPod, .sip-MarketGroup')
    if (!pod) continue

    const names = pod.querySelectorAll('.gl-ParticipantBorderless_Name')
    const odds = pod.querySelectorAll('.gl-ParticipantBorderless_Odds')

    if (names.length >= 3 && odds.length >= 3) {
      return {
        team1:  { name: names[0].textContent.trim(), odd: parseFloat(odds[0].textContent) },
        noGoal: { name: names[1].textContent.trim(), odd: parseFloat(odds[1].textContent) },
        team2:  { name: names[2].textContent.trim(), odd: parseFloat(odds[2].textContent) },
      }
    }
  }
  return null
}

// ─── Lista de jogos ao vivo (/IP/B1) ─────────────────────────────────────────

function scrapeLiveGames() {
  const url = window.location.href
  console.log('[bet365-preload] scrapeLiveGames() chamado | URL:', url)

  const competitions = document.querySelectorAll('.ovm-Competition')
  console.log('[bet365-preload] .ovm-Competition encontrados:', competitions.length)

  if (competitions.length === 0) {
    // Ajuda diagnóstico: mostra quantos elementos existem no DOM
    const totalEls = document.querySelectorAll('*').length
    console.log('[bet365-preload] DOM tem', totalEls, 'elementos no total — página pode não ter carregado ainda')
    ipcRenderer.send('liveGamesData', [])
    return
  }

  const games = []

  for (const competition of competitions) {
    const leagueEl = competition.querySelector('.ovm-CompetitionHeader_NameText')
    if (!leagueEl) {
      console.log('[bet365-preload] competição sem .ovm-CompetitionHeader_NameText, pulando')
      continue
    }

    // Formato esperado: "País - Nome da Liga"
    const fullLeague = leagueEl.textContent.trim()
    const dashIdx    = fullLeague.indexOf(' - ')
    const country    = dashIdx >= 0 ? fullLeague.slice(0, dashIdx).trim() : fullLeague
    const league     = dashIdx >= 0 ? fullLeague.slice(dashIdx + 3).trim() : fullLeague
    console.log('[bet365-preload] Liga:', fullLeague)

    const fixtures = competition.querySelectorAll('.ovm-Fixture')
    console.log('[bet365-preload]   fixtures nessa liga:', fixtures.length)

    for (const fixture of fixtures) {
      const teamEls = fixture.querySelectorAll('.ovm-FixtureDetailsTwoWay_TeamName')
      if (teamEls.length < 2) {
        console.log('[bet365-preload]   fixture sem 2 times, pulando')
        continue
      }

      const team1 = teamEls[0].textContent.trim()
      const team2 = teamEls[1].textContent.trim()
      if (!team1 || !team2) continue

      const scorePills = fixture.querySelectorAll('.ovm-ScorePill')
      const score = scorePills.length >= 2
        ? `${scorePills[0].textContent.trim()}-${scorePills[1].textContent.trim()}`
        : '0-0'

      const timeEl  = fixture.querySelector('.ovm-InPlayTimer, .ovm-FixtureFooter_Timer')
      const timeRaw = timeEl ? timeEl.textContent.trim() : ''
      const time    = timeRaw.includes(':') ? timeRaw.split(':')[0] : timeRaw || '--'

      const oddsEls = fixture.querySelectorAll('.ovm-ParticipantOddsOnly_Odds')
      const odds = {
        home: oddsEls[0] ? parseFloat(oddsEls[0].textContent) || null : null,
        draw: oddsEls[1] ? parseFloat(oddsEls[1].textContent) || null : null,
        away: oddsEls[2] ? parseFloat(oddsEls[2].textContent) || null : null,
      }

      const hasStream = !!fixture.querySelector('.ovm-VideoIconLabel, [class*="VideoIcon"]')

      console.log('[bet365-preload]   jogo:', team1, 'x', team2, '|', score, '|', time + "'" )
      games.push({ team1, team2, score, time, league, country, odds, hasStream })
    }
  }

  console.log('[bet365-preload] Total jogos raspados:', games.length, '| enviando liveGamesData')
  ipcRenderer.send('liveGamesData', games)
}
