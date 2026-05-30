import { useState, useEffect, useMemo } from 'react'
import type { LiveGame, RfGame } from '../electron.d'

interface Props {
  game: LiveGame | null  // jogo atual do bet365 (para aviso de "não encontrado")
}

function normalize(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}
function fuzzy(hay: string, needle: string): boolean {
  const h = normalize(hay), n = normalize(needle)
  if (h.includes(n) || n.includes(h)) return true
  return n.split(/\s+/).filter(w => w.length >= 3).some(w => h.includes(w))
}
function matchesGame(rfGame: RfGame, bet365: LiveGame): boolean {
  return (fuzzy(rfGame.team1, bet365.team1) || fuzzy(rfGame.team1, bet365.team2))
      && (fuzzy(rfGame.team2, bet365.team1) || fuzzy(rfGame.team2, bet365.team2))
}

export function RfListPanel({ game }: Props) {
  const [rfGames,  setRfGames]  = useState<RfGame[] | null>(null)  // null = carregando
  const [search,   setSearch]   = useState('')
  const [opening,  setOpening]  = useState<string | null>(null)  // chave do jogo a abrir

  useEffect(() => {
    // Carga inicial
    window.electronAPI.getRfGames().then(games => {
      if (games && games.length > 0) setRfGames(games as RfGame[])
      else setRfGames([])
    })
    const off = window.electronAPI.onRfGamesUpdate(games => setRfGames(games as RfGame[]))
    return off
  }, [])

  // Verifica se o jogo bet365 está na lista RF
  const matchFound = useMemo(() => {
    if (!game || !rfGames || rfGames.length === 0) return null
    return rfGames.some(rf => matchesGame(rf, game))
  }, [rfGames, game])

  const filtered = useMemo(() => {
    if (!rfGames) return []
    if (!search)  return rfGames
    const s = normalize(search)
    return rfGames.filter(g => normalize(g.team1).includes(s) || normalize(g.team2).includes(s))
  }, [rfGames, search])

  const handleOpen = async (rfGame: RfGame) => {
    const key = `${rfGame.team1}-${rfGame.team2}`
    setOpening(key)
    await window.electronAPI.openRfGame({ team1: rfGame.team1, team2: rfGame.team2 })
    setOpening(null)
  }

  const isLoading = rfGames === null || rfGames.length === 0

  return (
    <div className="screen-rfl">
      {/* Header */}
      <header className="rfl-header rb-drag">
        <span className="rfl-logo">RADAR<span className="rfl-logo-accent">FUTEBOL</span></span>
        {!isLoading && (
          <span className="rfl-badge">● {rfGames!.length} ao vivo</span>
        )}
        <span className="rb-row-spacer" />
        <button className="rb-btn-switch rb-no-drag" title="Minimizar" onClick={() => window.electronAPI.minimizeWindow()}>−</button>
        <button className="rb-close rb-no-drag" onClick={() => window.close()}>×</button>
      </header>

      {/* Aviso: jogo bet365 não encontrado no RF */}
      {game && rfGames !== null && rfGames.length > 0 && !matchFound && (
        <div className="rfl-warning">
          ⚠ <strong>{game.team1} × {game.team2}</strong> não encontrado no RadarFutebol
        </div>
      )}

      {/* Filtro */}
      {!isLoading && (
        <div className="rfl-filters rb-no-drag">
          <input
            className="dash-search"
            type="text"
            placeholder="Buscar times…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}

      {/* Lista */}
      <div className="rfl-games rb-no-drag">
        {isLoading ? (
          <>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="dash-game-card dash-skeleton-card">
                <div className="dgc-info">
                  <div className="sk-line sk-league" />
                  <div className="sk-line sk-teams" />
                </div>
                <div className="dgc-live">
                  <div className="sk-line sk-score" />
                  <div className="sk-line sk-time" />
                </div>
              </div>
            ))}
          </>
        ) : filtered.length === 0 ? (
          <div className="dash-empty">Nenhum jogo encontrado</div>
        ) : (
          filtered.map((rfGame, i) => {
            const key       = `${rfGame.team1}-${rfGame.team2}`
            const isMatch   = game ? matchesGame(rfGame, game) : false
            const isOpening = opening === key
            return (
              <button
                key={i}
                className={`dash-game-card${isMatch ? ' rfl-card-match' : ''}`}
                onClick={() => handleOpen(rfGame)}
                disabled={isOpening}
              >
                <div className="dgc-info">
                  <span className="dgc-league">{rfGame.league} · {rfGame.country}</span>
                  <span className="dgc-teams">
                    {rfGame.team1} <span className="dgc-vs">×</span> {rfGame.team2}
                  </span>
                </div>
                <div className="dgc-live">
                  <span className="dgc-score">{rfGame.score}</span>
                  <span className="dgc-time">{rfGame.time}</span>
                  {isOpening && <span className="rfl-opening">…</span>}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
