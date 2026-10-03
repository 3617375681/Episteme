import { formatSemanticDemo, runSemanticDemo } from './demo.js'

const result = await runSemanticDemo()
process.stdout.write(`EPISTEME SEMANTIC SESSION\n\n${formatSemanticDemo(result)}\n`)
