// lib/archive-store.js — Host 侧归档面板数据源与"取消归档"实现。
//
// 取消归档优先使用官方 API：新版 DSH（2026-10+）的 ctx.workspaceRegistry 已公开
// unarchiveSession(sessionId)。旧版 DSH 没有该方法，此时回退到内部实现：直接调用
// WorkspaceRegistry 实例上未公开的 setState()/requireState()，复刻 archiveSession()
// 自己的读-改-写模式（同一 enqueueOperation 队列、同一 storage domain）——不触碰
// 任何磁盘文件。两条路径都只把 sessionId 从 archivedSessionIds 摘掉；官方文档明确
// "archiving 从不触碰工作区记账——归档时保留 sessionIds 位置，取消归档会恢复原位"。

/**
 * 取消归档一个会话：把 sessionId 从归档集合里摘掉。
 * 优先走官方 unarchiveSession()；旧版 DSH 回退到内部读-改-写。
 * @param {object} registry ctx.workspaceRegistry 服务实例
 * @param {string} sessionId 要取消归档的会话 id
 * @returns {Promise<void>}
 */
export function unarchiveSession(registry, sessionId) {
  // 官方 API（新版 DSH 提供）
  if (typeof registry.unarchiveSession === 'function') {
    return registry.unarchiveSession(sessionId)
  }
  // 旧版回退：内部读-改-写
  if (typeof registry.enqueueOperation !== 'function'
    || typeof registry.requireState !== 'function'
    || typeof registry.setState !== 'function') {
    throw new Error(
      'dsh-workspace-toolkit: workspaceRegistry 既没有官方 unarchiveSession()，'
      + '也没有 enqueueOperation/requireState/setState 内部方法——取消归档功能需要更新以匹配当前 DSH 版本。',
    )
  }
  return registry.enqueueOperation(async () => {
    const state = registry.requireState()
    if (!state.archivedSessionIds.includes(sessionId)) return
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    })
  })
}

/**
 * 列出全部已归档会话的展示信息：id、标题（尽力读取，读不到就留空）、cwd、更新时间。
 * @param {object} services { workspaceRegistry, sessionQuery? }
 * @returns {Promise<Array<{sessionId: string, title?: string, cwd?: string, updatedAt?: number}>>}
 */
export async function listArchivedSessions(services) {
  const { workspaceRegistry, sessionQuery } = services
  const ids = [...workspaceRegistry.archivedSessionIds]
  if (ids.length === 0) return []

  let recordsById = new Map()
  if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
    try {
      const records = await sessionQuery.listSessions()
      recordsById = new Map(records.map((r) => [r.header.id, r]))
    } catch {
      // 列举失败不阻断面板：只是标题/cwd 缺失，sessionId 仍然可用。
    }
  }

  let titlesById = new Map()
  if (sessionQuery && typeof sessionQuery.readTitleSnapshots === 'function') {
    try {
      const results = await sessionQuery.readTitleSnapshots(ids)
      for (const item of results) {
        if (item.status === 'fulfilled' && item.value.title) {
          titlesById.set(item.sessionId, item.value.title.title)
        }
      }
    } catch {
      // 同上：标题读取失败不阻断面板。
    }
  }

  return ids.map((sessionId) => {
    const record = recordsById.get(sessionId)
    return {
      sessionId,
      title: titlesById.get(sessionId),
      cwd: record?.header.cwd,
      createdAt: record?.header.createdAt,
      persisted: record?.persisted ?? undefined,
    }
  })
}

/**
 * 一个会话可以"取消归档并直接归入"的工作区列表：只列出 cwd 与该会话的 cwd
 * 完全匹配（realpath 意义下）的工作区——workspaceRegistry.attachSession() 本身
 * 就会拒绝不匹配的 cwd，这里提前过滤，避免面板给出注定失败的选项。
 * @param {object} workspaceRegistry
 * @param {string | undefined} sessionCwd 会话头里记录的 cwd（未 realpath 规范化）
 * @returns {Promise<Array<{workspaceId: string, path: string, title: string}>>}
 */
export async function eligibleWorkspacesForCwd(workspaceRegistry, sessionCwd) {
  if (!sessionCwd) return []
  let match
  try {
    match = await workspaceRegistry.resolveByPath(sessionCwd)
  } catch {
    return []
  }
  if (!match) return []
  return [{ workspaceId: match.id, path: match.path, title: match.title }]
}
