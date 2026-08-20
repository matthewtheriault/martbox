import { useState } from 'react'
import type { Profile } from '../../../shared/types'
import { AVATAR_COLORS } from '../lib/avatars'

interface ProfilePickerProps {
  profiles: Profile[]
  // pin is the value that unlocked this profile (undefined if it has none)
  // — the caller holds onto it in memory so requests to a remote host can
  // prove ownership of this profile without prompting again.
  onSelect: (profile: Profile, pin?: string) => void
  onProfilesChanged: () => void
}

export default function ProfilePicker({
  profiles,
  onSelect,
  onProfilesChanged
}: ProfilePickerProps): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(AVATAR_COLORS[0])
  const [pinTarget, setPinTarget] = useState<Profile | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState(false)

  const createProfile = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    const profile = await window.api.profiles.create(trimmed, color)
    onProfilesChanged()
    onSelect(profile)
  }

  const selectProfile = (profile: Profile): void => {
    if (profile.hasPin) {
      setPinTarget(profile)
      setPinInput('')
      setPinError(false)
    } else {
      onSelect(profile)
    }
  }

  const submitPin = async (): Promise<void> => {
    if (!pinTarget) return
    const ok = await window.api.profiles.verifyPin(pinTarget.id, pinInput)
    if (ok) {
      onSelect(pinTarget, pinInput)
    } else {
      setPinError(true)
      setPinInput('')
    }
  }

  if (pinTarget) {
    return (
      <div className="profile-picker">
        <h1 className="profile-picker-title">Enter PIN for {pinTarget.name}</h1>
        <div className="profile-picker-form">
          <input
            type="password"
            inputMode="numeric"
            placeholder="PIN"
            value={pinInput}
            autoFocus
            onChange={(e) => {
              setPinInput(e.target.value)
              setPinError(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && submitPin()}
          />
          {pinError && <p className="settings-status-error">Wrong PIN.</p>}
          <div className="profile-picker-form-actions">
            <button className="btn-primary" onClick={submitPin}>
              Unlock
            </button>
            <button className="btn-secondary" onClick={() => setPinTarget(null)}>
              Back
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="profile-picker">
      <h1 className="profile-picker-title">Who&apos;s watching?</h1>
      <div className="profile-picker-grid">
        {profiles.map((profile) => (
          <button key={profile.id} className="profile-tile" onClick={() => selectProfile(profile)}>
            <span className="profile-avatar" style={{ background: profile.avatarId }}>
              {profile.name.charAt(0).toUpperCase()}
            </span>
            <span className="profile-tile-name">
              {profile.name}
              {profile.isAdmin && <span className="profile-admin-badge">Admin</span>}
            </span>
          </button>
        ))}

        {!creating && (
          <button className="profile-tile profile-tile-add" onClick={() => setCreating(true)}>
            <span className="profile-avatar profile-avatar-add">+</span>
            <span className="profile-tile-name">Add Profile</span>
          </button>
        )}
      </div>

      {creating && (
        <div className="profile-picker-form">
          <input
            type="text"
            placeholder="Profile name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createProfile()}
            autoFocus
          />
          <div className="profile-avatar-swatches">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                className={c === color ? 'profile-avatar-swatch active' : 'profile-avatar-swatch'}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div className="profile-picker-form-actions">
            <button className="btn-primary" onClick={createProfile}>
              Create
            </button>
            <button className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
