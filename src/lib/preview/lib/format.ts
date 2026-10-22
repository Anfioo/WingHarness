export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

export function formatTime(value?: number): string {
  if (!value) return '-'
  return new Date(value * 1000).toLocaleString()
}

export function extensionOf(nameOrPath: string): string {
  const name = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath
  const lowerName = name.toLowerCase()
  for (const compound of ['tar.gz', 'tar.bz2', 'tar.xz']) {
    if (lowerName.endsWith(`.${compound}`)) return compound
  }
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? lowerName.slice(dot + 1) : ''
}
