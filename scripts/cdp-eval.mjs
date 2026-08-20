const wsUrl = process.env.CDP_WS || 'ws://localhost:9222/devtools/page/ABDF67BFAAC8348BD7ABE6292A6D2C9F'
const expression = process.argv[2]
const ws = new WebSocket(wsUrl)

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  console.log(JSON.stringify(msg, null, 2))
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
}, 15000)
