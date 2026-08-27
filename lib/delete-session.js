// lib/delete-session.js — 已归档会话的受限永久删除。
//
// DSH 当前没有公开的 sessionPersistence.delete()。因此这里删除的是默认
// 文件型持久化后端创建的单会话目录，但只有在以下条件全部成立时才会执行：
//   1. 会话仍在 archivedSessionIds 中；
//   2. 会话当前没有活跃 Agent；
//   3. locate() 返回的文件严格位于
//      <DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/session.jsonl[.zstd]；
//   4. 目录和存档文件均不是符号链接 / junction，realpath 也没有逃出 sessions。
//
// 这样删除范围不会碰到工作区源码目录，也不会让仍在运行的 Agent 在退出时把
// 刚删除的记录重新写回。

import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const ARCHIVE_FILE_NAMES = new Set(['session.jsonl', 'session.jsonl.zstd'])

export class DeleteSessionError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'DeleteSessionError'
    this.status = status
  }
}

function reject(status, message) {
  throw new DeleteSessionError(status, message)
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

function defaultDshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured || join(homedir(), '.dsh')
}

/**
 * 校验 locate() 返回的路径，并返回唯一允许递归删除的会话目录。
 * @param {{sessionId: string, artifactPath: string, dshHome?: string}} input
 * @returns {Promise<{sessionDir: string, artifactPath: string, sessionsRoot: string}>}
 */
export async function resolveSafeSessionDirectory(input) {
  const { sessionId, artifactPath } = input
  if (!SESSION_ID_RE.test(sessionId)) reject(400, 'sessionId 格式不安全')
  if (typeof artifactPath !== 'string' || artifactPath.trim() === '') {
    reject(409, '当前存储后端没有该会话的独立磁盘文件')
  }

  const sessionsRoot = resolve(input.dshHome || defaultDshHome(), 'sessions')
  const resolvedArtifact = resolve(artifactPath)
  const sessionDir = dirname(resolvedArtifact)
  if (basename(sessionDir) !== sessionId) reject(409, '存档目录与 sessionId 不匹配，拒绝删除')
  if (!ARCHIVE_FILE_NAMES.has(basename(resolvedArtifact))) {
    reject(409, '存档文件名不是受支持的 DSH 会话文件，拒绝删除')
  }

  const rel = relative(sessionsRoot, sessionDir)
  const segments = rel.split(sep).filter(Boolean)
  if (segments.length !== 2 || segments.some((part) => part === '.' || part === '..') || !isInside(sessionsRoot, sessionDir)) {
    reject(409, '存档路径不在 DSH sessions 的单会话目录中，拒绝删除')
  }

  let rootReal
  let dirStat
  let dirReal
  let artifactStat
  let artifactReal
  try {
    ;[rootReal, dirStat, dirReal, artifactStat, artifactReal] = await Promise.all([
      realpath(sessionsRoot),
      lstat(sessionDir),
      realpath(sessionDir),
      lstat(resolvedArtifact),
      realpath(resolvedArtifact),
    ])
  } catch (error) {
    reject(404, `会话存档不存在或无法读取：${String(error?.message || error)}`)
  }

  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) reject(409, '会话存档目录不是普通目录，拒绝删除')
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) reject(409, '会话存档不是普通文件，拒绝删除')
  if (!isInside(rootReal, dirReal) || dirname(artifactReal) !== dirReal) {
    reject(409, '会话存档 realpath 逃出 DSH sessions，拒绝删除')
  }

  return { sessionDir, artifactPath: resolvedArtifact, sessionsRoot }
}

async function directoryBytes(path) {
  let total = 0
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await lstat(child)).size
  }
  return total
}

async function cleanBookkeeping(services, sessionId) {
  const warnings = []
  const { workspaceRegistry, sessionProjectionCache } = services

  try {
    const workspaces = await workspaceRegistry.list()
    for (const workspace of workspaces) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        warnings.push(`工作区 ${workspace.id || workspace.title || '(unknown)'} 登记清理失败：${String(error?.message || error)}`)
      }
    }
  } catch (error) {
    warnings.push(`无法枚举工作区登记：${String(error?.message || error)}`)
  }

  try {
    await services.unarchiveSession(workspaceRegistry, sessionId)
  } catch (error) {
    warnings.push(`归档登记清理失败：${String(error?.message || error)}`)
  }

  if (sessionProjectionCache && typeof sessionProjectionCache.requireTable === 'function') {
    try {
      const table = sessionProjectionCache.requireTable()
      if (table && typeof table.delete === 'function') await table.delete(sessionId)
    } catch (error) {
      warnings.push(`投影缓存清理失败（可通过重启自动恢复）：${String(error?.message || error)}`)
    }
  }

  return warnings
}

/**
 * 永久删除一个已归档、且当前没有活跃 Agent 的会话。
 * @param {object} services
 * @param {string} sessionId
 * @param {string} confirmation 必须精确为 DELETE
 */
export async function deleteArchivedSession(services, sessionId, confirmation) {
  if (!SESSION_ID_RE.test(sessionId)) reject(400, 'sessionId 格式不安全')
  if (confirmation !== 'DELETE') reject(400, '必须输入 DELETE 才能永久删除')
  if (!services.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
    reject(409, '只能永久删除仍处于归档状态的会话')
  }
  if (!services.agents || typeof services.agents.get !== 'function') {
    reject(503, 'Agent 状态服务不可用，为避免删除运行中的会话，已拒绝操作')
  }
  if (services.agents.get(sessionId) !== undefined) {
    reject(409, '该会话仍在运行。请先关闭会话或重启 DSH，再重新删除')
  }

  const headers = await services.sessionPersistence.list()
  const header = headers.find((item) => item.id === sessionId)
  if (!header) {
    const warnings = await cleanBookkeeping(services, sessionId)
    return { ok: true, deleted: false, alreadyMissing: true, bytesFreed: 0, warnings }
  }

  const location = services.sessionPersistence.locate(header)
  if (!location) reject(409, '当前存储后端没有该会话的独立磁盘文件')
  const target = await resolveSafeSessionDirectory({
    sessionId,
    artifactPath: location.path,
    dshHome: services.dshHome,
  })
  const bytesFreed = await directoryBytes(target.sessionDir)

  // 删除成功后，后续清理即使出现兼容性问题，也应把“数据已删除”作为成功结果
  // 返回给客户端，避免用户因 500 重试而困惑。
  await rm(target.sessionDir, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 })
  const warnings = await cleanBookkeeping(services, sessionId)
  return { ok: true, deleted: true, alreadyMissing: false, bytesFreed, warnings }
}
