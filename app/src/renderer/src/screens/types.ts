// Tipos compartilhados entre telas
// MockGame mantido apenas para compatibilidade de tipo — dados reais vêm do bet365 via LiveGame
export interface MockGame {
  id: number
  team1: string
  team2: string
  league: string
  country: string
  time: string
  score: string
}
