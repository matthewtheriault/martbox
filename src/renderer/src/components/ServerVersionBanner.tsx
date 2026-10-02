import { useEffect, useState } from 'react'
import type { ServerCompatibility } from '../../../shared/remoteAccess'

// Client mode only: when this app and the host speak different API
// versions, say which side to update instead of letting screens fail one
// request at a time. Re-checked whenever the tunnel (re)connects.
export default function ServerVersionBanner(): JSX.Element | null {
  const [compat, setCompat] = useState<ServerCompatibility | null>(null)

  useEffect(() => {
    const check = (): void => {
      window.api.remoteAccess
        .serverCompatibility()
        .then(setCompat)
        .catch(() => setCompat(null))
    }
    check()
    return window.api.remoteAccess.onStatus((status) => {
      if (status.status === 'connected') check()
    })
  }, [])

  if (!compat || compat.compatible) return null

  return (
    <div className="server-version-banner" role="alert">
      {compat.needsUpdate === 'server'
        ? `The server is running ${
            compat.server ? `MartBox ${compat.server.appVersion}` : 'an older MartBox'
          }, which is too old for this app. Ask the server owner to update it.`
        : `This app is older than the server (MartBox ${compat.server?.appVersion}). Update this app from Settings → App Updates.`}
    </div>
  )
}
