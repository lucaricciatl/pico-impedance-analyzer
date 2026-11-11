// electron-builder hook: ad-hoc sign the macOS bundle.
// Without a Developer ID electron-builder skips signing silently and the app
// dies on first launch on Apple Silicon ("is damaged").
const { execFileSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename + '.app'
  const appPath = `${context.appOutDir}/${appName}`
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('ad-hoc signed', appPath)
}
