// lib/reveal-path.js — 在系统文件管理器中"选中并显示"一个文件/目录。
//
// dsh-host-apiproxy 现成的 openNativePath 只做"用默认程序打开"（Windows 走
// Invoke-Item），不是"在文件管理器中定位并高亮该文件"。这里用 ctx.subprocess
// 自己拉起平台原生命令：
//   Windows: explorer.exe /select,<path>
//   macOS:   open -R <path>
//   Linux:   没有统一的"定位并高亮"命令（各文件管理器 CLI 不同），退化为用
//            xdg-open 打开其父目录（不高亮，但至少能到地方）。
//
// 只解析 sessionPersistence.locate() 给出的 SessionLocation.path；不新建、
// 不读取、不修改任何文件。

/**
 * 在系统文件管理器中显示给定路径（尽量选中并高亮；平台限制见上）。
 * @param {object} subprocess ctx.subprocess 服务实例
 * @param {string} targetPath 绝对路径（文件或目录）
 * @param {string} platform 'win32' | 'darwin' | 'linux'（缺省用 process.platform 意味不可用，故显式传入）
 * @returns {Promise<void>}
 */
export async function revealInFileManager(subprocess, targetPath, platform) {
  const graceMs = 5000
  const stdio = {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  }
  // spawn cwd 必须是一个存在的目录；targetPath 可能是文件，所以统一用其父目录
  // 作为 spawn 的 cwd（不影响 explorer/open 的目标参数，两者都吃绝对路径）。
  const parent = targetPath.replace(/[/\\][^/\\]*$/, '') || targetPath

  if (platform === 'win32') {
    // explorer.exe 对已存在的选中项返回码不总是 0（已知怪癖），不等待/不检查退出码。
    const handle = subprocess.spawn({
      argv: ['explorer.exe', `/select,${targetPath}`],
      cwd: parent,
      stdio,
      graceMs,
    })
    handle.done.catch(() => {})
    return
  }
  if (platform === 'darwin') {
    const handle = subprocess.spawn({
      argv: ['open', '-R', targetPath],
      cwd: parent,
      stdio,
      graceMs,
    })
    await handle.done
    return
  }
  // Linux：退化为打开父目录（xdg-open 没有统一的"选中文件"语义）。
  const handle = subprocess.spawn({
    argv: ['xdg-open', parent],
    cwd: parent,
    stdio,
    graceMs,
  })
  await handle.done
}
