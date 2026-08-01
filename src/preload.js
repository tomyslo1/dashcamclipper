const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dashcam', {
  getLibraryStatus: () => ipcRenderer.invoke('get-library-status'),
  chooseLibrary: () => ipcRenderer.invoke('choose-library'),
  getToolStatus: () => ipcRenderer.invoke('get-tool-status'),
  chooseTool: (tool) => ipcRenderer.invoke('choose-tool', tool),
  clearTool: (tool) => ipcRenderer.invoke('clear-tool', tool),
  chooseSource: () => ipcRenderer.invoke('choose-source'),
  scanSource: (rootPath, filters) => ipcRenderer.invoke('scan-source', rootPath, filters),
  playSegment: (segmentId) => ipcRenderer.invoke('play-segment', segmentId),
  getSegmentThumbnail: (segmentId) => ipcRenderer.invoke('get-segment-thumbnail', segmentId),
  setProcessingState: (options) => ipcRenderer.invoke('set-processing-state', options),
  importNewClips: () => ipcRenderer.invoke('import-new-clips'),
  getNameSuggestions: () => ipcRenderer.invoke('get-name-suggestions'),
  mergeSegment: (segmentId, options) => ipcRenderer.invoke('merge-segment', segmentId, options),
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
