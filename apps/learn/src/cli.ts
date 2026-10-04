import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RECORDABLE_DIMENSIONS, LearnSession, type AskResult } from './session.js'
import { seedTopic, TRANSFORMERS } from './seed.js'

/**
 * A terminal Learn session.
 *
 * The point of this file is that the whole loop is usable before any UI exists: a learner types a
 * question, sees which of their own prior understanding was retrieved and **why**, records what they now
 * understand, and asks again. Everything is printed as text so the reasoning is inspectable rather than
 * presented.
 *
 * Commands are single letters because the loop is meant to be repeated, not studied. `?` lists them.
 */

const DEFAULT_PATH = join(homedir(), '.episteme', 'learn.jsonl')

interface Command {
  readonly name: string
  readonly usage: string
  readonly help: string
}

const COMMANDS: readonly Command[] = [
  { name: 'ask', usage: '<question>', help: 'ask a question; free text also works' },
  { name: 'explain', usage: '[n]', help: 'show the ranked evidence behind the last answer' },
  { name: 'record', usage: '<nodeId> <dimension> <level>', help: 'record what you now understand' },
  { name: 'claim', usage: '<text>', help: 'add a claim of your own to the graph' },
  { name: 'graph', usage: '', help: 'list everything in your graph' },
  { name: 'open', usage: '', help: 'show the lines of inquiry you have left open' },
  { name: 'dimensions', usage: '', help: 'list the dimensions you can record' },
  { name: 'help', usage: '', help: 'show this list' },
  { name: 'quit', usage: '', help: 'leave (everything is already saved)' },
]

/**
 * Commands, and the aliases that must not cost a learner their question.
 *
 * This list is why the evidence command is `explain` and not `why`. The first version used `why`, and
 * `why order matters for attention` — the most natural way anyone would phrase that question — was read as
 * the command plus an argument and silently discarded. A surface whose own vocabulary eats the learner's
 * question is worse than one that makes them learn a syntax.
 *
 * Every alias here is therefore a word nobody opens a question with.
 */
const ALIASES: Readonly<Record<string, string>> = {
  '?': 'help',
  help: 'help',
  explain: 'explain',
  record: 'record',
  claim: 'claim',
  graph: 'graph',
  list: 'graph',
  open: 'open',
  dimensions: 'dimensions',
  dims: 'dimensions',
  ask: 'ask',
  quit: 'quit',
  exit: 'quit',
  q: 'quit',
}

/**
 * The alias table is exported so a test can assert the property that matters about it.
 *
 * That property is negative and easy to lose: **no command name or alias may be a word a learner would
 * open a question with.** `why` was such a word, it was the name of this command, and every question
 * beginning "why …" was silently swallowed. Re-adding an alias like `what` or `how` would reintroduce the
 * same class of bug, so the test names the words that must never appear here.
 */
export const RESERVED_WORDS = [
  'why',
  'what',
  'how',
  'when',
  'where',
  'which',
  'who',
  'does',
  'is',
  'are',
  'can',
  'should',
] as const

/**
 * Commands that consume the rest of the line as their argument.
 *
 * Only these may swallow trailing words. Anything else that matches a command name takes no argument, so a
 * learner who writes `graph the attention concepts` gets a question rather than a puzzling graph listing.
 */
const TAKES_ARGUMENT = new Set(['ask', 'explain', 'record', 'claim'])

export interface CliOptions {
  readonly filePath?: string
  readonly quiet?: boolean
}

/** Everything the CLI needs, so a test can drive it without a terminal. */
export interface CliOutput {
  write(text: string): void
}

/**
 * Runs one line of input and returns the text to print.
 *
 * Separated from the readline loop so the whole session is testable without a pty — the loop is the only
 * part that needs a terminal.
 */
export class LearnCli {
  readonly #session: LearnSession
  readonly #out: CliOutput
  #lastAsk: AskResult | undefined

  private constructor(session: LearnSession, out: CliOutput) {
    this.#session = session
    this.#out = out
  }

  static async open(out: CliOutput, options: CliOptions = {}): Promise<LearnCli> {
    const session = await LearnSession.open(
      options.filePath === undefined ? {} : { filePath: options.filePath },
    )
    const cli = new LearnCli(session, out)
    const seed = await seedTopic(session)
    if (seed.seeded) {
      cli.#out.write(
        `Seeded "${TRANSFORMERS.title}": ${seed.nodeCount} nodes, ${seed.edgeCount} links.\n` +
          `No understanding is recorded yet — that part is yours.\n\n`,
      )
    }
    return cli
  }

  get session(): LearnSession {
    return this.#session
  }

  /** Handles one line. Returns whether the session should continue. */
  async handle(line: string): Promise<boolean> {
    const trimmed = line.trim()
    if (trimmed === '') return true

    const [head, ...rest] = splitFirst(trimmed)
    const command = ALIASES[head.toLowerCase()]

    // Not a command, or a command that takes no argument followed by words — either way it is a question.
    // Falling through to `ask` is deliberate: the cost of guessing wrong is one answer the learner did not
    // want, while the cost of *not* guessing is their question disappearing.
    if (command === undefined || (!TAKES_ARGUMENT.has(command) && rest.length > 0)) {
      await this.#ask(trimmed)
      return true
    }

    if (command === 'quit') return false

    if (command === 'help') {
      this.#printHelp()
      return true
    }

    if (command === 'ask') {
      const question = rest.join(' ').trim()
      if (question === '') {
        this.#out.write('ask needs a question, e.g.  ask why is order hard for attention\n')
        return true
      }
      await this.#ask(question)
      return true
    }

    if (command === 'explain') {
      this.#printWhy(rest[0])
      return true
    }

    if (command === 'record') {
      await this.#record(rest)
      return true
    }

    if (command === 'claim') {
      const text = rest.join(' ').trim()
      if (text === '') {
        this.#out.write('claim needs some text, e.g.  claim self-attention cannot see order\n')
        return true
      }
      const node = await this.#session.addNode({ label: text, kind: 'claim' })
      this.#out.write(`Added claim ${node.nodeId}\n`)
      return true
    }

    if (command === 'graph') {
      this.#printGraph()
      return true
    }

    if (command === 'open') {
      this.#printOpenEnds()
      return true
    }

    if (command === 'dimensions') {
      this.#printDimensions()
      return true
    }

    await this.#ask(trimmed)
    return true
  }

  async #ask(question: string): Promise<void> {
    const result = await this.#session.ask(question)
    this.#lastAsk = result

    this.#out.write(`\n${result.answer}\n`)
    this.#out.write(
      result.usedContext
        ? `\n  built on ${result.known.length} thing(s) you had already recorded  [${result.retriever}]\n`
        : `\n  nothing you had recorded was relevant, so this starts from the ground  [${result.retriever}]\n`,
    )

    if (result.ranked.length > 0) {
      this.#out.write(`  retrieved, most relevant first:\n`)
      for (const entry of result.ranked.slice(0, 5)) {
        const why = entry.reasons[0]
        this.#out.write(
          `    ${entry.score.toFixed(3)}  ${entry.label}\n` +
            `           ${entry.nodeId} · ${entry.type} · ${why === undefined ? 'no signals' : why.explanation}\n`,
        )
      }
      this.#out.write(`  run "explain" for the full breakdown.\n`)
    }
    this.#out.write('\n')
  }

  /**
   * Prints how each retrieved node earned its place.
   *
   * The contributions shown are the ones that produced the ranking, not a reconstruction, so a learner can
   * check the system's reasoning against the order it just presented.
   */
  #printWhy(which?: string): void {
    const result = this.#lastAsk
    if (result === undefined) {
      this.#out.write('nothing asked yet\n')
      return
    }

    const index = which === undefined ? undefined : Number.parseInt(which, 10) - 1
    const entries =
      index === undefined || Number.isNaN(index)
        ? result.ranked
        : result.ranked.slice(Math.max(0, index), Math.max(0, index) + 1)

    if (entries.length === 0) {
      this.#out.write('nothing to explain\n')
      return
    }

    this.#out.write(`\nwhy these were retrieved for: ${result.question}\n`)
    this.#out.write(
      `weights: ${result.rules.map((rule) => `${rule.signal}=${rule.weight}`).join('  ')}\n`,
    )

    for (const entry of entries) {
      this.#out.write(`\n  ${entry.label}   [${entry.nodeId}]\n`)
      this.#out.write(`    total ${entry.score.toFixed(4)}  (${entry.origin})\n`)
      for (const reason of entry.reasons) {
        this.#out.write(
          `      ${reason.signal.padEnd(10)} value ${reason.value.toFixed(3)} × weight ${reason.weight} = ` +
            `${reason.contribution.toFixed(4)}  (${(reason.share * 100).toFixed(0)}% of total)\n` +
            `      ${' '.repeat(10)} ${reason.explanation}\n`,
        )
      }
    }
    this.#out.write('\n')
  }

  async #record(args: readonly string[]): Promise<void> {
    const [reference, dimension, level] = args
    if (reference === undefined || dimension === undefined || level === undefined) {
      this.#out.write('record needs a node, a dimension and a level, e.g.\n')
      this.#out.write('  record claim_1 confidence low\n\n')
      this.#printDimensions()
      return
    }

    const known = RECORDABLE_DIMENSIONS.find((candidate) => candidate.id === dimension)
    if (known === undefined) {
      this.#out.write(`"${dimension}" is not recordable here.\n\n`)
      this.#printDimensions()
      return
    }
    if (!known.levels.includes(level)) {
      this.#out.write(
        `"${level}" is not a level of ${dimension}. Use one of: ${known.levels.join(', ')}\n`,
      )
      return
    }

    // Resolved rather than assumed: an ambiguous reference must not silently attach the learner's
    // understanding to the wrong node, because a StateEvent is permanent.
    const matches = this.#session.resolveNodes(reference)
    if (matches.length === 0) {
      this.#out.write(`No node matches "${reference}". Run "graph" to see what is there.\n`)
      return
    }
    if (matches.length > 1) {
      this.#out.write(`"${reference}" matches ${matches.length} nodes — be more specific:\n`)
      for (const match of matches) this.#out.write(`  ${match.nodeId}  ${match.label}\n`)
      return
    }

    const target = matches[0]
    if (target === undefined) return

    try {
      const result = await this.#session.record(target.nodeId, { [dimension]: level })
      this.#out.write(
        `Recorded ${target.nodeId} → ${result.recorded.map((entry) => `${entry.id}=${entry.level}`).join(', ')}` +
          `  [${result.eventId}]\n`,
      )
      this.#out.write(`Your understanding is now part of the history. Ask again to see it used.\n`)
    } catch (error) {
      this.#out.write(`Could not record that: ${(error as Error).message}\n`)
    }
  }

  #printGraph(): void {
    const nodes = this.#session.listNodes()
    this.#out.write(`\n${nodes.length} node(s):\n`)
    for (const node of nodes) {
      const state = this.#session.understandingOf(node.nodeId)
      const understood =
        state.length === 0
          ? ''
          : `  ← you: ${state.map((entry) => `${entry.id}=${entry.level}`).join(', ')}`
      this.#out.write(
        `  ${node.nodeId.padEnd(28)} ${node.type.padEnd(9)} ${node.label}${understood}\n`,
      )
    }
    this.#out.write('\n')
  }

  #printOpenEnds(): void {
    const ends = this.#session.openEnds()
    if (ends.length === 0) {
      this.#out.write('\nno open lines of inquiry yet — record something and one will appear\n\n')
      return
    }
    this.#out.write(`\n${ends.length} open line(s) of inquiry:\n`)
    for (const end of ends) {
      this.#out.write(`  ${end.eventId}  ${end.label}\n`)
    }
    this.#out.write('\n')
  }

  #printDimensions(): void {
    this.#out.write('recordable dimensions:\n')
    for (const dimension of RECORDABLE_DIMENSIONS) {
      this.#out.write(
        `  ${dimension.id.padEnd(13)} ${dimension.levels.join(' | ').padEnd(30)} ${dimension.description}\n`,
      )
    }
    this.#out.write('\n')
  }

  #printHelp(): void {
    this.#out.write('\ncommands:\n')
    for (const command of COMMANDS) {
      this.#out.write(`  ${`${command.name} ${command.usage}`.trim().padEnd(42)} ${command.help}\n`)
    }
    this.#out.write(
      '\n  any other line is treated as a question — including one that starts with "why".\n\n',
    )
    this.#out.write('  ask -> see what was retrieved -> record -> ask again.\n')
    this.#out.write('  The difference between the two answers is the system working.\n\n')
  }
}

/** Splits on the first run of whitespace, so a command never swallows the rest of the line. */
function splitFirst(line: string): [string, ...string[]] {
  const match = /^(\S+)\s*([\s\S]*)$/u.exec(line)
  if (match === null) return [line]
  const head = match[1] ?? line
  const tail = (match[2] ?? '').trim()
  return tail === '' ? [head] : [head, ...tail.split(/\s+/u)]
}

/** The readline loop. The only part of this file that needs a terminal. */
async function main(): Promise<void> {
  const filePath = process.env.EPISTEME_FILE ?? DEFAULT_PATH
  const out: CliOutput = { write: (text) => process.stdout.write(text) }

  process.stdout.write(
    `EPISTEME · Learn\n` +
      `graph: ${filePath}\n` +
      `Everything you record is saved. Ask a question to begin; "?" lists commands.\n\n`,
  )

  const cli = await LearnCli.open(out, { filePath })

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  process.stdout.write('> ')

  // `for await` over the interface rather than an event handler: it serialises input, so a question that
  // takes longer than the next keystroke cannot interleave two answers.
  for await (const line of rl) {
    const keepGoing = await cli.handle(line)
    if (!keepGoing) break
    process.stdout.write('> ')
  }

  rl.close()
  process.stdout.write('\nSaved. Everything you recorded is on disk.\n')
}

// Only run when invoked directly, so importing this file in a test does not start a prompt. Comparing
// resolved file URLs rather than string suffixes: a path ending check matches on any same-named file.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
