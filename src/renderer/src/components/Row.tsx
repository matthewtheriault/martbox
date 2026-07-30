import type { ReactNode } from 'react'

export default function Row({
  title,
  children,
  empty
}: {
  title: string
  children: ReactNode
  empty?: string
}): JSX.Element | null {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children
  if (!hasChildren && !empty) return null
  return (
    <section className="row">
      <h2 className="row-title">{title}</h2>
      {hasChildren ? (
        <div className="row-scroller">{children}</div>
      ) : (
        <div className="row-empty">{empty}</div>
      )}
    </section>
  )
}
