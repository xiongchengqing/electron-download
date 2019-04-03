const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, shell, dialog } = require('electron')
const pupa = require('pupa')
const fetch = require('node-fetch')
const os = require('os')

const isWindows = os.type() === 'Windows_NT'

function registerListener (session, options, cb = () => {}) {
  const downloadItems = new Set()
  let receivedBytes = 0
  let completedBytes = 0
  let totalBytes = 0
  const activeDownloadItems = () => downloadItems.size
  const progressDownloadItems = () => receivedBytes / totalBytes

  options = Object.assign({ showBadge: true }, options)

  const listener = (e, item, webContents) => {
    downloadItems.add(item)
    totalBytes += item.getTotalBytes()

    let hostWebContents = webContents
    if (webContents.getType() === 'webview') {
      ;({ hostWebContents } = webContents)
    }

    const win = BrowserWindow.fromWebContents(hostWebContents)

    const errorMessage =
      options.errorMessage || 'The download of {filename} was interrupted'
    const errorTitle = options.errorTitle || 'Download Error'

    const dir = options.directory || app.getPath('downloads')
    const { filePath } = options
    item.setSavePath(filePath)

    if (typeof options.onStarted === 'function') {
      options.onStarted(item)
    }

    item.on('updated', () => {
      receivedBytes = [...downloadItems].reduce((receivedBytes, item) => {
        receivedBytes += item.getReceivedBytes()
        return receivedBytes
      }, completedBytes)

      if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
        app.setBadgeCount(activeDownloadItems())
      }

      if (!win.isDestroyed()) {
        win.setProgressBar(progressDownloadItems())
      }

      if (typeof options.onProgress === 'function') {
        options.onProgress(progressDownloadItems())
      }
    })

    item.on('done', (event, state) => {
      completedBytes += item.getTotalBytes()
      downloadItems.delete(item)

      if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
        app.setBadgeCount(activeDownloadItems())
      }

      if (!win.isDestroyed() && !activeDownloadItems()) {
        win.setProgressBar(-1)
        receivedBytes = 0
        completedBytes = 0
        totalBytes = 0
      }

      if (options.unregisterWhenDone) {
        session.removeListener('will-download', listener)
      }

      if (state === 'cancelled') {
        if (typeof options.onCancel === 'function') {
          options.onCancel(item)
        }
      } else if (state === 'interrupted') {
        const message = pupa(errorMessage, { filename: item.getFilename() })
        dialog.showErrorBox(errorTitle, message)
        cb(new Error(message))
      } else if (state === 'completed') {
        if (process.platform === 'darwin') {
          app.dock.downloadFinished(filePath)
        }

        if (options.openFolderWhenDone) {
          shell.showItemInFolder(path.join(dir, item.getFilename()))
        }

        cb(null, item)
      }
    })
  }

  session.on('will-download', listener)
}

const downloadWeb = async (win, url, options) => {
  const dir = options.directory || app.getPath('downloads')

  const filename = options.filename || url.substring(url.lastIndexOf('/') + 1)
  const originFilePath = path.join(dir, filename)

  const filePath = dialog.showSaveDialog(win, {
    defaultPath: `${originFilePath}`
  })
  if (!filePath) return
  return new Promise((resolve, reject) => {
    options = Object.assign({}, options, {
      unregisterWhenDone: true,
      filePath
    })

    registerListener(win.webContents.session, options, (err, item) => {
      if (err) {
        reject(err)
      } else {
        resolve(item)
      }
    })

    win.webContents.downloadURL(url)
  })
}

// 下载本地图片
const downloadLocal = (win, localPath, options) => {
  const dir = options.directory || app.getPath('downloads')
  localPath = decodeURIComponent(localPath)
  const regex = /^file:\/\/\/(.*)$/
  const m = regex.exec(localPath)
  // 如果是file 协议, 就取其中的绝对路径, mac 前需要有 /
  if (m) {
    localPath = isWindows ? m[1] : `/${m[1]}`
  }
  try {
    fs.accessSync(localPath, fs.constants.R_OK)
  } catch (e) {
    return
  }
  const imageExt = (path.extname(localPath) || '').slice(1)
  const filename = `${options.filename}.${imageExt}`
  const originFilePath = path.join(dir, filename)
  const filePath = dialog.showSaveDialog(win, {
    defaultPath: `${originFilePath}`
  })
  if (!filePath) return

  try {
    fs.createReadStream(localPath).pipe(fs.createWriteStream(filePath))
  } catch (e) {
    console.log(e)
  }
}

module.exports = (win, url, options) => {
  if (
    url.startsWith('http') ||
    url.startsWith('https') ||
    url.startsWith('data:')
  ) {
    downloadWeb(win, url, options)
  }
  downloadLocal(win, url, options)
}
