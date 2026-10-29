import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { SourceFilter } from "@/types"
import { Search } from "lucide-react"

type SearchBarProps = {
  search: string
  onSearchChange: (value: string) => void
  sourceFilter: SourceFilter
  onSourceFilterChange: (value: SourceFilter) => void
  groupFilter: string
  onGroupFilterChange: (value: string) => void
  groupOptions: string[]
}

const sourceOptions: Array<{ value: SourceFilter; label: string }> = [
  { value: "All", label: "All" },
  { value: "Home", label: "Home" },
  { value: "UserAgent", label: "User" },
  { value: "SystemAgent", label: "System" },
  { value: "SystemDaemon", label: "Daemon" },
]

export function SearchBar({
  search,
  onSearchChange,
  sourceFilter,
  onSourceFilterChange,
  groupFilter,
  onGroupFilterChange,
  groupOptions,
}: SearchBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search agents..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="flex items-center gap-1">
        {sourceOptions.map((option) => (
          <Button
            key={option.value}
            variant={sourceFilter === option.value ? "default" : "outline"}
            size="sm"
            onClick={() => onSourceFilterChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {groupOptions.length > 0 && (
        <select
          value={groupFilter}
          onChange={(e) => onGroupFilterChange(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Filter by group"
        >
          <option value="All">All Groups</option>
          {groupOptions.map((group) => (
            <option key={group} value={group}>
              {group}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
