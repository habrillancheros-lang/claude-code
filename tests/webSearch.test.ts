import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { getSessionId, regenerateSessionId } from '../src/bootstrap/state.js'

// Keep the production tool, resolver, MCP SDK, session lifecycle and result
// formatter. Unrelated UI, telemetry, the Anthropic model and an unrestricted
// MCP policy and proxy configuration are fixtures. webSearchRegistry.test.ts
// checks real policy denial and configured network options.
let anthropicCalls = 0
let proxyOptionsFixture: RequestInit = {}
mock.module('../src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('../src/services/api/claude.js', () => ({
  async *queryModelWithStreaming() {
    anthropicCalls++
    yield { type: 'assistant', message: { content: [{
      type: 'web_search_tool_result', tool_use_id: 'anthropic-search',
      content: [{ title: 'Anthropic fixture', url: 'https://example.org/native' }],
    }] } }
  },
}))
mock.module('../src/tools/WebSearchTool/UI.js', () => ({
  getToolUseSummary: () => '', renderToolResultMessage: () => null,
  renderToolUseMessage: () => null, renderToolUseProgressMessage: () => null,
}))
mock.module('../src/utils/log.js', () => ({ logError: () => {} }))
mock.module('../src/utils/messages.js', () => ({ createUserMessage: (x: unknown) => x }))
mock.module('../src/utils/model/model.js', () => ({
  getMainLoopModel: () => 'claude-sonnet-4', getSmallFastModel: () => 'claude-haiku-4',
}))
mock.module('../src/utils/slowOperations.js', () => ({
  jsonParse: JSON.parse, jsonStringify: JSON.stringify,
}))
mock.module('../src/services/mcp/config.js', () => ({
  filterMcpServersByPolicy: (configs: unknown) => ({ allowed: configs, blocked: [] }),
  isMcpServerDisabled: () => false,
  doesEnterpriseMcpConfigExist: () => false,
}))
mock.module('../src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => proxyOptionsFixture,
}))

const { WebSearchTool } = await import('../src/tools/WebSearchTool/WebSearchTool.js')
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
type RequestRecord = { url: string; headers: Headers; body: any; options?: RequestInit }
let requests: RequestRecord[] = []
let mode = 'success'

function installServerFixture() {
  globalThis.fetch = (async (url: any, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), headers: new Headers(init.headers), body, options: init })
    if (init.signal?.aborted) throw init.signal.reason
    if (mode === 'hang' || (mode === 'hang-search' && body?.method === 'tools/call')) {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    }
    if (!body || body.id === undefined) return new Response(null, { status: 202 })
    if (mode === 'http-error') return new Response('unavailable', { status: 503 })
    let result: unknown
    switch (body.method) {
      case 'initialize': result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'parallel-fixture', version: '1' },
      }; break
      case 'tools/list': result = { tools: mode === 'missing-tool' ? [] : [{
        name: 'web_search', description: 'Search fixture',
        inputSchema: { type: 'object', properties: {} },
      }] }; break
      case 'tools/call': result = mode === 'tool-error'
        ? { isError: true, content: [{ type: 'text', text: 'Search fixture failed' }] }
        : mode === 'empty' ? { content: [] }
        : { content: [{ type: 'text', text: JSON.stringify({
          results: [
            { title: 'Bun docs', url: 'https://bun.sh/docs', excerpts: ['Bun runtime documentation'] },
            { title: 'Unsafe URL fixture', url: 'javascript:alert(1)' },
          ],
        }) }] }; break
      default: throw new Error(`Unexpected MCP method ${body.method}`)
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  }) as typeof fetch
}

function context(agentId?: string, controller = new AbortController()) {
  return {
    agentId, abortController: controller,
    getAppState: () => ({ toolPermissionContext: {}, effortValue: undefined }),
    options: { mainLoopModel: 'claude-sonnet-4', thinkingConfig: { type: 'disabled' },
      agentDefinitions: { activeAgents: [] } },
  } as any
}

async function search(query = 'Bun runtime documentation', ctx = context(), extra = {}) {
  const input = WebSearchTool.inputSchema.parse({ query, ...extra })
  const validation = await WebSearchTool.validateInput(input, ctx)
  if (!validation.result) throw new Error(validation.message)
  return await WebSearchTool.call(input, ctx, undefined as any, undefined as any)
}

beforeEach(() => {
  requests = []; anthropicCalls = 0; mode = 'success'; proxyOptionsFixture = {}
  for (const key of ['CLAUDE_CODE_WEB_SEARCH_PROVIDER', 'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN', 'PARALLEL_API_KEY', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[key]
  installServerFixture()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

describe('WebSearch runtime caller with the real MCP SDK', () => {
  test('fresh no-key search reaches discovery, execution and the model result formatter', async () => {
    expect(WebSearchTool.isEnabled()).toBe(true)
    const { data } = await search()
    const mapped = WebSearchTool.mapToolResultToToolResultBlockParam(data, 'tool-use-1')
    expect(mapped.content).toContain('https://bun.sh/docs')
    expect(mapped.content).toContain('Bun runtime documentation')
    expect(mapped.tool_use_id).toBe('tool-use-1')
    expect(anthropicCalls).toBe(0)
    expect(requests.map(r => r.body?.method)).toContain('tools/list')
    const call = requests.find(r => r.body?.method === 'tools/call')!
    expect(call.body.params.name).toBe('web_search')
    expect(call.body.params.arguments.search_queries).toEqual(['Bun runtime documentation'])
    for (const request of requests) {
      expect(request.url).toBe('https://search.parallel.ai/mcp')
      expect(request.headers.get('user-agent')).toContain('claude-code')
      expect(request.headers.has('authorization')).toBe(false)
    }
  })

  test('ambient model and Parallel credentials are not sent to the anonymous service', async () => {
    process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key'
    process.env.PARALLEL_API_KEY = 'fixture-parallel-key'
    await search()
    for (const r of requests) expect(JSON.stringify(r.body) + [...r.headers].join()).not.toContain('fixture-')
  })

  test('configured network options reach every owned MCP request', async () => {
    proxyOptionsFixture = {
      proxy: 'http://proxy.example:8080',
      tls: { cert: 'fixture-cert', key: 'fixture-key' },
      keepalive: false,
    } as RequestInit
    await search()
    for (const r of requests) {
      expect((r.options as any).proxy).toBe('http://proxy.example:8080')
      expect((r.options as any).tls).toEqual({ cert: 'fixture-cert', key: 'fixture-key' })
      expect(r.options!.keepalive).toBe(false)
      expect(r.options!.redirect).toBe('error')
    }
  })

  test('explicit Anthropic selection uses the original provider and result contract', async () => {
    process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER = 'anthropic'
    const { data } = await search()
    expect(WebSearchTool.mapToolResultToToolResultBlockParam(data, 'native').content).toContain('https://example.org/native')
    expect(anthropicCalls).toBe(1)
    expect(requests).toHaveLength(0)
  })

  test('domain filters retain native search and explicit Parallel does not discard them', async () => {
    await search('Bun docs', context(), { allowed_domains: ['bun.sh'] })
    await search('Bun docs', context(), { blocked_domains: ['example.org'] })
    expect(anthropicCalls).toBe(2)
    expect(requests).toHaveLength(0)
    process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER = 'parallel'
    await expect(search('Bun docs', context(), { allowed_domains: ['bun.sh'] })).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  test('unknown explicit providers fail before a network request', async () => {
    process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER = 'typo'
    await expect(search()).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  test('Parallel is usable on Bedrock while explicit native selection keeps its original availability', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(WebSearchTool.isEnabled()).toBe(true)
    await search()
    process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER = 'anthropic'
    expect(WebSearchTool.isEnabled()).toBe(false)
    await expect(search()).rejects.toThrow()
  })

  test('link metadata only contains valid HTTP URLs and empty results are errors', async () => {
    const { data } = await search()
    const links = data.results.filter(r => typeof r !== 'string')
    expect(links).toHaveLength(1)
    expect((links[0] as any).content).toEqual([{ title: 'Bun docs', url: 'https://bun.sh/docs' }])
    mode = 'empty'
    await expect(search()).rejects.toThrow('no text results')
  })

  test('the existing permission gate remains passthrough instead of automatically granting search', async () => {
    expect((await WebSearchTool.checkPermissions({ query: 'Bun docs' }, context())).behavior).toBe('passthrough')
    expect(requests).toHaveLength(0)
  })

  test('same conversation keeps its identity, independent and interleaved agents do not share it', async () => {
    const firstRoot = getSessionId()
    await search('first search')
    await search('follow-up search')
    await Promise.all([search('agent one', context('agent-one')), search('agent two', context('agent-two'))])
    await search('agent one follow-up', context('agent-one'))
    const ids = requests.filter(r => r.body?.method === 'tools/call').map(r => r.body.params.arguments.session_id)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[3])
    expect(ids[4]).toBe(ids[2])
    expect(ids[0]).not.toBe(ids[2])
    regenerateSessionId()
    expect(getSessionId()).not.toBe(firstRoot)
    await search('new conversation')
    const last = requests.filter(r => r.body?.method === 'tools/call').at(-1)!
    expect(last.body.params.arguments.session_id).not.toBe(ids[0])
    // A background agent can outlive a parent /clear or /resume. Its own
    // conversation continues even though the main conversation has changed.
    await search('background agent follow-up', context('agent-one'))
    const background = requests.filter(r => r.body?.method === 'tools/call').at(-1)!
    expect(background.body.params.arguments.session_id).toBe(ids[2])
  })

  test('provider errors propagate without falling back or rotating conversation identity', async () => {
    mode = 'tool-error'
    await expect(search()).rejects.toThrow()
    const failed = requests.find(r => r.body?.method === 'tools/call')!.body.params.arguments.session_id
    mode = 'success'
    await search()
    const retried = requests.filter(r => r.body?.method === 'tools/call').at(-1)!.body.params.arguments.session_id
    expect(retried).toBe(failed)
    expect(anthropicCalls).toBe(0)
  })

  test('HTTP and discovery errors do not call an alternative provider', async () => {
    mode = 'http-error'; await expect(search()).rejects.toThrow()
    mode = 'missing-tool'; await expect(search()).rejects.toThrow()
    expect(anthropicCalls).toBe(0)
  })

  test('already-aborted calls and cancellation during search terminate without fallback', async () => {
    const before = new AbortController(); before.abort(new Error('cancel before search'))
    await expect(search('cancelled', context(undefined, before))).rejects.toThrow()
    expect(requests).toHaveLength(0)
    mode = 'hang-search'
    const during = new AbortController()
    const pending = search('cancelled during search', context(undefined, during))
    while (!requests.some(r => r.body?.method === 'tools/call')) await new Promise(r => setTimeout(r, 1))
    during.abort(new Error('cancel during search'))
    await expect(pending).rejects.toThrow()
    expect(anthropicCalls).toBe(0)
  })

  test('the whole-operation deadline covers both handshake and tool execution', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(10))
    try {
      mode = 'hang'
      await expect(search()).rejects.toThrow()
      mode = 'hang-search'
      await expect(search()).rejects.toThrow()
      expect(timeout).toHaveBeenCalledWith(60_000)
      expect(anthropicCalls).toBe(0)
    } finally {
      timeout.mockRestore()
    }
  })

  test.skipIf(process.env.PARALLEL_LIVE_SEARCH !== '1')('live anonymous WebSearch reaches the public service', async () => {
    const observed: RequestRecord[] = []
    globalThis.fetch = (async (url: any, init: RequestInit = {}) => {
      observed.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
      const response = await originalFetch(url, init)
      console.log('LIVE_MCP_RESPONSE', response.status, await response.clone().text())
      return response
    }) as typeof fetch
    const { data } = await search('Bun JavaScript runtime official documentation')
    const formatted = WebSearchTool.mapToolResultToToolResultBlockParam(data, 'live-search')
    expect(String(formatted.content)).toMatch(/https?:\/\//)
    for (const r of observed) {
      expect(r.url).toBe('https://search.parallel.ai/mcp')
      expect(r.headers.get('user-agent')).toContain('claude-code')
      expect(r.headers.has('authorization')).toBe(false)
    }
    console.log('LIVE_MODEL_TOOL_RESULT', JSON.stringify(formatted))
  })
})
