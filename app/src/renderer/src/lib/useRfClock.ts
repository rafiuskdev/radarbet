import { useState, useEffect, useRef } from 'react'
import type { RfMatchState } from '../electron.d'

interface ClockRef {
  period:   string
  min:      number
  sec:      number
  syncedAt: number
}

function parseClock(clock: string): ClockRef | null {
  // Formato esperado: "1ª Parte - 6:13" ou "2ª Parte - 45:00"
  const m = clock.match(/^(.+?)\s*[-–]\s*(\d+):(\d+)$/)
  if (!m) return null
  return {
    period:   m[1].trim(),
    min:      parseInt(m[2], 10),
    sec:      parseInt(m[3], 10),
    syncedAt: Date.now(),
  }
}

/**
 * Mantém um contador local a partir do último clock recebido do RF,
 * eliminando o delay de polling. Inclui acréscimos da bet365 quando informados.
 */
export function useRfClock(
  matchState: RfMatchState | null,
  extraTime:  string | null,
): string {
  const clockRef    = useRef<ClockRef | null>(null)
  const extraRef    = useRef(extraTime)
  const staticClock = useRef<string>('')
  const [display, setDisplay] = useState('')

  // Mantém ref do extraTime sem recriar o interval
  useEffect(() => { extraRef.current = extraTime }, [extraTime])

  // Sincroniza com o clock do RF sempre que chega um novo estado
  useEffect(() => {
    const raw = matchState?.clock ?? ''
    if (!raw) return
    const parsed = parseClock(raw)
    if (parsed) {
      clockRef.current = parsed
      staticClock.current = ''
    } else {
      // Estado estático: "Intervalo", "Antes do jogo", etc.
      clockRef.current = null
      staticClock.current = raw
      setDisplay(raw)
    }
  }, [matchState?.clock])

  // Contador local — roda uma vez, lê tudo via refs
  useEffect(() => {
    const id = setInterval(() => {
      const ref = clockRef.current
      if (!ref) return  // estado estático — não avança
      const elapsed  = Math.floor((Date.now() - ref.syncedAt) / 1000)
      const total    = ref.min * 60 + ref.sec + elapsed
      const min      = Math.floor(total / 60)
      const sec      = total % 60
      const timeStr  = `${min}:${String(sec).padStart(2, '0')}`
      const extra    = extraRef.current ? ` +${extraRef.current}` : ''
      setDisplay(`${ref.period} - ${timeStr}${extra}`)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return display
}
