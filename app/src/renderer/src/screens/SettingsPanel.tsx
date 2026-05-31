import { useState } from 'react'
import { SKEYS, readFloat, readBool, readStr, writeSetting } from '../lib/settings'

const LANCES_LINE_OPTS = ['3', '5', '10', 'all'] as const
const POPUP_LINE_OPTS  = ['1', '2', '3', '5']    as const

type LancesLine = typeof LANCES_LINE_OPTS[number]
type PopupLine  = typeof POPUP_LINE_OPTS[number]

interface Props {
  onBack: () => void
}

export function SettingsPanel({ onBack }: Props) {
  // Radar de Odds
  const [radarOpacity,      setRadarOpacity]      = useState(() => Math.round(readFloat(SKEYS.radarOpacity,  1.0) * 100))
  const [radarFontSize,     setRadarFontSize]     = useState(() => Math.round(readFloat(SKEYS.radarFontSize, 14)))
  const [radarSoundEnabled, setRadarSoundEnabled] = useState(() => readBool(SKEYS.radarSoundEnabled, true))
  const [radarSoundVolume,  setRadarSoundVolume]  = useState(() => Math.round(readFloat(SKEYS.radarSoundVolume, 25)))

  // Radar de Lances
  const [lancesOpacity,   setLancesOpacity]   = useState(() => Math.round(readFloat(SKEYS.lancesOpacity,  1.0) * 100))
  const [lancesFontSize,  setLancesFontSize]  = useState(() => Math.round(readFloat(SKEYS.lancesFontSize, 14)))
  const [lancesLineCount, setLancesLineCount] = useState<LancesLine>(() => readStr(SKEYS.lancesLineCount, '10', LANCES_LINE_OPTS))

  // Popup de Lances
  const [popupLines,     setPopupLines]     = useState<PopupLine>(() => readStr(SKEYS.popupLines, '3', POPUP_LINE_OPTS))
  const [popupBgOpacity, setPopupBgOpacity] = useState(() => Math.round(readFloat(SKEYS.popupBgOpacity, 0.92) * 100))

  return (
    <div className="settings-panel">
      <header className="settings-header rb-drag">
        <button className="gm-back-btn rb-no-drag" onClick={onBack}>←</button>
        <span className="settings-title">Configurações</span>
      </header>

      <div className="settings-body rb-no-drag">

        {/* ── Radar de Odds ────────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">Radar de Odds</div>

          <div className="rsp-row">
            <span className="rsp-label">Opacidade</span>
            <span className="rsp-val">{radarOpacity}%</span>
            <input className="rsp-slider" type="range" min="10" max="100" step="5"
              value={radarOpacity}
              onChange={e => { const v = +e.target.value; setRadarOpacity(v); writeSetting(SKEYS.radarOpacity, v / 100) }}
            />
          </div>

          <div className="rsp-row">
            <span className="rsp-label">Fonte</span>
            <span className="rsp-val">{radarFontSize}px</span>
            <input className="rsp-slider" type="range" min="9" max="18" step="1"
              value={radarFontSize}
              onChange={e => { const v = +e.target.value; setRadarFontSize(v); writeSetting(SKEYS.radarFontSize, v) }}
            />
          </div>

          <div className="rsp-row">
            <span className="rsp-label">Alertas</span>
            <button
              className={`rb-btn-switch rb-no-drag${radarSoundEnabled ? ' rb-btn-active' : ''}`}
              style={{ marginLeft: 'auto' }}
              onClick={() => { const v = !radarSoundEnabled; setRadarSoundEnabled(v); writeSetting(SKEYS.radarSoundEnabled, v) }}
            >
              {radarSoundEnabled ? '♪ On' : '♪ Off'}
            </button>
          </div>

          <div className="rsp-row">
            <span className="rsp-label">Volume</span>
            <span className="rsp-val">{radarSoundVolume}%</span>
            <input className="rsp-slider" type="range" min="5" max="100" step="5"
              value={radarSoundVolume}
              onChange={e => { const v = +e.target.value; setRadarSoundVolume(v); writeSetting(SKEYS.radarSoundVolume, v) }}
            />
          </div>
        </div>

        {/* ── Radar de Lances ──────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">Radar de Lances</div>

          <div className="rsp-row">
            <span className="rsp-label">Opacidade</span>
            <span className="rsp-val">{lancesOpacity}%</span>
            <input className="rsp-slider" type="range" min="10" max="100" step="5"
              value={lancesOpacity}
              onChange={e => { const v = +e.target.value; setLancesOpacity(v); writeSetting(SKEYS.lancesOpacity, v / 100) }}
            />
          </div>

          <div className="rsp-row">
            <span className="rsp-label">Fonte</span>
            <span className="rsp-val">{lancesFontSize}px</span>
            <input className="rsp-slider" type="range" min="9" max="18" step="1"
              value={lancesFontSize}
              onChange={e => { const v = +e.target.value; setLancesFontSize(v); writeSetting(SKEYS.lancesFontSize, v) }}
            />
          </div>

          <div className="rsp-row">
            <span className="rsp-label">Linhas</span>
            <div className="lances-line-opts" style={{ flex: 1 }}>
              {LANCES_LINE_OPTS.map(opt => (
                <button
                  key={opt}
                  className={`lances-line-btn${lancesLineCount === opt ? ' active' : ''}`}
                  onClick={() => { setLancesLineCount(opt); writeSetting(SKEYS.lancesLineCount, opt) }}
                >
                  {opt === 'all' ? 'Todas' : opt}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Popup de Lances ──────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">Popup de Lances</div>

          <div className="rsp-row">
            <span className="rsp-label">Linhas</span>
            <div className="lances-line-opts" style={{ flex: 1 }}>
              {POPUP_LINE_OPTS.map(opt => (
                <button
                  key={opt}
                  className={`lances-line-btn${popupLines === opt ? ' active' : ''}`}
                  onClick={() => { setPopupLines(opt); writeSetting(SKEYS.popupLines, opt) }}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          <div className="rsp-row">
            <span className="rsp-label">BG Fundo</span>
            <span className="rsp-val">{popupBgOpacity}%</span>
            <input className="rsp-slider" type="range" min="10" max="100" step="5"
              value={popupBgOpacity}
              onChange={e => { const v = +e.target.value; setPopupBgOpacity(v); writeSetting(SKEYS.popupBgOpacity, v / 100) }}
            />
          </div>
        </div>

      </div>
    </div>
  )
}
