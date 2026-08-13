import { useEffect, useState } from 'react'
import type { IptvSettingsInfo, Library, Profile, ScanProgress } from '../../../shared/types'
import type { RemoteAccessMode, RemoteAccessStatus } from '../../../shared/remoteAccess'
import { useProfile } from '../lib/ProfileContext'
import { AVATAR_COLORS } from '../lib/avatars'

export default function Settings(): JSX.Element {
  const { activeProfile, switchProfile } = useProfile()
  const [libraries, setLibraries] = useState<Library[]>([])
  const [newLibraryType, setNewLibraryType] = useState<'movie' | 'tv'>('movie')
  const [tmdbKey, setTmdbKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saving' | 'valid' | 'invalid'>('idle')
  const [scanProgress, setScanProgress] = useState<Record<number, ScanProgress>>({})
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [newProfileName, setNewProfileName] = useState('')

  const [remoteMode, setRemoteMode] = useState<RemoteAccessMode>('off')
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus>({ status: 'idle' })
  const [hasApiToken, setHasApiToken] = useState(false)
  const [apiTokenInput, setApiTokenInput] = useState('')
  const [tokenStatus, setTokenStatus] = useState<'idle' | 'saving' | 'valid' | 'invalid'>('idle')
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [connectCodeInput, setConnectCodeInput] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)

  const [m3uUrl, setM3uUrl] = useState('')
  const [epgUrl, setEpgUrl] = useState('')
  const [iptvInfo, setIptvInfo] = useState<IptvSettingsInfo | null>(null)
  const [iptvStatus, setIptvStatus] = useState<'idle' | 'refreshing' | 'ok' | 'error'>('idle')
  const [iptvError, setIptvError] = useState<string | null>(null)

  const refreshLibraries = (): void => {
    window.api.library.list().then(setLibraries)
  }

  const refreshProfiles = (): void => {
    window.api.profiles.list().then(setProfiles)
  }

  useEffect(() => {
    refreshLibraries()
    refreshProfiles()
    window.api.settings.get().then((s) => {
      setTmdbKey(s.tmdbApiKey ?? '')
      setRemoteMode(s.remoteAccessMode)
    })
    window.api.remoteAccess.hasApiToken().then(setHasApiToken)
    window.api.remoteAccess.getStatus().then(setRemoteStatus)
    window.api.iptv.getSettings().then((info) => {
      setIptvInfo(info)
      setM3uUrl(info.m3uUrl ?? '')
      setEpgUrl(info.epgUrl ?? '')
      if (info.lastError) {
        setIptvStatus('error')
        setIptvError(info.lastError)
      } else if (info.channelCount > 0) {
        setIptvStatus('ok')
      }
    })
    const unsubscribeScan = window.api.library.onScanProgress((progress) => {
      setScanProgress((prev) => ({ ...prev, [progress.libraryId]: progress }))
      if (progress.phase === 'done') refreshLibraries()
    })
    const unsubscribeRemote = window.api.remoteAccess.onStatus(setRemoteStatus)
    return () => {
      unsubscribeScan()
      unsubscribeRemote()
    }
  }, [])

  const addProfile = async (): Promise<void> => {
    const trimmed = newProfileName.trim()
    if (!trimmed) return
    const color = AVATAR_COLORS[profiles.length % AVATAR_COLORS.length]
    await window.api.profiles.create(trimmed, color)
    setNewProfileName('')
    refreshProfiles()
  }

  const startRename = (profile: Profile): void => {
    setRenamingId(profile.id)
    setRenameValue(profile.name)
  }

  const saveRename = async (id: number): Promise<void> => {
    const trimmed = renameValue.trim()
    if (trimmed) await window.api.profiles.rename(id, trimmed)
    setRenamingId(null)
    refreshProfiles()
  }

  const removeProfile = async (id: number): Promise<void> => {
    await window.api.profiles.remove(id)
    refreshProfiles()
    if (id === activeProfile.id) switchProfile()
  }

  const addLibrary = async (): Promise<void> => {
    const path = await window.api.library.pickFolder()
    if (!path) return
    await window.api.library.add(path, newLibraryType)
    refreshLibraries()
  }

  const removeLibrary = async (id: number): Promise<void> => {
    await window.api.library.remove(id)
    refreshLibraries()
  }

  const scanLibrary = async (id: number): Promise<void> => {
    await window.api.library.scan(id)
  }

  const saveKey = async (): Promise<void> => {
    setKeyStatus('saving')
    const valid = await window.api.settings.setTmdbKey(tmdbKey.trim())
    setKeyStatus(valid ? 'valid' : 'invalid')
  }

  const saveApiToken = async (): Promise<void> => {
    setTokenStatus('saving')
    const valid = await window.api.remoteAccess.saveApiToken(apiTokenInput.trim())
    setTokenStatus(valid ? 'valid' : 'invalid')
    if (valid) {
      setHasApiToken(true)
      setApiTokenInput('')
    }
  }

  const enableHost = async (): Promise<void> => {
    await window.api.remoteAccess.enableHost()
    setRemoteMode('host')
  }

  const generateInvite = async (): Promise<void> => {
    setInviteError(null)
    try {
      const code = await window.api.remoteAccess.generateInvite()
      setInviteCode(code)
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to generate invite')
    }
  }

  const connectToFriend = async (): Promise<void> => {
    setConnectError(null)
    try {
      await window.api.remoteAccess.connectClient(connectCodeInput.trim())
      setRemoteMode('client')
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'That invite code did not work')
    }
  }

  const disableRemoteAccess = async (): Promise<void> => {
    await window.api.remoteAccess.disable()
    setRemoteMode('off')
    setInviteCode(null)
    setConnectCodeInput('')
  }

  const handleModeChange = (value: RemoteAccessMode): void => {
    if (value === 'off') disableRemoteAccess()
    else setRemoteMode(value)
  }

  const saveAndRefreshIptv = async (): Promise<void> => {
    setIptvStatus('refreshing')
    setIptvError(null)
    const result = await window.api.iptv.refresh(m3uUrl.trim(), epgUrl.trim())
    if (result.error) {
      setIptvStatus('error')
      setIptvError(result.error)
    } else {
      setIptvStatus('ok')
    }
    window.api.iptv.getSettings().then(setIptvInfo)
  }

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>

      <section className="settings-section">
        <h2>Profiles</h2>
        <div className="settings-row">
          <input
            type="text"
            placeholder="New profile name"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addProfile()}
          />
          <button className="btn-primary" onClick={addProfile}>
            Add Profile
          </button>
        </div>

        <ul className="library-list">
          {profiles.map((profile) => (
            <li key={profile.id} className="library-item">
              {renamingId === profile.id ? (
                <input
                  type="text"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveRename(profile.id)}
                  onBlur={() => saveRename(profile.id)}
                />
              ) : (
                <div className="library-name">
                  {profile.name}
                  {profile.id === activeProfile.id && (
                    <span className="library-type">(current)</span>
                  )}
                </div>
              )}
              <div className="library-actions">
                <button className="btn-secondary" onClick={() => startRename(profile)}>
                  Rename
                </button>
                <button className="btn-danger" onClick={() => removeProfile(profile.id)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-section">
        <h2>Remote Access</h2>
        <p className="settings-hint">
          Let friends stream from this server securely over Tailscale — no port forwarding, and
          nothing exposed to the public internet.
        </p>

        <div className="settings-row">
          <select value={remoteMode} onChange={(e) => handleModeChange(e.target.value as RemoteAccessMode)}>
            <option value="off">Off</option>
            <option value="host">Host this server</option>
            <option value="client">Connect to a friend&apos;s server</option>
          </select>
        </div>

        {remoteMode === 'host' && (
          <>
            {!hasApiToken && (
              <>
                <p className="settings-hint">
                  Paste a Tailscale API access token (generate one in the Tailscale admin
                  console) so MartBox can create invites for you.
                </p>
                <div className="settings-row">
                  <input
                    type="password"
                    placeholder="Tailscale API token"
                    value={apiTokenInput}
                    onChange={(e) => setApiTokenInput(e.target.value)}
                  />
                  <button className="btn-primary" onClick={saveApiToken}>
                    Save
                  </button>
                </div>
                {tokenStatus === 'valid' && <p className="settings-status-ok">Token saved.</p>}
                {tokenStatus === 'invalid' && (
                  <p className="settings-status-error">That token didn&apos;t work.</p>
                )}
              </>
            )}

            {hasApiToken && (
              <>
                <p className="settings-hint">
                  Status: {remoteStatus.status}
                  {remoteStatus.tailscaleAddr && ` — ${remoteStatus.tailscaleAddr}`}
                  {remoteStatus.message && ` — ${remoteStatus.message}`}
                </p>
                {remoteStatus.status !== 'connected' && (
                  <div className="settings-row">
                    <button className="btn-primary" onClick={enableHost}>
                      Enable Host Mode
                    </button>
                  </div>
                )}
                {remoteStatus.status === 'connected' && (
                  <div className="settings-row">
                    <button className="btn-primary" onClick={generateInvite}>
                      Generate Invite
                    </button>
                  </div>
                )}
                {inviteCode && (
                  <div className="settings-row">
                    <input type="text" readOnly value={inviteCode} onFocus={(e) => e.target.select()} />
                    <button
                      className="btn-secondary"
                      onClick={() => navigator.clipboard.writeText(inviteCode)}
                    >
                      Copy
                    </button>
                  </div>
                )}
                {inviteError && <p className="settings-status-error">{inviteError}</p>}
              </>
            )}
          </>
        )}

        {remoteMode === 'client' && (
          <>
            <div className="settings-row">
              <input
                type="text"
                placeholder="Paste invite code"
                value={connectCodeInput}
                onChange={(e) => setConnectCodeInput(e.target.value)}
              />
              <button className="btn-primary" onClick={connectToFriend}>
                Connect
              </button>
            </div>
            <p className="settings-hint">
              Status: {remoteStatus.status}
              {remoteStatus.message && ` — ${remoteStatus.message}`}
            </p>
            {connectError && <p className="settings-status-error">{connectError}</p>}
          </>
        )}
      </section>

      {remoteMode !== 'client' && (
        <>
          <section className="settings-section">
            <h2>Live TV</h2>
            <p className="settings-hint">
              Point MartBox at an M3U(8) playlist and (optionally) an XMLTV EPG URL to enable Live
              TV.
            </p>
            <div className="settings-row">
              <input
                type="text"
                placeholder="M3U playlist URL"
                value={m3uUrl}
                onChange={(e) => setM3uUrl(e.target.value)}
              />
            </div>
            <div className="settings-row">
              <input
                type="text"
                placeholder="XMLTV EPG URL (optional)"
                value={epgUrl}
                onChange={(e) => setEpgUrl(e.target.value)}
              />
              <button className="btn-primary" onClick={saveAndRefreshIptv}>
                Save &amp; Refresh
              </button>
            </div>
            {iptvStatus === 'refreshing' && <p className="settings-hint">Refreshing…</p>}
            {iptvStatus === 'ok' && iptvInfo && (
              <p className="settings-status-ok">
                {iptvInfo.channelCount} channels
                {iptvInfo.lastRefreshedAt &&
                  ` — last refreshed ${new Date(iptvInfo.lastRefreshedAt).toLocaleString()}`}
              </p>
            )}
            {iptvStatus === 'error' && <p className="settings-status-error">{iptvError}</p>}
          </section>

          <section className="settings-section">
            <h2>TMDb API Key</h2>
            <p className="settings-hint">
              Used to fetch posters, descriptions, cast, and ratings. Get a free key at{' '}
              themoviedb.org → Settings → API.
            </p>
            <div className="settings-row">
              <input
                type="text"
                placeholder="TMDb API Key"
                value={tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
              />
              <button className="btn-primary" onClick={saveKey}>
                Save
              </button>
            </div>
            {keyStatus === 'valid' && <p className="settings-status-ok">Key saved and verified.</p>}
            {keyStatus === 'invalid' && (
              <p className="settings-status-error">That key didn&apos;t work.</p>
            )}
          </section>

          <section className="settings-section">
            <h2>Libraries</h2>
            <div className="settings-row">
              <select
                value={newLibraryType}
                onChange={(e) => setNewLibraryType(e.target.value as 'movie' | 'tv')}
              >
                <option value="movie">Movies</option>
                <option value="tv">TV Shows</option>
              </select>
              <button className="btn-primary" onClick={addLibrary}>
                Add Library Folder
              </button>
            </div>

            <ul className="library-list">
              {libraries.map((lib) => {
                const progress = scanProgress[lib.id]
                return (
                  <li key={lib.id} className="library-item">
                    <div>
                      <div className="library-name">
                        {lib.name} <span className="library-type">({lib.type})</span>
                      </div>
                      <div className="library-path">{lib.path}</div>
                      {progress && progress.phase !== 'done' && (
                        <div className="library-scan-status">
                          {progress.phase === 'scanning'
                            ? 'Scanning files…'
                            : `Matching metadata (${progress.current}/${progress.total}) ${progress.message}`}
                        </div>
                      )}
                    </div>
                    <div className="library-actions">
                      <button className="btn-secondary" onClick={() => scanLibrary(lib.id)}>
                        Scan
                      </button>
                      <button className="btn-danger" onClick={() => removeLibrary(lib.id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
