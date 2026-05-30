import { useState, useEffect, useRef, useMemo } from 'react'
import type { RfMatchState } from '../electron.d'

// ── Linhas ────────────────────────────────────────────────────────────────────

type LineOption = '3' | '5' | '10' | 'all'

const LINE_HEIGHTS: Record<LineOption, number> = {
  '3':   140,
  '5':   200,
  '10':  355,
  'all': 560,
}
const SETTINGS_EXTRA = 118  // altura do painel de settings expandido

// ── Cores ─────────────────────────────────────────────────────────────────────

function getColor(iconType: string): string {
  if (iconType === 'homeattack' || iconType === 'awayattack')           return '#f59e0b'
  if (iconType === 'homesafe'   || iconType === 'awaysafe')             return '#10b981'
  if (iconType === 'commentary' || iconType === 'dangerousfreekick')    return '#ef4444'
  if (iconType === 'shotontarget')  return '#10b981'
  if (iconType === 'shotofftarget') return '#f59e0b'
  if (iconType === 'yellowcard')    return '#fcd34d'
  if (iconType === 'redcard')       return '#ef4444'
  if (iconType === 'corner')        return '#a78bfa'
  return '#6b7280'
}

// Ícone diferenciado por tipo E por lado (home → ▶, away → ◀)
function getDot(iconType: string, side: 'home' | 'away' | 'neutral'): string {
  if (iconType === 'homeattack') return '▶'
  if (iconType === 'awayattack') return '◀'
  if (iconType === 'homesafe' || iconType === 'awaysafe')           return '■'
  if (iconType === 'commentary' || iconType === 'dangerousfreekick') return '⚡'
  if (iconType === 'shotontarget')  return '●'
  if (iconType === 'shotofftarget') return '○'
  if (iconType === 'corner')        return '⌒'
  if (iconType === 'yellowcard' || iconType === 'redcard') return '▪'
  return '·'
}

function getOpacity(iconType: string): number {
  if (['throwin', 'goalkick', 'ballsafe', 'whistle', 'freekick'].includes(iconType)) return 0.38
  if (iconType === 'homesafe' || iconType === 'awaysafe') return 0.65
  return 1.0
}

// ── Lado do evento ────────────────────────────────────────────────────────────

function getSide(
  iconType: string,
  text:     string,
  home:     string,
  away:     string,
): 'home' | 'away' | 'neutral' {
  if (iconType === 'homeattack' || iconType === 'homesafe') return 'home'
  if (iconType === 'awayattack' || iconType === 'awaysafe') return 'away'
  if (!home && !away) return 'neutral'
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const t = norm(text)
  if (norm(home).split(/\s+/).filter(w => w.length >= 3).some(w => t.includes(w))) return 'home'
  if (norm(away).split(/\s+/).filter(w => w.length >= 3).some(w => t.includes(w))) return 'away'
  return 'neutral'
}

// ── Componente ────────────────────────────────────────────────────────────────

// Parse "45' + 2'" → 47, "30'" → 30
function parseMinute(minute: string): number {
  const base  = parseInt(minute.match(/^(\d+)/)?.[1] ?? '0')
  const extra = parseInt(minute.match(/\+\s*(\d+)/)?.[1] ?? '0')
  return base + extra
}

interface Props {
  onBack: () => void
}

export function LancesPanel({ onBack }: Props) {
  const [matchState,   setMatchState]   = useState<RfMatchState | null>(null)
  const [notFound,     setNotFound]     = useState<'not-found' | 'no-radar' | false>(false)
  const [isStale,      setIsStale]      = useState(false)
  const [lineCount,    setLineCount]    = useState<LineOption>('10')
  const [showSettings, setShowSettings] = useState(false)
  const [opacity,      setOpacity]      = useState(1.0)
  const [fontSize,     setFontSize]     = useState(12)

  const staleRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevTopRef = useRef('')

  // Último ataque perigoso por lado (iconType === 'commentary')
  const lastAP = useMemo(() => {
    const events = matchState?.events ?? []
    const home   = matchState?.homeTeam ?? ''
    const away   = matchState?.awayTeam ?? ''
    let homeMin: number | null = null
    let awayMin: number | null = null

    for (const ev of events) {
      if (ev.iconType !== 'commentary' && ev.iconType !== 'dangerousfreekick') continue
      const side = getSide(ev.iconType, ev.text, home, away)
      if (side === 'home' && homeMin === null) homeMin = parseMinute(ev.minute)
      if (side === 'away' && awayMin === null) awayMin = parseMinute(ev.minute)
      if (homeMin !== null && awayMin !== null) break
    }

    const currentMin = parseMinute(events[0]?.minute ?? '')
    return {
      home: homeMin !== null ? Math.max(0, currentMin - homeMin) : null,
      away: awayMin !== null ? Math.max(0, currentMin - awayMin) : null,
    }
  }, [matchState])

  useEffect(() => {
    const offChanged  = window.electronAPI.onRfGameChanged(() => {
      setMatchState(null)
      setNotFound(false as const)
    })
    const offNotFound = window.electronAPI.onRfGameNotFound(reason => setNotFound(reason))
    const off = window.electronAPI.onRfMatchUpdate(state => {
      setNotFound(false as const)
      setMatchState(state)
      setIsStale(false)
      if (staleRef.current) clearTimeout(staleRef.current)
      staleRef.current = setTimeout(() => setIsStale(true), 15_000)
      const top = state.events[0]?.text ?? ''
      if (top !== prevTopRef.current) prevTopRef.current = top
    })
    return () => { off(); offNotFound(); offChanged(); if (staleRef.current) clearTimeout(staleRef.current) }
  }, [])

  // Redimensiona janela ao mudar linhas ou abrir/fechar settings
  useEffect(() => {
    const h = LINE_HEIGHTS[lineCount] + (showSettings ? SETTINGS_EXTRA : 0)
    window.electronAPI.resizeWindow(320, h)
  }, [lineCount, showSettings])

  const events   = matchState?.events ?? []
  const home     = matchState?.homeTeam ?? ''
  const away     = matchState?.awayTeam ?? ''
  const score    = matchState?.score ?? '— - —'
  const displayed = lineCount === 'all' ? events : events.slice(0, parseInt(lineCount))

  return (
    <div className="screen-lances" style={{ opacity, zoom: fontSize / 12 }}>
      {/* Topbar */}
      <div className="lances-topbar rb-drag">
        <button className="gm-back-btn rb-no-drag" onClick={onBack}>←</button>
        <div className="lances-header-info">
          <span className="lances-teams">{home || '…'} × {away || '…'}</span>
          <span className={`lances-score${isStale ? ' lances-score-stale' : ''}`}>{score}</span>
        </div>
        <button
          className={`rb-btn-switch rb-no-drag${showSettings ? ' rb-btn-active' : ''}`}
          onClick={() => setShowSettings(s => !s)}
          title="Configurações"
        >⚙</button>
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </div>

      {/* Painel de settings */}
      {showSettings && (
        <div className="lances-settings rb-no-drag">
          {/* Linhas */}
          <div className="rsp-row">
            <span className="rsp-label">Linhas</span>
            <div className="lances-line-opts">
              {(['3', '5', '10', 'all'] as LineOption[]).map(opt => (
                <button
                  key={opt}
                  className={`lances-line-btn${lineCount === opt ? ' active' : ''}`}
                  onClick={() => setLineCount(opt)}
                >
                  {opt === 'all' ? 'Todas' : opt}
                </button>
              ))}
            </div>
          </div>
          {/* Fonte */}
          <div className="rsp-row">
            <span className="rsp-label">Fonte</span>
            <span className="rsp-val">{fontSize}px</span>
            <input
              className="rsp-slider"
              type="range"
              min="9" max="18" step="1"
              value={fontSize}
              onChange={e => setFontSize(parseInt(e.target.value))}
            />
          </div>
          {/* Opacidade */}
          <div className="rsp-row">
            <span className="rsp-label">Opacidade</span>
            <span className="rsp-val">{Math.round(opacity * 100)}%</span>
            <input
              className="rsp-slider"
              type="range"
              min="10" max="100" step="5"
              value={Math.round(opacity * 100)}
              onChange={e => setOpacity(parseInt(e.target.value) / 100)}
            />
          </div>
        </div>
      )}

      {/* Último ataque perigoso por equipa */}
      {matchState && (
        <div className="lances-ap-bar rb-drag">
          <div className="lances-ap-side lances-ap-home">
            <span className="lances-ap-icon">⚡</span>
            <span className="lances-ap-val">
              {lastAP.home !== null ? `${lastAP.home}'` : '—'}
            </span>
          </div>
          <span className="lances-ap-label">Último AP</span>
          <div className="lances-ap-side lances-ap-away">
            <span className="lances-ap-val">
              {lastAP.away !== null ? `${lastAP.away}'` : '—'}
            </span>
            <span className="lances-ap-icon">⚡</span>
          </div>
        </div>
      )}

      {/* Lista de lances */}
      <div className="lances-list rb-no-drag">
        {notFound ? (
          <div className="lances-not-found">
            <span className="lances-nf-icon">⚠</span>
            <p>{notFound === 'no-radar'
              ? 'Radar não disponível para este jogo'
              : 'Jogo não encontrado no RadarFutebol'
            }</p>
            <p className="lances-nf-sub">{notFound === 'no-radar'
              ? 'Este jogo existe no RadarFutebol mas não tem cobertura de Radar'
              : 'O jogo pode não estar disponível ou o nome pode ser diferente'
            }</p>
          </div>
        ) : events.length === 0 ? (
          <div className="lances-skeleton">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="lances-sk-row">
                <div className="sk-line lances-sk-time" />
                <div className="sk-line lances-sk-text" />
              </div>
            ))}
            <p className="lances-waiting">Aguardando lances…</p>
          </div>
        ) : null}
        {!notFound && events.length > 0 && (
          displayed.map((ev, i) => {
            const side    = getSide(ev.iconType, ev.text, home, away)
            const color   = getColor(ev.iconType)
            const dot     = getDot(ev.iconType, side)
            const evOpa   = getOpacity(ev.iconType)
            const timeStr = ev.minute + (ev.seconds ? ` ${ev.seconds}` : '')

            return (
              <div key={i} className={`lances-row lances-row-${side}`} style={{ opacity: evOpa }}>
                {/* Ordem DOM: [time] [dot] [text]
                    home (row):         time · dot · text
                    away (row-reverse): text · dot · time  */}
                <span className="lances-time">{timeStr}</span>
                <span className="lances-dot" style={{ color }}>{dot}</span>
                <span className="lances-text" style={{ color }}>{ev.text}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
