// Nothing is exposed to the renderer: the UI talks to its own origin over HTTP.
// Kept as a file so `sandbox: true` + contextIsolation stay honest.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktop: true,
})
