export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: { x: number; y: number; z?: number; visibility?: number }[],
  options?: { color?: string; lineWidth?: number; radius?: number }
) {
  const { color = "white", lineWidth = 2, radius = 4 } = options || {};

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  for (const landmark of landmarks) {
    if (landmark.visibility && landmark.visibility < 0.5) continue;
    
    const x = landmark.x * ctx.canvas.width;
    const y = landmark.y * ctx.canvas.height;
    
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawConnectors(
  ctx: CanvasRenderingContext2D,
  landmarks: { x: number; y: number; visibility?: number }[],
  connections: { start: number; end: number }[],
  options?: { color?: string; lineWidth?: number }
) {
  const { color = "white", lineWidth = 2 } = options || {};

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  for (const connection of connections) {
    const start = landmarks[connection.start];
    const end = landmarks[connection.end];

    if (start.visibility && start.visibility < 0.5) continue;
    if (end.visibility && end.visibility < 0.5) continue;

    const startX = start.x * ctx.canvas.width;
    const startY = start.y * ctx.canvas.height;
    const endX = end.x * ctx.canvas.width;
    const endY = end.y * ctx.canvas.height;

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }
  ctx.restore();
}
