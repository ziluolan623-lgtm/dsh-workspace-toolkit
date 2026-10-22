// test/security.test.js — 安全性测试套件（对抗性输入 + 删除守卫）
//
// 覆盖点：
//   1. sessionId 格式校验（路径穿越、分隔符、超长）
//   2. 存档路径必须落在 <DSH_HOME>/sessions/<cwd>/<sessionId>/
//   3. 符号链接 / junction / realpath 逃逸拒绝
//   4. 目录内非法文件拒绝（防误删非会话数据）
//   5. 版本化存档文件名支持（v3 / v4）
//   6. 空目录（废弃会话）允许删除
//   7. 删除守卫：未归档 / 确认串错误 / 运行中会话
//   8. 删除后通知前端（emitSessionRemoved）
//   9. 拒绝删除时不得对磁盘产生副作用

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DeleteSessionError,
  deleteArchivedSession,
  findSessionDirOnDisk,
  resolveSafeSessionDirectory,
} from '../lib/delete-session.js'

const SID = 'session-11111111-2222-4333-8444-555555555555'
const OTHER_SID = 'session-99999999-8888-4777-8666-555555555555'

/** 建一个临时 DSH_HOME 与一个会话目录。 */
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wt-sec-'))
  const dshHome = join(root, '.dsh')
  const sessionsRoot = join(dshHome, 'sessions')
  const cwdDir = join(sessionsRoot, '--D-example--')
  const sessionDir = join(cwdDir, options.sessionId || SID)
  await mkdir(sessionDir, { recursive: true })
  const fileName = options.fileName || 'session.v4.jsonl.zstd'
  if (options.emptyDir !== true) {
    await writeFile(join(sessionDir, fileName), Buffer.alloc(options.bytes ?? 64, 1))
  }
  return { root, dshHome, sessionsRoot, cwdDir, sessionDir, sessionId: options.sessionId || SID }
}

const isDeleteError = (status) => (error) =>
  error instanceof DeleteSessionError && error.status === status

// ---------------------------------------------------------------------------
// 1. sessionId 格式（路径穿越 / 分隔符 / 越界字符）
// ---------------------------------------------------------------------------
test('security: rejects path-traversal and malformed sessionId before touching disk', async () => {
  for (const bad of ['../evil', '..', '.', 'a/b', 'a\\b', 'C:\\abs', 'session-..', '', ' ', 'x'.repeat(300)]) {
    await assert.rejects(
      resolveSafeSessionDirectory({ sessionId: bad, sessionDir: 'C:\\whatever' }),
      isDeleteError(400),
      `sessionId ${JSON.stringify(bad)} must be rejected with 400`,
    )
  }
})

// ---------------------------------------------------------------------------
// 2. 合法存档文件名（含版本段）
// ---------------------------------------------------------------------------
test('security: accepts legacy and versioned archive file names', async (t) => {
  for (const fileName of ['session.jsonl', 'session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']) {
    const f = await fixture({ fileName })
    t.after(() => rm(f.root, { recursive: true, force: true }))
    const target = await resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: f.sessionDir, dshHome: f.dshHome })
    assert.equal(target.sessionDir, f.sessionDir)
    assert.equal(target.artifactPath, join(f.sessionDir, fileName))
  }
})

// ---------------------------------------------------------------------------
// 3. 空目录 = 废弃会话，允许删除
// ---------------------------------------------------------------------------
test('security: allows deleting an empty abandoned session directory', async (t) => {
  const f = await fixture({ emptyDir: true })
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const target = await resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: f.sessionDir, dshHome: f.dshHome })
  assert.equal(target.sessionDir, f.sessionDir)
  assert.equal(target.artifactPath, undefined)
})

// ---------------------------------------------------------------------------
// 4. 目录内有非法文件 → 拒绝（防误删非会话数据）
// ---------------------------------------------------------------------------
test('security: refuses a session directory holding unrecognized files', async (t) => {
  const f = await fixture({ emptyDir: true })
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await writeFile(join(f.sessionDir, 'important-notes.txt'), 'data')
  await assert.rejects(
    resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: f.sessionDir, dshHome: f.dshHome }),
    isDeleteError(409),
  )
})

// ---------------------------------------------------------------------------
// 5. 目录名与 sessionId 不一致 → 拒绝
// ---------------------------------------------------------------------------
test('security: refuses a directory whose basename differs from sessionId', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const wrong = join(f.sessionsRoot, '--D-example--', 'session-someone-else')
  await mkdir(wrong, { recursive: true })
  await writeFile(join(wrong, 'session.jsonl.zstd'), 'x')
  await assert.rejects(
    resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: wrong, dshHome: f.dshHome }),
    isDeleteError(409),
  )
})

// ---------------------------------------------------------------------------
// 6. 符号链接目录 → 拒绝
// ---------------------------------------------------------------------------
test('security: refuses a symlinked session directory', async (t) => {
  const f = await fixture({ emptyDir: true })
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const realDir = join(f.cwdDir, 'real-target')
  await mkdir(realDir, { recursive: true })
  await writeFile(join(realDir, 'session.jsonl.zstd'), 'x')
  const linkDir = join(f.cwdDir, f.sessionId)
  await rm(linkDir, { recursive: true, force: true })
  try {
    await symlink(realDir, linkDir, 'junction')
  } catch {
    return // 环境不允许建链接：跳过
  }
  await assert.rejects(
    resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: linkDir, dshHome: f.dshHome }),
    isDeleteError(409),
  )
  // 磁盘扫描也必须跳过链接目录
  assert.equal(await findSessionDirOnDisk(f.sessionsRoot, f.sessionId), undefined)
})

// ---------------------------------------------------------------------------
// 7. 存档文件是符号链接 → 拒绝
// ---------------------------------------------------------------------------
test('security: refuses a symlinked archive file', async (t) => {
  const f = await fixture({ emptyDir: true })
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const outsideFile = join(f.root, 'outside.jsonl')
  await writeFile(outsideFile, 'x')
  try {
    await symlink(outsideFile, join(f.sessionDir, 'session.jsonl.zstd'), 'file')
  } catch {
    return
  }
  await assert.rejects(
    resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: f.sessionDir, dshHome: f.dshHome }),
    isDeleteError(409),
  )
})

// ---------------------------------------------------------------------------
// 8. artifactPath 在 sessions 根之外 → 拒绝
// ---------------------------------------------------------------------------
test('security: refuses artifact paths outside the sessions root', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const outside = join(f.root, 'outside', f.sessionId)
  await mkdir(outside, { recursive: true })
  const artifactPath = join(outside, 'session.jsonl.zstd')
  await writeFile(artifactPath, 'x')
  await assert.rejects(
    resolveSafeSessionDirectory({ sessionId: f.sessionId, artifactPath, dshHome: f.dshHome }),
    isDeleteError(409),
  )
})

// ---------------------------------------------------------------------------
// 9. 目录层级不符合 <cwd>/<sessionId> → 拒绝
// ---------------------------------------------------------------------------
test('security: refuses a session directory nested deeper than one cwd level', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const deepDir = join(f.sessionsRoot, '--D-example--', 'extra', f.sessionId)
  await mkdir(deepDir, { recursive: true })
  await writeFile(join(deepDir, 'session.jsonl.zstd'), 'x')
  await assert.rejects(
    resolveSafeSessionDirectory({ sessionId: f.sessionId, sessionDir: deepDir, dshHome: f.dshHome }),
    isDeleteError(409),
  )
})

// ---------------------------------------------------------------------------
// 10. 删除守卫：未归档 / 确认串错误 / 非法 id
// ---------------------------------------------------------------------------
test('security: delete guards reject unarchived, wrong-confirmation and malformed input', async () => {
  const registry = { archivedSessionIds: [SID], async list() { return [] } }
  await assert.rejects(
    deleteArchivedSession({ workspaceRegistry: registry }, SID, 'delete'),
    isDeleteError(400),
  )
  await assert.rejects(
    deleteArchivedSession({ workspaceRegistry: { archivedSessionIds: [] } }, SID, 'DELETE'),
    isDeleteError(409),
  )
  await assert.rejects(
    deleteArchivedSession({ workspaceRegistry: registry }, '../etc/passwd', 'DELETE'),
    isDeleteError(400),
  )
})

// ---------------------------------------------------------------------------
// 11. 运行中会话：不再拦截，但返回警告（用户显式接受的策略）
// ---------------------------------------------------------------------------
test('security: active session delete proceeds with a warning instead of refusing', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const emitted = []
  const result = await deleteArchivedSession({
    dshHome: f.dshHome,
    workspaceRegistry: { archivedSessionIds: [f.sessionId], async list() { return [] } },
    agents: { get: () => ({ id: f.sessionId }) },
    unarchiveSession: async () => {},
    emitSessionRemoved: (id) => emitted.push(id),
  }, f.sessionId, 'DELETE')
  assert.equal(result.deleted, true)
  assert.ok(result.warnings.some((w) => w.includes('活跃 Agent')), 'must warn about the running agent')
  assert.deepEqual(emitted, [f.sessionId], 'must notify the client list removal')
  await assert.rejects(access(f.sessionDir))
})

// ---------------------------------------------------------------------------
// 12. 成功删除：磁盘目录消失 + 通知前端 + 清理登记
// ---------------------------------------------------------------------------
test('security: successful delete removes the directory, cleans bookkeeping and notifies the client', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const detached = []
  const emitted = []
  const archived = [f.sessionId]
  const result = await deleteArchivedSession({
    dshHome: f.dshHome,
    workspaceRegistry: {
      archivedSessionIds: archived,
      async list() { return [{ id: 'w1', title: 'ws', async detachSession(id) { detached.push(id) } }] },
    },
    agents: { get: () => undefined },
    unarchiveSession: async (_r, id) => { archived.splice(archived.indexOf(id), 1) },
    emitSessionRemoved: (id) => emitted.push(id),
  }, f.sessionId, 'DELETE')
  assert.equal(result.deleted, true)
  assert.equal(result.bytesFreed, 64)
  assert.deepEqual(detached, [f.sessionId])
  assert.deepEqual(archived, [])
  assert.deepEqual(emitted, [f.sessionId])
  await assert.rejects(access(f.sessionDir))
  const remaining = await readdir(f.cwdDir).catch(() => [])
  assert.ok(!remaining.includes(f.sessionId), 'session directory must be gone')
})

// ---------------------------------------------------------------------------
// 13. 拒绝删除时不得产生副作用（目录必须还在）
// ---------------------------------------------------------------------------
test('security: a refused delete leaves the disk untouched', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  // 未归档 → 拒绝
  await assert.rejects(
    deleteArchivedSession({
      dshHome: f.dshHome,
      workspaceRegistry: { archivedSessionIds: [], async list() { return [] } },
      agents: { get: () => undefined },
      unarchiveSession: async () => {},
      emitSessionRemoved: () => {},
    }, f.sessionId, 'DELETE'),
    isDeleteError(409),
  )
  // 目录与文件必须原样保留
  await access(f.sessionDir)
  await access(join(f.sessionDir, 'session.v4.jsonl.zstd'))
})

// ---------------------------------------------------------------------------
// 14. 其它会话目录不受影响（只删目标会话）
// ---------------------------------------------------------------------------
test('security: deleting one session never touches sibling sessions', async (t) => {
  const f = await fixture()
  const sibling = await fixture({ sessionId: OTHER_SID, fileName: 'session.v3.jsonl.zstd' })
  t.after(async () => {
    await rm(f.root, { recursive: true, force: true })
    await rm(sibling.root, { recursive: true, force: true })
  })
  await deleteArchivedSession({
    dshHome: f.dshHome,
    workspaceRegistry: { archivedSessionIds: [f.sessionId], async list() { return [] } },
    agents: { get: () => undefined },
    unarchiveSession: async () => {},
    emitSessionRemoved: () => {},
  }, f.sessionId, 'DELETE')
  // 兄弟会话目录（不同 DSH_HOME）不受影响
  await access(sibling.sessionDir)
})
