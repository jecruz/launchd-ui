import { useState, useEffect, useCallback } from "react"
import type { JobListEntry, JobSource, JobSortKey, SortDirection } from "@/types"
import { listJobs } from "@/lib/invoke"

type UseJobsReturn = {
  jobs: JobListEntry[]
  filteredJobs: JobListEntry[]
  loading: boolean
  error: string | null
  search: string
  setSearch: (value: string) => void
  sourceFilter: JobSource | "All"
  setSourceFilter: (value: JobSource | "All") => void
  groupFilter: string
  setGroupFilter: (value: string) => void
  sortKey: JobSortKey
  setSortKey: (value: JobSortKey) => void
  sortDirection: SortDirection
  setSortDirection: (value: SortDirection) => void
  refresh: () => Promise<void>
}

export function useJobs(initialState?: {
  search?: string
  sourceFilter?: JobSource | "All"
  groupFilter?: string
  sortKey?: JobSortKey
  sortDirection?: SortDirection
}): UseJobsReturn {
  const [jobs, setJobs] = useState<JobListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState(initialState?.search ?? "")
  const [sourceFilter, setSourceFilter] = useState<JobSource | "All">(initialState?.sourceFilter ?? "All")
  const [groupFilter, setGroupFilter] = useState(initialState?.groupFilter ?? "All")
  const [sortKey, setSortKey] = useState<JobSortKey>(initialState?.sortKey ?? "health")
  const [sortDirection, setSortDirection] = useState<SortDirection>(initialState?.sortDirection ?? "asc")

  useEffect(() => {
    if (initialState?.search !== undefined) {
      setSearch(initialState.search)
    }
    if (initialState?.sourceFilter !== undefined) {
      setSourceFilter(initialState.sourceFilter)
    }
    if (initialState?.groupFilter !== undefined) {
      setGroupFilter(initialState.groupFilter)
    }
    if (initialState?.sortKey !== undefined) {
      setSortKey(initialState.sortKey)
    }
    if (initialState?.sortDirection !== undefined) {
      setSortDirection(initialState.sortDirection)
    }
  }, [
    initialState?.search,
    initialState?.sourceFilter,
    initialState?.groupFilter,
    initialState?.sortDirection,
    initialState?.sortKey,
  ])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await listJobs()
      setJobs(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const filteredJobs = jobs.filter((job) => {
    const matchesSearch =
      search === "" ||
      job.label.toLowerCase().includes(search.toLowerCase()) ||
      (job.metadata.group ?? "").toLowerCase().includes(search.toLowerCase()) ||
      job.metadata.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase())) ||
      (job.metadata.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (job.metadata.template ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (job.metadata.health_check_url ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (job.metadata.health_check_command ?? "").toLowerCase().includes(search.toLowerCase()) ||
      job.metadata.ports.some((port) => String(port).includes(search.toLowerCase()))
    const matchesSource =
      sourceFilter === "All" || job.source === sourceFilter
    const matchesGroup =
      groupFilter === "All" || (job.metadata.group ?? "Ungrouped") === groupFilter
    return matchesSearch && matchesSource && matchesGroup
  })

  return {
    jobs,
    filteredJobs,
    loading,
    error,
    search,
    setSearch,
    sourceFilter,
    setSourceFilter,
    groupFilter,
    setGroupFilter,
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,
    refresh,
  }
}
