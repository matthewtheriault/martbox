import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Profile } from '../../../shared/types'
import type { RemoteAccessMode, RemoteAccessStatus } from '../../../shared/remoteAccess'
import ProfilePicker from '../components/ProfilePicker'
import ServerModeChooser from '../components/ServerModeChooser'

interface ProfileContextValue {
  activeProfile: Profile
  switchProfile: () => void
  isHost: boolean
  // The PIN that unlocked activeProfile, if it has one — held only in
  // memory, never persisted. Threaded into progress reads/writes so a
  // remote host can verify the caller actually unlocked this profile,
  // rather than trusting whatever profileId a request claims.
  profilePin: string | null
}

const ProfileContext = createContext<ProfileContextValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }): JSX.Element {
  const [remoteMode, setRemoteMode] = useState<RemoteAccessMode | null>(null)
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)
  const [activePin, setActivePin] = useState<string | null>(null)
  // Local-only for this session: true once the user has picked "this is my
  // server" this run. Not persisted — once they've actually created a local
  // profile (or connected as a client), that fact alone is enough to skip
  // the chooser on the next launch, so no separate setting is needed.
  const [roleChosen, setRoleChosen] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus>({ status: 'idle' })
  // A sidecar error is terminal for the current connection attempt (bad/
  // expired invite, host unreachable, etc.) — retrying the profiles fetch
  // forever in that case would just silently spin rather than let the user
  // know something is actually wrong. Ref because refreshProfiles's retry
  // closure needs the latest value without re-subscribing to status.
  const givenUp = useRef(false)

  // Joining a friend's server kicks off the Tailscale sidecar connection
  // without waiting for it (connectClient resolves immediately), so this can
  // fire before the sidecar has a local port to forward through yet and
  // throw "Not connected to a host yet". That's transient on a normal
  // connection (a slower machine/network just takes longer) — retry instead
  // of leaving profiles null forever with the loading screen giving no sign
  // of what's actually happening.
  const refreshProfiles = (): void => {
    window.api.profiles.list().then(setProfiles).catch(() => {
      if (!givenUp.current) setTimeout(refreshProfiles, 1000)
    })
  }

  useEffect(() => {
    window.api.settings.get().then((s) => setRemoteMode(s.remoteAccessMode))
  }, [])

  useEffect(() => {
    if (remoteMode !== 'client') return
    window.api.remoteAccess.getStatus().then(setRemoteStatus)
    return window.api.remoteAccess.onStatus((status) => {
      setRemoteStatus(status)
      if (status.status === 'error') givenUp.current = true
    })
  }, [remoteMode])

  useEffect(() => {
    if (remoteMode !== null) refreshProfiles()
  }, [remoteMode])

  // Bails all the way back out to the host-vs-join choice — the only way out
  // of a connection that's never going to succeed (bad/expired invite, host
  // offline) since Settings itself is unreachable without a profile yet.
  const abortConnect = (): void => {
    givenUp.current = false
    setRemoteStatus({ status: 'idle' })
    setRemoteMode('off')
    setRoleChosen(false)
    setProfiles(null)
    window.api.remoteAccess.disable()
  }

  if (remoteMode === null || profiles === null) {
    const stuck = remoteMode === 'client' && (remoteStatus.status === 'error' || givenUp.current)
    return (
      <div className="app-loading">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div>{stuck ? (remoteStatus.message ?? 'Could not connect to that server.') : 'Starting MartBox…'}</div>
          {remoteMode === 'client' && !stuck && remoteStatus.status !== 'idle' && (
            <div className="settings-hint">Connecting to host… ({remoteStatus.status})</div>
          )}
          {remoteMode === 'client' && (
            <button className="btn-secondary" onClick={abortConnect}>
              Cancel
            </button>
          )}
        </div>
      </div>
    )
  }

  // First run only: remote access has never been configured and there's no
  // local profile yet. Resolve host-vs-join before any profile picker shows,
  // so a client joining a friend's server is never funneled through creating
  // a throwaway local profile first (which would trivially become "admin"
  // just for being first in an empty local database).
  if (remoteMode === 'off' && profiles.length === 0 && !roleChosen) {
    return (
      <ServerModeChooser
        onHostLocally={() => setRoleChosen(true)}
        onConnected={() => {
          setRemoteMode('client')
          setRoleChosen(true)
        }}
      />
    )
  }

  if (!activeProfile) {
    return (
      <ProfilePicker
        profiles={profiles}
        onSelect={(profile, pin) => {
          setActiveProfile(profile)
          setActivePin(pin ?? null)
        }}
        onProfilesChanged={refreshProfiles}
      />
    )
  }

  return (
    <ProfileContext.Provider
      value={{
        activeProfile,
        switchProfile: () => {
          setActiveProfile(null)
          setActivePin(null)
        },
        // 'off' (not sharing yet) and 'host' both mean this machine actually
        // owns the files on disk; only 'client' means "remote viewer with no
        // real filesystem access" — file-path/reveal-in-folder features key
        // off this, not off remoteMode directly.
        isHost: remoteMode !== 'client',
        profilePin: activePin
      }}
    >
      {children}
    </ProfileContext.Provider>
  )
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext)
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider')
  return ctx
}
