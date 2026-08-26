/* global window, document, fetch */
// client/client.js — dsh-workspace-toolkit 的 Browser 侧 bundle（手写 CJS
// factory，供 dsh web 客户端 ModuleLoader 注入；结构对齐 dsh-chat-import /
// dsh-talk-map：ModuleLoader.load + module.exports {name, inject, apply} +
// ctx.slots.register）。
//
// 两块能力：
//   1. 侧边栏底部动作区竖排修复 —— 纯 CSS 注入，无需服务、无需槎注册。
//   2. 归档会话面板 —— 注册进 sidebar.footer.action（触发按钮）+
//      shell.overlay（滑出面板），面板内列出归档会话，支持取消归档 / 在文件夹
//      中显示 / 移动到工作区（后两者调用同源 /workspace-toolkit/* 路由）。
window.__ModuleLoader__.load({
  id: 'dsh-workspace-toolkit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback } = React

    // ---------------------------------------------------------------------
    // 功能 1：侧边栏底部动作区竖排修复。
    // ---------------------------------------------------------------------
    // 多个插件的 sidebar.footer.action 挤在同一行时会被压扁；改成纵向排列。
    // 用 !important 是因为宿主组件的 CSS-module 类名规则可能比我们晚生效。
    function insertColumnFixStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-dsh-workspace-toolkit-colfix]')) return () => {}
      const tag = document.createElement('style')
      tag.dataset.dshWorkspaceToolkitColfix = '1'
      tag.textContent = '[class*="footerActions"] { flex-direction: column !important; gap: 4px !important; }'
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // ---------------------------------------------------------------------
    // 归档面板：同源 fetch 封装。
    // ---------------------------------------------------------------------
    async function requestJson(path, init) {
      const response = await fetch(path, init)
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          detail = JSON.stringify(body)
        } catch { /* body not json */ }
        throw new Error(`${path} → ${response.status} ${detail}`)
      }
      return await response.json()
    }
    function postJson(path, body) {
      return requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    const api = {
      list() {
        return requestJson('/workspace-toolkit/archive/list')
      },
      unarchive(sessionId) {
        return postJson('/workspace-toolkit/archive/unarchive', { sessionId })
      },
      reveal(sessionId) {
        return postJson('/workspace-toolkit/archive/reveal', { sessionId })
      },
      eligibleMoves(sessionId) {
        return postJson('/workspace-toolkit/archive/eligible-moves', { sessionId })
      },
      moveTo(sessionId, workspaceId) {
        return postJson('/workspace-toolkit/archive/move-to', { sessionId, workspaceId })
      },
    }

    // ---------------------------------------------------------------------
    // 明暗主题（对齐 dsh-chat-import 的做法：body[data-ds-dark-theme] 判定）。
    // ---------------------------------------------------------------------
    const isDark = () => typeof document !== 'undefined' && document.body && document.body.hasAttribute('data-ds-dark-theme')
    const themeColors = () => (isDark()
      ? { bg: '#1b1f27', border: '#2a3040', field: '#14181f', text: '#e4e8ee', dim: '#9aa3b2', dimmer: '#7a8394', accent: '#4f8cff', hover: '#1f2530', danger: '#e5484d' }
      : { bg: '#ffffff', border: '#d8dee6', field: '#f5f6f8', text: '#1f2328', dim: '#57606a', dimmer: '#6e7781', accent: '#0969da', hover: '#eef1f5', danger: '#cf222e' })

    function ArchiveIcon() {
      return React.createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        React.createElement('rect', { x: 3, y: 4, width: 18, height: 4, rx: 1 }),
        React.createElement('path', { d: 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8' }),
        React.createElement('path', { d: 'M10 13h4' }))
    }

    function formatTime(iso) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleString()
      } catch {
        return ''
      }
    }

    function MoveMenu({ session, colors, onMoved, onError, busy, setBusy }) {
      const [open, setOpen] = useState(false)
      const [workspaces, setWorkspaces] = useState(null)

      const openMenu = useCallback(async () => {
        if (open) { setOpen(false); return }
        setOpen(true)
        try {
          const res = await api.eligibleMoves(session.sessionId)
          setWorkspaces(res.workspaces || [])
        } catch (err) {
          onError(String((err && err.message) || err))
          setWorkspaces([])
        }
      }, [open, session.sessionId, onError])

      const move = useCallback(async (workspaceId) => {
        setBusy(true)
        try {
          await api.moveTo(session.sessionId, workspaceId)
          setOpen(false)
          onMoved(session.sessionId)
        } catch (err) {
          onError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }, [session.sessionId, onMoved, onError, setBusy])

      return React.createElement('div', { style: { position: 'relative', display: 'inline-block' } },
        React.createElement('button', {
          type: 'button', disabled: busy,
          style: menuButtonStyle(colors),
          onClick: openMenu,
        }, '移动到工作区…'),
        open && React.createElement('div', {
          style: {
            position: 'absolute', right: 0, top: '100%', marginTop: '4px',
            background: colors.bg, border: '1px solid ' + colors.border, borderRadius: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,.2)', zIndex: 10, minWidth: '200px',
            maxHeight: '200px', overflowY: 'auto',
          },
        },
          workspaces === null && React.createElement('div', { style: { padding: '8px 12px', fontSize: '12px', color: colors.dimmer } }, '加载中…'),
          workspaces !== null && workspaces.length === 0 && React.createElement('div', { style: { padding: '8px 12px', fontSize: '12px', color: colors.dimmer } }, '没有 cwd 匹配的工作区'),
          workspaces !== null && workspaces.map((w) => React.createElement('button', {
            key: w.workspaceId, type: 'button', disabled: busy,
            style: menuItemStyle(colors),
            onClick: () => move(w.workspaceId),
          }, w.title))))
    }

    function menuButtonStyle(colors) {
      return {
        background: 'transparent', border: '1px solid ' + colors.border, color: colors.text,
        borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
      }
    }
    function menuItemStyle(colors) {
      return {
        display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
        border: 'none', color: colors.text, padding: '6px 12px', fontSize: '12.5px', cursor: 'pointer',
      }
    }

    function ArchiveRow({ session, colors, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const unarchive = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          await api.unarchive(session.sessionId)
          onChanged(session.sessionId)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }, [session.sessionId, onChanged])

      const reveal = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          await api.reveal(session.sessionId)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }, [session.sessionId])

      return React.createElement('div', {
        style: {
          padding: '10px 12px', borderBottom: '1px solid ' + colors.border,
          display: 'flex', flexDirection: 'column', gap: '6px',
        },
      },
        React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: colors.text } },
          session.title || '(无标题)'),
        session.cwd && React.createElement('div', { style: { fontSize: '11.5px', color: colors.dimmer, wordBreak: 'break-all' } }, session.cwd),
        session.createdAt && React.createElement('div', { style: { fontSize: '11px', color: colors.dimmer } }, formatTime(session.createdAt)),
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' } },
          React.createElement('button', {
            type: 'button', disabled: busy, onClick: unarchive,
            style: { ...menuButtonStyle(colors), color: colors.accent, borderColor: colors.accent },
          }, '取消归档'),
          React.createElement('button', {
            type: 'button', disabled: busy, onClick: reveal,
            style: menuButtonStyle(colors),
          }, '在文件夹中显示'),
          React.createElement(MoveMenu, { session, colors, busy, setBusy, onMoved: onChanged, onError: setError })),
        error && React.createElement('div', { style: { fontSize: '11.5px', color: colors.danger } }, error))
    }

    function ArchivePanel({ onClose }) {
      const colors = themeColors()
      const [sessions, setSessions] = useState(null)
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        try {
          const res = await api.list()
          setSessions(res.sessions || [])
        } catch (err) {
          setError(String((err && err.message) || err))
          setSessions([])
        }
      }, [])

      useEffect(() => { load() }, [load])

      const onChanged = useCallback((sessionId) => {
        setSessions((prev) => (prev || []).filter((s) => s.sessionId !== sessionId))
      }, [])

      return React.createElement('div', {
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9998, display: 'flex', justifyContent: 'flex-end' },
        onClick: onClose,
      },
        React.createElement('div', {
          style: {
            position: 'fixed', top: 0, right: 0, bottom: 0, width: '380px', maxWidth: '94vw',
            background: colors.bg, borderLeft: '1px solid ' + colors.border, color: colors.text,
            font: '13px/1.6 system-ui, sans-serif', zIndex: 9999, display: 'flex', flexDirection: 'column',
            boxShadow: '-8px 0 32px rgba(0,0,0,.35)',
          },
          onClick: (e) => { e.stopPropagation() },
        },
          React.createElement('div', {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid ' + colors.border },
          },
            React.createElement('span', { style: { fontSize: '14px', fontWeight: 600 } }, '归档会话'),
            React.createElement('button', {
              style: { background: 'transparent', border: 'none', color: colors.dim, fontSize: '16px', cursor: 'pointer', padding: '2px 6px', borderRadius: '4px' },
              onClick: onClose, title: '关闭',
            }, '✕')),
          error && React.createElement('div', { style: { padding: '10px 16px', color: colors.danger, fontSize: '12.5px' } }, error),
          sessions === null && !error && React.createElement('div', { style: { padding: '16px', color: colors.dimmer } }, '加载中…'),
          sessions !== null && sessions.length === 0 && React.createElement('div', { style: { padding: '16px', color: colors.dimmer } }, '没有归档会话'),
          sessions !== null && sessions.length > 0 && React.createElement('div', { style: { overflowY: 'auto', flex: 1 } },
            sessions.map((s) => React.createElement(ArchiveRow, { key: s.sessionId, session: s, colors, onChanged })))))
    }

    function ArchivePanelButton(props) {
      const [open, setOpen] = useState(false)
      const rail = props.wide === false
      const triggerStyle = {
        boxSizing: 'border-box',
        display: 'flex', alignItems: 'center',
        justifyContent: rail ? 'center' : 'flex-start',
        gap: rail ? '0' : '8px',
        background: 'transparent', border: 'none',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: rail ? '50%' : '12px',
        cursor: 'pointer',
        flex: 'none',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        width: rail ? '36px' : 'calc(100% + 4px)',
        height: rail ? '36px' : '42px',
        margin: rail ? '8px 0 10px' : '4px -2px',
        padding: rail ? '0' : '0 10px 0 8px',
        fontSize: '14px', lineHeight: '22px', fontWeight: 400,
      }
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button', style: triggerStyle, title: '归档会话', 'aria-label': '归档会话',
          onClick: () => setOpen(true),
        },
          React.createElement(ArchiveIcon),
          !rail && '归档会话'),
        open && React.createElement(ArchivePanel, { onClose: () => setOpen(false) }))
    }

    // ---------------------------------------------------------------------
    // apply
    // ---------------------------------------------------------------------
    const name = 'dsh-workspace-toolkit'
    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.effect(() => insertColumnFixStyle(), 'dsh-workspace-toolkit: column fix')
        ctx.effect(() =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'archive-panel', order: 20 },
            ArchivePanelButton,
          ), 'dsh-workspace-toolkit: sidebar button')
      } catch (error) {
        console.error('[dsh-workspace-toolkit] client apply failed:', error)
      }
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
