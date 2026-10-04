#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { optionValue } from './cli.js'
import { startLearnServer } from './server.js'

/**
 * Starts the Learn surface and prints where it is.
 *
 * The printed line is the whole interface: it says where to look and what is behind it. Nothing is opened
 * automatically, because a program that opens a browser is a program that acts without being asked.
 */
const DEFAULT_PATH = join(homedir(), '.episteme', 'learn.jsonl')

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `EPISTEME · Learn —— 本地网页界面\n` +
      `\n  用法：pnpm learn:web [选项]\n` +
      `\n  选项：\n` +
      `    -f, --file <路径>   指定图谱文件（默认 ${DEFAULT_PATH}）\n` +
      `    -p, --port <端口>   监听端口（默认 4321）\n` +
      `    -h, --help          显示这份说明\n` +
      `\n  环境变量：EPISTEME_FILE 与 --file 等效，PORT 与 --port 等效；命令行参数优先。\n` +
      `\n  只监听本机回环地址。这里没有身份验证，所以不要把它暴露到网络上。\n\n`,
  )
  process.exit(0)
}

const filePath = optionValue(argv, '--file', '-f') ?? process.env.EPISTEME_FILE ?? DEFAULT_PATH
const portText = optionValue(argv, '--port', '-p') ?? process.env.PORT ?? '4321'
const port = Number.parseInt(portText, 10)

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`端口 "${portText}" 不是有效端口。\n`)
  process.exit(1)
}

const server = await startLearnServer({ port, filePath })

process.stdout.write(
  `\nEPISTEME · Learn\n` +
    `\n  界面：  ${server.url}\n` +
    `  图谱：  ${filePath}\n` +
    `\n  这是你自己认知图谱上的一个本地界面。你记录的一切都会写入磁盘，关掉进程也不会丢。\n` +
    `  只监听本机回环地址：这里没有身份验证，所以没有什么是可以暴露到网络上的。\n` +
    `\n  按 Ctrl+C 停止。\n\n`,
)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  process.stdout.write('\n已保存。你记录的所有内容都在磁盘上。\n')
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
