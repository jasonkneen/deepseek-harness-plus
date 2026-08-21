import { appendRunnerEvent, consumeRunnerRequest } from '../../src/runner-protocol.ts'

const args = process.argv.slice(2)
const requestPath = args[args.indexOf('--request') + 1] as string
const eventsPath = args[args.indexOf('--events') + 1] as string
const request = consumeRunnerRequest(requestPath)
appendRunnerEvent(eventsPath, { type: 'started', pid: process.pid })

const configuredExit = Number(request.argv[1])
if (Number.isSafeInteger(configuredExit)) {
  setTimeout(() => {
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode: configuredExit, signal: null })
    process.exitCode = configuredExit
  }, 10)
} else {
  const hold = setInterval(() => {}, 1_000)
  let terminated = false
  const terminate = (): void => {
    if (terminated) return
    terminated = true
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 1, signal: null })
    clearInterval(hold)
    if (process.connected) process.disconnect()
    process.exitCode = 1
  }
  process.on('message', (message: unknown) => {
    if (message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'terminate') terminate()
  })
  process.on('disconnect', terminate)
}
