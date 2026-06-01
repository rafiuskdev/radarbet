import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { OddsSnapshot, BetfairMarketInfo, LiveGame } from '../electron.d'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number | null): string {
  return v != null ? v.toFixed(2) : '—'
}

function fmtMatched(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1000) return `£${(v / 1000).toFixed(1)}k`
  return `£${v.toFixed(0)}`
}

// Janelas de tempo disponíveis (minutos)
const TIME_WINDOWS = [5, 10, 15] as const
type TimeWindow = typeof TIME_WINDOWS[number]

// ── SVG Chart ─────────────────────────────────────────────────────────────────

const PAD = { top: 14, right: 52, bottom: 30, left: 38 }
const VW  = 600
const VH  = 200

function PriceChart({ history }: { history: OddsSnapshot[] }) {
  if (history.length < 2) {
    return (
      <div className="mc-chart-empty">
        <span>Aguardando dados</span>
        <span className="mc-chart-empty-sub">Selecione um mercado para iniciar</span>
      </div>
    )
  }

  const chartW = VW - PAD.left - PAD.right
  const chartH = VH - PAD.top  - PAD.bottom

  const allPrices = history.flatMap(s =>
    [s.back, s.lastTraded].filter((v): v is number => v != null)
  )
  const rawMin = Math.min(...allPrices)
  const rawMax = Math.max(...allPrices)
  const span   = Math.max(rawMax - rawMin, 0.05)
  const yMin   = rawMin - span * 0.1
  const yMax   = rawMax + span * 0.1

  const firstTs = history[0].ts
  const lastTs  = history[history.length - 1].ts
  const tRange  = Math.max(lastTs - firstTs, 1)

  const xByTs  = (ts: number) => PAD.left + ((ts - firstTs) / tRange) * chartW
  const xByIdx = (i: number) => xByTs(history[i].ts)
  const yScale = (v: number) => PAD.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH

  // SMA de 10 pontos aplicada ao back para suavizar oscilações rápidas
  const smoothedBack: (number | null)[] = history.map((_, i) => {
    const slice = history.slice(Math.max(0, i - 9), i + 1)
    const vals  = slice.map(s => s.back).filter((v): v is number => v != null)
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  })

  function toPoints(key: 'lastTraded'): string
  function toPoints(key: 'back', smooth: true): string
  function toPoints(key: 'back' | 'lastTraded', smooth?: true): string {
    return history
      .map((s, i) => {
        const v = (key === 'back' && smooth) ? smoothedBack[i] : s[key]
        return v != null ? `${xByTs(s.ts).toFixed(1)},${yScale(v).toFixed(1)}` : null
      })
      .filter(Boolean)
      .join(' ')
  }

  // ── Ticks do eixo X ──────────────────────────────────────────────────────
  const tickMs  = tRange < 90_000 ? 30_000 : tRange < 600_000 ? 60_000 : 120_000
  const timeFmt = tickMs < 60_000
    ? { hour: '2-digit' as const, minute: '2-digit' as const, second: '2-digit' as const }
    : { hour: '2-digit' as const, minute: '2-digit' as const }

  const xTicks: Array<{ x: number; label: string }> = []

  // Início e fim sempre presentes
  xTicks.push({ x: PAD.left,           label: new Date(firstTs).toLocaleTimeString('pt-BR', timeFmt) })
  xTicks.push({ x: PAD.left + chartW,  label: new Date(lastTs).toLocaleTimeString('pt-BR', timeFmt) })

  // Ticks intermediários
  let prevX = PAD.left - 30
  for (let t = Math.ceil(firstTs / tickMs) * tickMs; t < lastTs; t += tickMs) {
    const x = xByTs(t)
    if (x - PAD.left < 28 || (PAD.left + chartW) - x < 28) continue
    if (x - prevX < 35) continue
    prevX = x
    xTicks.push({ x, label: new Date(t).toLocaleTimeString('pt-BR', timeFmt) })
  }
  xTicks.sort((a, b) => a.x - b.x)

  const yTicks      = [yMax, (yMin + yMax) / 2, yMin]
  const last        = history[history.length - 1]
  const tipX        = xByIdx(history.length - 1)
  const lastSmooth  = smoothedBack[history.length - 1]
  const tipY        = lastSmooth != null ? yScale(lastSmooth) : null

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="mc-chart-svg">
      <defs>
        <filter id="mc-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Grid horizontal */}
      {yTicks.map((val, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={yScale(val)} x2={VW - PAD.right} y2={yScale(val)}
            stroke="rgba(255,255,255,0.05)" strokeWidth={1}/>
          <text x={PAD.left - 4} y={yScale(val) + 3.5} textAnchor="end"
            fontSize={9} fill="rgba(255,255,255,0.3)">{val.toFixed(2)}</text>
        </g>
      ))}

      {/* Ticks do eixo X */}
      {xTicks.map(({ x, label }, i) => {
        const isEdge = i === 0 || i === xTicks.length - 1
        const anchor = x <= PAD.left + 10 ? 'start' : x >= PAD.left + chartW - 10 ? 'end' : 'middle'
        return (
          <g key={i}>
            {!isEdge && (
              <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + chartH}
                stroke="rgba(255,255,255,0.06)" strokeWidth={1} strokeDasharray="2,3"/>
            )}
            <text x={x} y={VH - 5} textAnchor={anchor}
              fontSize={8} fill="rgba(255,255,255,0.35)">{label}</text>
          </g>
        )
      })}

      {/* lastTraded */}
      <polyline points={toPoints('lastTraded')} fill="none"
        stroke="rgba(255,255,255,0.25)" strokeWidth={1}
        strokeLinejoin="round" strokeDasharray="3,3"/>

      {/* back — suavizado com SMA */}
      <polyline points={toPoints('back', true)} fill="none"
        stroke="#10B981" strokeWidth={2} strokeLinejoin="round"/>

      {/* Rótulos borda direita */}
      {last.back != null && (
        <text x={VW - PAD.right + 5} y={yScale(last.back) + 3.5}
          fontSize={9} fill="#10B981" fontWeight="bold">{last.back.toFixed(2)}</text>
      )}
      {last.lastTraded != null && (() => {
        const y   = yScale(last.lastTraded)
        const yBk = last.back != null ? yScale(last.back) : null
        const off = yBk != null && Math.abs(y - yBk) < 12 ? (y > yBk ? 12 : -6) : 0
        return (
          <text x={VW - PAD.right + 5} y={y + 3.5 + off}
            fontSize={9} fill="rgba(255,255,255,0.4)">{last.lastTraded.toFixed(2)}</text>
        )
      })()}

      {/* Glow dot */}
      {tipY != null && (
        <g filter="url(#mc-glow)">
          <circle cx={tipX} cy={tipY} r={6} fill="#10B981" opacity={0.2}>
            <animate attributeName="r"       values="5;9;5"          dur="2s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.25;0.05;0.25" dur="2s" repeatCount="indefinite"/>
          </circle>
          <circle cx={tipX} cy={tipY} r={3.5} fill="#10B981"/>
        </g>
      )}
    </svg>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props { game: LiveGame; onBack: () => void }

export function MercadoPanel({ game, onBack }: Props) {
  const [markets,       setMarkets]       = useState<BetfairMarketInfo[]>([])
  const [marketId,      setMarketId]      = useState<string | null>(null)
  const [polling,       setPolling]       = useState(false)
  const [searching,     setSearching]     = useState(false)
  const [searchErr,     setSearchErr]     = useState('')
  const [history,       setHistory]       = useState<OddsSnapshot[]>([])
  const [latest,        setLatest]        = useState<OddsSnapshot | null>(null)
  const [timeWindowMin, setTimeWindowMin] = useState<TimeWindow>(5)
  const [pollMs,        setPollMs]        = useState(1000)

  const chartRef       = useRef<HTMLDivElement>(null)
  const timeWindowRef  = useRef<TimeWindow>(timeWindowMin)
  timeWindowRef.current = timeWindowMin

  const activeMarket = markets.find(m => m.marketId === marketId)

  // Filtra histórico pela janela de tempo
  const visibleHistory = useMemo(() => {
    if (history.length === 0) return history
    const lastTs = history[history.length - 1].ts
    const cutoff = lastTs - timeWindowMin * 60_000
    const idx    = history.findIndex(s => s.ts >= cutoff)
    return idx >= 0 ? history.slice(idx) : history
  }, [history, timeWindowMin])

  // ── Scroll → ajusta janela de tempo ──────────────────────────────────────
  useEffect(() => {
    const el = chartRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const cur = timeWindowRef.current
      const idx = TIME_WINDOWS.indexOf(cur)
      if (e.deltaY < 0) setTimeWindowMin(TIME_WINDOWS[Math.max(0, idx - 1)])
      else              setTimeWindowMin(TIME_WINDOWS[Math.min(TIME_WINDOWS.length - 1, idx + 1)])
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // ── Eventos em tempo real ─────────────────────────────────────────────────
  useEffect(() => {
    return window.electronAPI.onBetfairUpdate(snap => {
      setLatest(snap)
      setHistory(prev => [...prev, snap])
    })
  }, [])

  // ── Ao montar: carrega histórico existente ou busca ───────────────────────
  useEffect(() => {
    window.electronAPI.betfairGetHistory().then(hist => {
      if (hist.length > 0) {
        setHistory(hist)
        setLatest(hist[hist.length - 1])
        setPolling(true)
        return
      }
      doSearch()
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isHalf = game.time?.toUpperCase() === 'HT'

  const doSearch = useCallback(async () => {
    setSearching(true)
    setSearchErr('')
    setMarkets([])
    setMarketId(null)
    try {
      const result = await window.electronAPI.betfairSearchMarkets(game.team1, game.team2, game.score, isHalf)
      if (result.markets.length === 0) {
        setSearchErr('Jogo não encontrado na Betfair inplay')
        return
      }
      setMarkets(result.markets)
      const def = result.markets.find(m => m.line === result.defaultLine) ?? result.markets[0]
      setMarketId(def.marketId)
    } catch {
      setSearchErr('Erro ao buscar mercados')
    } finally {
      setSearching(false)
    }
  }, [game.team1, game.team2, game.score, isHalf])

  // Re-busca mercados quando o jogo entra/sai do HT
  const prevIsHalfRef = useRef(isHalf)
  useEffect(() => {
    if (prevIsHalfRef.current === isHalf) return
    prevIsHalfRef.current = isHalf
    doSearch()
  }, [isHalf, doSearch])

  // ── Troca de mercado: limpa histórico + reinicia polling ──────────────────
  useEffect(() => {
    if (!marketId) return
    setHistory([])
    setLatest(null)
    window.electronAPI.betfairStartPolling(marketId, pollMs)
    setPolling(true)
    return () => { window.electronAPI.betfairStopPolling() }
  // pollMs fora das deps — troca de intervalo tratada em handlePollMsChange
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketId])

  // ── Troca de intervalo: reinicia sem apagar histórico ─────────────────────
  const handlePollMsChange = useCallback((ms: number) => {
    setPollMs(ms)
    if (polling && marketId) {
      window.electronAPI.betfairStopPolling()
      window.electronAPI.betfairStartPolling(marketId, ms)
    }
  }, [polling, marketId])

  const handleSelectMarket = useCallback((id: string) => {
    if (id === marketId) return
    window.electronAPI.betfairStopPolling()
    setPolling(false)
    setMarketId(id)
  }, [marketId])

  const handleStop = useCallback(() => {
    window.electronAPI.betfairStopPolling()
    setPolling(false)
  }, [])

  const handleResume = useCallback(() => {
    if (!marketId) return
    window.electronAPI.betfairStartPolling(marketId, pollMs)
    setPolling(true)
  }, [marketId, pollMs])

  return (
    <div className="screen-mercado">
      {/* Header */}
      <header className="mc-header rb-drag">
        <div className="mc-header-info">
          <span className="mc-title">Radar de Mercado</span>
          <span className="mc-header-teams">{game.team1} × {game.team2}</span>
        </div>
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={onBack}>×</button>
      </header>

      {/* Seletor de mercado */}
      <div className="mc-market-row rb-no-drag">
        {searching && <span className="mc-searching">Buscando mercados...</span>}
        {!searching && searchErr && (
          <div className="mc-search-err">
            <span>{searchErr}</span>
            <button className="mc-retry-btn" onClick={doSearch}>↺ Tentar novamente</button>
          </div>
        )}
        {!searching && markets.length > 0 && (
          <div className="mc-mkt-btns">
            {markets.map(m => (
              <button
                key={m.marketId}
                className={`mc-mkt-btn${m.marketId === marketId ? ' active' : ''}`}
                onClick={() => handleSelectMarket(m.marketId)}
              >
                U{m.line}
              </button>
            ))}
          </div>
        )}
        <div className="mc-market-row-right">
          <select
            className="mc-interval-select"
            value={pollMs}
            onChange={e => handlePollMsChange(Number(e.target.value))}
            title="Intervalo de polling"
          >
            <option value={1000}>1s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
          <select
            className="mc-interval-select"
            value={timeWindowMin}
            onChange={e => setTimeWindowMin(Number(e.target.value) as TimeWindow)}
            title="Janela de tempo do gráfico"
          >
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={15}>15 min</option>
          </select>
          {polling
            ? <button className="mc-btn mc-btn--stop"  onClick={handleStop}>■</button>
            : <button className="mc-btn mc-btn--start" onClick={handleResume} disabled={!marketId}>▶</button>
          }
        </div>
      </div>

      {/* Resumo de odds */}
      <div className="mc-odds-row">
        <div className="mc-odds-cell">
          <span className="mc-odds-label">BACK</span>
          <span className="mc-odds-val mc-odds-back">{fmt(latest?.back ?? null)}</span>
        </div>
        <div className="mc-odds-sep"/>
        <div className="mc-odds-cell">
          <span className="mc-odds-label">ÚLTIMO NEGOC.</span>
          <span className="mc-odds-val mc-odds-last">{fmt(latest?.lastTraded ?? null)}</span>
        </div>
        <div className="mc-odds-sep"/>
        <div className="mc-odds-cell">
          <span className="mc-odds-label">MATCHED</span>
          <span className="mc-odds-val mc-odds-matched">{fmtMatched(latest?.totalMatched ?? null)}</span>
        </div>
        <div className="mc-odds-sep"/>
        <div className="mc-odds-cell">
          <span className="mc-odds-label">MERCADO</span>
          <span className="mc-odds-val mc-odds-mktname">{activeMarket ? `U${activeMarket.line}` : '—'}</span>
        </div>
      </div>

      {/* Legenda */}
      <div className="mc-legend">
        <span className="mc-legend-item mc-legend-back">── Back</span>
        <span className="mc-legend-item mc-legend-last">╌ Último negociado</span>
        <span className="mc-legend-count">{visibleHistory.length > 0 ? `${visibleHistory.length} pts` : ''}</span>
      </div>

      {/* Gráfico — scroll para ajustar janela de tempo */}
      <div className="mc-chart-wrap" ref={chartRef}>
        <PriceChart history={visibleHistory} />
      </div>

      {/* Status */}
      <div className="mc-status">
        {polling
          ? <><span className="mc-status-dot mc-status-dot--live"/>dados com ~1min de atraso (sem login BF)</>
          : <><span className="mc-status-dot"/>parado — {activeMarket ? `mercado: ${activeMarket.marketId}` : 'nenhum mercado'}</>
        }
      </div>
    </div>
  )
}
