(() => {
  'use strict';

  // Grayscale closing, then hysteresis on dark detail. No semantic recognition.
  function extremum(src, W, H, horizontal, maximum) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let value = maximum ? 0 : 255;
      for (let offset = -2; offset <= 2; offset++) {
        const xx = horizontal ? Math.max(0, Math.min(W - 1, x + offset)) : x;
        const yy = horizontal ? y : Math.max(0, Math.min(H - 1, y + offset));
        value = maximum ? Math.max(value, src[yy * W + xx]) : Math.min(value, src[yy * W + xx]);
      }
      out[y * W + x] = value;
    }
    return out;
  }

  function build(image, W, H) {
    const N = W * H, lum = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = i * 4;
      lum[i] = image.data[p] * .2126 + image.data[p + 1] * .7152 + image.data[p + 2] * .0722;
    }
    let closed = extremum(lum, W, H, true, true);
    closed = extremum(closed, W, H, false, true);
    closed = extremum(closed, W, H, true, false);
    closed = extremum(closed, W, H, false, false);

    const mask = new Uint8Array(N), visited = new Uint8Array(N), queue = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const contrast = closed[i] - lum[i];
      if (lum[i] < 205 && contrast >= 12) mask[i] = lum[i] < 175 && contrast >= 24 ? 2 : 1;
    }
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'), output = ctx.createImageData(W, H);
    for (let start = 0; start < N; start++) {
      if (!mask[start] || visited[start]) continue;
      let head = 0, tail = 1, strong = 0;
      queue[0] = start; visited[start] = 1;
      while (head < tail) {
        const i = queue[head++], x = i % W, y = Math.floor(i / W);
        if (mask[i] === 2) strong++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
          const next = yy * W + xx;
          if (!visited[next] && mask[next]) { visited[next] = 1; queue[tail++] = next; }
        }
      }
      // Weak texture and isolated specks are decoration, not puzzle boundaries.
      if (tail < 4 || strong < 2) continue;
      for (let j = 0; j < tail; j++) {
        const i = queue[j], p = i * 4;
        const darkness = Math.min(1, Math.max(0, (205 - lum[i]) / 65));
        const alpha = Math.min(.50, Math.max(0, (closed[i] - lum[i] - 10) / 85)) * darkness;
        output.data[p] = 75; output.data[p + 1] = 56; output.data[p + 2] = 50;
        output.data[p + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(output, 0, 0);
    return canvas;
  }
  window.NurieDetail = Object.freeze({build});
})();
