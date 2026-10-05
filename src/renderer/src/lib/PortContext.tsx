import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { musicPlayer } from './musicPlayer'
import { bookPlayer } from './bookPlayer'

const PortContext = createContext<number>(0)

export function PortProvider({ children }: { children: ReactNode }): JSX.Element {
  const [port, setPort] = useState(0)

  useEffect(() => {
    window.api.media.serverPort().then((p) => {
      musicPlayer.setPort(p)
      bookPlayer.setPort(p)
      setPort(p)
    })
  }, [])

  if (!port) return <div className="app-loading">Starting MartBox…</div>
  return <PortContext.Provider value={port}>{children}</PortContext.Provider>
}

export function usePort(): number {
  return useContext(PortContext)
}
