export interface GameData {
  time: string | null
  extraTime: string | null
  suspended: boolean
  score: number | null
  goals: {
    label: string
    isHalf: boolean
    lines: Array<{ line: number; over: number | null; under: number | null }>
  } | null
  nextGoal: {
    team1:  { name: string; odd: number }
    noGoal: { name: string; odd: number }
    team2:  { name: string; odd: number }
  } | null
  updatedAt: number
}

export interface Game {
  winId: number
  data: GameData
}

export interface MockGame {
  id: number
  team1: string
  team2: string
  league: string
  country: string
  time: string
  score: string
}

export interface LiveGame {
  team1: string
  team2: string
  league: string
  country: string
  time: string
  score: string
  odds: { home: number | null; draw: number | null; away: number | null }
  hasStream: boolean
}

export interface LanceEvent {
  minute:   string
  seconds:  string
  iconType: string
  text:     string
}

export interface RfMatchState {
  events:   LanceEvent[]
  score:    string
  homeTeam: string
  awayTeam: string
  clock:    string
}

export interface RfGame {
  team1:   string
  team2:   string
  time:    string
  score:   string
  league:  string
  country: string
}

export interface GameTime {
  time:      string | null
  extraTime: string | null
}

export interface OddsSnapshot {
  ts:           number
  back:         number | null
  lay:          number | null
  lastTraded:   number | null
  totalMatched: number | null
}

export interface BetfairMarketInfo {
  marketId:   string
  marketType: string
  line:       number
}

declare global {
  interface Window {
    electronAPI: {
      onGameDataUpdate:        (cb: (data: GameData) => void) => () => void
      onGameTimeUpdate:        (cb: (data: GameTime) => void) => () => void
      onBet365Closed:          (cb: () => void)              => () => void
      onGameWindowDataUpdated: (cb: (game: MockGame) => void) => () => void
      getBet365Games:          () => Promise<{ games: Game[] }>
      openBet365:              (teams?: { team1: string; team2: string }) => Promise<{ ok: boolean }>
      focusBet365:             () => Promise<{ ok: boolean }>
      resizeWindow:            (w: number, h: number) => Promise<void>
      openGameWindow:          (game: MockGame) => Promise<{ ok: boolean }>
      getGameWindowData:       () => Promise<MockGame | null>
      openFeatureWindow:       (featureId: string) => Promise<{ ok: boolean }>
      getLiveGames:            () => Promise<LiveGame[]>
      onLiveGamesUpdate:       (cb: (games: LiveGame[]) => void) => () => void
      minimizeWindow:          () => Promise<void>
      showWindow:              () => Promise<void>
      showGameWindow:          () => Promise<void>
      showFeatureWindow:       (featureId: string) => Promise<void>
      onRfMatchUpdate:   (cb: (state: RfMatchState) => void) => () => void
      onRfGameNotFound:  (cb: (reason: 'not-found' | 'no-radar') => void) => () => void
      onRfGameChanged:   (cb: () => void) => () => void
      onRfExtraTime:     (cb: (v: string | null) => void) => () => void
      getRfGames:       () => Promise<RfGame[]>
      onRfGamesUpdate:  (cb: (games: RfGame[]) => void) => () => void
      openRfGame:       (rfGame: { team1: string; team2: string }) => Promise<{ ok: boolean; error?: string; gameKey?: string }>
      onBetfairUpdate:      (cb: (snap: OddsSnapshot) => void) => () => void
      betfairSearchMarkets: (team1: string, team2: string, score: string, isHalf: boolean) => Promise<{ markets: BetfairMarketInfo[]; defaultLine: number }>
      betfairStartPolling:  (marketId: string, intervalMs: number) => Promise<{ ok: boolean }>
      betfairStopPolling:   () => Promise<void>
      betfairGetHistory:    () => Promise<OddsSnapshot[]>
    }
  }
}
