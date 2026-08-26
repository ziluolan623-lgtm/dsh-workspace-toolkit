// lib/archive-store.js — Host 侧归档面板数据源与"取消归档"实现。
//
// dsh-workspace（ctx.workspaceRegistry）只公开 archiveSession()，没有公开对应的
// "取消归档"方法（archivedSessionIds 是只读 getter）。这是本插件里唯一绕不开的
// 内部实现依赖：直接调用 WorkspaceRegistry 实例上未公开、未在服务目录里登记的
// setState()/requireState()（同一份 workspaceRegistry 实例，本进程内单例），
// 复刻 archiveSession() 自己采用的读-改-写模式，让"取消归档"跟官方写法走同一条
// enqueueOperation 队列，同一个 ctx.storage.domain 持久化路径——不触碰任何磁盘
// 文件。dsh-workspace 包升级重构这两个方法名时，本文件的 unarchiveSession 会
// 直接抛错（下方做了存在性检查，报错文案指向这里）而不是静默写坏数据。
//
// 现给用户的说明：官方文档明确"archiving 从不触碰工作区记账——归档时保留
// sessionIds 位置，取消归档会恢复原位"（源码注释），所以这里的取消归档只是把
// sessionId 从 archivedSessionIds 里摘掉，会话该在哪个工作区/未分组，由现有
// sessionIds 记账决定，不需要额外处理。

/**
 * 取消归档一个会话：把 sessionId 从 archivedSessionIds 里摘掉。
 * 直接复刻 archiveSession() 的实现模式（enqueueOperation → requireState → setState），
 * 因为 WorkspaceRegistry 没有公开对应方法。
 * @param {object} registry ctx.workspaceRegistry 服务实例
 * @param {string} sessionId 要取消归档的会话 id
 * @returns {Promise<void>}
 */
export function unarchiveSession(registry, sessionId) {
  if (typeof registry.enqueueOperation !== 'function'
    || typeof registry.requireState !== 'function'
    || typeof registry.setState !== 'function') {
    throw new Error(
      'dsh-workspace-toolkit: workspaceRegistry 缺少 enqueueOperation/requireState/setState 内部方法'
      + '（未公开 API，dsh-workspace 包升级后签名可能已变化）——取消归档功能需要更新以匹配新版本。',
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
