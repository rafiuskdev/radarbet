import { useState, useCallback, useEffect } from 'react'
import { Login }            from './screens/Login'
import { Dashboard }        from './screens/Dashboard'
import { GameMenu }         from './screens/GameMenu'
import { RadarPanel }       from './screens/RadarPanel'
import { Feature2Panel }    from './screens/Feature2Panel'
import { LancesPanel }      from './screens/LancesPanel'
import { LancesPopupPanel } from './screens/LancesPopupPanel'
import { RfListPanel }      from './screens/RfListPanel'
import type { LiveGame } from './electron.d'
import './App.css'

/**
 * MODE determina o papel desta instância da janela:
 *   null       → janela principal (login → dashboard)
 *   'game'     → menu de funcionalidades do jogo
 *   'radar'    → radar de odds (funcionalidade 1)
 *   'feature2' → funcionalidade 2
 *   (futuras funcionalidades seguem o mesmo padrão)
 */
const MODE = new URLSearchParams(window.location.search).get('mode')

export default function App() {
  const [screen,       setScreen]       = useState<'login' | 'dashboard'>('login')
  const [selectedGame, setSelectedGame] = useState<LiveGame | null>(null)

  useEffect(() => {
    if (MODE === null) {
      window.electronAPI.resizeWindow(380, 520)
      return
    }
    // Janelas de jogo/funcionalidade buscam o jogo atual via IPC
    window.electronAPI.getGameWindowData().then(game => {
      if (game) setSelectedGame(game as LiveGame)
    })
  }, [])

  // Janela de jogo escuta troca de jogo (usuário clicou em outro no dashboard)
  useEffect(() => {
    if (MODE !== 'game') return
    return window.electronAPI.onGameWindowDataUpdated(game => setSelectedGame(game as LiveGame))
  }, [])

  // ── Handlers da janela principal ──────────────────────────────────────────
  const handleLogin = useCallback(() => {
    setScreen('dashboard')
    window.electronAPI.resizeWindow(860, 580)
  }, [])

  const handleSelectGame = useCallback((game: LiveGame) => {
    window.electronAPI.openGameWindow(game)
  }, [])

  // ── Handler da janela de jogo ─────────────────────────────────────────────
  const handleOpenFeature = useCallback((featureId: string) => {
    window.electronAPI.openFeatureWindow(featureId)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────

  if (MODE === 'radar') {
    if (!selectedGame) return <div className="radarbet-root" />
    return <div className="radarbet-root"><RadarPanel game={selectedGame} onBack={() => window.close()} /></div>
  }

  if (MODE === 'feature2') {
    return <div className="radarbet-root"><Feature2Panel onBack={() => window.close()} /></div>
  }

  if (MODE === 'lances') {
    return <div className="radarbet-root"><LancesPanel onBack={() => window.close()} /></div>
  }

  if (MODE === 'lances-popup') {
    return <div className="radarbet-root radarbet-root--popup"><LancesPopupPanel /></div>
  }

  if (MODE === 'game') {
    if (!selectedGame) return <div className="radarbet-root" />
    return <div className="radarbet-root"><GameMenu game={selectedGame} onOpenFeature={handleOpenFeature} /></div>
  }

  return (
    <div className="radarbet-root">
      {screen === 'login'     && <Login onLogin={handleLogin} />}
      {screen === 'dashboard' && <Dashboard onSelectGame={handleSelectGame} />}
    </div>
  )
}
