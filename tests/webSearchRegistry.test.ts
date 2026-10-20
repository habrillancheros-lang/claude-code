import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the production registry selects WebSearch and respects deny, simple mode and provider availability', async () => {
  // A fresh process keeps the unrelated UI/model fixtures in webSearch.test.ts
  // out of this check. Registry, permission matcher, tool and MCP SDK are real.
  const configDir = await mkdtemp(join(tmpdir(), 'claude-web-search-registry-'))
  try {
    await writeFile(join(configDir, 'client-cert.pem'), 'fixture-client-cert')
    await writeFile(join(configDir, 'client-key.pem'), 'fixture-client-key')
    const child = Bun.spawn([process.execPath, '--preload', './plugins/bunBundleDev.ts', '--eval', `
      const { getTools } = await import('./src/tools.ts')
      const { getEmptyToolPermissionContext } = await import('./src/Tool.ts')
      const { WebSearchTool } = await import('./src/tools/WebSearchTool/WebSearchTool.ts')
      const { setSessionSettingsCache } = await import('./src/utils/settings/settingsCache.ts')
      const { setMcpServerEnabled, doesEnterpriseMcpConfigExist } = await import('./src/services/mcp/config.ts')
      const { getManagedFilePath } = await import('./src/utils/settings/managedPath.ts')
      const { disableKeepAlive } = await import('./src/utils/proxy.ts')
      disableKeepAlive()
      const context = getEmptyToolPermissionContext()
      const selected = getTools(context).find(tool => tool.name === 'WebSearch')
      const requests = []
      globalThis.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        const headers = new Headers(init.headers)
        requests.push({ url: String(url), ua: headers.get('user-agent'), auth: headers.has('authorization'), method: body?.method,
          proxy: init.proxy, unix: init.unix, cert: init.tls?.cert, key: init.tls?.key, keepalive: init.keepalive })
        if (!body || body.id === undefined) return new Response(null, { status: 202 })
        const result = body.method === 'initialize'
          ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'registry-fixture', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Bun docs', url: 'https://bun.sh/docs', excerpts: ['Registry search excerpt'] }] }) }] }
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      }
      const input = selected.inputSchema.parse({ query: 'Bun runtime docs' })
      const caller = { abortController: new AbortController() }
      const validation = await selected.validateInput(input, caller)
      if (!validation.result) throw new Error(validation.message)
      const { data } = await selected.call(input, caller)
      const formatted = selected.mapToolResultToToolResultBlockParam(data, 'registry-search')
      async function blocksWithoutRequests(settings) {
        setSessionSettingsCache({ settings, errors: [] })
        const before = requests.length
        const rejected = !(await selected.validateInput(input, caller)).result
        let directCallRejected = false
        try { await selected.call(input, caller) } catch { directCallRejected = true }
        return rejected && directCallRejected && requests.length === before
      }
      const emptyAllowlistBlocked = await blocksWithoutRequests({ allowedMcpServers: [] })
      const urlDenyBlocked = await blocksWithoutRequests({ deniedMcpServers: [{ serverUrl: 'https://search.parallel.ai/mcp' }] })
      const nameDenyBlocked = await blocksWithoutRequests({ deniedMcpServers: [{ serverName: 'parallel-search' }] })
      setSessionSettingsCache({ settings: { allowedMcpServers: [{ serverUrl: 'https://search.parallel.ai/mcp' }] }, errors: [] })
      const explicitUrlAllowed = (await selected.validateInput(input, caller)).result
      const allowedStart = requests.length
      await selected.call(input, caller)
      const explicitUrlExecuted = explicitUrlAllowed && requests.length > allowedStart
      setMcpServerEnabled('parallel-search', false)
      const disabledServerBlocked = await blocksWithoutRequests({})
      setMcpServerEnabled('parallel-search', true)
      process.env.USER_TYPE = 'ant'
      process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = process.env.CLAUDE_CONFIG_DIR
      getManagedFilePath.cache.clear()
      doesEnterpriseMcpConfigExist.cache.clear()
      const { writeFile, rm } = await import('node:fs/promises')
      const managedFile = process.env.CLAUDE_CONFIG_DIR + '/managed-mcp.json'
      await writeFile(managedFile, JSON.stringify({ mcpServers: {} }))
      const enterpriseConfigBlocked = await blocksWithoutRequests({})
      await rm(managedFile)
      process.env.USER_TYPE = 'external'
      delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
      getManagedFilePath.cache.clear()
      doesEnterpriseMcpConfigExist.cache.clear()
      const denied = getEmptyToolPermissionContext()
      denied.alwaysDenyRules.session = ['WebSearch']
      const denyRemoved = !getTools(denied).some(tool => tool.name === 'WebSearch')
      process.env.CLAUDE_CODE_SIMPLE = '1'
      const simpleRemoved = !getTools(context).some(tool => tool.name === 'WebSearch')
      delete process.env.CLAUDE_CODE_SIMPLE
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      const parallelBedrock = getTools(context).includes(WebSearchTool)
      process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER = 'anthropic'
      const nativeBedrockRemoved = !getTools(context).some(tool => tool.name === 'WebSearch')
      console.log(JSON.stringify({ actualTool: selected === WebSearchTool, denyRemoved, simpleRemoved, parallelBedrock, nativeBedrockRemoved, emptyAllowlistBlocked, urlDenyBlocked, nameDenyBlocked, explicitUrlExecuted, disabledServerBlocked, enterpriseConfigBlocked, content: formatted.content, requests }))
    `], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env, USER_TYPE: 'external', FEATURE_FLAGS: '',
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_WEB_SEARCH_PROVIDER: '', CLAUDE_CODE_SIMPLE: '',
        CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
        CLAUDE_CODE_REPL: '0', CLAUDE_CODE_VERIFY_PLAN: '0', ENABLE_LSP_TOOL: '0',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
        ANTHROPIC_MODEL: 'claude-sonnet-4-20250514', ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', PARALLEL_API_KEY: '',
        https_proxy: '', http_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: 'http://proxy.fixture.invalid:8080',
        ANTHROPIC_UNIX_SOCKET: '/tmp/anthropic-fixture.sock',
        CLAUDE_CODE_CLIENT_CERT: join(configDir, 'client-cert.pem'),
        CLAUDE_CODE_CLIENT_KEY: join(configDir, 'client-key.pem'),
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    const result = JSON.parse(stdout)
    for (const key of ['actualTool', 'denyRemoved', 'simpleRemoved', 'parallelBedrock', 'nativeBedrockRemoved',
      'emptyAllowlistBlocked', 'urlDenyBlocked', 'nameDenyBlocked', 'explicitUrlExecuted', 'disabledServerBlocked', 'enterpriseConfigBlocked']) {
      expect(result[key]).toBe(true)
    }
    expect(result.content).toContain('https://bun.sh/docs')
    expect(result.content).toContain('Registry search excerpt')
    expect(result.requests.map((request: any) => request.method)).toContain('tools/list')
    expect(result.requests.map((request: any) => request.method)).toContain('tools/call')
    for (const request of result.requests) {
      expect(request.url).toBe('https://search.parallel.ai/mcp')
      expect(request.ua).toContain('claude-code')
      expect(request.auth).toBe(false)
      expect(request.proxy).toBe('http://proxy.fixture.invalid:8080')
      expect(request.unix).toBeUndefined()
      expect(request.cert).toBe('fixture-client-cert')
      expect(request.key).toBe('fixture-client-key')
      expect(request.keepalive).toBe(false)
    }
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})
