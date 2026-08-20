import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Profile } from '../../../shared/types'
import type { RemoteAccessMode } from '../../../shared/remoteAccess'
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

  // Joining a friend's server kicks off the Tailscale sidecar connection
  // without waiting for it (connectClient resolves immediately), so this can
  // fire before the sidecar has a local port to forward through yet and
  // throw "Not connected to a host yet". That's transient — retry instead of
  // leaving profiles null forever, which stalls the whole app on the
  // "Starting MartBox…" screen with no recovery.
  const refreshProfiles = (): void => {
    window.api.profiles.list().then(setProfiles).catch(() => {
      setTimeout(refreshProfiles, 1000)
    })
  }

  useEffect(() => {
    window.api.settings.get().then((s) => setRemoteMode(s.remoteAccessMode))
  }, [])

  useEffect(() => {
    if (remoteMode !== null) refreshProfiles()
  }, [remoteMode])

  if (remoteMode === null || profiles === null) return <div className="app-loading">Starting MartBox…</div>

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
