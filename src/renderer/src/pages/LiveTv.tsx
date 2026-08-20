import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { IptvChannel } from '../../../shared/types'
import { formatClockTime } from '../lib/media'
import PosterCard from '../components/PosterCard'
import VirtualGrid from '../components/VirtualGrid'
import SkeletonGrid from '../components/SkeletonGrid'

export default function LiveTv(): JSX.Element {
  const navigate = useNavigate()
  const [channels, setChannels] = useState<IptvChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [showDead, setShowDead] = useState(false)

  const loadChannels = (): void => {
    window.api.iptv.list().then((list) => {
      setChannels(list)
      setLoading(false)
    })
  }

  useEffect(loadChannels, [])

  // A health check can run in the background (after every playlist refresh,
  // or via the "Verify Channels" button in Settings) — refresh the list once
  // it finishes so newly-flagged dead channels drop out of view without the
  // user having to manually reload the page.
  useEffect(() => {
    return window.api.iptv.onHealthProgress((progress) => {
      if (progress.done) loadChannels()
    })
  }, [])

  const deadCount = useMemo(() => channels.filter((c) => c.isDead).length, [channels])

  // group_title is frequently multi-valued (e.g. "Kids;Sports"), so the
  // filter operates on the individual tags, not the raw joined string.
  const categories = useMemo(
    () =>
      [...new Set(channels.flatMap((c) => c.groupTitle?.split(';').filter(Boolean) ?? []))].sort(),
    [channels]
  )

  const visible = useMemo(() => {
    let list = showDead ? channels : channels.filter((c) => !c.isDead)
    if (category) list = list.filter((c) => c.groupTitle?.split(';').includes(category))
    const trimmed = query.trim().toLowerCase()
    if (trimmed) list = list.filter((c) => c.name.toLowerCase().includes(trimmed))
    return list
  }, [channels, category, query, showDead])

  return (
    <div className="page">
      <div className="page-title-row">
        <h1 className="page-title">
          Live TV
          {channels.length > 0 && <span className="page-title-count">{channels.length}</span>}
        </h1>
        {channels.length > 0 && (
          <div className="grid-controls">
            <input
              type="text"
              placeholder="Search channels…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {categories.length > 0 && (
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All Categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            {deadCount > 0 && (
              <label className="grid-controls-checkbox">
                <input
                  type="checkbox"
                  checked={showDead}
                  onChange={(e) => setShowDead(e.target.checked)}
                />
                Show {deadCount} unavailable
              </label>
            )}
          </div>
        )}
      </div>
      {loading ? (
        <SkeletonGrid count={24} />
      ) : channels.length === 0 ? (
        <p className="empty-state-inline">No channels yet. Add an M3U playlist URL in Settings.</p>
      ) : (
        // Full-index IPTV playlists can run into the thousands of channels —
        // virtualized so only the rows near the viewport ever mount.
        <VirtualGrid
          items={visible}
          itemKey={(ch) => ch.id}
          itemWidth={170}
          itemHeight={310}
          columnGap={17.6}
          rowGap={25.6}
          renderItem={(ch) => {
            const progressFraction =
              ch.nowPlayingStartsAt && ch.nowPlayingEndsAt
                ? (Date.now() - new Date(ch.nowPlayingStartsAt).getTime()) /
                  (new Date(ch.nowPlayingEndsAt).getTime() - new Date(ch.nowPlayingStartsAt).getTime())
                : undefined

            return (
              <PosterCard
                title={ch.name}
                posterUrl={ch.logoUrl ?? undefined}
                progressFraction={progressFraction}
                onClick={() => navigate(`/play/live/${ch.id}`)}
                subtitle={
                  ch.nowPlayingTitle ? (
                    <>
                      <div className="live-now-line">
                        <span className="live-dot" />
                        {ch.nowPlayingTitle}
                      </div>
                      {ch.nextProgrammeTitle && (
                        <div className="live-next-line">
                          Next: {ch.nextProgrammeTitle}
                          {ch.nextProgrammeStartsAt &&
                            ` · ${formatClockTime(ch.nextProgrammeStartsAt)}`}
                        </div>
                      )}
                    </>
                  ) : null
                }
              />
            )
          }}
        />
      )}
    </div>
  )
}
