import { useState, useEffect, useCallback } from "react"

type Theme = "system" | "light" | "dark"

const STORAGE_KEY = "launchd-ui-theme"
const query = "(prefers-color-scheme: dark)"

function getSystemDark(): boolean {
  return window.matchMedia?.(query).matches ?? false
}

function applyDark(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark)
}

function resolveTheme(theme: Theme): boolean {
  if (theme === "system") return getSystemDark()
  return theme === "dark"
}

/** Follow the system palette unless the operator selects a persistent override. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  })

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
  }, [])

  const cycle = useCallback(() => {
    setThemeState((prev) =>
      prev === "system" ? "dark" : prev === "dark" ? "light" : "system"
    )
  }, [])

  useEffect(() => {
    applyDark(resolveTheme(theme))
    if (theme === "system") {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, theme)
    }

    if (theme !== "system" || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const handler = () => applyDark(getSystemDark())
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [theme])

  return { theme, setTheme, cycle }
}
