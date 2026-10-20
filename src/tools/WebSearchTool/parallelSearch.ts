import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHash } from 'crypto'
import type { Output, SearchResult } from './WebSearchTool.js'

export const PARALLEL_SEARCH_SERVER_NAME = 'parallel-search'
export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp'
const PARALLEL_SEARCH_USER_AGENT =
  'claude-code/parallel-search (+https://github.com/tanbiralam/claude-code)'
const PARALLEL_SEARCH_TIMEOUT_MS = 60_000

type SearchInput = {
  allowed_domains?: string[]
  blocked_domains?: string[]
}

/** Domain filters remain on the existing provider: anonymous MCP has no filter arguments. */
export function resolveWebSearchProvider(input: SearchInput = {}):
  | 'parallel'
  | 'anthropic' {
  const configured = process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER
  if (configured && configured !== 'parallel' && configured !== 'anthropic') {
    throw new Error(
      'CLAUDE_CODE_WEB_SEARCH_PROVIDER must be parallel or anthropic.',
    )
  }
  if (input.allowed_domains?.length || input.blocked_domains?.length) {
    if (configured === 'parallel') {
      throw new Error(
        'Domain filters require CLAUDE_CODE_WEB_SEARCH_PROVIDER=anthropic. Parallel anonymous search does not support domain filter settings.',
      )
    }
    return 'anthropic'
  }
  return configured === 'anthropic' ? 'anthropic' : 'parallel'
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Keep the server's excerpts intact and surface JSON result links in the existing UI. */
function searchResults(texts: string[]): Output['results'] {
  const links: SearchResult['content'] = []
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || !('results' in parsed)) continue
      if (!Array.isArray(parsed.results)) continue
      for (const hit of parsed.results) {
        if (hit && typeof hit === 'object' && httpUrl(hit.url)) {
          links.push({
            title: typeof hit.title === 'string' ? hit.title : hit.url,
            url: hit.url,
          })
        }
      }
    } catch {
      // MCP text may be Markdown rather than JSON. It remains useful to the model.
    }
  }
  return links.length
    ? [{ tool_use_id: 'parallel-web-search', content: links }, ...texts]
    : texts
}

export async function runParallelSearch({
  query,
  sessionId,
  agentId,
  signal: callerSignal,
  fetchOptions,
}: {
  query: string
  sessionId: string
  agentId?: string
  signal: AbortSignal
  fetchOptions?: RequestInit
}): Promise<Output> {
  const startTime = performance.now()
  // These are opaque runtime identities, not user text or credentials. An agent
  // owns its conversation even if the main session resets while it runs.
  const conversationId = createHash('sha256')
    .update(JSON.stringify(agentId ? ['agent', agentId] : ['session', sessionId]))
    .digest('hex')
  const signal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(PARALLEL_SEARCH_TIMEOUT_MS),
  ])
  signal.throwIfAborted()

  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(PARALLEL_SEARCH_URL),
    {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers)
        headers.set('User-Agent', PARALLEL_SEARCH_USER_AGENT)
        return fetch(url, {
          ...init,
          ...fetchOptions,
          headers,
          redirect: 'error',
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        })
      },
    },
  )

  try {
    await client.connect(transport)
    const tools = await client.listTools({}, { signal })
    if (!tools.tools.some(tool => tool.name === 'web_search')) {
      throw new Error('Parallel Search MCP did not advertise web_search.')
    }
    const response = CallToolResultSchema.parse(await client.callTool(
      {
        name: 'web_search',
        arguments: {
          objective: query,
          search_queries: [query],
          session_id: conversationId,
        },
      },
      undefined,
      { signal },
    ))
    const texts = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
    if (response.isError) {
      throw new Error(`Parallel web search failed: ${texts.join('\n')}`)
    }
    if (!texts.length) {
      throw new Error('Parallel web search returned no text results.')
    }
    return {
      query,
      results: searchResults(texts),
      durationSeconds: (performance.now() - startTime) / 1000,
    }
  } finally {
    await client.close()
  }
}
