// lib/routes.js — Host 侧 HTTP 路由：/workspace-toolkit/* 前缀，供 Client 用
// fetch 调用。刻意不用 /api 前缀（那是 dsh 的浏览器信任边界，POST 请求走
// same-origin 校验，不申请 CSRF token）。
//
// 只读端点用 GET；有副作用的端点用 POST，且校验 same-origin（同 dsh-talk-map
// 的做法：origin 缺失视为本机 curl/工具，放行；跨源浏览器 POST 拒绝）。

import { listArchivedSessions, unarchiveSession, eligibleWorkspacesForCwd } from './archive-store.js'
import { deleteArchivedSession, DeleteSessionError, findSessionDirOnDisk, findArchiveFileIn } from './delete-session.js'
import { revealInFileManager } from './reveal-path.js'
import { homedir } from 'node:os'
import { join as pathJoin, resolve as pathResolve } from 'node:path'

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
  const sessionProjectionCache = ctx.get('sessionProjectionCache')
  const agents = ctx.get('agents')

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

        if (route === 'POST /workspace-toolkit/archive/delete') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          const result = await deleteArchivedSession({
            workspaceRegistry: ctx.workspaceRegistry,
            sessionPersistence: ctx.sessionPersistence,
            agents,
            sessionProjectionCache,
            unarchiveSession,
            dshHome: process.env.DSH_HOME || undefined,
            // 删除成功后通知前端列表移除该会话（DSH 的会话列表事件）。
            emitSessionRemoved: (sessionId) => { ctx.emit('api-session/removed', sessionId) },
          }, body.sessionId, body.confirmation)
          sendJson(response, 200, result)
          return
        }

        if (route === 'POST /workspace-toolkit/archive/reveal') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          // 直接磁盘扫描定位（sessionPersistence.locate() 在新版 DSH 已移除）。
          const sessionsRoot = pathResolve(process.env.DSH_HOME || pathJoin(homedir(), '.dsh'), 'sessions')
          const sessionDir = await findSessionDirOnDisk(sessionsRoot, body.sessionId)
          if (sessionDir === undefined) {
            sendJson(response, 404, { error: '会话存档不存在' })
            return
          }
          const artifact = await findArchiveFileIn(sessionDir)
          const target = artifact || sessionDir
          await revealInFileManager(ctx.subprocess, target, process.platform)
          sendJson(response, 200, { ok: true, path: target })
          return
        }

        if (route === 'POST /workspace-toolkit/archive/eligible-moves') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          // 会话 cwd：优先 sessionQuery（live-preferred），失败则回退磁盘扫描。
          let cwd
          if (sessionQuery && typeof sessionQuery.readSession === 'function') {
            try {
              const snapshot = await sessionQuery.readSession(body.sessionId)
              cwd = snapshot?.session?.cwd
            } catch { /* 会话可能已不存在 */ }
          }
          const workspaces = await eligibleWorkspacesForCwd(ctx.workspaceRegistry, cwd)
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
        const status = err instanceof DeleteSessionError ? err.status : 500
        sendJson(response, status, { error: String((err && err.message) || err) })
      }
    },
  })
}
