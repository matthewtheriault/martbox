import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const PortContext = createContext<number>(0)

export function PortProvider({ children }: { children: ReactNode }): JSX.Element {
  const [port, setPort] = useState(0)

  useEffect(() => {
    window.api.media.serverPort().then(setPort)
  }, [])

  if (!port) return <div className="app-loading">Starting MartBox…</div>
  return <PortContext.Provider value={port}>{children}</PortContext.Provider>
}

export function usePort(): number {
  return useContext(PortContext)
}
