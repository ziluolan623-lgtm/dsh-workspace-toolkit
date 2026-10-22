// lib/routes.js — Host 侧 HTTP 路由：/workspace-toolkit/* 前缀，供 Client 用
// fetch 调用。刻意不用 /api 前缀（那是 dsh 的浏览器信任边界，POST 请求走
// same-origin 校验，不申请 CSRF token）。
//
// 只读端点用 GET；有副作用的端点用 POST，且校验 same-origin（同 dsh-talk-map
// 的做法：origin 缺失视为本机 curl/工具，放行；跨源浏览器 POST 拒绝）。

import { listArchivedSessions, unarchiveSession } from './archive-store.js'
import { deleteArchivedSession, DeleteSessionError, findSessionDirOnDisk, findArchiveFileIn } from './delete-session.js'
import { revealInFileManager } from './reveal-path.js'
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join as pathJoin, resolve as pathResolve } from 'node:path'

/**
 * 解析一个会话的工作目录（cwd）。
 * 优先走 sessionQuery（live-preferred，读得到最新 header）；失败时回退到直接读取
 * 磁盘存档的第一帧 header——DSH 的日志是逐帧追加的 zstd，第一帧正好是 header，
 * 所以 zstdDecompressSync 解出的第一个 JSON 就是它。
 * @param {string} sessionsRoot <DSH_HOME>/sessions
 * @param {string} sessionId 会话 id
 * @param {object | undefined} sessionQuery 可选服务
 * @returns {Promise<string | undefined>}
 */
async function resolveSessionCwd(sessionsRoot, sessionId, sessionQuery) {
  if (sessionQuery && typeof sessionQuery.readSession === 'function') {
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      const cwd = snapshot?.session?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch { /* 回退到磁盘 */ }
  }
  const dir = await findSessionDirOnDisk(sessionsRoot, sessionId)
  if (dir === undefined) return undefined
  const artifact = await findArchiveFileIn(dir)
  if (artifact === undefined) return undefined
  let text
  try {
    const raw = await readFile(artifact)
    text = artifact.toLowerCase().endsWith('.zstd')
      ? zstdDecompressSync(raw).toString('utf8')
      : raw.toString('utf8')
  } catch {
    return undefined
  }
  const firstLine = text.split('\n', 1)[0]
  try {
    const header = JSON.parse(firstLine)
    return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  } catch {
    return undefined
  }
}

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

        if (route === 'POST /workspace-toolkit/archive/register-workspace') {
          const body = await readJsonBody(request)
          if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            sendJson(response, 400, { error: 'sessionId 必填' })
            return
          }
          const sessionsRoot = pathResolve(process.env.DSH_HOME || pathJoin(homedir(), '.dsh'), 'sessions')
          const cwd = await resolveSessionCwd(sessionsRoot, body.sessionId, sessionQuery)
          if (cwd === undefined) {
            sendJson(response, 404, { error: '无法确定该会话的工作目录（存档缺失或 header 不可读）' })
            return
          }
          try {
            // 把会话自己的目录注册为工作区（已存在则复用），随后取消归档，会话即归入该工作区。
            const workspace = await ctx.workspaceRegistry.create(cwd)
            await unarchiveSession(ctx.workspaceRegistry, body.sessionId)
            sendJson(response, 200, {
              ok: true,
              workspace: {
                id: String(workspace.id),
                title: workspace.title,
                path: workspace.path,
              },
            })
          } catch (err) {
            sendJson(response, 409, { error: `注册工作区失败：${String(err && err.message ? err.message : err)}` })
          }
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
