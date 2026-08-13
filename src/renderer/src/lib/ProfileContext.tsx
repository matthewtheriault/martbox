import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Profile } from '../../../shared/types'
import ProfilePicker from '../components/ProfilePicker'

interface ProfileContextValue {
  activeProfile: Profile
  switchProfile: () => void
}

const ProfileContext = createContext<ProfileContextValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }): JSX.Element {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)

  const refreshProfiles = (): void => {
    window.api.profiles.list().then(setProfiles)
  }

  useEffect(refreshProfiles, [])

  if (profiles === null) return <div className="app-loading">Starting MartBox…</div>

  if (!activeProfile) {
    return (
      <ProfilePicker
        profiles={profiles}
        onSelect={setActiveProfile}
        onProfilesChanged={refreshProfiles}
      />
    )
  }

  return (
    <ProfileContext.Provider
      value={{ activeProfile, switchProfile: () => setActiveProfile(null) }}
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
