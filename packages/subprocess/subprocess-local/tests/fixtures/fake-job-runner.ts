import { appendRunnerEvent, consumeRunnerRequest } from '../../src/runner-protocol.ts'

const args = process.argv.slice(2)
const requestPath = args[args.indexOf('--request') + 1] as string
const eventsPath = args[args.indexOf('--events') + 1] as string
const request = consumeRunnerRequest(requestPath)
appendRunnerEvent(eventsPath, { type: 'started', pid: process.pid })

const configuredExit = Number(request.argv[1])
// Events carry target results; zero means the runner completed its own work.
if (Number.isSafeInteger(configuredExit)) {
  setTimeout(() => {
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode: configuredExit, signal: null })
    process.exitCode = 0
  }, 10)
} else {
  setInterval(() => {}, 1_000)
}
