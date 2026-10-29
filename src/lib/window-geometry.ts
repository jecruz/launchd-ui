import type { WindowGeometry } from "@/types"

type Area = { x: number; y: number; width: number; height: number }

/** Fit persisted physical geometry into a currently attached monitor's work area. */
export function fitWindow(geometry: WindowGeometry | null, areas: Area[]): WindowGeometry | null {
  const available = areas.filter((area) => Object.values(area).every(Number.isFinite) && area.width > 0 && area.height > 0)
  if (!available.length) return null
  const valid = geometry && Object.values(geometry).every(Number.isFinite) && geometry.width > 0 && geometry.height > 0
  const area = (valid && available.find((area) => geometry.x < area.x + area.width && geometry.x + geometry.width > area.x && geometry.y < area.y + area.height && geometry.y + geometry.height > area.y)) || available[0]
  const width = Math.min(area.width, Math.max(640, valid ? geometry.width : 1200))
  const height = Math.min(area.height, Math.max(480, valid ? geometry.height : 940))
  return {
    width: Math.round(width), height: Math.round(height),
    x: Math.round(Math.max(area.x, Math.min(valid ? geometry.x : area.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(valid ? geometry.y : area.y, area.y + area.height - height))),
  }
}
