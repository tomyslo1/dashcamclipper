const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dashcam', {
  getToolStatus: () => ipcRenderer.invoke('get-tool-status'),
  chooseTool: (tool) => ipcRenderer.invoke('choose-tool', tool),
  clearTool: (tool) => ipcRenderer.invoke('clear-tool', tool),
  chooseSource: () => ipcRenderer.invoke('choose-source'),
  scanSource: (rootPath, filters) => ipcRenderer.invoke('scan-source', rootPath, filters),
  playSegment: (segmentId) => ipcRenderer.invoke('play-segment', segmentId),
  getSegmentThumbnail: (segmentId) => ipcRenderer.invoke('get-segment-thumbnail', segmentId),
  mergeSegment: (segmentId, name) => ipcRenderer.invoke('merge-segment', segmentId, name),
  cancelMediaJob: () => ipcRenderer.invoke('cancel-media-job'),
  openOutputInVlc: (outputId) => ipcRenderer.invoke('open-output-in-vlc', outputId),
  saveTrimmedVideo: (options) => ipcRenderer.invoke('save-trimmed-video', options),
  discardOutput: (outputId) => ipcRenderer.invoke('discard-output', outputId),
  deleteSegment: (segmentId) => ipcRenderer.invoke('delete-segment', segmentId),
  onMediaProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('media-progress', listener)
    return () => ipcRenderer.removeListener('media-progress', listener)
  }
})
