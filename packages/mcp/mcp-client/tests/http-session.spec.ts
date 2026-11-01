/** Streamable HTTP session teardown against a stateful in-process MCP server. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

/** Start a stateful MCP endpoint and record the HTTP methods it receives. */
async function startStatefulServer(): Promise<{ url: string; methods: string[]; sessions: string[] }> {
  const methods: string[] = []
  const sessions: string[] = []
  const mcp = new McpServer({ name: 'stateful-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const id = randomUUID()
      sessions.push(id)
      return id
    },
  })
  await mcp.connect(transport)
  const handle = toNodeHandler({ fetch: request => transport.handleRequest(request) })
  const server = createServer((request, response) => {
    methods.push(request.method ?? '')
    handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stateful fixture has no TCP address')
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await mcp.close()
  })
  return { url: `http://127.0.0.1:${address.port}/mcp`, methods, sessions }
}

describe('streamable-http session teardown', () => {
  it('ends the server session with DELETE when the plugin unloads', async () => {
    const server = await startStatefulServer()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'stateful',
      url: server.url,
      headers: {},
      toolCallTimeoutMs: 10_000,
      failOnStartupError: true,
    }
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, config)
    await fiber
    await vi.waitFor(() => { expect(server.sessions).toHaveLength(1) })

    await fiber.dispose()

    expect(server.methods).toContain('DELETE')
  })
})
