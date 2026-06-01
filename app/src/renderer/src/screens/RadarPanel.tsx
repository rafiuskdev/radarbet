import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { GameData } from '../electron.d'
import { SKEYS, readFloat, readBool, writeSetting } from '../lib/settings'
import rawOddsTable from '../data/odds_justas.json'
import logo365 from '../assets/logo-bet365.jpg'
import logoBF  from '../assets/logo-betfair.png'
import type { LiveGame } from '../electron.d'

interface OddsRow { mercado: number; justa: number }
const oddsTable = rawOddsTable as OddsRow[]

function getFairOdd(mkt: number | null): number | null {
  if (!mkt || isNaN(mkt) || !oddsTable.length) return null
  let best = oddsTable[0], minDiff = Infinity
  for (const row of oddsTable) {
    const d = Math.abs(mkt - row.mercado)
    if (d < minDiff) { minDiff = d; best = row }
  }
  return best.justa
}

function getAdjacentOdds(mkt: number | null) {
  if (!mkt || isNaN(mkt) || !oddsTable.length) return { above: null as OddsRow | null, below: null as OddsRow | null }
  let idx = 0, minDiff = Infinity
  for (let i = 0; i < oddsTable.length; i++) {
    const d = Math.abs(mkt - oddsTable[i].mercado)
    if (d < minDiff) { minDiff = d; idx = i }
  }
  return {
    above: idx > 0                    ? oddsTable[idx - 1] : null,
    below: idx < oddsTable.length - 1 ? oddsTable[idx + 1] : null,
  }
}

function fmt(v: number | null): string { return v != null ? v.toFixed(2) : '—' }

function calcTicksPerMin(fairOdd: number, minsRemaining: number): number {
  if (minsRemaining <= 0 || fairOdd <= 1.0) return 0
  return (fairOdd * Math.log(fairOdd) * 100) / minsRemaining
}

function fmtTick(v: number | null): string { return v != null ? v.toFixed(2) : '—' }

let _audioCtx: AudioContext | null = null
function playBeep(volume = 0.25, freq = 880, dur = 0.12) {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext()
    if (_audioCtx.state === 'suspended') _audioCtx.resume()
    const osc  = _audioCtx.createOscillator()
    const gain = _audioCtx.createGain()
    osc.connect(gain)
    gain.connect(_audioCtx.destination)
    osc.frequency.value = freq
    osc.type = 'sine'
    const t = _audioCtx.currentTime
    gain.gain.setValueAtTime(volume, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.start(t)
    osc.stop(t + dur)
  } catch {}
}

interface Props {
  game: LiveGame
  onBack: () => void
}

export function RadarPanel({ game, onBack }: Props) {
  const [gameData,     setGameData]     = useState<GameData | null>(null)
  const [isStale,      setIsStale]      = useState(false)
  const [flashing,     setFlashing]     = useState(false)
  const [timerTxt,     setTimerTxt]     = useState('0:00')
  const [timerColor,   setTimerColor]   = useState('')
  const [oddDir,          setOddDir]          = useState<'up' | 'down' | null>(null)
  const [selectedLineIdx, setSelectedLineIdx] = useState(0)
  const [soundEnabled,    setSoundEnabled]    = useState(() => readBool(SKEYS.radarSoundEnabled, true))
  const [soundVolume,     setSoundVolume]     = useState(() => Math.round(readFloat(SKEYS.radarSoundVolume, 25)))
  const [opacity,      setOpacity]      = useState(() => readFloat(SKEYS.radarOpacity, 1.0))
  const [fontSize,     setFontSize]     = useState(() => Math.round(readFloat(SKEYS.radarFontSize, 14)))
  const [extraTimeInput, setExtraTimeInput] = useState('')
  const [oddSimInput,    setOddSimInput]    = useState('')

  const prevOdds          = useRef<Record<string, number | null>>({})
  const changedAt         = useRef<Record<string, number>>({})
  const prevG1Ref         = useRef<number | null>(null)
  const selectedLineNumRef = useRef<number | null>(null)
  const soundEnabledRef   = useRef(readBool(SKEYS.radarSoundEnabled, true))
  const soundVolumeRef    = useRef(readFloat(SKEYS.radarSoundVolume, 25) / 100)
  const staleRef          = useRef<ReturnType<typeof setTimeout> | null>(null)
  const widgetRef  = useRef<HTMLDivElement>(null)
  const resizeRef  = useRef<HTMLDivElement>(null)

  // Recebe dados do scraper via IPC
  useEffect(() => {
    const off = window.electronAPI.onGameDataUpdate(data => {
      setGameData(data)
      setIsStale(false)
      if (staleRef.current) clearTimeout(staleRef.current)
      staleRef.current = setTimeout(() => setIsStale(true), 10_000)
    })
    const offClosed = window.electronAPI.onBet365Closed(() => setGameData(null))
    return () => { off(); offClosed() }
  }, [])

  // Sincroniza settings globais (alteradas no painel de configurações principal)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SKEYS.radarOpacity)  setOpacity(readFloat(SKEYS.radarOpacity, 1.0))
      if (e.key === SKEYS.radarFontSize) setFontSize(Math.round(readFloat(SKEYS.radarFontSize, 14)))
      if (e.key === SKEYS.radarSoundEnabled) {
        const v = readBool(SKEYS.radarSoundEnabled, true)
        setSoundEnabled(v)
        soundEnabledRef.current = v
      }
      if (e.key === SKEYS.radarSoundVolume) {
        const v = Math.round(readFloat(SKEYS.radarSoundVolume, 25))
        setSoundVolume(v)
        soundVolumeRef.current = v / 100
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Timer de estabilidade da odd — usa chave por linha para não zerar ao trocar de linha
  useEffect(() => {
    const id = setInterval(() => {
      const key   = 'g1-odd-' + selectedLineNumRef.current
      const since = changedAt.current[key]
      if (!since) { setTimerTxt('0:00'); setTimerColor(''); return }
      const s = Math.floor((Date.now() - since) / 1000)
      setTimerTxt(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)
      setTimerColor(s >= 120 ? '#f08030' : s >= 60 ? '#e8c030' : '')
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Rastreia mudanças de odd, dispara flash e detecta direção. Retorna true se houve mudança.
  const trackOdd = useCallback((id: string, newVal: number | null, doFlash = false): boolean => {
    const rounded = newVal != null ? +newVal.toFixed(2) : null
    const isFirst = !(id in prevOdds.current)
    let changed = false
    if (!isFirst && prevOdds.current[id] !== rounded && rounded !== null) {
      changedAt.current[id] = Date.now()
      changed = true
      if (doFlash) { setFlashing(true); setTimeout(() => setFlashing(false), 900) }
    }
    if (isFirst) changedAt.current[id] = Date.now()
    prevOdds.current[id] = rounded
    return changed
  }, [])

  useEffect(() => {
    if (!gameData) return

    const score   = typeof gameData.score === 'number' ? gameData.score : 0
    const target  = score + 0.5
    const lines   = gameData.goals?.lines ?? []
    const start   = Math.max(0, lines.findIndex(l => l.line >= target))
    const avail   = lines.slice(start, start + 3)
    const sel     = avail[selectedLineIdx]
    const g1      = sel?.under ?? null
    const lineNum = sel?.line ?? null

    // Mantém ref do número da linha para o timer interval poder ler sem dependência
    selectedLineNumRef.current = lineNum

    // Seta direcional: compara com o valor anterior
    if (prevG1Ref.current !== null && g1 !== null && g1 !== prevG1Ref.current) {
      setOddDir(g1 > prevG1Ref.current ? 'up' : 'down')
    }
    if (g1 !== null) prevG1Ref.current = g1

    // Chave inclui o número da linha — evita falso "mudança" ao trocar de linha
    const g1Changed = trackOdd('g1-odd-' + lineNum, g1, true)
    if (g1Changed && soundEnabledRef.current) playBeep(soundVolumeRef.current)

    trackOdd('nx1-odd', gameData.nextGoal?.team1.odd ?? null)
    trackOdd('nx2-odd', gameData.nextGoal?.team2.odd ?? null)
  }, [gameData, trackOdd, selectedLineIdx])

  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const next = !prev
      soundEnabledRef.current = next
      writeSetting(SKEYS.radarSoundEnabled, next)
      return next
    })
  }, [])

  // Handle de resize da janela Electron
  useEffect(() => {
    const handle = resizeRef.current
    const widget = widgetRef.current
    if (!handle || !widget) return
    let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0
    const onDown = (e: MouseEvent) => {
      resizing = true; sx = e.clientX; sy = e.clientY
      sw = widget.offsetWidth; sh = widget.offsetHeight
      document.body.style.cursor = 'se-resize'
      e.preventDefault(); e.stopPropagation()
    }
    const onMove = (e: MouseEvent) => {
      if (!resizing) return
      window.electronAPI.resizeWindow(Math.max(200, sw + (e.clientX - sx)), Math.max(150, sh + (e.clientY - sy)))
    }
    const onUp = () => { resizing = false; document.body.style.cursor = '' }
    handle.addEventListener('mousedown', onDown)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      handle.removeEventListener('mousedown', onDown)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 3 linhas disponíveis a partir do score actual
  const availableLines = useMemo(() => {
    if (!gameData?.goals?.lines?.length) return []
    const score  = typeof gameData.score === 'number' ? gameData.score : 0
    const target = score + 0.5
    const lines  = gameData.goals.lines
    const start  = Math.max(0, lines.findIndex(l => l.line >= target))
    return lines.slice(start, start + 3)
  }, [gameData?.goals?.lines, gameData?.score])

  // Reset ao índice 0 quando o score muda (nova linha base)
  const prevAutoLineRef = useRef<number | null>(null)
  useEffect(() => {
    const autoLine = availableLines[0]?.line ?? null
    if (autoLine !== prevAutoLineRef.current) {
      prevAutoLineRef.current = autoLine
      setSelectedLineIdx(0)
      setOddDir(null)
      prevG1Ref.current = null
    }
  }, [availableLines])

  // Derivações baseadas na linha seleccionada
  const selectedLine = availableLines[selectedLineIdx] ?? null
  const g1Under  = selectedLine?.under ?? null
  const g2Under  = availableLines[selectedLineIdx + 1]?.under ?? null  // linha seguinte
  const isHalf   = gameData?.goals?.isHalf ?? false
  const line1Num = selectedLine?.line ?? null
  const adj      = getAdjacentOdds(g1Under)
  const g1Fair   = getFairOdd(g1Under)
  const g2Fair   = getFairOdd(g2Under)
  const nx1Odd   = gameData?.nextGoal?.team1.odd ?? null
  const nx2Odd   = gameData?.nextGoal?.team2.odd ?? null
  const nx1Fair  = getFairOdd(nx1Odd)
  const nx2Fair  = getFairOdd(nx2Odd)
  const isG1Value  = g1Under  != null && g1Fair  != null && g1Under  >= g1Fair
  const isNx1Value = nx1Odd   != null && nx1Fair != null && nx1Odd   >= nx1Fair
  const isNx2Value = nx2Odd   != null && nx2Fair != null && nx2Odd   >= nx2Fair

  // Ticks/minuto — derivada da curva de Poisson: |dO/dt| / 0.01
  const currentMinute = gameData?.time ? (parseInt(gameData.time.split(':')[0]) || 0) : null
  const autoExtraMin  = gameData?.extraTime ? (parseInt(gameData.extraTime.replace('+', '')) || 0) : 0
  const tBase         = isHalf ? 45 : 90
  const minsRem       = currentMinute != null ? Math.max(0.1, tBase + autoExtraMin - currentMinute) : null

  const autoTicks = (g1Fair != null && g1Fair > 1.0 && minsRem != null)
    ? calcTicksPerMin(g1Fair, minsRem) : null

  const simExtraTicks = (() => {
    if (!extraTimeInput || g1Fair == null || g1Fair <= 1.0 || currentMinute == null) return null
    const extra = parseInt(extraTimeInput)
    if (isNaN(extra)) return null
    return calcTicksPerMin(g1Fair, Math.max(0.1, tBase + extra - currentMinute))
  })()

  const simOddTicks = (() => {
    if (!oddSimInput || minsRem == null) return null
    const simOdd = parseFloat(oddSimInput)
    if (isNaN(simOdd) || simOdd <= 1.0) return null
    return calcTicksPerMin(simOdd, minsRem)
  })()

  const statusText = (() => {
    if (!gameData) return ''
    const ts = new Date(gameData.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return isStale ? `⚠ Dados antigos (${ts})` : ts
  })()

  return (
    <div
      ref={widgetRef}
      className={`screen-radar${flashing ? ' rb-flashing' : ''}`}
      style={{ opacity, zoom: fontSize / 12 }}
    >
      <div id="rb-flash-overlay" />

      {/* Topbar — fora do overlay, sempre visível */}
      <div className="radar-topbar rb-drag">
        <button className="gm-back-btn rb-no-drag" onClick={onBack} title="Voltar ao menu">←</button>
        <span className="rb-mkt-tag">{gameData?.goals ? (isHalf ? 'HT' : 'FT') : '—'}</span>

        {/* Selector de linhas — 3 botões clicáveis */}
        <div className="rb-line-btns rb-no-drag">
          {availableLines.length > 0
            ? availableLines.map((l, i) => (
                <button
                  key={l.line}
                  className={`rb-line-btn${selectedLineIdx === i ? ' active' : ''}`}
                  onClick={() => { setSelectedLineIdx(i); setOddDir(null); prevG1Ref.current = null }}
                  title={`Seleccionar linha U${l.line}`}
                >
                  {l.line}
                </button>
              ))
            : <span className="rb-line-tag">—</span>
          }
        </div>

        <span className="rb-topbar-time">{gameData?.time || '--:--'}</span>
        {gameData?.extraTime && <span className="rb-extra-time">{gameData.extraTime}</span>}
        <span className="rb-row-spacer" />
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </div>

      {/* Corpo — overlay de suspensão cobre apenas esta área */}
      <div className="rb-body">
      {gameData?.suspended && <div className="rb-suspended-overlay">🔒</div>}

      {/* Referência do jogo */}
      <div className="radar-game-ref rb-drag">
        <span className="radar-game-teams">{game.team1} × {game.team2}</span>
        <span className="radar-game-meta">{game.league}</span>
      </div>

      {/* Skeleton: aguardando primeiros dados do scraper */}
      {!gameData && (
        <div className="radar-skeleton rb-drag">
          <div className="rb-cards-row">
            <div className="rb-card rb-card-365">
              <div className="sk-line sk-radar-logo" />
              <div className="sk-line sk-radar-adj" />
              <div className="sk-line sk-radar-main" />
              <div className="sk-line sk-radar-adj" />
            </div>
            <div className="rb-card rb-card-bf">
              <div className="sk-line sk-radar-logo" />
              <div className="sk-line sk-radar-adj" />
              <div className="sk-line sk-radar-main" />
              <div className="sk-line sk-radar-adj" />
            </div>
          </div>
          <div className="rb-row rb-row-timer">
            <div className="sk-line sk-radar-timer" />
          </div>
          <div className="rb-row rb-row-nx">
            <div className="sk-line sk-radar-nx" />
          </div>
          <div className="radar-skeleton-msg">Aguardando dados…</div>
        </div>
      )}

      {/* Dados reais */}
      {gameData && <>
        <div className="rb-cards-row rb-drag">
          <div className="rb-card rb-card-365">
            <img className="rb-card-logo" src={logo365} alt="bet365" />
            <span className="rb-card-adj">{adj.above ? fmt(adj.above.mercado) : '—'}</span>
            <span className="rb-card-main">{fmt(g1Under)}</span>
            <span className="rb-card-adj">{adj.below ? fmt(adj.below.mercado) : '—'}</span>
          </div>
          <div className="rb-card rb-card-bf">
            <img className="rb-card-logo" src={logoBF} alt="betfair" />
            <span className="rb-card-adj">{adj.above ? fmt(adj.above.justa) : '—'}</span>
            <div className="rb-card-main-row">
              <span className="rb-card-main" style={{ color: g1Fair ? (isG1Value ? '#00d472' : '') : '' }}>
                {fmt(g1Fair)}
              </span>
              {oddDir && (
                <span className={`rb-odd-arrow ${oddDir === 'up' ? 'rb-odd-up' : 'rb-odd-down'}`}>
                  {oddDir === 'up' ? '▲' : '▼'}
                </span>
              )}
            </div>
            <span className="rb-card-adj">{adj.below ? fmt(adj.below.justa) : '—'}</span>
          </div>
        </div>

        <div className="rb-row rb-row-timer rb-drag">
          <span className="rb-timer-icon" style={{ color: timerColor }}>⊙</span>
          <span className="rb-timer"      style={{ color: timerColor }}>{timerTxt}</span>
        </div>

        <div className="rb-row rb-row-ticks rb-drag">
          <span className="rb-tick-icon">⚡</span>
          <span className="rb-tick-val">{fmtTick(autoTicks)}</span>
          <span className="rb-tick-unit">t/m</span>
          <span className="rb-tick-div" />
          <span className="rb-tick-pfx">+</span>
          <input
            type="number"
            min="0" max="30" step="1"
            value={extraTimeInput}
            onChange={e => setExtraTimeInput(e.target.value)}
            className="rb-tick-inp rb-no-drag"
            placeholder="0"
          />
          <span className="rb-tick-sim">{simExtraTicks != null ? fmtTick(simExtraTicks) : ''}</span>
          <span className="rb-tick-div" />
          <span className="rb-tick-pfx">@</span>
          <input
            type="number"
            min="1.01" step="0.01"
            value={oddSimInput}
            onChange={e => setOddSimInput(e.target.value)}
            className="rb-tick-inp rb-no-drag"
            placeholder="—"
          />
          <span className="rb-tick-sim">{simOddTicks != null ? fmtTick(simOddTicks) : ''}</span>
        </div>

        <div className="rb-row rb-row-nx rb-drag">
          <span className="rb-nx-label">Nx1</span>
          <span className="rb-nx-odd">{fmt(nx1Odd)}</span>
          <span className={`rb-nx-ind${isNx1Value ? ' rb-nx-value' : ''}`}>{nx1Fair ? (isNx1Value ? '▲' : '─') : '●'}</span>
          <span className="rb-nx-spacer" />
          <span className="rb-nx-label">Nx2</span>
          <span className="rb-nx-odd">{fmt(nx2Odd)}</span>
          <span className={`rb-nx-ind${isNx2Value ? ' rb-nx-value' : ''}`}>{nx2Fair ? (isNx2Value ? '▲' : '─') : '●'}</span>
        </div>

        <div className="rb-status">{statusText}</div>
      </>}

      </div>{/* /rb-body */}

      <div ref={resizeRef} id="rb-resize-handle" className="rb-no-drag" />
    </div>
  )
}
