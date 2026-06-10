export const MAX_ANALYSIS_DIMENSION_PX = 960;

export function getAnalysisFrameSizeFromDimensions(sourceWidth: number, sourceHeight: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, MAX_ANALYSIS_DIMENSION_PX / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function getAnalysisFrameSize(video: HTMLVideoElement) {
  return getAnalysisFrameSizeFromDimensions(
    video.videoWidth || video.clientWidth,
    video.videoHeight || video.clientHeight
  );
}
