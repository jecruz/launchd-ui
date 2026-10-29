import { useState, useEffect, useCallback, useRef } from "react"
import type { JobListEntry, SourceFilter, JobSortKey, SortDirection } from "@/types"
import { listJobs } from "@/lib/invoke"

type UseJobsReturn = {
  jobs: JobListEntry[]
  filteredJobs: JobListEntry[]
  loading: boolean
  error: string | null
  search: string
  setSearch: (value: string) => void
  sourceFilter: SourceFilter
  setSourceFilter: (value: SourceFilter) => void
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
  sourceFilter?: SourceFilter
  groupFilter?: string
  sortKey?: JobSortKey
  sortDirection?: SortDirection
}): UseJobsReturn {
  const [jobs, setJobs] = useState<JobListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState(initialState?.search ?? "")
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(initialState?.sourceFilter ?? "All")
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

  const request = useRef(0)
  const refresh = useCallback(async () => {
    const generation = ++request.current
    setLoading(true)
    setError(null)
    try {
      const result = await listJobs()
      if (generation === request.current) setJobs(result)
    } catch (e) {
      if (generation === request.current) setError(String(e))
    } finally {
      if (generation === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => { request.current += 1 }
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
      sourceFilter === "All" || (sourceFilter === "Home" ? job.is_home_agent : job.source === sourceFilter)
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
