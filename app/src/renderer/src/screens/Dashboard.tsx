import { useState, useMemo, useEffect } from 'react'
import type { LiveGame } from '../electron.d'

// ─── Skeleton de carregamento ─────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="dash-game-card dash-skeleton-card">
      <div className="dgc-info">
        <div className="sk-line sk-league" />
        <div className="sk-line sk-teams" />
      </div>
      <div className="dgc-live">
        <div className="sk-line sk-score" />
        <div className="sk-line sk-time" />
      </div>
    </div>
  )
}

// ─── Estados do dashboard ─────────────────────────────────────────────────────
// null  → não conectado (bet365 não aberta)
// []    → conectando / aguardando dados
// [...] → jogos carregados

interface Props {
  onSelectGame: (game: LiveGame) => void
}

export function Dashboard({ onSelectGame }: Props) {
  const [liveGames,       setLiveGames]       = useState<LiveGame[] | null>(null)
  const [search,          setSearch]          = useState('')
  const [selectedLeague,  setSelectedLeague]  = useState('all')
  const [selectedCountry, setSelectedCountry] = useState('all')
  // Para adicionar novos filtros: declare mais estados aqui e adicione ao useMemo abaixo

  useEffect(() => {
    // Na carga inicial só sai do estado null se já houver jogos reais
    // (Chrome pode já estar aberto de uma sessão anterior)
    window.electronAPI.getLiveGames().then(games => {
      if (games && games.length > 0) setLiveGames(games)
    })
    const off = window.electronAPI.onLiveGamesUpdate(games => setLiveGames(games))
    return off
  }, [])

  const handleSync = () => {
    setLiveGames([]) // [] = skeleton (conectando)
    window.electronAPI.openBet365()
  }

  const games = liveGames ?? []

  const leagues   = useMemo(() => Array.from(new Set(games.map(g => g.league))).sort(),   [games])
  const countries = useMemo(() => Array.from(new Set(games.map(g => g.country))).sort(), [games])

  const filtered = useMemo(() => games.filter(g => {
    const matchSearch  = !search || [g.team1, g.team2].some(t => t.toLowerCase().includes(search.toLowerCase()))
    const matchLeague  = selectedLeague  === 'all' || g.league  === selectedLeague
    const matchCountry = selectedCountry === 'all' || g.country === selectedCountry
    // Adicione mais condições de filtro aqui seguindo o mesmo padrão
    return matchSearch && matchLeague && matchCountry
  }), [games, search, selectedLeague, selectedCountry])

  const isNotConnected = liveGames === null
  const isLoading      = liveGames !== null && liveGames.length === 0

  return (
    <div className="screen-dashboard">
      {/* Header */}
      <header className="dash-header rb-drag">
        <span className="dash-logo">RADARBET</span>
        {!isNotConnected && (
          <span className={`dash-live-badge${isLoading ? ' dash-live-badge-loading' : ''}`}>
            {isLoading ? 'Sincronizando…' : `● ${games.length} ao vivo`}
          </span>
        )}
        <span className="rb-row-spacer" />
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </header>

      {/* Estado: não conectado → botão central */}
      {isNotConnected && (
        <div className="dash-empty-state rb-no-drag">
          <div className="dash-sync-icon">⚡</div>
          <p className="dash-sync-label">Nenhum jogo carregado</p>
          <p className="dash-sync-sub">Conecte ao bet365 para ver os jogos ao vivo</p>
          <button className="dash-sync-btn" onClick={handleSync}>
            ⟳ Sincronizar Jogos
          </button>
        </div>
      )}

      {/* Estado: conectando → filtros + skeleton */}
      {!isNotConnected && (
        <>
          <div className="dash-filters rb-no-drag">
            <input
              className="dash-search"
              type="text"
              placeholder="Buscar times..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              disabled={isLoading}
            />
            <select className="dash-select" value={selectedLeague} onChange={e => setSelectedLeague(e.target.value)} disabled={isLoading}>
              <option value="all">Todas as ligas</option>
              {leagues.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select className="dash-select" value={selectedCountry} onChange={e => setSelectedCountry(e.target.value)} disabled={isLoading}>
              <option value="all">Todos os países</option>
              {countries.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="dash-games rb-no-drag">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
            ) : filtered.length === 0 ? (
              <div className="dash-empty">Nenhum jogo encontrado</div>
            ) : (
              filtered.map((game, i) => (
                <button key={`${game.team1}-${game.team2}-${i}`} className="dash-game-card" onClick={() => onSelectGame(game)}>
                  <div className="dgc-info">
                    <span className="dgc-league">{game.league} · {game.country}</span>
                    <span className="dgc-teams">
                      {game.team1} <span className="dgc-vs">×</span> {game.team2}
                    </span>
                  </div>
                  <div className="dgc-live">
                    {game.hasStream && <span className="dgc-stream" title="Stream disponível">📺</span>}
                    <span className="dgc-score">{game.score}</span>
                    <span className="dgc-time">{game.time}'</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
