const ERO_BASE  = 'https://ero.betfair.com/www/sports/exchange/readonly/v1'
const SCAN_URL  = `https://scan-inbf.betfair.com/www/sports/navigation/facet/v1/search?_ak=nzIFcwyWhrlwYMrh&alt=json`
const AK        = 'nzIFcwyWhrlwYMrh'

const FETCH_HEADERS = {
  'Accept':          'application/json',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':         'https://www.betfair.com/',
  'Origin':          'https://www.betfair.com',
  'Accept-Language': 'en-GB,en;q=0.9',
}

const POST_HEADERS = {
  ...FETCH_HEADERS,
  'Content-Type': 'application/json',
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type OddsSnapshot = {
  ts:           number
  back:         number | null
  lay:          number | null
  lastTraded:   number | null
  totalMatched: number | null
}

export type BetfairMarketInfo = {
  marketId:   string
  marketType: string   // "OVER_UNDER_25"
  line:       number   // 2.5
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Mercados de golos — tempo completo
const FT_GOAL_TYPES: Record<string, number> = {
  OVER_UNDER_05: 0.5,
  OVER_UNDER_15: 1.5,
  OVER_UNDER_25: 2.5,
  OVER_UNDER_35: 3.5,
  OVER_UNDER_45: 4.5,
  OVER_UNDER_55: 5.5,
}

// Mercados de golos — primeiro tempo (HT)
const HT_GOAL_TYPES: Record<string, number> = {
  FIRST_HALF_GOALS_05: 0.5,
  FIRST_HALF_GOALS_15: 1.5,
  FIRST_HALF_GOALS_25: 2.5,
  HALF_TIME:           -1,   // resultado HT (1X2) — sem linha numérica
}

// Alias retrocompatível usado noutros sítios do bridge
const GOAL_TYPES = FT_GOAL_TYPES

const MAX_SNAPSHOTS = 500

// ── Polling state ─────────────────────────────────────────────────────────────

const histories = new Map<string, OddsSnapshot[]>()
const pollers   = new Map<string, ReturnType<typeof setInterval>>()

// ── Market discovery ──────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function teamMatchScore(eventName: string, t1: string, t2: string): number {
  const en = normalize(eventName)
  let score = 0
  for (const tok of normalize(t1).split(' ').filter(t => t.length >= 3))
    if (en.includes(tok)) score += 2
  for (const tok of normalize(t2).split(' ').filter(t => t.length >= 3))
    if (en.includes(tok)) score += 2
  return score
}

// ── Helpers para parsear o scan-inbf ─────────────────────────────────────────

function parseScanInbfEvents(data: unknown): Array<{ eventId: number; marketIds: string[] }> {
  const result: Array<{ eventId: number; marketIds: string[] }> = []
  try {
    // Estrutura: facets[0].values[0] (eventType) → .next.values[] (competitions)
    //            → .next.values[] (events) → .next.values[] (markets)
    const compValues = (data as Record<string, unknown>)
      ?.facets?.[(data as Record<string, unknown>)?.facets ? 0 : -1]
    const facets = ((data as Record<string, unknown>)?.facets as unknown[]) ?? []
    const compList = (facets[0] as Record<string, unknown>)
      ?.values?.[(facets[0] as Record<string, unknown>)?.values ? 0 : -1]
    void compValues  // silencia lint
    const topValues = ((facets[0] as Record<string, unknown>)?.values as unknown[]) ?? []
    // topValues[0] = eventType=1 node
    const eventTypeNode = topValues[0] as Record<string, unknown> | undefined
    const compNodes = ((eventTypeNode?.next as Record<string, unknown>)?.values as unknown[]) ?? []

    for (const comp of compNodes) {
      const eventNodes = (((comp as Record<string, unknown>).next as Record<string, unknown>)?.values as unknown[]) ?? []
      for (const ev of eventNodes) {
        const evR     = ev as Record<string, unknown>
        const eventId = (evR.key as Record<string, unknown>)?.eventId as number | undefined
        if (!eventId) continue
        const marketVals = (((evR.next as Record<string, unknown>)?.values) as unknown[]) ?? []
        const marketIds  = marketVals
          .map(m => ((m as Record<string, unknown>).key as Record<string, unknown>)?.marketId as string)
          .filter(Boolean)
        if (marketIds.length) result.push({ eventId, marketIds })
      }
    }
    void compList
  } catch { /* ignore */ }
  return result
}

export async function searchBetfairMarketsForGame(
  team1: string,
  team2: string,
  scoreStr: string,
  isHalf = false
): Promise<{ markets: BetfairMarketInfo[]; defaultLine: number }> {
  const fallback   = { markets: [] as BetfairMarketInfo[], defaultLine: 2.5 }
  const activeTypes = isHalf ? HT_GOAL_TYPES : FT_GOAL_TYPES

  console.log('[betfair:search] ── Iniciando busca ──────────────────────────')
  console.log('[betfair:search] team1:', team1, '| team2:', team2, '| score:', scoreStr, '| isHalf:', isHalf)

  // ── Passo 1: scan-inbf POST → todos os eventIds + marketIds ──────────────

  const scanBody = {
    filter: {
      marketBettingTypes: ['ASIAN_HANDICAP_SINGLE_LINE', 'ASIAN_HANDICAP_DOUBLE_LINE', 'ODDS'],
      productTypes:       ['EXCHANGE'],
      marketTypeCodes:    ['MATCH_ODDS', ...Object.keys(activeTypes)],
      contentGroup:       { language: 'en', regionCode: 'UK' },
      turnInPlayEnabled:  true,
      maxResults:         0,
      selectBy:           'RANK',
      eventTypeIds:       [1],
    },
    facets: [{
      type:       'EVENT_TYPE',
      skipValues: 0,
      maxValues:  1,
      next: {
        type:       'COMPETITION',
        skipValues: 0,
        maxValues:  100,
        next: {
          type:       'EVENT',
          skipValues: 0,
          maxValues:  100,
          next: { type: 'MARKET', maxValues: 10 },
        },
      },
    }],
    currencyCode: 'GBP',
    locale:       'en_GB',
  }

  console.log('[betfair:search] Passo 1: POST scan-inbf...')
  let scanData: unknown
  try {
    const res = await fetch(SCAN_URL, { method: 'POST', headers: POST_HEADERS, body: JSON.stringify(scanBody) })
    console.log('[betfair:search] scan-inbf status:', res.status, res.statusText)
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[betfair:search] scan-inbf erro:', err.slice(0, 300))
      return fallback
    }
    const raw = await res.text()
    console.log('[betfair:search] scan-inbf bytes:', raw.length)
    scanData = JSON.parse(raw)
  } catch (e) {
    console.error('[betfair:search] scan-inbf falhou:', (e as Error).message)
    return fallback
  }

  const events = parseScanInbfEvents(scanData)
  console.log('[betfair:search] Eventos extraídos do scan-inbf:', events.length)
  if (events.length === 0) {
    console.warn('[betfair:search] Nenhum evento — pode ser fora de horário inplay')
    return fallback
  }

  // ── Passo 2: eventTimelines → nomes dos jogos (via placar home/away) ───────
  // Usa eventIds diretamente — URL curta, sem limites de dados

  const allEventIds = events.map(e => String(e.eventId)).join(',')
  const timelinesUrl = `https://ips.betfair.com/inplayservice/v1/eventTimelines?_ak=${AK}&alt=json&locale=en_GB&eventIds=${allEventIds}`
  console.log('[betfair:search] Passo 2: eventTimelines com', events.length, 'eventIds')
  console.log('[betfair:search] URL (primeiros 200):', timelinesUrl.slice(0, 200))

  let timelinesData: unknown[]
  try {
    const res = await fetch(timelinesUrl, { headers: FETCH_HEADERS })
    console.log('[betfair:search] eventTimelines status:', res.status, res.statusText)
    if (!res.ok) {
      console.error('[betfair:search] eventTimelines erro:', (await res.text().catch(() => '')).slice(0, 200))
      return fallback
    }
    const raw = await res.text()
    console.log('[betfair:search] eventTimelines bytes:', raw.length)
    timelinesData = JSON.parse(raw) as unknown[]
    console.log('[betfair:search] eventTimelines eventos recebidos:', timelinesData.length)
  } catch (e) {
    console.error('[betfair:search] eventTimelines falhou:', (e as Error).message)
    return fallback
  }

  // ── Passo 3: match por PLACAR (primário) + nome (tiebreaker) ─────────────
  // bet365 envia nomes em PT ("Noruega"), Betfair em EN ("Norway") — não coincidem.
  // Placar exato (ex: 3-1) é suficiente para identificar o jogo em 99% dos casos.

  const scoreParts  = scoreStr.match(/(\d+)[^\d]+(\d+)/)
  const bet365Home  = scoreParts ? Number(scoreParts[1]) : -1
  const bet365Away  = scoreParts ? Number(scoreParts[2]) : -1
  console.log('[betfair:search] Placar bet365:', bet365Home, '-', bet365Away)

  let bestEventId: number | null = null
  let bestMatchPts = -1

  for (const ev of timelinesData) {
    const e      = ev as Record<string, unknown>
    const sc     = e.score as { home?: { name?: string; score?: string }; away?: { name?: string; score?: string } } | undefined
    const homeName = sc?.home?.name ?? ''
    const awayName = sc?.away?.name ?? ''
    const homeGoals = parseInt(sc?.home?.score ?? '-1', 10)
    const awayGoals = parseInt(sc?.away?.score ?? '-1', 10)

    const scorePts = (homeGoals === bet365Home && awayGoals === bet365Away) ? 4 : 0
    const namePts  = teamMatchScore(`${homeName} v ${awayName}`, team1, team2)
    const total    = scorePts + namePts

    console.log(`[betfair:search]   "${homeName} v ${awayName}"  placar=${homeGoals}-${awayGoals}  scorePts=${scorePts} namePts=${namePts}  id=${e.eventId}`)

    if (total > bestMatchPts) {
      bestMatchPts = total
      bestEventId  = (e.eventId as number | undefined) ?? null
    }
  }

  console.log('[betfair:search] Melhor match pts:', bestMatchPts, '→ eventId:', bestEventId)

  // Aceita se tem pelo menos match de placar (4) OU bom match de nome (≥2)
  if (!bestEventId || bestMatchPts < 2) {
    console.warn('[betfair:search] Jogo não encontrado.')
    return fallback
  }

  // ── Passo 4: buscar marketIds do evento encontrado no scan-inbf ───────────
  // Esses são TODOS os marketIds desse evento (MATCH_ODDS + OVER_UNDER_*)

  const ourEvent = events.find(e => e.eventId === bestEventId)
  if (!ourEvent) {
    console.warn('[betfair:search] eventId', bestEventId, 'não encontrado no scan-inbf')
    return fallback
  }

  console.log('[betfair:search] Passo 4: bymarket (descrição) com', ourEvent.marketIds.length, 'IDs do evento')
  console.log('[betfair:search] marketIds:', ourEvent.marketIds.join(', '))

  const descParams = new URLSearchParams({
    _ak: AK, alt: 'json', currencyCode: 'GBP', locale: 'en_GB',
    marketIds: ourEvent.marketIds.join(','),
    types: 'MARKET_STATE,MARKET_DESCRIPTION',
  })

  let descData: unknown
  try {
    const res = await fetch(`${ERO_BASE}/bymarket?${descParams}`, { headers: FETCH_HEADERS })
    console.log('[betfair:search] bymarket (descrição) status:', res.status, res.statusText)
    if (!res.ok) {
      console.error('[betfair:search] bymarket (descrição) erro:', (await res.text().catch(() => '')).slice(0, 200))
      return fallback
    }
    descData = JSON.parse(await res.text())
  } catch (e) {
    console.error('[betfair:search] bymarket (descrição) falhou:', (e as Error).message)
    return fallback
  }

  // ── Passo 5: filtrar mercados de golos ────────────────────────────────────

  const descNodes = ((descData as Record<string, unknown>)
    ?.eventTypes as { eventNodes?: unknown[] }[])?.[0]?.eventNodes ?? []
  const allMarketNodes = (descNodes as Record<string, unknown>[])
    .flatMap(n => (n.marketNodes as Record<string, unknown>[] | undefined) ?? [])

  console.log('[betfair:search] marketNodes com descrição:', allMarketNodes.length)

  const markets: BetfairMarketInfo[] = []
  for (const m of allMarketNodes) {
    const type = (m.description as { marketType?: string } | undefined)?.marketType ?? ''
    console.log(`[betfair:search]   ${m.marketId}  type=${type || '?'}`)
    if (!(type in activeTypes)) continue
    markets.push({ marketId: m.marketId as string, marketType: type, line: activeTypes[type] })
  }

  markets.sort((a, b) => a.line - b.line)
  console.log('[betfair:search] Mercados de golos:', markets.map(m => `U${m.line}(${m.marketId})`).join('  '))

  const parts      = scoreStr.match(/(\d+)[^\d]+(\d+)/)
  const totalGoals = parts ? Number(parts[1]) + Number(parts[2]) : 0
  const defaultLine = markets.find(m => m.line > totalGoals)?.line ?? markets[0]?.line ?? 2.5
  console.log('[betfair:search] totalGoals:', totalGoals, '→ defaultLine:', defaultLine)
  console.log('[betfair:search] ────────────────────────────────────────────')

  return { markets, defaultLine }
}

// ── Odds fetching ─────────────────────────────────────────────────────────────

function buildOddsUrl(marketId: string): string {
  const p = new URLSearchParams({
    _ak:          AK,
    alt:          'json',
    currencyCode: 'GBP',
    locale:       'en_GB',
    marketIds:    marketId,
    types:        'MARKET_STATE,RUNNER_STATE,RUNNER_EXCHANGE_PRICES_BEST',
  })
  return `${ERO_BASE}/bymarket?${p}`
}

async function fetchOdds(marketId: string): Promise<OddsSnapshot | null> {
  try {
    const res = await fetch(buildOddsUrl(marketId), { headers: FETCH_HEADERS })
    if (!res.ok) return null

    const data    = await res.json() as Record<string, unknown>
    const markets = (
      (data?.eventTypes as { eventNodes: { marketNodes: unknown[] }[] }[])?.[0]
        ?.eventNodes?.[0]
        ?.marketNodes ?? []
    ) as Record<string, unknown>[]

    const market = markets.find(m => m.marketId === marketId) ?? markets[0]
    if (!market) return null

    const runners = ((market.runners as unknown[]) ?? [])
      .slice()
      .sort((a: unknown, b: unknown) => {
        const sa = (a as { state?: { sortPriority?: number } }).state?.sortPriority ?? 0
        const sb = (b as { state?: { sortPriority?: number } }).state?.sortPriority ?? 0
        return sa - sb
      }) as Record<string, unknown>[]

    const under = runners[0]
    if (!under) return null

    const ex = under.exchange as { availableToBack?: { price: number }[]; availableToLay?: { price: number }[] } | undefined
    const st = under.state  as { lastPriceTraded?: number } | undefined
    const ms = market.state as { totalMatched?: number }   | undefined

    return {
      ts:           Date.now(),
      back:         ex?.availableToBack?.[0]?.price ?? null,
      lay:          ex?.availableToLay?.[0]?.price  ?? null,
      lastTraded:   st?.lastPriceTraded ?? null,
      totalMatched: ms?.totalMatched    ?? null,
    }
  } catch {
    return null
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

export function startBetfairPolling(
  marketId:   string,
  pageKey:    string,
  intervalMs: number,
  onUpdate:   (snap: OddsSnapshot) => void
): void {
  stopBetfairPolling(pageKey)
  histories.set(pageKey, [])

  const poll = async (): Promise<void> => {
    const snap = await fetchOdds(marketId)
    if (!snap) return
    const hist = histories.get(pageKey)!
    hist.push(snap)
    if (hist.length > MAX_SNAPSHOTS) hist.splice(0, hist.length - MAX_SNAPSHOTS)
    onUpdate(snap)
  }

  poll()
  pollers.set(pageKey, setInterval(poll, intervalMs))
}

export function stopBetfairPolling(pageKey: string): void {
  const t = pollers.get(pageKey)
  if (t) { clearInterval(t); pollers.delete(pageKey) }
  histories.delete(pageKey)
}

export function getBetfairHistory(pageKey: string): OddsSnapshot[] {
  return histories.get(pageKey) ?? []
}
