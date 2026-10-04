import type { Profile } from '../../../shared/types'
import { usePort } from '../lib/PortContext'

// A profile's photo, or its colour with the first letter of its name.
export default function Avatar({
  profile,
  className
}: {
  profile: Pick<Profile, 'id' | 'name' | 'avatarId' | 'avatarPhoto'>
  className: string
}): JSX.Element {
  const port = usePort()
  if (profile.avatarPhoto && port) {
    return (
      <span className={`${className} avatar-photo`}>
        <img src={`http://127.0.0.1:${port}/api/profiles/${profile.id}/avatar?v=${profile.avatarPhoto}`} alt="" />
      </span>
    )
  }
  return (
    <span
      className={className}
      style={{
        background: `linear-gradient(135deg, ${profile.avatarId}, color-mix(in srgb, ${profile.avatarId} 60%, #000))`
      }}
    >
      {profile.name.charAt(0).toUpperCase()}
    </span>
  )
}
