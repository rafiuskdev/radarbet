import { useState, useEffect, useRef } from 'react'
import type { RfMatchState } from '../electron.d'
import { SKEYS, readFloat, readStr, writeSetting } from '../lib/settings'
import { useRfClock } from '../lib/useRfClock'

type PopupLineOption = '1' | '2' | '3' | '5'
const POPUP_LINE_OPTS = ['1', '2', '3', '5'] as const

const POPUP_ROW_H  = 34
const POPUP_INFO_H = 22

// Cor de fundo da janela inteira baseada no evento mais recente
function getWindowBg(iconType?: string, alpha = 0.92): string {
  const a = alpha.toFixed(2)
  if (!iconType)                                                              return `rgba(15, 15, 25, ${a})`
  if (iconType === 'commentary' || iconType === 'dangerousfreekick')         return `rgba(160, 20, 20, ${a})`
  if (iconType === 'homeattack' || iconType === 'awayattack')                return `rgba(155, 85, 5, ${a})`
  if (iconType === 'shotontarget' || iconType === 'shotofftarget')           return `rgba(155, 85, 5, ${a})`
  if (iconType === 'homesafe' || iconType === 'awaysafe')                    return `rgba(10, 110, 60, ${a})`
  return `rgba(20, 20, 35, ${a})`
}

function getColor(iconType: string): string {
  if (iconType === 'homeattack' || iconType === 'awayattack')                return 'rgba(255,210,80,1)'
  if (iconType === 'homesafe'   || iconType === 'awaysafe')                  return 'rgba(150,255,200,1)'
  if (iconType === 'commentary' || iconType === 'dangerousfreekick')         return 'rgba(255,150,150,1)'
  if (iconType === 'shotontarget')   return 'rgba(150,255,200,1)'
  if (iconType === 'shotofftarget')  return 'rgba(255,210,80,1)'
  if (iconType === 'yellowcard')     return '#fcd34d'
  if (iconType === 'redcard')        return '#fca5a5'
  if (iconType === 'corner')         return '#c4b5fd'
  return 'rgba(255,255,255,0.55)'
}

function getDot(iconType: string): string {
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

export function LancesPopupPanel() {
  const [matchState,  setMatchState]  = useState<RfMatchState | null>(null)
  const [extraTime,   setExtraTime]   = useState<string | null>(null)
  const [popupLines,  setPopupLines]  = useState<PopupLineOption>(() => readStr(SKEYS.popupLines, '3', POPUP_LINE_OPTS))
  const [ctxMenu,     setCtxMenu]     = useState<{ x: number; y: number } | null>(null)
  const [bgOpacity,   setBgOpacity]   = useState<number>(() => readFloat(SKEYS.popupBgOpacity, 0.92))

  const staleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off        = window.electronAPI.onRfMatchUpdate(state => {
      setMatchState(state)
      if (staleRef.current) clearTimeout(staleRef.current)
      staleRef.current = setTimeout(() => setMatchState(null), 15_000)
    })
    const offChanged  = window.electronAPI.onRfGameChanged(() => { setMatchState(null); setExtraTime(null) })
    const offExtra    = window.electronAPI.onRfExtraTime(v => setExtraTime(v))
    const onStorage  = (e: StorageEvent) => {
      if (e.key === SKEYS.popupBgOpacity) setBgOpacity(readFloat(SKEYS.popupBgOpacity, 0.92))
      if (e.key === SKEYS.popupLines)     setPopupLines(readStr(SKEYS.popupLines, '3', POPUP_LINE_OPTS))
    }
    window.addEventListener('storage', onStorage)
    return () => {
      off(); offChanged(); offExtra()
      window.removeEventListener('storage', onStorage)
      if (staleRef.current) clearTimeout(staleRef.current)
    }
  }, [])

  useEffect(() => {
    window.electronAPI.resizeWindow(320, parseInt(popupLines) * POPUP_ROW_H + POPUP_INFO_H)
  }, [popupLines])

  const events      = matchState?.events ?? []
  const popupEvs    = events.slice(0, parseInt(popupLines))
  const windowBg    = getWindowBg(events[0]?.iconType, bgOpacity)
  const score       = matchState?.score ?? null
  const rfClock     = useRfClock(matchState, extraTime)
  const timeDisplay = rfClock || null

  const openCtx = (e: React.MouseEvent) => {
    e.preventDefault()
    const mw = 160, mh = 160
    setCtxMenu({
      x: Math.min(e.clientX, window.innerWidth  - mw),
      y: Math.min(e.clientY, window.innerHeight - mh),
    })
  }

  return (
    <div className="screen-lances-popup rb-drag" style={{ background: windowBg }} onContextMenu={openCtx}>
      {/* Linhas de eventos */}
      <div className="popup-rows">
        {popupEvs.length === 0 ? (
          <div className="popup-row-v2" style={{ justifyContent: 'center' }}>
            <span className="popup-text-v2" style={{ opacity: 0.45 }}>Aguardando…</span>
          </div>
        ) : (
          popupEvs.map((ev, i) => {
            const timeStr = ev.minute + (ev.seconds ? ` ${ev.seconds}` : '')
            return (
              <div
                key={i}
                className={`popup-row-v2${i === 0 ? ' popup-row-new' : ''}`}
                style={{ background: i % 2 === 1 ? 'rgba(0,0,0,0.14)' : 'transparent' }}
              >
                <span className="popup-time-v2">{timeStr}</span>
                <span className="popup-dot-v2" style={{ color: getColor(ev.iconType) }}>{getDot(ev.iconType)}</span>
                <span className="popup-text-v2">{ev.text}</span>
              </div>
            )
          })
        )}
      </div>

      {/* Barra de info: placar + tempo */}
      <div className="popup-info-bar">
        <span className="popup-info-score">{score ?? '— - —'}</span>
        {timeDisplay && <span className="popup-info-time">{timeDisplay}</span>}
      </div>

      {/* Menu de contexto (botão direito) */}
      {ctxMenu && (
        <>
          <div className="popup-ctx-overlay" onClick={() => setCtxMenu(null)} />
          <div className="popup-ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }}>
            <div className="popup-ctx-section">Linhas</div>
            {(['1', '2', '3', '5'] as PopupLineOption[]).map(opt => (
              <button
                key={opt}
                className={`popup-ctx-item${popupLines === opt ? ' active' : ''}`}
                onClick={() => { setPopupLines(opt); writeSetting(SKEYS.popupLines, opt); setCtxMenu(null) }}
              >
                {opt} linha{parseInt(opt) > 1 ? 's' : ''}
                {popupLines === opt && <span className="popup-ctx-check">✓</span>}
              </button>
            ))}
            <div className="popup-ctx-sep" />
            <button className="popup-ctx-item popup-ctx-close-btn" onClick={() => window.close()}>
              Fechar popup
            </button>
          </div>
        </>
      )}
    </div>
  )
}
