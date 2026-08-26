// lib/routes.js — Host 侧 HTTP 路由：/workspace-toolkit/* 前缀，供 Client 用
// fetch 调用。刻意不用 /api 前缀（那是 dsh 的浏览器信任边界，POST 请求走
// same-origin 校验，不申请 CSRF token）。
//
// 只读端点用 GET；有副作用的端点用 POST，且校验 same-origin（同 dsh-talk-map
// 的做法：origin 缺失视为本机 curl/工具，放行；跨源浏览器 POST 拒绝）。

import { listArchivedSessions, unarchiveSession, eligibleWorkspacesForCwd } from './archive-store.js'
import { revealInFileManager } from './reveal-path.js'

const MAX_BODY_BYTES = 64 * 1024

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true // curl / 本机工具
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * 挂载 /workspace-toolkit/* 路由。ctx 需已具备 workspaceRegistry /
 * sessionPersistence / subprocess（由调用方通过 ctx.inject 保证）。
 * @param {import('cordis').Context} ctx
 * @param {{ register(route: object): () => void }} webServer
 * @returns {() => void} 反注册函数
 */
export function registerRoutes(ctx, webServer) {
  const sessionQuery = ctx.get('sessionQuery')

  return webServer.register({
    kind: 'prefix',
    path: '/workspace-toolkit',
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const route = `${request.method ?? 'GET'} ${url.pathname}`
      try {
        if (route === 'GET /workspace-toolkit/archive/list') {
          const sessions = await listArchivedSessions({
            workspaceRegistry: ctx.workspaceRegistry,
            sessionQuery,
          })
          sendJson(response, 200, { sessions })
          return
        }

        if (request.method === 'POST' && !sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin request refused' })
          return
        }

        if (route === 'POST /workspace-toolkit/archive/unarchive') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          await unarchiveSession(ctx.workspaceRegistry, body.sessionId)
          sendJson(response, 200, { ok: true })
          return
        }

        if (route === 'POST /workspace-toolkit/archive/reveal') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          const headers = await ctx.sessionPersistence.list()
          const header = headers.find((h) => h.id === body.sessionId)
          if (header === undefined) {
            sendJson(response, 404, { error: '会话不在持久化存储中' })
            return
          }
          const location = ctx.sessionPersistence.locate(header)
          if (location === undefined) {
            sendJson(response, 409, { error: '当前存储后端没有该会话的独立磁盘文件' })
            return
          }
          await revealInFileManager(ctx.subprocess, location.path, process.platform)
          sendJson(response, 200, { ok: true, path: location.path })
          return
        }

        if (route === 'POST /workspace-toolkit/archive/eligible-moves') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          const headers = await ctx.sessionPersistence.list()
          const header = headers.find((h) => h.id === body.sessionId)
          const workspaces = await eligibleWorkspacesForCwd(ctx.workspaceRegistry, header?.cwd)
          sendJson(response, 200, { workspaces })
          return
        }

        if (route === 'POST /workspace-toolkit/archive/move-to') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
            sendJson(response, 400, { error: 'workspaceId 必填' })
            return
          }
          const workspace = ctx.workspaceRegistry.get(body.workspaceId)
          if (workspace === undefined) {
            sendJson(response, 404, { error: '工作区不存在' })
            return
          }
          await workspace.attachSession(body.sessionId)
          await unarchiveSession(ctx.workspaceRegistry, body.sessionId)
          sendJson(response, 200, { ok: true })
          return
        }

        sendJson(response, 404, { error: 'not found' })
      } catch (err) {
        sendJson(response, 500, { error: String((err && err.message) || err) })
      }
    },
  })
}
