import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileWithMtime } from '../session-scanner-types'

export type SessionDiscoveredFile = {
  file: Omit<FileWithMtime, 'modifiedAt'>
  sidecarPath?: string
}

/** The stat a file was last indexed with; the owner already retains it, so the cache copies nothing. */
export type SessionCommittedStat = {
  mtimeMs: number
  sizeBytes: number | null
  identity: { dev: number; ino: number } | null
}

type DirectoryObservation = { mtimeMs: number; observedAt: number }

type QuietStat = SessionCommittedStat & { sizeBytes: number }

// A directory changed this close to its observation may change again within the same mtime tick.
const DIRECTORY_MTIME_GRANULARITY_MS = 2_000

/**
 * Lets a walk reuse the committed stat of a quiet file. Directory mtimes expose creates, deletes
 * and atomic renames; an in-place write to a quiet file waits for the owner's next complete restat.
 */
export class SessionDiscoveryStatCache {
  /** One baseline per probed directory, which only directories with several quiet files get. */
  private readonly directories = new Map<string, DirectoryObservation>()
  /** Directory observations of the running pass; an unfinished pass must not mark them seen. */
  private readonly pending = new Map<string, DirectoryObservation | null>()
  /** Probed directories unchanged since their baseline; only their files reuse stats this pass. */
  private readonly unchanged = new Set<string>()
  /** Files whose last stat failed or differed from their committed row stay restat until it matches. */
  private readonly unsettled = new Set<string>()
  /** `dev:ino` of files last seen with several links; rows lack link counts, which alias collapsing needs. */
  private readonly linkedInodes = new Set<string>()
  /** Files last modified before this count as quiet. */
  private quietBeforeMs = Number.NEGATIVE_INFINITY
  /** A complete restat records directory baselines without reusing any file stat. */
  private reuse = false

  constructor(private readonly committed: (path: string) => SessionCommittedStat | undefined) {}

  beginPass(quietBeforeMs: number, reuse: boolean): void {
    this.quietBeforeMs = quietBeforeMs
    this.reuse = reuse
    this.unchanged.clear()
    this.pending.clear()
  }

  /** Call only after the pass finished walking; an aborted walk leaves its directories unseen. */
  endPass(): void {
    for (const [path, observation] of this.pending) {
      if (observation) {
        this.directories.set(path, observation)
      } else {
        this.directories.delete(path)
      }
    }
    this.pending.clear()
    this.unchanged.clear()
  }

  /** Probe a directory only when it can save more file stats than the probe costs. */
  wantsDirectoryMtime(path: string, entries: readonly Dirent[]): boolean {
    let quiet = 0
    for (const entry of entries) {
      if (entry.isFile() && this.quietRow(join(path, entry.name)) && ++quiet >= 2) {
        return true
      }
    }
    return false
  }

  /** Call after listing; a null mtime (unprobed or unreadable) leaves the entries to be restat. */
  observeDirectory(path: string, mtimeMs: number | null): void {
    // Directory keys match dirname() of the paths the walk joins under them.
    const key = dirname(join(path, '-'))
    const previous = this.directories.get(key)
    if (mtimeMs === null && !previous) {
      return
    }
    this.pending.set(key, mtimeMs === null ? null : { mtimeMs, observedAt: Date.now() })
    // The granularity guard also covers a change between the listing and this later stat.
    if (
      mtimeMs !== null &&
      previous?.mtimeMs === mtimeMs &&
      previous.observedAt - previous.mtimeMs >= DIRECTORY_MTIME_GRANULARITY_MS
    ) {
      this.unchanged.add(key)
    }
  }

  reusable(path: string): SessionDiscoveredFile | undefined {
    if (!this.reuse || !this.unchanged.has(dirname(path))) {
      return undefined
    }
    const row = this.quietRow(path)
    if (!row) {
      return undefined
    }
    return {
      file: {
        path,
        mtimeMs: row.mtimeMs,
        sizeBytes: row.sizeBytes,
        sidecar: 'none',
        ...(row.identity
          ? {
              dev: row.identity.dev,
              ino: row.identity.ino,
              nlink: this.linkedInodes.has(inodeKey(row.identity.dev, row.identity.ino)) ? 2 : 1
            }
          : {})
      }
    }
  }

  /** Record a fresh stat; null means it failed. */
  observed(path: string, observation: SessionDiscoveredFile | null): void {
    const { dev, ino, nlink } = observation?.file ?? {}
    if (typeof dev === 'number' && typeof ino === 'number') {
      if (typeof nlink === 'number' && nlink > 1) {
        this.linkedInodes.add(inodeKey(dev, ino))
      } else if (this.linkedInodes.size > 0) {
        this.linkedInodes.delete(inodeKey(dev, ino))
      }
    }
    const row = this.committed(path)
    if (!observation || (row && !matchesRow(row, observation.file))) {
      // A deferred read of a changed file must not be skipped by reusing its stale row next pass.
      this.unsettled.add(path)
    } else if (this.unsettled.size > 0) {
      this.unsettled.delete(path)
    }
  }

  private quietRow(path: string): QuietStat | undefined {
    if (this.unsettled.has(path)) {
      return undefined
    }
    const row = this.committed(path)
    return row && isQuiet(row, this.quietBeforeMs) ? row : undefined
  }
}

function inodeKey(dev: number, ino: number): string {
  return `${dev}:${ino}`
}

function isQuiet(row: SessionCommittedStat, quietBeforeMs: number): row is QuietStat {
  return row.sizeBytes !== null && row.mtimeMs < quietBeforeMs
}

function matchesRow(row: SessionCommittedStat, file: SessionDiscoveredFile['file']): boolean {
  return (
    row.mtimeMs === file.mtimeMs &&
    row.sizeBytes === (file.sizeBytes ?? null) &&
    (!row.identity || (row.identity.dev === file.dev && row.identity.ino === file.ino))
  )
}
