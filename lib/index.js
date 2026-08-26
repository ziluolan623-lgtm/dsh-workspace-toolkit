// lib/index.js — dsh-workspace-toolkit Host 侧入口。
//
// 功能对照（详见 README）：
//   1. 侧边栏底部按钮竖排修复 —— 纯 Client 端 CSS；Host 侧没有实际逻辑，仅注册
//      一个占位 effect 保持两端结构对称（用户要求：全部功能 Host+Client 成对）。
//   2-5. 归档面板（列表 / 取消归档 / 在文件夹中显示 / 移动到工作区）—— 需要
//      workspaceRegistry + sessionPersistence + subprocess + webServer 四个
//      服务；四者用同一层 ctx.inject 一起等待，任一缺失整块归档功能不激活，
//      但不会拖垮宿主进程（inject 只是等待，不是抛错）。
//
// sessionQuery 是可选加成（标题/cwd 展示更丰富），缺失时归档面板仍能工作，只是
// 标题列可能是空的——在 routes.js 内部用 ctx.get('sessionQuery') 单独处理。

import { registerRoutes } from './routes.js'

export const name = 'dsh-workspace-toolkit'

export function apply(ctx) {
  // 功能 1 的 Host 半：无状态、无服务依赖，只是让本插件在 Host 侧也“存在”，
  // 与 client/client.js 里真正做事的 CSS 注入对称。
  ctx.effect(() => {
    return () => {}
  }, 'dsh-workspace-toolkit: sidebar-fix host placeholder')

  // 功能 2-5：归档面板的完整后端。
  ctx.inject(['workspaceRegistry', 'sessionPersistence', 'subprocess', 'webServer'], (services) => {
    services.effect(() => {
      const unregister = registerRoutes(services, services.webServer)
      return () => { unregister() }
    }, 'dsh-workspace-toolkit: archive panel routes')
  })
}
