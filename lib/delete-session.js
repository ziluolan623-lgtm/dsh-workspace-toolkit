// lib/delete-session.js — 已归档会话的受限永久删除。
//
// DSH 当前没有公开的 sessionPersistence.delete()。因此这里删除的是默认
// 文件型持久化后端创建的单会话目录，但只有在以下条件全部成立时才会执行：
//   1. 会话仍在 archivedSessionIds 中；
//   2. 会话当前没有活跃 Agent；
//   3. 目标目录严格位于 <DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/，
//      目录和存档文件均不是符号链接 / junction，realpath 没有逃出 sessions。
//
// 注意（2026-08-27 修复）：不要依赖 sessionPersistence.list() 判断会话是否
// 存在——实测 list() 会漏报某些已持久化会话（header 索引缺失），导致删除被
// 误判为 "alreadyMissing" 而跳过 rm。现在改为直接扫描磁盘定位会话目录：
//   1. 先扫 <DSH_HOME>/sessions/*/<sessionId>/ 找到目录（不依赖任何服务）；
//   2. 找到了就校验并删除；
//   3. 只有磁盘上真的不存在时才走登记清理 + alreadyMissing 分支。

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
 * 直接扫描 <sessionsRoot>/<encoded-cwd>/<sessionId>/ 定位一个会话目录，
 * 不依赖 sessionPersistence.list()（它会漏报某些会话）。
 * @param {string} sessionsRoot DSH sessions 根目录（<DSH_HOME>/sessions）
 * @param {string} sessionId 目标会话 id
 * @returns {Promise<string | undefined>} 找到的会话目录绝对路径
 */
export async function findSessionDirOnDisk(sessionsRoot, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return undefined
  let cwdDirs
  try {
    cwdDirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const cwdEntry of cwdDirs) {
    if (!cwdEntry.isDirectory() || cwdEntry.isSymbolicLink()) continue
    const candidate = join(sessionsRoot, cwdEntry.name, sessionId)
    try {
      const st = await lstat(candidate)
      if (st.isDirectory() && !st.isSymbolicLink()) return candidate
    } catch {
      // 目录不存在，继续下一个 cwd
    }
  }
  return undefined
}

/**
 * 校验一个待删除的会话目录，返回唯一允许递归删除的目标。
 * 支持两种输入：
 *   - artifactPath（locate() 的产物）：从存档文件反推目录；
 *   - sessionDir（磁盘扫描找到的目录）：直接校验该目录。
 * @param {{sessionId: string, artifactPath?: string, sessionDir?: string, dshHome?: string}} input
 * @returns {Promise<{sessionDir: string, artifactPath: string, sessionsRoot: string}>}
 */
export async function resolveSafeSessionDirectory(input) {
  const { sessionId } = input
  if (!SESSION_ID_RE.test(sessionId)) reject(400, 'sessionId 格式不安全')

  let sessionDir = input.sessionDir
  if (sessionDir !== undefined && sessionDir.trim() !== '') {
    // 磁盘扫描模式：目录已知，需在目录内确认存档文件。
    sessionDir = resolve(sessionDir)
    if (basename(sessionDir) !== sessionId) reject(409, '存档目录与 sessionId 不匹配，拒绝删除')
    let foundArtifact
    for (const name of ARCHIVE_FILE_NAMES) {
      const candidate = join(sessionDir, name)
      try {
        if ((await lstat(candidate)).isFile()) { foundArtifact = candidate; break }
      } catch { /* not this name */ }
    }
    if (!foundArtifact) reject(404, '会话目录内没有找到受支持的存档文件（session.jsonl / session.jsonl.zstd）')
    input.artifactPath = foundArtifact
  }

  const artifactPath = input.artifactPath
  if (typeof artifactPath !== 'string' || artifactPath.trim() === '') {
    reject(409, '无法确定该会话的磁盘存档位置')
  }

  const sessionsRoot = resolve(input.dshHome || defaultDshHome(), 'sessions')
  const resolvedArtifact = resolve(artifactPath)
  sessionDir = dirname(resolvedArtifact)
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
  const { workspaceRegistry } = services

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

  return warnings
}

/**
 * 永久删除一个已归档、且当前没有活跃 Agent 的会话。
 * 删除目标由磁盘扫描决定，不依赖 sessionPersistence.list()（其会漏报会话）。
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

  // 1) 直接扫磁盘定位会话目录（不依赖 list()）。
  const sessionsRoot = resolve(services.dshHome || defaultDshHome(), 'sessions')
  const foundDir = await findSessionDirOnDisk(sessionsRoot, sessionId)

  if (!foundDir) {
    // 磁盘上真的没有这个会话的目录：只做登记清理。
    const warnings = await cleanBookkeeping(services, sessionId)
    return { ok: true, deleted: false, alreadyMissing: true, bytesFreed: 0, warnings }
  }

  // 2) 校验并删除磁盘目录。
  const target = await resolveSafeSessionDirectory({
    sessionId,
    sessionDir: foundDir,
    dshHome: services.dshHome,
  })
  const bytesFreed = await directoryBytes(target.sessionDir)
  await rm(target.sessionDir, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 })

  // 3) 删除成功后清理登记（即使登记清理出现兼容性问题，也把“数据已删除”作为成功返回）。
  const warnings = await cleanBookkeeping(services, sessionId)
  return { ok: true, deleted: true, alreadyMissing: false, bytesFreed, warnings }
}
