import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

interface VirtualGridProps<T> {
  items: T[]
  itemKey: (item: T) => string | number
  renderItem: (item: T) => ReactNode
  // Must match the real rendered card size/gap in CSS (poster-card width +
  // .grid's gap) — used only to compute how many columns fit per row and
  // how tall each virtual row is, not for the actual visual sizing (each
  // row still lays out with the same grid-template-columns as the
  // non-virtualized `.grid`, so real layout always wins on width).
  itemWidth: number
  itemHeight: number
  columnGap: number
  rowGap: number
}

// Renders `items` as the same auto-fill card grid used everywhere else in
// the app, but only mounts the rows actually near the viewport. Needed once
// a list gets into the thousands of items (e.g. a full-index IPTV playlist)
// — mounting every card at once gets janky well before that.
export default function VirtualGrid<T>({
  items,
  itemKey,
  renderItem,
  itemWidth,
  itemHeight,
  columnGap,
  rowGap
}: VirtualGridProps<T>): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const [columnCount, setColumnCount] = useState(1)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    scrollParentRef.current = el.closest('.app-content')

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (!width) return
      setColumnCount(Math.max(1, Math.floor((width + columnGap) / (itemWidth + columnGap))))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [columnGap, itemWidth])

  const rowCount = Math.ceil(items.length / columnCount)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => itemHeight + rowGap,
    overscan: 4
  })

  const virtualRows = virtualizer.getVirtualItems()

  return (
    <div ref={containerRef} style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const start = virtualRow.index * columnCount
        const rowItems = items.slice(start, start + columnCount)
        return (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="grid"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
              marginBottom: 0
            }}
          >
            {rowItems.map((item) => (
              <div key={itemKey(item)}>{renderItem(item)}</div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
