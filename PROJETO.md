# RadarBet2 — Referência Técnica (Fase 1 concluída)

## Arquitectura geral

```
[aba bet365 — incógnito]          [aba stream — rushflows.vip]
     scraper.js                         content.js
   (lê DOM a cada 2s)   →   chrome.storage.local   →   (widget flutuante)
   guarda radar_<tabId>        radar_<tabId>             polling 2s
```

O background.js faz de mediador: responde a mensagens dos content scripts, gere tabs e ativa o auto-open da bet365.

---

## Ficheiros

```
extension/
├── manifest.json          MV3 v1.3.0
├── background.js          service worker
├── scraper.js             content script → bet365 only
├── content.js             content script → rushflows.vip (widget)
├── radar.css              estilos do widget
├── data/
│   └── odds_justas.json   45 entradas [{mercado, justa}] decrescentes
└── icons/
    ├── logo-bet365.jpg
    ├── logo-betfair.png
    ├── 16.png / 48.png / 128.png
```

### manifest.json — pontos importantes
- `host_permissions`: `*://*.bet365.com/*` e `*://rushflows.vip/*`
- `scraper.js` injeta em todas as páginas bet365 (`document_idle`)
- `content.js` + `radar.css` injeta em todas as páginas rushflows.vip
- `web_accessible_resources`: `odds_justas.json`, ambos os logos

---

## background.js

| Mensagem recebida | O que faz |
|---|---|
| `getTabId` | devolve `sender.tab.id` ao scraper |
| `getBet365Games` | consulta tabs bet365 + storage, devolve `[{tabId, data}]` |
| `openBet365` | abre `bet365.com/#/IP/B1` em janela anónima; se `teams` recebido, aguarda load e envia `navigateToGame` ao scraper |
| `focusTab` | `chrome.tabs.update(tabId, {active:true})` + foca a janela |

**Eventos:**
- `tabs.onUpdated` → detecta `rushflows.vip/watch/*` → envia `showRadar` ao content script (com fallback de injeção manual)
- `tabs.onRemoved` → limpa `radar_<tabId>` do storage
- `action.onClicked` → toggle manual em qualquer site que não seja bet365

---

## scraper.js (bet365)

**Ciclo:** `getTabId` → `scrape()` → `setInterval(scrape, 2000)`

**Storage key:** `radar_<myTabId>`

**Dados guardados:**
```js
{
  tabId, time, score,   // score = total golos (home+away) ou null
  goals: {
    label, isHalf,
    lines: [{ line, over, under }]  // ordenadas ASC, filtradas, só where over!=null
  },
  nextGoal: { team1:{name,odd}, noGoal:{name,odd}, team2:{name,odd} },
  updatedAt
}
```

### Seletores DOM da bet365

**Tempo:**
```
.lv-ScoreBasedClockPart
.lv-ClockBasedTime_Clocks
[class*="lv-ClockBased"]
[class*="ScoreClock"]
```

**Placar (tentativa — pode falhar se não visível no tab):**
```
.lv-ScoreBasedScore          → "0 - 1" combinado
[class*="Score_VSHome/Away"] → home e away separados
```

**Mercado de Golos:**
```
Labels de grupo:   .sip-MarticipantGroupButton_Text, .gl-MarketGroupButton_Text
  → procura "gol|goal", prioriza "parte|half" sobre "encontro|match"
  → IMPORTANTE: !matchContainer na condição "encontro" para não sobrescrever
    com "Encontro - Golos - Mais Opções"

Labels de linha:   .srb-ParticipantLabelCentered_Name  → [1.5, 2.5, …]
Colunas:           .gl-Market_General-columnheader
  Header:          .gl-MarketColumnHeader  → "Mais de" / "Menos de"
  Odds:            .gl-ParticipantOddsOnly_Odds
```

**Próximo Golo (N.° Golo):**
```
Labels:  .sip/gl-MarketGroupButton_Text  → contém "golo" / "próximo gol" / "next goal"
Nomes:   .gl-ParticipantBorderless_Name  [0]=team1 [1]=noGoal [2]=team2
Odds:    .gl-ParticipantBorderless_Odds  [0..2]
```

**Navegação automática (`navigateToGame`):**
- Estratégia 1: `a[href*="EV"]` → texto contém ambas as equipas (fuzzyTeamMatch)
- Estratégia 2: `[class*="Fixture|Coupon|MarketGroup|Event"]` → clica no closest `<a>`
- 12 tentativas, 1s intervalo

---

## content.js (rushflows.vip)

### Estado global
```js
let visible, widget, oddsTable, pollInterval, linkedTabId, retryTimer
let timerInterval, bet365Opened
const prevOdds = {}   // id → valor anterior (para detectar mudanças)
const changedAt = {}  // id → timestamp da última mudança (para o timer)
```

### Fluxo de inicialização
```
init()
  └─ isStreamPage() → startRadarAuto() → showRadarNow()
       └─ loadOddsTable() → buildWidget() → fetchGames()
            └─ getBet365Games → autoMatchGame() → linkGame(tabId)
                 └─ startPolling() → poll() cada 2s → updateRadar()
```

**Auto-open bet365:** na primeira chamada a `fetchGames()` sem jogos + `isStreamPage()`:
- envia `openBet365` com `teams: getTeamsFromUrl()`
- `bet365Opened = true` (evita múltiplas abas)
- teams extraídos do param `?title=` da URL, split por `x|X|×|vs`

**Auto-match:** `autoMatchGame()` → `teamMatch()` (contains + word-prefix ≥4 chars)

### Seleção da linha de golos
```js
const totalGoals = data.score ?? 0
const targetLine = totalGoals + 0.5   // 0 golos → 0.5, 1 golo → 1.5, etc.
const line1 = lines.find(l => l.line >= targetLine) || lines[0]
const line2 = lines.find(l => l.line > line1.line) || null
```

### Flash + Timer
- `trackOdd(id, newVal, flash)` — detecta mudança; `flash=true` apenas para `rb-g1` (Under bet365)
- `flashWidget()` — adiciona `.rb-flashing` ao `#radarbet-widget` (remove após 900ms)
- `updateTimerDisplay()` — corre a cada 1s; cor: `>60s` → amarelo `#e8c030`, `>120s` → laranja `#f08030`

### Lookup odds_justas.json
- `getFairOdd(marketOdd)` → busca `mercado` mais próxima → retorna `justa`
- `getAdjacentOdds(marketOdd)` → mesmo índice ± 1 (tabela decrescente: idx-1 = maior, idx+1 = menor)

---

## Widget — Painéis e IDs

### Painel selector (`#rb-panel-selector`)
```
#rb-drag-handle     → arrastar (só este painel)
#rb-game-list       → lista de jogos renderizada dinamicamente
#rb-refresh         → re-fetch jogos
#rb-close           → hide()
```

### Painel radar (`#rb-panel-radar`)
```
#rb-flash-overlay   → overlay de flash branco (animation via .rb-flashing)

Topbar:
  #rb-market-label  → "1ª" ou "FT"
  #rb-g1-line       → "U1.5" / "U2.5" (linha activa)
  #rb-time          → tempo do jogo
  #rb-g2-odd        → under da linha seguinte (topbar)
  #rb-g2-fair       → fair da linha seguinte
  #rb-settings-btn  → abre painel settings
  #rb-switch        → switchGame()
  #rb-close2        → hide()

Cards:
  Card bet365 (.rb-card-365):
    #rb-adj-above-mkt   → odd mercado da linha acima
    #rb-g1-odd          → odd mercado principal (grande)
    #rb-adj-below-mkt   → odd mercado da linha abaixo

  Card betfair (.rb-card-bf):
    #rb-adj-above-jst   → odd justa da linha acima
    #rb-g1-fair         → odd justa principal (grande)
    #rb-adj-below-jst   → odd justa da linha abaixo

Timer row:
  #rb-g1-timer-icon     → ⊙ (muda cor com tempo)
  #rb-g1-timer          → "M:SS"

Nx row:
  #rb-nx1-odd / #rb-nx2-odd    → odds equipa 1 / 2
  #rb-nx1-ind / #rb-nx2-ind    → ▲ (value) ou ─

#rb-status            → timestamp ou mensagem de erro
#rb-resize-handle     → arrasto no canto inferior direito
```

### Painel settings (`#rb-panel-settings`)
Vazio (placeholder "Em breve..."). Pronto para features futuras.

---

## CSS — Classes principais

| Classe | Descrição |
|---|---|
| `#radarbet-widget` | container fixo, 248px, z-index máximo, overflow hidden |
| `#rb-flash-overlay` | pseudo-overlay para flash; animation `rbFlashOverlay` 0.9s |
| `.rb-topbar` | flex row com labels e botões |
| `.rb-cards-row` | flex row com dois cards |
| `.rb-card-365` | fundo verde escuro `rgba(0,110,55,0.22)` |
| `.rb-card-bf` | fundo âmbar escuro `rgba(110,85,0,0.22)` |
| `.rb-card-adj` | odd adjacente pequena `11px #3a4a58` |
| `.rb-card-main` | odd principal grande `22px bold #fff` |
| `.rb-line-tag` | label U1.5/U2.5 `9px #4a7a8a` |
| `.rb-nx-value` | cor verde `#00d472` (valor detectado) |
| `#rb-resize-handle` | triângulo no canto direito, `cursor: se-resize` |
| `#rb-panel-radar` | `cursor: grab` em toda a área |

---

## Drag & Resize

**`makeDraggable(el, handle)`**
- Ignora clicks em `button` ou em `#rb-resize-handle`
- Move `el` via `style.left/top`, anula `right/bottom`
- Attachado a: `#rb-drag-handle` (selector), `#rb-panel-radar`, `#rb-panel-settings`

**`makeResizable(el, handle)`**
- Handle: `#rb-resize-handle`
- Min: 200×100px
- Usa `stopPropagation` para não conflituar com drag

---

## Notas e limitações conhecidas

- **Placar** (`readTotalGoals`) pode não funcionar se o elemento do placar não estiver visível no tab "Populares" — a seleção de linha funciona na mesma porque `totalGoals=0` → `targetLine=0.5` → primeira linha disponível (normalmente a correcta)
- **"Encontro - Golos - Mais Opções"** seria lido em vez de "Encontro - Golos" sem o guard `!matchContainer` — bug crítico já corrigido
- **Navegação automática** na bet365 (`navigateToGame`) usa seletores genéricos; pode falhar se o HTML da página `/B1` mudar
- **Incógnito** requer "Permitir em modo anónimo" activado em `chrome://extensions`
- **Seletores bet365** podem mudar sem aviso (SPA dinâmico) — monitorar periodicamente

---

## Próximas features (Fase 2 — ideias)

- Painel de configurações: escolha de linhas, thresholds de alerta, som
- Histórico de odds com mini-gráfico
- Alertas sonoros quando odd muda
- Suporte a outros mercados (Handicap, BTTS)
