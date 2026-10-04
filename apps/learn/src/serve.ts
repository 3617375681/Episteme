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
