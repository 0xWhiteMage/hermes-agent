#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock inference server.
 *
 * Implements just enough of the /v1/* surface for `hermes serve` (or the
 * plain CLI) to resolve a provider, list models, and get back a canned chat
 * completion — without hitting a real LLM. This is the shared core used by:
 *
 *   - apps/desktop/e2e/mock-server.ts   (Playwright E2E, layers scripted
 *     multi-turn tool-call sequences on top via `onCompletionRequest`)
 *   - apps/desktop/scripts/dev-mock.mjs (local dev, launches the desktop app
 *     against this server with no real API key)
 *   - tests/install/install-update-e2e.sh (installer/updater E2E, drives a
 *     real `hermes` CLI chat round-trip against this server inside the
 *     dev-sandbox)
 *
 * Deliberately zero npm dependencies (only node:http/fs/os/path) so it runs
 * with nothing but the Node binary `scripts/install.sh` already provisions —
 * no `npm install` required to use it from a bash test.
 *
 * Endpoints:
 *   GET  /v1/models             -> { data: [{ id, ... }] }
 *   POST /v1/chat/completions   -> streaming (SSE) or non-streaming response
 *
 * ## Library usage (import from Node/TS)
 *
 * ```js
 * import { startMockServer } from '../../scripts/mock-inference-server.mjs'
 * const mock = await startMockServer({ reply: 'hi!' })
 * // mock.url is an OpenAI-compatible base (append /v1)
 * await mock.close()
 * ```
 *
 * Pass `onCompletionRequest(parsedBody)` to script multi-turn tool-call
 * sequences (see apps/desktop/e2e/mock-server.ts for the canonical example);
 * return a `ScriptedTurn`-shaped object (see `streamScriptedTurn` below) or
 * `undefined`/`null` to fall through to the default single canned reply.
 *
 * ## CLI usage (bash tests, no Node API needed)
 *
 * ```bash
 * node scripts/mock-inference-server.mjs --port-file /tmp/mock-url &
 * # wait for the file to appear, then read the base URL from it
 * url="$(cat /tmp/mock-url)"
 * ```
 *
 * Options: `--port <n>` (default: ephemeral), `--reply "<text>"`,
 * `--port-file <path>` (written once listening; contains the bare URL, e.g.
 * `http://127.0.0.1:54321`), `--model <id>` (default: `mock-model`).
 */

import http from 'node:http'
import fs from 'node:fs'

/** Default canned assistant reply used when no turn/hook overrides it. */
export const DEFAULT_MOCK_REPLY = 'Hello from the mock inference server! The full boot chain is working.'

/**
 * @typedef {object} ScriptedTurn
 * @property {string} text Assistant text content to stream. Empty string = no visible text.
 * @property {Array<{name: string, args: Record<string, unknown>}>} [toolCalls]
 *   Tool calls to emit. Omitted/empty = final turn (finish_reason: "stop").
 */

/**
 * @typedef {object} MockServerOptions
 * @property {string} [reply] Canned reply text for the default (non-scripted) path.
 * @property {string} [model] Model id reported by /v1/models and echoed back. Default "mock-model".
 * @property {(parsedBody: any, ctx: {requestCount: number}) => (ScriptedTurn | null | undefined)} [onCompletionRequest]
 *   Called once per /v1/chat/completions request with the parsed JSON body.
 *   Return a ScriptedTurn to control that turn's response, or nothing to fall
 *   through to the default single canned reply.
 * @property {string} [holdFirstStreamForPrompt] Pause the matching stream after its first token.
 * @property {string} [holdFirstCompletionContaining] Pause the first completion whose request JSON contains this text.
 */

/**
 * @typedef {object} MockServer
 * @property {number} port
 * @property {string} url Base URL, e.g. "http://127.0.0.1:54321" (append /v1).
 * @property {string[]} receivedPrompts Last user message content of every request received so far.
 * @property {() => Promise<void>} waitForHeldStream
 * @property {() => Promise<void>} waitForHeldCompletion
 * @property {() => void} releaseHeldStream
 * @property {() => number} heldCompletionCount
 * @property {() => Promise<void>} close
 */

/** SSE chunk shape for a streaming chat completion. */
export function sseChunk(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'mock-completion',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/**
 * Stream a plain text response (no tool calls) as SSE, finishing with
 * `finish_reason: "stop"`. This is the default canned-reply path.
 * @param {import('node:http').ServerResponse} res
 * @param {string} model
 * @param {string} text
 * @param {(() => Promise<void>) | undefined} [waitForRelease]
 */
export function streamTextResponse(res, model, text, waitForRelease) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const words = text.split(' ')
  let i = 0

  const sendChunk = () => {
    if (i >= words.length) {
      res.write(sseChunk(model, {}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const word = i === 0 ? words[i] : ' ' + words[i]
    res.write(sseChunk(model, { content: word }))
    i++
    if (waitForRelease && i === 1) {
      waitForRelease().then(() => setTimeout(sendChunk, 20))
      return
    }
    setTimeout(sendChunk, 20)
  }

  sendChunk()
}

/** Non-streaming plain text response. */
export function nonStreamingTextResponse(res, model, text) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'mock-completion',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  )
}

/**
 * Stream a single scripted turn: first the text content (word by word),
 * then a chunk carrying the tool_calls (if any), with the appropriate
 * finish_reason.
 *
 * If the turn has no text and no tool calls, it's an empty final response.
 * If it has text but no tool calls, it's a final answer (finish_reason: stop).
 * If it has tool calls (with or without text), finish_reason is "tool_calls".
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} model
 * @param {ScriptedTurn} turn
 * @param {number} callIdSeed unique-ish seed for tool_call ids
 */
export function streamScriptedTurn(res, model, turn, callIdSeed = 0) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const hasToolCalls = Boolean(turn.toolCalls && turn.toolCalls.length > 0)
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop'
  const toolCallsDelta = () => ({
    tool_calls: turn.toolCalls.map((tc, idx) => ({
      index: idx,
      id: `call_e2e_${callIdSeed}_${idx}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    })),
  })

  if (!turn.text) {
    res.write(sseChunk(model, hasToolCalls ? toolCallsDelta() : {}, finishReason))
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  const words = turn.text.split(' ')
  let i = 0

  const sendChunk = () => {
    if (i >= words.length) {
      res.write(sseChunk(model, hasToolCalls ? toolCallsDelta() : {}, finishReason))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const word = i === 0 ? words[i] : ' ' + words[i]
    res.write(sseChunk(model, { content: word }))
    i++
    setTimeout(sendChunk, 20)
  }

  sendChunk()
}

/** Non-streaming version of a scripted turn. */
export function nonStreamingScriptedTurn(res, model, turn, callIdSeed = 0) {
  const hasToolCalls = Boolean(turn.toolCalls && turn.toolCalls.length > 0)
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop'

  const message = { role: 'assistant' }
  if (turn.text) {
    message.content = turn.text
  }
  if (hasToolCalls) {
    message.tool_calls = turn.toolCalls.map((tc, idx) => ({
      id: `call_e2e_${callIdSeed}_${idx}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }))
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'mock-completion',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  )
}

/**
 * Start the mock server on an ephemeral (or given) port.
 * @param {MockServerOptions} [options]
 * @returns {Promise<MockServer>}
 */
export function startMockServer(options = {}) {
  const model = options.model || 'mock-model'
  const reply = options.reply || DEFAULT_MOCK_REPLY

  return new Promise((resolve, reject) => {
    const receivedPrompts = []
    let requestCount = 0
    let resolveHeldStreamStarted = null
    let releaseHeldStream = null
    let heldCompletionCount = 0
    const heldStreamStarted = new Promise((resolveHeld) => {
      resolveHeldStreamStarted = resolveHeld
    })
    const heldStreamReleased = new Promise((resolveRelease) => {
      releaseHeldStream = resolveRelease
    })

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: model, object: 'model', created: 0, owned_by: 'mock' }],
          }),
        )
        return
      }

      if (req.method === 'POST' && req.url && req.url.startsWith('/v1/chat/completions')) {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk.toString()
        })

        req.on('end', () => {
          let parsed = {}
          try {
            parsed = JSON.parse(body)
          } catch {
            // malformed JSON — treat as non-streaming with defaults
          }

          requestCount++

          const messages = Array.isArray(parsed.messages) ? parsed.messages : []
          const lastUserMessage = [...messages].reverse().find((m) => m && m.role === 'user')
          if (typeof lastUserMessage?.content === 'string') {
            receivedPrompts.push(lastUserMessage.content)
          }

          const stream = parsed.stream === true
          const responseModel = parsed.model || model
          const holdThisCompletion = Boolean(
            options.holdFirstCompletionContaining &&
              heldCompletionCount === 0 &&
              JSON.stringify(parsed).includes(options.holdFirstCompletionContaining),
          )

          const scriptedTurn = options.onCompletionRequest
            ? options.onCompletionRequest(parsed, { requestCount })
            : null

          if (scriptedTurn) {
            if (stream) {
              streamScriptedTurn(res, responseModel, scriptedTurn, requestCount)
            } else {
              nonStreamingScriptedTurn(res, responseModel, scriptedTurn, requestCount)
            }
            return
          }

          if (stream) {
            const holdThisStream = Boolean(
              options.holdFirstStreamForPrompt &&
                typeof lastUserMessage?.content === 'string' &&
                lastUserMessage.content.includes(options.holdFirstStreamForPrompt),
            )
            streamTextResponse(
              res,
              responseModel,
              reply,
              holdThisStream || holdThisCompletion
                ? () => {
                    if (holdThisCompletion) {
                      heldCompletionCount++
                    }
                    resolveHeldStreamStarted?.()
                    return heldStreamReleased
                  }
                : undefined,
            )
          } else {
            if (holdThisCompletion) {
              heldCompletionCount++
              resolveHeldStreamStarted?.()
              void heldStreamReleased.then(() => nonStreamingTextResponse(res, responseModel, reply))
            } else {
              nonStreamingTextResponse(res, responseModel, reply)
            }
          }
        })

        req.on('error', () => {
          res.writeHead(400)
          res.end('Bad request')
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    })

    server.on('error', reject)

    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }

      const port = addr.port
      const url = `http://127.0.0.1:${port}`

      resolve({
        port,
        url,
        receivedPrompts,
        waitForHeldStream: () => heldStreamStarted,
        waitForHeldCompletion: () => heldStreamStarted,
        releaseHeldStream: () => releaseHeldStream?.(),
        heldCompletionCount: () => heldCompletionCount,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) {
                rejectClose(err)
              } else {
                resolveClose()
              }
            })
          }),
      })
    })
  })
}

// ─── CLI entry point ─────────────────────────────────────────────────────
//
// Lets a bash test drive this with no Node API: start it as a background
// process, poll `--port-file` for the resolved URL, curl the fixed OpenAI
// surface directly.

function parseCliArgs(argv) {
  const args = { port: 0, model: 'mock-model' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') {
      args.port = Number(argv[++i])
    } else if (arg === '--reply') {
      args.reply = argv[++i]
    } else if (arg === '--model') {
      args.model = argv[++i]
    } else if (arg === '--port-file') {
      args.portFile = argv[++i]
    } else if (arg === '-h' || arg === '--help') {
      args.help = true
    }
  }
  return args
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'Usage: node mock-inference-server.mjs [--port N] [--reply TEXT] [--model ID] [--port-file PATH]',
    )
    return
  }

  const mock = await startMockServer({ port: args.port, reply: args.reply, model: args.model })
  console.log(`mock inference server listening at ${mock.url}`)
  if (args.portFile) {
    fs.writeFileSync(args.portFile, mock.url, 'utf8')
  }

  const shutdown = () => {
    mock.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Only run the CLI entry point when this file is executed directly (not
// when imported as a module by desktop's e2e/dev-mock wrappers).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
