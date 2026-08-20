interface FilePathRowProps {
  path: string
  isHost: boolean
}

// "Show in Folder" only makes sense on the machine that actually owns the
// file — a remote client has no local access to a host path like
// "D:\Movies\...", so isHost (off/host modes, not client) gates the button.
// The path text itself is still shown either way, since it's just
// informational and can help spot duplicates.
export default function FilePathRow({ path, isHost }: FilePathRowProps): JSX.Element {
  return (
    <div className="file-path-row" title={path}>
      <span className="file-path-text">{path}</span>
      {isHost && (
        <button
          className="file-path-reveal"
          onClick={(e) => {
            e.stopPropagation()
            window.api.system.showInFolder(path)
          }}
        >
          Show in Folder
        </button>
      )}
    </div>
  )
}
