// electron-builder afterPack hook. electron-builder has no built-in macro
// for picking a platform/arch-specific extraResource per packaged target
// (only ${arch} and ${platform}, and ${platform} is the *build host's*
// platform, not the target's) so this hook copies the one matching
// sidecar binary from resources/sidecar/<goos>-<goarch>/ (built by
// scripts/build-sidecar.sh) into the packaged app's resources directory.
const fs = require('fs')
const path = require('path')

// electron-builder's Arch enum (builder-util): ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

function goTarget(electronPlatformName, archName) {
  const goos =
    electronPlatformName === 'darwin' || electronPlatformName === 'mas'
      ? 'darwin'
      : electronPlatformName === 'win32'
        ? 'windows'
        : 'linux'
  const goarch = archName === 'arm64' ? 'arm64' : 'amd64'
  return { goos, goarch }
}

module.exports = async function afterPack(context) {
  const archName = ARCH_NAMES[context.arch] ?? 'x64'
  const { goos, goarch } = goTarget(context.electronPlatformName, archName)
  const ext = goos === 'windows' ? '.exe' : ''

  const src = path.join(
    context.packager.projectDir,
    'resources',
    'sidecar',
    `${goos}-${goarch}`,
    `martbox-sidecar${ext}`
  )

  if (!fs.existsSync(src)) {
    throw new Error(
      `Sidecar binary not found at ${src}. Run "npm run build:sidecar" before packaging.`
    )
  }

  const resourcesDir =
    context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources')

  const destDir = path.join(resourcesDir, 'sidecar')
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, `martbox-sidecar${ext}`)
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)

  console.log(`[afterPackSidecar] copied ${goos}-${goarch} sidecar to ${dest}`)
}
