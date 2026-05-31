import { useState, useEffect, useRef } from 'react'
import type { RfMatchState } from '../electron.d'

type PopupLineOption = '1' | '2' | '3' | '5'

const POPUP_ROW_H = 34

// Cor de fundo da janela inteira baseada no evento mais recente
function getWindowBg(iconType?: string): string {
  if (!iconType)                                                              return 'rgba(15, 15, 25, 0.95)'
  if (iconType === 'commentary' || iconType === 'dangerousfreekick')         return 'rgba(160, 20, 20, 0.95)'
  if (iconType === 'homeattack' || iconType === 'awayattack')                return 'rgba(155, 85, 5, 0.95)'
  if (iconType === 'shotontarget' || iconType === 'shotofftarget')           return 'rgba(155, 85, 5, 0.90)'
  if (iconType === 'homesafe' || iconType === 'awaysafe')                    return 'rgba(10, 110, 60, 0.95)'
  return 'rgba(20, 20, 35, 0.92)'
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
  const [popupLines,  setPopupLines]  = useState<PopupLineOption>('3')
  const [ctxMenu,     setCtxMenu]     = useState<{ x: number; y: number } | null>(null)

  const staleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off        = window.electronAPI.onRfMatchUpdate(state => {
      setMatchState(state)
      if (staleRef.current) clearTimeout(staleRef.current)
      staleRef.current = setTimeout(() => setMatchState(null), 15_000)
    })
    const offChanged = window.electronAPI.onRfGameChanged(() => setMatchState(null))
    return () => { off(); offChanged(); if (staleRef.current) clearTimeout(staleRef.current) }
  }, [])

  useEffect(() => {
    window.electronAPI.resizeWindow(320, parseInt(popupLines) * POPUP_ROW_H)
  }, [popupLines])

  const events   = matchState?.events ?? []
  const popupEvs = events.slice(0, parseInt(popupLines))
  const windowBg = getWindowBg(events[0]?.iconType)

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
                onClick={() => { setPopupLines(opt); setCtxMenu(null) }}
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
