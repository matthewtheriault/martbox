import { useState } from 'react'

interface ServerModeChooserProps {
  onHostLocally: () => void
  onConnected: () => void
}

// Shown once, on a truly first run (no local profiles yet, remote access
// still off) — before any profile exists at all. Deciding host-vs-join here
// means a client never creates a throwaway local profile that would
// trivially become "admin" just for being first in an empty local database;
// admin status only ever comes from whichever profile is genuinely first on
// the real server, local or remote.
export default function ServerModeChooser({
  onHostLocally,
  onConnected
}: ServerModeChooserProps): JSX.Element {
  const [joining, setJoining] = useState(false)
  const [code, setCode] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async (): Promise<void> => {
    setError(null)
    setConnecting(true)
    try {
      await window.api.remoteAccess.connectClient(code.trim())
      onConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That invite code did not work')
    } finally {
      setConnecting(false)
    }
  }

  if (joining) {
    return (
      <div className="profile-picker">
        <h1 className="profile-picker-title">Join a friend&apos;s server</h1>
        <div className="profile-picker-form">
          <input
            type="text"
            placeholder="Paste invite code"
            value={code}
            autoFocus
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect()}
          />
          {error && <p className="settings-status-error">{error}</p>}
          <div className="profile-picker-form-actions">
            <button className="btn-primary" onClick={connect} disabled={connecting || !code.trim()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
            <button className="btn-secondary" onClick={() => setJoining(false)} disabled={connecting}>
              Back
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="profile-picker">
      <h1 className="profile-picker-title">Welcome to MartBox</h1>
      <p className="settings-hint">Is this your media server, or are you joining a friend&apos;s?</p>
      <div className="profile-picker-form-actions">
        <button className="btn-primary" onClick={onHostLocally}>
          This is my server
        </button>
        <button className="btn-secondary" onClick={() => setJoining(true)}>
          Join a friend&apos;s server
        </button>
      </div>
    </div>
  )
}
