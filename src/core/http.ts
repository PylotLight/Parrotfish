// Small HTTP helpers for OpenAI-compatible servers (llama-server, parakeet-api, ptts-openai-server...).

/** `http://host:8081/v1` + `/chat/completions`, tolerating trailing/leading slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function authHeaders(apiKey: unknown): Record<string, string> {
  return typeof apiKey === 'string' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export async function expectOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response
  let body = ''
  try {
    body = (await response.text()).slice(0, 300)
  } catch {
    // ignore
  }
  throw new Error(`${what} failed: HTTP ${response.status}${body ? ` ${body}` : ''}`)
}

async function* streamIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

export type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>

/** Splits a byte or string stream into lines (SSE and JSONL). */
export async function* readLines(body: ByteSource): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const iterable: AsyncIterable<Uint8Array | string> = body instanceof ReadableStream ? streamIterable(body) : body
  for await (const chunk of iterable) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      yield buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer) yield buffer
}

/** Server-sent events `data:` payloads, stopping at `[DONE]`. */
export async function* sseData(body: ByteSource): AsyncGenerator<string> {
  for await (const line of readLines(body)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') return
    if (data) yield data
  }
}

/** The content delta of an OpenAI chat.completion.chunk (reasoning_content is skipped). */
export function chatDelta(json: unknown): string {
  const choice = (json as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]
  const content = choice?.delta?.content
  return typeof content === 'string' ? content : ''
}

/** Raw bytes of a response body as chunks (for PCM streams). */
export async function* bodyChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    yield new Uint8Array(await response.arrayBuffer())
    return
  }
  yield* streamIterable(response.body)
}
