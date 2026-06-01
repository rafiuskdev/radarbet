export const SKEYS = {
  radarOpacity:      'rb.radar.opacity',
  radarFontSize:     'rb.radar.fontSize',
  radarSoundEnabled: 'rb.radar.soundEnabled',
  radarSoundVolume:  'rb.radar.soundVolume',
  lancesOpacity:     'rb.lances.opacity',
  lancesFontSize:    'rb.lances.fontSize',
  lancesLineCount:   'rb.lances.lineCount',
  popupLines:        'rb.popup.lines',
  popupBgOpacity:    'rb.popup.bgOpacity',
  bet365Region:      'rb.bet365.region',
} as const

export function readFloat(key: string, def: number): number {
  const v = localStorage.getItem(key)
  if (v === null) return def
  const n = parseFloat(v)
  return isNaN(n) ? def : n
}

export function readBool(key: string, def: boolean): boolean {
  const v = localStorage.getItem(key)
  if (v === null) return def
  return v === 'true'
}

export function readStr<T extends string>(key: string, def: T, valid: readonly T[]): T {
  const v = localStorage.getItem(key) as T | null
  if (!v || !valid.includes(v)) return def
  return v
}

export function writeSetting(key: string, value: string | number | boolean): void {
  localStorage.setItem(key, String(value))
}
