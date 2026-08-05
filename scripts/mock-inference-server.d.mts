import type { ServerResponse } from 'node:http'

/** Default canned assistant reply used when no turn/hook overrides it. */
export declare const DEFAULT_MOCK_REPLY: string

export interface ScriptedTurn {
  /** Assistant text content to stream. Empty string = no visible text. */
  text: string
  /** Tool calls to emit. Omitted/empty = final turn (finish_reason: "stop"). */
  toolCalls?: Array<{
    name: string
    args: Record<string, unknown>
  }>
}

export interface MockServerOptions {
  /** Canned reply text for the default (non-scripted) path. */
  reply?: string
  /** Model id reported by /v1/models and echoed back. Default "mock-model". */
  model?: string
  /**
   * Called once per /v1/chat/completions request with the parsed JSON body.
   * Return a ScriptedTurn to control that turn's response, or nothing to
   * fall through to the default single canned reply.
   */
  onCompletionRequest?: (
    parsedBody: any,
    ctx: { requestCount: number },
  ) => ScriptedTurn | null | undefined
  /** Pause the matching stream after its first token. */
  holdFirstStreamForPrompt?: string
  /** Pause the first completion whose request JSON contains this text. */
  holdFirstCompletionContaining?: string
  /** Ephemeral by default; pass to bind a fixed port. */
  port?: number
}

export interface MockServer {
  port: number
  /** Base URL, e.g. "http://127.0.0.1:54321" (append /v1). */
  url: string
  /** Last user message content of every request received so far. */
  receivedPrompts: string[]
  waitForHeldStream: () => Promise<void>
  waitForHeldCompletion: () => Promise<void>
  releaseHeldStream: () => void
  heldCompletionCount: () => number
  close: () => Promise<void>
}

export declare function startMockServer(options?: MockServerOptions): Promise<MockServer>

export declare function sseChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason?: string | null,
): string

export declare function streamTextResponse(
  res: ServerResponse,
  model: string,
  text: string,
  waitForRelease?: () => Promise<void>,
): void

export declare function nonStreamingTextResponse(res: ServerResponse, model: string, text: string): void

export declare function streamScriptedTurn(
  res: ServerResponse,
  model: string,
  turn: ScriptedTurn,
  callIdSeed?: number,
): void

export declare function nonStreamingScriptedTurn(
  res: ServerResponse,
  model: string,
  turn: ScriptedTurn,
  callIdSeed?: number,
): void
