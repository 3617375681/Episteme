import { formatPersistentDemo, runPersistentDemo } from './demo.js'

const result = await runPersistentDemo()
process.stdout.write(`EPISTEME PERSISTENT SESSION\n\n${formatPersistentDemo(result)}\n`)
