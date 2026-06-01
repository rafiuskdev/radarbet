import type { LiveGame } from '../electron.d'

interface Feature {
  id: string
  icon: string
  title: string
  description: string
}

// Para adicionar novas funcionalidades: insira um novo objeto nesta lista
const FEATURES: Feature[] = [
  {
    id:          'radar',
    icon:        '📡',
    title:       'Radar de Odds',
    description: 'Compare odds ao vivo com o Betfair em tempo real',
  },
  {
    id:          'lances',
    icon:        '⚡',
    title:       'Radar de Lances',
    description: 'Acompanhe ataques e lances ao vivo via radarfutebol',
  },
  {
    id:          'mercado',
    icon:        '📈',
    title:       'Radar de Mercado',
    description: 'Histórico de preços Betfair (back/lay)',
  },
  {
    id:          'feature2',
    icon:        '⬜',
    title:       'Funcionalidade 2',
    description: 'Em desenvolvimento',
  },
]

interface Props {
  game: LiveGame
  onOpenFeature: (featureId: string) => void
}

export function GameMenu({ game, onOpenFeature }: Props) {
  return (
    <div className="screen-game-menu">
      <header className="gm-header rb-drag">
        <div className="gm-game-info">
          <span className="gm-teams">{game.team1} × {game.team2}</span>
          <span className="gm-meta">{game.league} · {game.time}' · {game.score}</span>
        </div>
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </header>

      <div className="gm-body rb-no-drag">
        <p className="gm-section-label">FUNCIONALIDADES DISPONÍVEIS</p>
        <div className="gm-features-grid">
          {FEATURES.map(feat => (
            <button
              key={feat.id}
              className="gm-feature-card"
              onClick={() => onOpenFeature(feat.id)}
            >
              <span className="gm-feat-icon">{feat.icon}</span>
              <span className="gm-feat-title">{feat.title}</span>
              <span className="gm-feat-desc">{feat.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
