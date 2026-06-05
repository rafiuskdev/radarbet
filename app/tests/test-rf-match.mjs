/**
 * test-rf-match.mjs — valida o matcher de nomes RF × bet365 com dados reais.
 * Reproduz a lógica de scoreRfMatch/nameMatchScore do radarFutebolBridge.ts.
 * Cenário crítico: ~12 jogos Sub-20 brasileiros, quase todos 0-0 no min 41.
 */

const NOISE_TOKENS = new Set([
  'fc','sc','ac','cf','afc','ec','se','sad','aa','as','sd','ad','cd','fk','if','bk','sk','sv',
  'club','clube','de','do','da','dos','das','del','the','el','la','und','am','reserve','reserves','reservas','res','team','ii','iii',
])
function gameCategory(a, b) {
  const s = `${a} ${b}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  let cat = ''
  const age = s.match(/\b(?:u|sub)\s?-?\s?(1[5-9]|2[0-3])\b/)
  if (age) cat += 'u' + age[1]
  if (/\b(women|fem|feminin[oa]|girls|ladies|wsl|\(w\)|\bw\b)\b/.test(s)) cat += 'w'
  if (/\b(reserve|reserves|reservas)\b/.test(s)) cat += 'r'
  return cat
}
const PHRASE_ALIASES = [
  ['estados unidos', 'usa'], ['united states', 'usa'],
  ['coreia do sul', 'southkorea'], ['south korea', 'southkorea'],
  ['paises baixos', 'netherlands'], ['holanda', 'netherlands'],
  ['arabia saudita', 'saudiarabia'], ['saudi arabia', 'saudiarabia'],
]
const TOKEN_ALIASES = {
  alemanha: 'germany', brasil: 'brazil', espanha: 'spain', franca: 'france',
  finlandia: 'finland', hungria: 'hungary', inglaterra: 'england', italia: 'italy',
  noruega: 'norway', polonia: 'poland', turquia: 'turkey', suecia: 'sweden',
  belgica: 'belgium', dinamarca: 'denmark', croacia: 'croatia',
}
function applyPhraseAliases(s) {
  let out = ` ${s} `
  for (const [from, to] of PHRASE_ALIASES) out = out.split(` ${from} `).join(` ${to} `)
  return out.trim()
}
function toTokens(name) {
  const norm = applyPhraseAliases(name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim())
  return norm.split(' ')
    .filter(t => t.length >= 2 && !NOISE_TOKENS.has(t) && !/^(?:u|sub)\d{1,2}$/.test(t) && !/^\d{1,2}$/.test(t))
    .map(t => TOKEN_ALIASES[t] ?? t)
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp
    }
  }
  return dp[b.length]
}
function tokenMatch(t, u) {
  if (t === u) return true
  if (t.length >= 4 && u.length >= 4 && (u.includes(t) || t.includes(u))) return true
  if (Math.max(t.length, u.length) >= 5 && lev(t, u) <= 1) return true
  return false
}
function teamSim(aTok, bTok) {
  if (!aTok.length || !bTok.length) return 0
  const [short, long] = aTok.length <= bTok.length ? [aTok, bTok] : [bTok, aTok]
  let matched = 0
  for (const t of short) if (long.some(u => tokenMatch(t, u))) matched++
  return matched / short.length
}
function nameMatchScore(ev, t1, t2) {
  const a1 = toTokens(t1), a2 = toTokens(t2)
  const c1 = toTokens(ev.timeCasa), c2 = toTokens(ev.timeFora)
  return Math.max(Math.min(teamSim(a1, c1), teamSim(a2, c2)), Math.min(teamSim(a1, c2), teamSim(a2, c1)))
}
const NAME_GATE = 0.5
function scoreRfMatch(ev, t1, t2, score, time) {
  if (gameCategory(t1, t2) !== gameCategory(ev.timeCasa, ev.timeFora)) return -1
  const ns = nameMatchScore(ev, t1, t2)
  if (ns < NAME_GATE) return -1
  let pts = ns * 10
  if (score) { const rf = `${ev.golTimeCasaFt}-${ev.golTimeForaFt}`; pts += rf === score ? 3 : -1 }
  if (time) { const a = parseInt(ev.tempoAtual, 10), b = parseInt(time, 10); if (!isNaN(a) && !isNaN(b) && Math.abs(a-b)<=5) pts += 1.5 }
  return pts
}

// ── Dados reais capturados via SSE (cluster Sub-20) ─────────────────────────────
const mk = (casa, fora, gc, gf, t) => ({ timeCasa: casa, timeFora: fora, golTimeCasaFt: gc, golTimeForaFt: gf, tempoAtual: t, idWilliamhill: `${casa}` })
const sse = [
  mk('Varhaug','Hinna',2,2,"81'"),
  mk('Platense Reserve','Belgrano Reserve',0,0,"41'"),
  mk('Horizonte U20','Atlético Cearense U20',1,1,"41'"),
  mk('Grêmio U20','Novo Hamburgo U20',0,0,"41'"),
  mk('Coimbra FC Porto U20','Minas Boca Futebol U20',0,1,"38'"),
  mk('Itapirense U20','Ferroviária U20',0,0,"41'"),
  mk('Santo André U20','São Paulo U20',0,0,"41'"),
  mk('Mirassol U20','Corinthians U20',0,0,"43'"),
  mk('Novorizontino U20','Desportivo Brasil U20',0,0,"42'"),
  mk('XV de Jaú U20','Mauá U20',0,0,"35'"),
  mk('São Bento U20','União Suzano AC U20',0,0,"41'"),
  mk('Red Bull Bragantino U20','Flamengo de Guarulhos U20',1,0,"43'"),
  mk('Botafogo-SP U20','União São João U20',0,0,"44'"),
  mk('Ituano U20','Audax-SP U20',0,0,"41'"),
  mk('Portuguesa Santista U20','Ponte Preta  U20',1,0,"41'"),
  mk('Referência FC U20','Água Santa U20',0,1,"41'"),
  mk('CA Bandeirante U20','São Caetano U20',1,0,"43'"),
  mk('Jabaquara U20','Portuguesa U20',0,0,"40'"),
  // seleções em inglês (RF) — bet365 manda em PT
  mk('Hungary','Finland',2,0,"59'"),
  mk('Germany','Spain',1,1,"30'"),
  mk('Norway','Sweden',0,0,"59'"),
  mk('South Korea','Japan',0,0,"59'"),
]

// Casos de teste: [bet365 t1, t2, score, time, esperado idWilliamhill (timeCasa esperado)]
const cases = [
  // grafia idêntica
  ['Grêmio U20','Novo Hamburgo U20','0-0','41','Grêmio U20'],
  ['Itapirense U20','Ferroviária U20','0-0','41','Itapirense U20'],
  ['Mirassol U20','Corinthians U20','0-0','43','Mirassol U20'],
  ['Santo André U20','São Paulo U20','0-0','42','Santo André U20'],
  // ordem invertida (bet365 pode trocar casa/fora)
  ['Corinthians U20','Mirassol U20','0-0','43','Mirassol U20'],
  // grafias/abreviações diferentes
  ['Gremio Sub-20','Novo Hamburgo Sub-20','0-0','40','Grêmio U20'],
  ['RB Bragantino U20','Flamengo Guarulhos U20','1-0','43','Red Bull Bragantino U20'],
  ['Botafogo SP U20','Uniao Sao Joao U20','0-0','44','Botafogo-SP U20'],
  // placar levemente desatualizado (bet365 atrasado) — nome deve mandar
  ['Ituano U20','Audax SP U20','0-1','41','Ituano U20'],
  // PT (bet365) → EN (RF): seleções — caso real do log
  ['Hungria','Finlândia','2-0','59','Hungary'],
  ['Alemanha','Espanha','1-1','30','Germany'],
  ['Noruega','Suécia','0-0','59','Norway'],
  // distinguir entre dois 0-0 de seleção no mesmo minuto (Noruega/Suécia vs Coreia/Japão)
  ['Coreia do Sul','Japão','0-0','59','South Korea'],
]

let pass = 0, fail = 0
for (const [t1, t2, score, time, expect] of cases) {
  const ranked = sse.map(ev => ({ ev, pts: scoreRfMatch(ev, t1, t2, score, time) }))
    .filter(c => c.pts > 0).sort((a, b) => b.pts - a.pts)
  const best = ranked[0]
  const ok = best && best.ev.timeCasa === expect
  const runnerUp = ranked[1]
  console.log(`${ok ? '[OK]' : '[X]'} ${t1} x ${t2}`)
  if (best) console.log(`    → ${best.ev.timeCasa}/${best.ev.timeFora} (pts=${best.pts.toFixed(1)})` +
    (runnerUp ? `  | 2º: ${runnerUp.ev.timeCasa} (pts=${runnerUp.pts.toFixed(1)})` : '  | sem 2º'))
  else console.log('    → NENHUM candidato')
  if (ok) pass++; else { fail++; console.log(`    ESPERADO: ${expect}`) }
}
console.log(`\n${pass}/${pass + fail} passaram`)
process.exit(fail ? 1 : 0)
