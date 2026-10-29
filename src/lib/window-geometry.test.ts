import { expect, it } from "vitest"
import { fitWindow } from "./window-geometry"

it("recovers a disconnected monitor position and clamps dimensions to the current work area", () => {
  expect(fitWindow({ x: 8000, y: -3000, width: 9000, height: 5000 }, [{ x: 0, y: 24, width: 1280, height: 776 }])).toEqual({ x: 0, y: 24, width: 1280, height: 776 })
  expect(fitWindow({ x: -1900, y: 40, width: 900, height: 700 }, [{ x: 0, y: 24, width: 1280, height: 776 }, { x: -1920, y: 0, width: 1920, height: 1080 }])?.x).toBe(-1900)
  expect(fitWindow(null, [])).toBeNull()
})

it("selects the monitor with the greatest overlap instead of enumeration order", () => {
  expect(fitWindow({ x: 900, y: 0, width: 900, height: 600 }, [{ x: 0, y: 0, width: 1000, height: 800 }, { x: 1000, y: 0, width: 1000, height: 800 }])?.x).toBe(1000)
})
