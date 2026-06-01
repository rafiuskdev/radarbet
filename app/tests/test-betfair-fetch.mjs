/**
 * test-betfair-fetch.mjs
 *
 * Faz fetch directo ao endpoint ero.betfair.com descoberto no intercept,
 * usando o _ak público do frontend da Betfair.
 * Mostra a estrutura completa de runners/odds do mercado.
 *
 * Uso: node test-betfair-fetch.mjs [marketId]
 */

import { writeFileSync } from 'fs'

const MARKET_ID = process.argv[2] ?? '1.258772506'
const OUT_FILE  = `./betfair-fetch-${MARKET_ID.replace(/\./g, '_')}.json`
const AK        = 'nzIFcwyWhrlwYMrh'  // app key pública do frontend betfair.com
const URL_BASE  = 'https://ero.betfair.com/www/sports/exchange/readonly/v1/bymarket'

const params = new URLSearchParams({
  _ak:          AK,
  alt:          'json',
  currencyCode: 'GBP',
  locale:       'en_GB',
  marketIds:    MARKET_ID,
  rollupModel:  'STAKE',
  types:        'MARKET_STATE,RUNNER_STATE,RUNNER_EXCHANGE_PRICES_BEST,MARKET_RATES,RUNNER_METADATA',
})

const url = `${URL_BASE}?${params}`

console.log('[fetch] URL:', url)
console.log('[fetch] Fazendo pedido...\n')

try {
  const res = await fetch(url, {
    headers: {
      'Accept':          'application/json',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer':         `https://www.betfair.com/exchange/plus/football/market/${MARKET_ID}`,
      'Origin':          'https://www.betfair.com',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  })

  console.log('[fetch] Status:', res.status, res.statusText)
  console.log('[fetch] Content-Type:', res.headers.get('content-type'))

  const data = await res.json()
  writeFileSync(OUT_FILE, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`\n[fetch] Resposta completa salva em: ${OUT_FILE}`)

  // Extrair e resumir runners com odds
  console.log('\n' + '═'.repeat(60))
  console.log(' RESUMO — Runners e odds')
  console.log('═'.repeat(60))

  const markets = data?.eventTypes?.[0]?.eventNodes?.[0]?.marketNodes ?? []
  if (markets.length === 0) {
    console.log('⚠  Nenhum marketNode encontrado — estrutura diferente.')
    console.log('Keys na raiz:', Object.keys(data))
  }

  for (const m of markets) {
    console.log(`\nMercado: ${m.marketId}`)
    console.log(`  inplay:       ${m.state?.inplay}`)
    console.log(`  delayed data: ${m.isMarketDataDelayed}`)
    console.log(`  runners (${m.runners?.length ?? 0}):`)

    for (const r of m.runners ?? []) {
      console.log(`\n  Runner: ${r.runnerName ?? r.selectionId}  (id=${r.selectionId})`)
      console.log(`    lastPriceTraded : ${r.lastPriceTraded ?? 'n/a'}`)
      console.log(`    totalMatched    : ${r.totalMatched ?? 'n/a'}`)
      const back = r.ex?.availableToBack ?? []
      const lay  = r.ex?.availableToLay  ?? []
      console.log(`    Back (top 3)    :`, back.slice(0, 3).map(p => `${p.price}@£${p.size?.toFixed(0)}`).join('  '))
      console.log(`    Lay  (top 3)    :`, lay.slice(0, 3).map(p => `${p.price}@£${p.size?.toFixed(0)}`).join('  '))
    }
  }
} catch (e) {
  console.error('[fetch] Erro:', e.message)
}
