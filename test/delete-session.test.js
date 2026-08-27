import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DeleteSessionError,
  deleteArchivedSession,
  resolveSafeSessionDirectory,
} from '../lib/delete-session.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-toolkit-'))
  const dshHome = join(root, '.dsh')
  const sessionId = 'session-11111111-2222-4333-8444-555555555555'
  const sessionDir = join(dshHome, 'sessions', '--D-example--', sessionId)
  const artifactPath = join(sessionDir, 'session.jsonl.zstd')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(artifactPath, Buffer.alloc(37, 1))
  return { root, dshHome, sessionId, sessionDir, artifactPath }
}

test('accepts exactly one DSH session directory', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const target = await resolveSafeSessionDirectory(f)
  assert.equal(target.sessionDir, f.sessionDir)
  assert.equal(target.artifactPath, f.artifactPath)
})

test('rejects a locate path outside DSH_HOME/sessions', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const outside = join(f.root, 'outside', f.sessionId)
  await mkdir(outside, { recursive: true })
  const artifactPath = join(outside, 'session.jsonl.zstd')
  await writeFile(artifactPath, 'x')
  await assert.rejects(
    resolveSafeSessionDirectory({ ...f, artifactPath }),
    (error) => error instanceof DeleteSessionError && error.status === 409,
  )
})

test('rejects a session directory whose name does not match sessionId', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const wrongDir = join(f.dshHome, 'sessions', '--D-example--', 'session-someone-else')
  await mkdir(wrongDir, { recursive: true })
  const artifactPath = join(wrongDir, 'session.jsonl.zstd')
  await writeFile(artifactPath, 'x')
  await assert.rejects(
    resolveSafeSessionDirectory({ ...f, artifactPath }),
    (error) => error instanceof DeleteSessionError && error.status === 409,
  )
})

test('deletes an inactive archived session and clears bookkeeping', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const archived = [f.sessionId]
  const detached = []
  const cacheDeletes = []
  const services = {
    dshHome: f.dshHome,
    workspaceRegistry: {
      archivedSessionIds: archived,
      async list() {
        return [{ id: 'workspace-1', async detachSession(id) { detached.push(id) } }]
      },
    },
    agents: { get() { return undefined } },
    sessionPersistence: {
      async list() { return [{ id: f.sessionId }] },
      locate() { return { kind: 'jsonl', path: f.artifactPath } },
    },
    sessionProjectionCache: {
      requireTable() {
        return { async delete(id) { cacheDeletes.push(id) } }
      },
    },
    async unarchiveSession(_registry, id) {
      archived.splice(archived.indexOf(id), 1)
    },
  }

  const result = await deleteArchivedSession(services, f.sessionId, 'DELETE')
  assert.equal(result.deleted, true)
  assert.equal(result.bytesFreed, 37)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(detached, [f.sessionId])
  assert.deepEqual(cacheDeletes, [f.sessionId])
  assert.deepEqual(archived, [])
  await assert.rejects(access(f.sessionDir))
})

test('refuses to delete an active session before touching persistence', async () => {
  let listed = false
  const sessionId = 'session-11111111-2222-4333-8444-555555555555'
  await assert.rejects(
    deleteArchivedSession({
      workspaceRegistry: { archivedSessionIds: [sessionId] },
      agents: { get() { return { id: sessionId } } },
      sessionPersistence: { async list() { listed = true; return [] } },
    }, sessionId, 'DELETE'),
    (error) => error instanceof DeleteSessionError && error.status === 409,
  )
  assert.equal(listed, false)
})

test('requires exact DELETE confirmation and archived state', async () => {
  const sessionId = 'session-11111111-2222-4333-8444-555555555555'
  await assert.rejects(
    deleteArchivedSession({ workspaceRegistry: { archivedSessionIds: [sessionId] } }, sessionId, 'delete'),
    (error) => error instanceof DeleteSessionError && error.status === 400,
  )
  await assert.rejects(
    deleteArchivedSession({ workspaceRegistry: { archivedSessionIds: [] } }, sessionId, 'DELETE'),
    (error) => error instanceof DeleteSessionError && error.status === 409,
  )
})
