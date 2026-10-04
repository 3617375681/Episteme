#!/usr/bin/env node
import { startLearnServer } from './server.js'

/**
 * Starts the Learn surface and prints where it is.
 *
 * The printed line is the whole interface: it says where to look and what is behind it. Nothing is opened
 * automatically, because a program that opens a browser is a program that acts without being asked.
 */
const port = Number.parseInt(process.env.PORT ?? '4321', 10)

const server = await startLearnServer({ port })

process.stdout.write(
  `\nEPISTEME · Learn\n` +
    `\n  ${server.url}\n` +
    `\n  A local surface over your own cognitive graph. Everything you record is written to disk and\n` +
    `  survives closing this process. Loopback only: there is no authentication, so there is nothing\n` +
    `  here to expose to a network.\n` +
    `\n  Ctrl+C to stop.\n\n`,
)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  process.stdout.write('\nSaved. Everything you recorded is on disk.\n')
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
