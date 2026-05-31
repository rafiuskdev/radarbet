import { useState, useEffect, useRef, useMemo } from 'react'
import type { RfMatchState } from '../electron.d'
import { SKEYS, readFloat, readStr } from '../lib/settings'
import { useRfClock } from '../lib/useRfClock'

// ── Linhas ────────────────────────────────────────────────────────────────────

type LineOption = '3' | '5' | '10' | 'all'

const LINE_OPTS = ['3', '5', '10', 'all'] as const

const LINE_HEIGHTS: Record<LineOption, number> = {
  '3':   140,
  '5':   200,
  '10':  355,
  'all': 560,
}

// ── Cores ─────────────────────────────────────────────────────────────────────

function getColor(iconType: string): string {
  if (iconType === 'homeattack' || iconType === 'awayattack')                          return '#f59e0b'
  if (iconType === 'homedanger' || iconType === 'awaydanger')                          return '#ef4444'
  if (iconType === 'homesafe'   || iconType === 'awaysafe')                            return '#10b981'
  if (iconType === 'commentary' || iconType === 'dangerousfreekick')                   return '#ef4444'
  if (iconType === 'shotontarget')  return '#10b981'
  if (iconType === 'shotofftarget') return '#f59e0b'
  if (iconType === 'yellowcard')    return '#fcd34d'
  if (iconType === 'redcard')       return '#ef4444'
  if (iconType === 'corner')        return '#a78bfa'
  return '#6b7280'
}

function getDot(iconType: string): string {
  if (iconType === 'homeattack')                              return '▶'
  if (iconType === 'homedanger')                              return '⚡'
  if (iconType === 'awayattack')                              return '◀'
  if (iconType === 'awaydanger')                              return '⚡'
  if (iconType === 'homesafe' || iconType === 'awaysafe')     return '■'
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
  if (iconType === 'homeattack' || iconType === 'homesafe' || iconType === 'homedanger') return 'home'
  if (iconType === 'awayattack' || iconType === 'awaysafe' || iconType === 'awaydanger') return 'away'
  if (!home && !away) return 'neutral'
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const t = norm(text)
  if (norm(home).split(/\s+/).filter(w => w.length >= 3).some(w => t.includes(w))) return 'home'
  if (norm(away).split(/\s+/).filter(w => w.length >= 3).some(w => t.includes(w))) return 'away'
  return 'neutral'
}

// ── Componente ────────────────────────────────────────────────────────────────

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
  const [lineCount,  setLineCount]  = useState<LineOption>(() => readStr(SKEYS.lancesLineCount, '10', LINE_OPTS))
  const [opacity,    setOpacity]    = useState(() => readFloat(SKEYS.lancesOpacity, 1.0))
  const [fontSize,   setFontSize]   = useState(() => Math.round(readFloat(SKEYS.lancesFontSize, 14)))
  const [extraTime,  setExtraTime]  = useState<string | null>(null)

  const staleRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevTopRef = useRef('')

  const lastAP = useMemo(() => {
    const events = matchState?.events ?? []
    const home   = matchState?.homeTeam ?? ''
    const away   = matchState?.awayTeam ?? ''
    let homeMin: number | null = null
    let awayMin: number | null = null

    for (const ev of events) {
      if (!['commentary', 'dangerousfreekick', 'homedanger', 'awaydanger'].includes(ev.iconType)) continue
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

  const rfClock = useRfClock(matchState, extraTime)

  useEffect(() => {
    const offExtra    = window.electronAPI.onRfExtraTime(v => setExtraTime(v))
    const offChanged  = window.electronAPI.onRfGameChanged(() => {
      setMatchState(null)
      setNotFound(false as const)
      setExtraTime(null)
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
    return () => { off(); offNotFound(); offChanged(); offExtra(); if (staleRef.current) clearTimeout(staleRef.current) }
  }, [])

  useEffect(() => {
    window.electronAPI.resizeWindow(320, LINE_HEIGHTS[lineCount])
  }, [lineCount])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SKEYS.lancesOpacity)   setOpacity(readFloat(SKEYS.lancesOpacity, 1.0))
      if (e.key === SKEYS.lancesFontSize)  setFontSize(Math.round(readFloat(SKEYS.lancesFontSize, 14)))
      if (e.key === SKEYS.lancesLineCount) setLineCount(readStr(SKEYS.lancesLineCount, '10', LINE_OPTS))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
          {rfClock && (
            <span className="lances-header-time">{rfClock}</span>
          )}
        </div>
        <button
          className="rb-btn-switch rb-no-drag"
          title="Abrir popup de lances"
          onClick={() => window.electronAPI.openFeatureWindow('lances-popup')}
        >□</button>
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </div>

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
            const dot     = getDot(ev.iconType)
            const evOpa   = getOpacity(ev.iconType)
            const timeStr = ev.minute + (ev.seconds ? ` ${ev.seconds}` : '')

            return (
              <div key={i} className={`lances-row lances-row-${side}`} style={{ opacity: evOpa }}>
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
