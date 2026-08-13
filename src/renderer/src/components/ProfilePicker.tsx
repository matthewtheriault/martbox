import { useState } from 'react'
import type { Profile } from '../../../shared/types'
import { AVATAR_COLORS } from '../lib/avatars'

interface ProfilePickerProps {
  profiles: Profile[]
  onSelect: (profile: Profile) => void
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

  const createProfile = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    const profile = await window.api.profiles.create(trimmed, color)
    onProfilesChanged()
    onSelect(profile)
  }

  return (
    <div className="profile-picker">
      <h1 className="profile-picker-title">Who&apos;s watching?</h1>
      <div className="profile-picker-grid">
        {profiles.map((profile) => (
          <button key={profile.id} className="profile-tile" onClick={() => onSelect(profile)}>
            <span className="profile-avatar" style={{ background: profile.avatarId }}>
              {profile.name.charAt(0).toUpperCase()}
            </span>
            <span className="profile-tile-name">{profile.name}</span>
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
