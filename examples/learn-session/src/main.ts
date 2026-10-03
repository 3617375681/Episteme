import { formatDemo, runDemo } from './demo.js'

const result = await runDemo()
process.stdout.write(`${formatDemo(result)}\n`)
