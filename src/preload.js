const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dashcam', {
  getLibraryStatus: () => ipcRenderer.invoke('get-library-status'),
  chooseLibrary: () => ipcRenderer.invoke('choose-library'),
  getToolStatus: () => ipcRenderer.invoke('get-tool-status'),
  savePreferences: (preferences) => ipcRenderer.invoke('save-preferences', preferences),
  chooseTool: (tool) => ipcRenderer.invoke('choose-tool', tool),
  clearTool: (tool) => ipcRenderer.invoke('clear-tool', tool),
  chooseSource: () => ipcRenderer.invoke('choose-source'),
  scanSource: (rootPath, filters) => ipcRenderer.invoke('scan-source', rootPath, filters),
  playSegment: (segmentId) => ipcRenderer.invoke('play-segment', segmentId),
  getSegmentThumbnail: (segmentId) => ipcRenderer.invoke('get-segment-thumbnail', segmentId),
  setProcessingState: (options) => ipcRenderer.invoke('set-processing-state', options),
  clearProcessedHistory: () => ipcRenderer.invoke('clear-processed-history'),
  importNewClips: () => ipcRenderer.invoke('import-new-clips'),
  getNameSuggestions: () => ipcRenderer.invoke('get-name-suggestions'),
  listProcessedVideos: () => ipcRenderer.invoke('list-processed-videos'),
  getProcessedVideoThumbnail: (fileName) => ipcRenderer.invoke('get-processed-video-thumbnail', fileName),
  playProcessedVideo: (fileName) => ipcRenderer.invoke('play-processed-video', fileName),
  reencodeSavedVideo: (fileName) => ipcRenderer.invoke('reencode-saved-video', fileName),
  applyTitleDatesToVideos: (fileNames) => ipcRenderer.invoke('apply-title-dates-to-videos', fileNames),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  openUpdateRelease: () => ipcRenderer.invoke('open-update-release'),
  mergeSegments: (segmentIds, options) => ipcRenderer.invoke('merge-segments', segmentIds, options),
  cancelMediaJob: () => ipcRenderer.invoke('cancel-media-job'),
  openOutputInVlc: (outputId) => ipcRenderer.invoke('open-output-in-vlc', outputId),
  saveTrimmedVideo: (options) => ipcRenderer.invoke('save-trimmed-video', options),
  discardOutput: (outputId) => ipcRenderer.invoke('discard-output', outputId),
  deleteSegment: (segmentId) => ipcRenderer.invoke('delete-segment', segmentId),
  deleteSegments: (segmentIds) => ipcRenderer.invoke('delete-segments', segmentIds),
  onMediaProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('media-progress', listener)
    return () => ipcRenderer.removeListener('media-progress', listener)
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('update-status', listener)
    return () => ipcRenderer.removeListener('update-status', listener)
  }
})
