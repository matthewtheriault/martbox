import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  AppUpdateStatus,
  Library,
  Movie,
  Profile,
  ScanProgress,
  Show
} from '../../../shared/types'
import {
  TSNET_UDP_PORT,
  type PeerConnection,
  type RemoteAccessMode,
  type RemoteAccessStatus,
  type ServerCompatibility,
  type TailscaleGuestDevice
} from '../../../shared/remoteAccess'
import { useProfile } from '../lib/ProfileContext'
import { AVATAR_COLORS } from '../lib/avatars'

function PeerPathLabel({ peer }: { peer: PeerConnection | undefined }): JSX.Element | null {
  if (!peer) return null
  if (!peer.online) return <span className="library-type"> · Offline</span>
  if (peer.path === 'direct') return <span className="settings-status-ok"> · Direct connection</span>
  if (peer.path === 'relayed') {
    return <span className="settings-status-error"> · Relayed (slower)</span>
  }
  return <span className="library-type"> · Online, not streaming</span>
}

export default function Settings(): JSX.Element {
  const navigate = useNavigate()
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

  const [myPinInput, setMyPinInput] = useState('')
  const [myPinStatus, setMyPinStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [allPins, setAllPins] = useState<Array<Profile & { pin: string | null }> | null>(null)
  const [editingPinId, setEditingPinId] = useState<number | null>(null)
  const [editingPinValue, setEditingPinValue] = useState('')

  const [remoteMode, setRemoteMode] = useState<RemoteAccessMode>('off')
  const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus>({ status: 'idle' })
  const [hasApiToken, setHasApiToken] = useState(false)
  const [apiTokenInput, setApiTokenInput] = useState('')
  const [tokenStatus, setTokenStatus] = useState<'idle' | 'saving' | 'valid' | 'invalid'>('idle')
  const [hostError, setHostError] = useState<string | null>(null)
  const [enablingHost, setEnablingHost] = useState(false)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [connectCodeInput, setConnectCodeInput] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [guests, setGuests] = useState<TailscaleGuestDevice[] | null>(null)
  const [guestsError, setGuestsError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const [libraryCounts, setLibraryCounts] = useState<Record<number, number>>({})
  const [unmatchedMovies, setUnmatchedMovies] = useState<Movie[]>([])
  const [unmatchedShows, setUnmatchedShows] = useState<Show[]>([])

  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null)
  const [serverCompat, setServerCompat] = useState<ServerCompatibility | null>(null)

  const refreshLibraries = (): void => {
    window.api.library.list().then(setLibraries)
    Promise.all([window.api.movies.list(), window.api.shows.list()]).then(([movies, shows]) => {
      const counts: Record<number, number> = {}
      for (const m of movies) counts[m.libraryId] = (counts[m.libraryId] ?? 0) + 1
      for (const s of shows) counts[s.libraryId] = (counts[s.libraryId] ?? 0) + 1
      setLibraryCounts(counts)
      setUnmatchedMovies(movies.filter((m) => !m.tmdbId))
      setUnmatchedShows(shows.filter((s) => !s.tmdbId))
    })
  }

  const refreshProfiles = (): void => {
    window.api.profiles.list().then(setProfiles)
  }

  const refreshAllPins = (): void => {
    if (!activeProfile.isAdmin) return
    window.api.profiles.listWithPins(activeProfile.id).then(setAllPins)
  }

  useEffect(() => {
    if (remoteMode === 'host' && remoteStatus.status === 'connected') refreshGuests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteMode, remoteStatus.status])

  useEffect(() => {
    refreshLibraries()
    refreshProfiles()
    refreshAllPins()
    window.api.settings.get().then((s) => {
      setTmdbKey(s.tmdbApiKey ?? '')
      setRemoteMode(s.remoteAccessMode)
    })
    window.api.remoteAccess.hasApiToken().then(setHasApiToken)
    window.api.remoteAccess.getStatus().then(setRemoteStatus)
    const unsubscribeScan = window.api.library.onScanProgress((progress) => {
      setScanProgress((prev) => ({ ...prev, [progress.libraryId]: progress }))
      if (progress.phase === 'done') refreshLibraries()
    })
    const unsubscribeRemote = window.api.remoteAccess.onStatus(setRemoteStatus)
    window.api.updates.getStatus().then(setUpdateStatus)
    const unsubscribeUpdates = window.api.updates.onStatus(setUpdateStatus)
    window.api.remoteAccess
      .serverCompatibility()
      .then(setServerCompat)
      .catch(() => setServerCompat(null))
    return () => {
      unsubscribeScan()
      unsubscribeRemote()
      unsubscribeUpdates()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const saveMyPin = async (): Promise<void> => {
    setMyPinStatus('saving')
    await window.api.profiles.setPin(activeProfile.id, activeProfile.id, myPinInput.trim() || null)
    setMyPinInput('')
    setMyPinStatus('saved')
    refreshProfiles()
    refreshAllPins()
  }

  const startEditPin = (profile: Profile): void => {
    setEditingPinId(profile.id)
    setEditingPinValue('')
  }

  const saveEditedPin = async (id: number): Promise<void> => {
    await window.api.profiles.setPin(activeProfile.id, id, editingPinValue.trim() || null)
    setEditingPinId(null)
    refreshProfiles()
    refreshAllPins()
  }

  const clearPin = async (id: number): Promise<void> => {
    await window.api.profiles.setPin(activeProfile.id, id, null)
    refreshProfiles()
    refreshAllPins()
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
    try {
      const valid = await window.api.remoteAccess.saveApiToken(apiTokenInput.trim())
      setTokenStatus(valid ? 'valid' : 'invalid')
      if (valid) {
        setHasApiToken(true)
        setApiTokenInput('')
      }
    } catch {
      setTokenStatus('invalid')
    }
  }

  const removeApiToken = async (): Promise<void> => {
    await window.api.remoteAccess.removeApiToken()
    setHasApiToken(false)
    setApiTokenInput('')
    setTokenStatus('idle')
  }

  const enableHost = async (): Promise<void> => {
    setHostError(null)
    setEnablingHost(true)
    try {
      await window.api.remoteAccess.enableHost()
      setRemoteMode('host')
    } catch (err) {
      setHostError(err instanceof Error ? err.message : 'Failed to enable host mode')
    } finally {
      setEnablingHost(false)
    }
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

  const refreshGuests = async (): Promise<void> => {
    setGuestsError(null)
    try {
      setGuests(await window.api.remoteAccess.listGuests())
    } catch (err) {
      setGuestsError(err instanceof Error ? err.message : 'Failed to load connected friends')
    }
  }

  const revokeGuest = async (deviceId: string): Promise<void> => {
    setRevokingId(deviceId)
    try {
      await window.api.remoteAccess.revokeGuest(deviceId)
      await refreshGuests()
    } catch (err) {
      setGuestsError(err instanceof Error ? err.message : 'Failed to revoke access')
    } finally {
      setRevokingId(null)
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
    try {
      await window.api.remoteAccess.disable()
    } finally {
      setRemoteMode('off')
      setInviteCode(null)
      setConnectCodeInput('')
    }
  }

  const handleModeChange = (value: RemoteAccessMode): void => {
    if (value === 'off') disableRemoteAccess()
    else setRemoteMode(value)
  }

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>

      <section className="settings-section">
        <h2>Profiles</h2>
        {activeProfile.isAdmin ? (
          <p className="settings-status-ok">
            You are signed in as {activeProfile.name}, the admin account.
          </p>
        ) : (
          <p className="settings-hint">Signed in as {activeProfile.name} (not the admin).</p>
        )}
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
                  {profile.isAdmin && <span className="profile-admin-badge">Admin</span>}
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
        <h2>My PIN</h2>
        <p className="settings-hint">
          Set a PIN to lock your profile — anyone picking it will need to enter it first.
        </p>
        <div className="settings-row">
          <input
            type="password"
            inputMode="numeric"
            placeholder={activeProfile.hasPin ? 'Change PIN' : 'Set a PIN'}
            value={myPinInput}
            onChange={(e) => {
              setMyPinInput(e.target.value)
              setMyPinStatus('idle')
            }}
            onKeyDown={(e) => e.key === 'Enter' && saveMyPin()}
          />
          <button className="btn-primary" onClick={saveMyPin}>
            Save
          </button>
          {activeProfile.hasPin && (
            <button className="btn-danger" onClick={() => clearPin(activeProfile.id)}>
              Clear PIN
            </button>
          )}
        </div>
        {myPinStatus === 'saved' && <p className="settings-status-ok">PIN updated.</p>}
      </section>

      {activeProfile.isAdmin && allPins && (
        <section className="settings-section">
          <h2>All Profile PINs</h2>
          <p className="settings-hint">
            As the admin, you can see and reset every profile&apos;s PIN.
          </p>
          <ul className="library-list">
            {allPins.map((profile) => (
              <li key={profile.id} className="library-item">
                <div className="library-name">
                  {profile.name}
                  {profile.isAdmin && <span className="profile-admin-badge">Admin</span>}
                  <span className="library-type">
                    {editingPinId === profile.id
                      ? ''
                      : profile.pin
                        ? `PIN: ${profile.pin}`
                        : 'No PIN set'}
                  </span>
                </div>
                {editingPinId === profile.id ? (
                  <div className="library-actions">
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="New PIN"
                      value={editingPinValue}
                      autoFocus
                      onChange={(e) => setEditingPinValue(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveEditedPin(profile.id)}
                    />
                    <button className="btn-primary" onClick={() => saveEditedPin(profile.id)}>
                      Save
                    </button>
                    <button className="btn-secondary" onClick={() => setEditingPinId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="library-actions">
                    <button className="btn-secondary" onClick={() => startEditPin(profile)}>
                      {profile.pin ? 'Change' : 'Set PIN'}
                    </button>
                    {profile.pin && (
                      <button className="btn-danger" onClick={() => clearPin(profile.id)}>
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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
                <div className="settings-row">
                  <button className="btn-secondary" onClick={removeApiToken}>
                    Remove Token
                  </button>
                </div>
                {remoteStatus.status !== 'connected' && (
                  <div className="settings-row">
                    <button className="btn-primary" onClick={enableHost} disabled={enablingHost}>
                      {enablingHost ? 'Enabling…' : 'Enable Host Mode'}
                    </button>
                  </div>
                )}
                {hostError && <p className="settings-status-error">{hostError}</p>}
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
                {remoteStatus.status === 'connected' && (
                  <div className="settings-subsection">
                    <h3>Connected Friends</h3>
                    {guests?.some(
                      (g) =>
                        remoteStatus.peers?.find((p) => p.hostname === g.hostname)?.path === 'relayed'
                    ) && (
                      <p className="settings-hint">
                        Some friends are connecting through Tailscale&apos;s relay servers, which
                        limits streaming speed. For a direct connection, enable UPnP on your router
                        or forward UDP port {TSNET_UDP_PORT} to this computer.
                      </p>
                    )}
                    {guestsError && <p className="settings-status-error">{guestsError}</p>}
                    {guests && guests.length === 0 && (
                      <p className="settings-hint">No friends have joined yet.</p>
                    )}
                    {guests && guests.length > 0 && (
                      <ul className="library-list">
                        {guests.map((guest) => (
                          <li key={guest.id} className="library-item">
                            <div className="library-name">
                              {guest.hostname}
                              <span className="library-type">
                                {guest.lastSeen
                                  ? `Last seen ${new Date(guest.lastSeen).toLocaleString()}`
                                  : 'Never seen'}
                              </span>
                              <PeerPathLabel
                                peer={remoteStatus.peers?.find((p) => p.hostname === guest.hostname)}
                              />
                            </div>
                            <div className="library-actions">
                              <button
                                className="btn-danger"
                                onClick={() => revokeGuest(guest.id)}
                                disabled={revokingId === guest.id}
                              >
                                {revokingId === guest.id ? 'Revoking…' : 'Revoke Access'}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
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
              {remoteStatus.status === 'connected' && (
                <PeerPathLabel peer={remoteStatus.peers?.[0]} />
              )}
            </p>
            {remoteStatus.peers?.[0]?.path === 'relayed' && (
              <p className="settings-hint">
                Your connection to this server is going through Tailscale&apos;s relay servers,
                which limits streaming speed. The server owner can fix this by enabling UPnP on
                their router or forwarding UDP port {TSNET_UDP_PORT}.
              </p>
            )}
            {connectError && <p className="settings-status-error">{connectError}</p>}
          </>
        )}
      </section>

      {remoteMode !== 'client' && !window.api.isMasBuild && (
        <>
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
                        <span className="library-type">
                          {' — '}
                          {libraryCounts[lib.id] ?? 0} {lib.type === 'movie' ? 'movies' : 'shows'}
                        </span>
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

          {(unmatchedMovies.length > 0 || unmatchedShows.length > 0) && (
            <section className="settings-section">
              <h2>
                Needs Attention
                <span className="page-title-count">
                  {unmatchedMovies.length + unmatchedShows.length}
                </span>
              </h2>
              <p className="settings-hint">
                These didn&apos;t get a TMDb match on scan — open one and use &quot;Edit Metadata → Search
                TMDb&quot; to fix it.
              </p>
              <ul className="library-list">
                {unmatchedMovies.map((m) => (
                  <li key={`movie-${m.id}`} className="library-item">
                    <div>
                      <div className="library-name">
                        {m.title} <span className="library-type">(movie)</span>
                      </div>
                    </div>
                    <div className="library-actions">
                      <button className="btn-secondary" onClick={() => navigate(`/movie/${m.id}`)}>
                        Open
                      </button>
                    </div>
                  </li>
                ))}
                {unmatchedShows.map((s) => (
                  <li key={`show-${s.id}`} className="library-item">
                    <div>
                      <div className="library-name">
                        {s.title} <span className="library-type">(show)</span>
                      </div>
                    </div>
                    <div className="library-actions">
                      <button className="btn-secondary" onClick={() => navigate(`/show/${s.id}`)}>
                        Open
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="settings-section">
        <h2>App Updates</h2>
        <p className="settings-hint">
          MartBox {updateStatus?.currentVersion ?? ''} checks for new versions automatically and
          downloads them in the background. Installing an update keeps your libraries, profiles,
          watch history and settings, and the database is backed up first.
        </p>
        {updateStatus?.state === 'unsupported' ? (
          <p className="settings-hint">
            Automatic updates aren&apos;t available in this build (development or Mac App Store).
          </p>
        ) : (
          <>
            <div className="settings-row">
              {updateStatus?.state === 'ready' ? (
                <button className="btn-primary" onClick={() => window.api.updates.installNow()}>
                  Restart to install {updateStatus.latestVersion}
                </button>
              ) : (
                <button
                  className="btn-secondary"
                  onClick={() => window.api.updates.checkNow()}
                  disabled={
                    updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'
                  }
                >
                  {updateStatus?.state === 'checking' ? 'Checking…' : 'Check for Updates'}
                </button>
              )}
            </div>
            {updateStatus?.state === 'up-to-date' && (
              <p className="settings-hint">You&apos;re up to date.</p>
            )}
            {updateStatus?.state === 'downloading' && (
              <p className="settings-hint">
                Downloading {updateStatus.latestVersion}… {updateStatus.progressPercent ?? 0}%
              </p>
            )}
            {updateStatus?.state === 'ready' && (
              <p className="settings-status-ok">
                MartBox {updateStatus.latestVersion} is downloaded and ready to install.
              </p>
            )}
            {updateStatus?.state === 'error' && (
              <p className="settings-status-error">Update check failed: {updateStatus.error}</p>
            )}
            {updateStatus?.releaseNotes &&
              (updateStatus.state === 'downloading' || updateStatus.state === 'ready') && (
                <pre className="settings-release-notes">{updateStatus.releaseNotes}</pre>
              )}
          </>
        )}
        {serverCompat && (
          <p className={serverCompat.compatible ? 'settings-hint' : 'settings-status-error'}>
            {serverCompat.server
              ? `Server is running MartBox ${serverCompat.server.appVersion}.`
              : 'Server is running a MartBox version older than 0.2.'}
            {serverCompat.needsUpdate === 'server' && ' Update the server to use this app.'}
            {serverCompat.needsUpdate === 'app' && ' Update this app to match the server.'}
          </p>
        )}
      </section>
    </div>
  )
}
