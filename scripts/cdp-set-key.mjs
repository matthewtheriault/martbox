const wsUrl = 'ws://localhost:9222/devtools/page/ABDF67BFAAC8348BD7ABE6292A6D2C9F'
const ws = new WebSocket(wsUrl)

function send(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }))
}

ws.addEventListener('open', () => {
  send(ws, 1, 'Runtime.evaluate', {
    expression: `window.api.settings.setTmdbKey("43397f406e7604cac28a8b77d712b02")`,
    awaitPromise: true,
    returnByValue: true
  })
})

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  console.log(JSON.stringify(msg))
  if (msg.id === 1) {
    ws.close()
    process.exit(0)
  }
})

ws.addEventListener('error', (e) => {
  console.error('ws error', e)
  process.exit(1)
})

setTimeout(() => {
  console.error('timeout')
  process.exit(1)
}, 10000)
