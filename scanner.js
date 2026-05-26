/* QR / Barcode Scanner — iOS + Android */
class CodeScanner
{
  static FORMATS = [
    'qr_code', 'aztec', 'code_128', 'code_39', 'code_93',
    'codabar', 'data_matrix', 'ean_13', 'ean_8',
    'itf', 'pdf417', 'upc_a', 'upc_e'
  ];

  static PERSIST_MS         = 2000;   // how long a code stays in the overlay after the last hit
  static DETECT_INTERVAL_MS = 120;    // detection rate
  static MAX_DETECT_DIM     = 1024;   // frame is downscaled to this size before decoding
  static HIT_PAD_PX         = 24;     // click hitbox padding around each rectangle
  static HIT_NEAR_LIMIT_PX  = 80;     // "almost-miss" click still selects the nearest code
  static MASK_OUT_TRIES     = 6;      // ZXing fallback: max decode passes per frame
  static ZXING_TIMEOUT_MS   = 8000;


  constructor()
  {
    this.video           = document.getElementById('video');
    this.overlay         = document.getElementById('overlay');
    this.ctx             = this.overlay.getContext('2d');
    this.statusEl        = document.getElementById('status');
    this.selectedCard    = document.getElementById('selectedCard');
    this.selectedValueEl = document.getElementById('selectedValue');
    this.clearBtn        = document.getElementById('clearSelected');
    this.liveCount       = document.getElementById('liveCount');
    this.liveList        = document.getElementById('liveList');
    this.fatalEl         = document.getElementById('fatal');
    this.fatalMsg        = document.getElementById('fatalMsg');

    this.detector    = null;     // BarcodeDetector (native path)
    this.zxingReader = null;     // ZXing fallback path
    this.zxingMulti  = null;
    this.useZxing    = false;

    this.stream     = null;
    this.workCanvas = document.createElement('canvas');
    this.workCtx    = this.workCanvas.getContext('2d', { willReadFrequently: true });

    this.tracker        = new Map();   // rawValue -> { rawValue, corners, lastSeenAt }
    this.lastDetections = [];
    this.lastListKey    = '';
    this.selectedValue  = '';
    this.emittedValue   = '';
    this.detectBusy     = false;
  }


  async start()
  {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    {
      this.showFatal('Kamera-Zugriff in diesem Browser nicht verfügbar.');
      return;
    }

    if (!(await this.setupEngine()))
    {
      return;
    }
    if (!(await this.startCamera()))
    {
      return;
    }

    this.fitOverlay();
    window.addEventListener('resize', () => this.fitOverlay());
    window.addEventListener('orientationchange', () => setTimeout(() => this.fitOverlay(), 200));

    this.overlay.style.pointerEvents = 'auto';
    this.overlay.addEventListener('click', (event) => this.handleClick(event));
    this.clearBtn.addEventListener('click', () => this.clearSelection());

    this.renderLoop();
    this.detectLoop();
  }


  /* ===================== Engine-Setup ===================== */

  async setupEngine()
  {
    if ('BarcodeDetector' in window)
    {
      try
      {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const wantedFormats = CodeScanner.FORMATS.filter(format => supported.includes(format));
        this.detector = new window.BarcodeDetector({
          formats: wantedFormats.length ? wantedFormats : ['qr_code']
        });
        return true;
      }
      catch (error)
      {
        // fall through to ZXing
      }
    }

    this.useZxing = true;
    if (!(await this.waitForZxing(CodeScanner.ZXING_TIMEOUT_MS)))
    {
      this.showFatal('Barcode-Bibliothek (ZXing) konnte nicht geladen werden.');
      return false;
    }
    try
    {
      this.setupZxing();
      return true;
    }
    catch (error)
    {
      this.showFatal('ZXing-Init fehlgeschlagen: ' + (error.message || error));
      return false;
    }
  }


  setupZxing()
  {
    const hints = new Map();
    const formats = [
      ZXing.BarcodeFormat.QR_CODE,    ZXing.BarcodeFormat.AZTEC,
      ZXing.BarcodeFormat.DATA_MATRIX, ZXing.BarcodeFormat.PDF_417,
      ZXing.BarcodeFormat.CODE_128,    ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.CODE_93,     ZXing.BarcodeFormat.CODABAR,
      ZXing.BarcodeFormat.EAN_13,      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.UPC_A,       ZXing.BarcodeFormat.UPC_E,
      ZXing.BarcodeFormat.ITF
    ].filter(format => format !== undefined);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    this.zxingReader = new ZXing.MultiFormatReader();
    this.zxingReader.setHints(hints);

    // GenericMultipleBarcodeReader is not always exposed in the UMD build — try several paths
    const MultiReaderCtor =
      ZXing.GenericMultipleBarcodeReader ||
      (ZXing.multi && ZXing.multi.GenericMultipleBarcodeReader) ||
      ZXing.QRCodeMultiReader ||
      (ZXing.multi && ZXing.multi.qrcode && ZXing.multi.qrcode.QRCodeMultiReader) ||
      null;
    if (MultiReaderCtor)
    {
      try
      {
        this.zxingMulti = MultiReaderCtor.length > 0
          ? new MultiReaderCtor(this.zxingReader)
          : new MultiReaderCtor();
      }
      catch (error)
      {
        this.zxingMulti = null;
      }
    }
  }


  waitForZxing(timeoutMs)
  {
    return new Promise(resolve =>
    {
      const startedAt = performance.now();
      const check = () =>
      {
        if (typeof window.ZXing !== 'undefined' && window.ZXing.MultiFormatReader)
        {
          resolve(true);
          return;
        }
        if (performance.now() - startedAt > timeoutMs)
        {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }


  async startCamera()
  {
    this.setStatus('Kamera startet…');
    try
    {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
    }
    catch (error)
    {
      this.showFatal('Kein Kamerazugriff: ' + (error.message || error));
      return false;
    }

    this.video.srcObject = this.stream;
    try
    {
      await this.video.play();
    }
    catch (error)
    {
      // iOS may require a user gesture — keep going
    }
    this.setStatus('Suche Codes…');
    return true;
  }


  /* ===================== Detection loop ===================== */

  detectLoop()
  {
    if (this.detectBusy)
    {
      return;
    }
    if (this.video.readyState < 2 || !this.video.videoWidth)
    {
      setTimeout(() => this.detectLoop(), 50);
      return;
    }

    this.detectBusy = true;
    const startedAt = performance.now();

    this.detectFrame()
      .then(detections => this.acceptDetections(detections))
      .catch(error => this.setStatus('Fehler: ' + (error.message || error)))
      .finally(() =>
      {
        this.detectBusy = false;
        const elapsed = performance.now() - startedAt;
        const wait = Math.max(0, CodeScanner.DETECT_INTERVAL_MS - elapsed);
        setTimeout(() => this.detectLoop(), wait);
      });
  }


  async detectFrame()
  {
    if (!this.video.videoWidth || !this.video.videoHeight)
    {
      return [];
    }
    const scale = this.prepareWorkCanvas();
    if (this.useZxing)
    {
      return this.detectZxing(scale);
    }
    return this.detectNative(scale);
  }


  prepareWorkCanvas()
  {
    const videoWidth  = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    const longestSide = Math.max(videoWidth, videoHeight);
    const scale = longestSide > CodeScanner.MAX_DETECT_DIM
      ? CodeScanner.MAX_DETECT_DIM / longestSide
      : 1;
    const targetWidth  = Math.round(videoWidth  * scale);
    const targetHeight = Math.round(videoHeight * scale);

    if (this.workCanvas.width !== targetWidth || this.workCanvas.height !== targetHeight)
    {
      this.workCanvas.width  = targetWidth;
      this.workCanvas.height = targetHeight;
    }
    this.workCtx.drawImage(this.video, 0, 0, targetWidth, targetHeight);
    return scale;
  }


  acceptDetections(detections)
  {
    const now = performance.now();
    for (const detection of detections)
    {
      this.tracker.set(detection.rawValue, {
        rawValue:   detection.rawValue,
        corners:    detection.corners,
        lastSeenAt: now
      });
    }
  }


  /* ===================== Detection — native path ===================== */

  async detectNative(scale)
  {
    const invertScale = 1 / scale;
    let rawDetections;
    try
    {
      rawDetections = await this.detector.detect(this.workCanvas);
    }
    catch (error)
    {
      // fallback: feed the <video> element directly (no downscaling)
      rawDetections = await this.detector.detect(this.video);
      return rawDetections.map(detection => ({
        rawValue: detection.rawValue,
        corners:  this.cornersFromNativeDetection(detection)
      }));
    }

    return rawDetections.map(detection =>
    {
      const corners = this.cornersFromNativeDetection(detection).map(point => ({
        x: point.x * invertScale,
        y: point.y * invertScale
      }));
      return { rawValue: detection.rawValue, corners };
    });
  }


  cornersFromNativeDetection(detection)
  {
    if (detection.cornerPoints && detection.cornerPoints.length)
    {
      return detection.cornerPoints.map(point => ({ x: point.x, y: point.y }));
    }
    const box = detection.boundingBox;
    return [
      { x: box.x,             y: box.y              },
      { x: box.x + box.width, y: box.y              },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x,             y: box.y + box.height }
    ];
  }


  /* ===================== Detection — ZXing path ===================== */

  detectZxing(scale)
  {
    const invertScale = 1 / scale;
    const results = this.zxingMulti
      ? this.zxingFindMulti()
      : this.zxingFindByMaskOut();

    const out  = [];
    const seen = new Set();
    for (const result of results)
    {
      const text = result.getText();
      if (seen.has(text))
      {
        continue;
      }
      seen.add(text);
      const corners = this.cornersFromZxingResult(result).map(point => ({
        x: point.x * invertScale,
        y: point.y * invertScale
      }));
      out.push({ rawValue: text, corners });
    }
    return out;
  }


  zxingFindMulti()
  {
    try
    {
      return this.zxingMulti.decodeMultiple(this.buildZxingBitmap()) || [];
    }
    catch (error)
    {
      return [];
    }
  }


  // No multi-reader available: decode one code, paint that region grey on
  // the work canvas, decode again — up to N passes.
  zxingFindByMaskOut()
  {
    const results = [];
    const seen = new Set();

    for (let attempt = 0; attempt < CodeScanner.MASK_OUT_TRIES; attempt++)
    {
      let result = null;
      try
      {
        result = this.zxingReader.decode(this.buildZxingBitmap());
      }
      catch (error)
      {
        // no hit
      }
      this.zxingReader.reset();
      if (!result)
      {
        break;
      }
      const text = result.getText();
      if (seen.has(text))
      {
        break;
      }
      seen.add(text);
      results.push(result);
      if (!this.maskOutResult(result))
      {
        break;
      }
    }
    return results;
  }


  maskOutResult(result)
  {
    const points = this.safeResultPoints(result);
    if (points.length < 2)
    {
      return false;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points)
    {
      const x = point.getX();
      const y = point.getY();
      if (x < minX) { minX = x; }
      if (x > maxX) { maxX = x; }
      if (y < minY) { minY = y; }
      if (y > maxY) { maxY = y; }
    }
    const padding = 24;
    this.workCtx.fillStyle = '#888';
    this.workCtx.fillRect(
      Math.max(0, minX - padding),
      Math.max(0, minY - padding),
      (maxX - minX) + padding * 2,
      (maxY - minY) + padding * 2
    );
    return true;
  }


  cornersFromZxingResult(result)
  {
    const points = this.safeResultPoints(result);

    if (points.length >= 3)
    {
      const corners = points.map(point => ({ x: point.getX(), y: point.getY() }));
      if (corners.length === 3)
      {
        // reconstruct the 4th corner as a parallelogram
        const [a, b, c] = corners;
        corners.push({ x: a.x + (c.x - b.x), y: a.y + (c.y - b.y) });
      }
      return corners;
    }

    if (points.length === 2)
    {
      // linear barcode: build a rectangle around the line
      const start = { x: points[0].getX(), y: points[0].getY() };
      const end   = { x: points[1].getX(), y: points[1].getY() };
      const deltaX = end.x - start.x;
      const deltaY = end.y - start.y;
      const length = Math.hypot(deltaX, deltaY) || 1;
      const normalX = -deltaY / length * 30;
      const normalY =  deltaX / length * 30;
      return [
        { x: start.x + normalX, y: start.y + normalY },
        { x: end.x   + normalX, y: end.y   + normalY },
        { x: end.x   - normalX, y: end.y   - normalY },
        { x: start.x - normalX, y: start.y - normalY }
      ];
    }

    // last resort: center of the frame
    const width  = this.workCanvas.width;
    const height = this.workCanvas.height;
    return [
      { x: width / 4,         y: height / 4         },
      { x: width * 3 / 4,     y: height / 4         },
      { x: width * 3 / 4,     y: height * 3 / 4     },
      { x: width / 4,         y: height * 3 / 4     }
    ];
  }


  safeResultPoints(result)
  {
    const raw = result.getResultPoints();
    if (!raw)
    {
      return [];
    }
    return raw.filter(point => point != null && typeof point.getX === 'function');
  }


  buildZxingBitmap()
  {
    const luminance = new ZXing.HTMLCanvasElementLuminanceSource(this.workCanvas);
    const binarizer = new ZXing.HybridBinarizer(luminance);
    return new ZXing.BinaryBitmap(binarizer);
  }


  /* ===================== Render loop ===================== */

  renderLoop()
  {
    const now = performance.now();
    for (const [key, entry] of this.tracker)
    {
      if (now - entry.lastSeenAt > CodeScanner.PERSIST_MS)
      {
        this.tracker.delete(key);
      }
    }
    this.lastDetections = Array.from(this.tracker.values());

    this.drawDetections(this.lastDetections);
    this.renderLiveList(this.lastDetections);
    this.updateStatus(this.lastDetections);

    requestAnimationFrame(() => this.renderLoop());
  }


  drawDetections(detections)
  {
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!detections.length)
    {
      return;
    }

    const multi = detections.length > 1;
    const strokeColor = multi ? '#ffb020' : '#22dd66';
    const fillColor   = multi ? 'rgba(255,176,32,0.18)' : 'rgba(34,221,102,0.18)';

    for (let index = 0; index < detections.length; index++)
    {
      const detection = detections[index];
      const cssPoints = detection.corners.map(point => this.videoToCss(point.x, point.y));

      this.ctx.beginPath();
      this.ctx.moveTo(cssPoints[0].x, cssPoints[0].y);
      for (let i = 1; i < cssPoints.length; i++)
      {
        this.ctx.lineTo(cssPoints[i].x, cssPoints[i].y);
      }
      this.ctx.closePath();
      this.ctx.lineWidth = 4;
      this.ctx.strokeStyle = strokeColor;
      this.ctx.fillStyle   = fillColor;
      this.ctx.fill();
      this.ctx.stroke();

      const minX = Math.min(...cssPoints.map(point => point.x));
      const maxX = Math.max(...cssPoints.map(point => point.x));
      const maxY = Math.max(...cssPoints.map(point => point.y));
      const label = (multi ? '#' + (index + 1) + '  ' : '')
        + this.truncate(detection.rawValue, 48);
      this.drawLabel(label, (minX + maxX) / 2, maxY + 10);
    }
  }


  drawLabel(text, centerX, topY)
  {
    this.ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const padX = 10;
    const padY = 6;
    const width  = this.ctx.measureText(text).width + padX * 2;
    const height = 14 + padY * 2;
    let x = Math.round(centerX - width / 2);
    let y = Math.round(topY);

    if (x < 6)
    {
      x = 6;
    }
    if (x + width > window.innerWidth - 6)
    {
      x = window.innerWidth - 6 - width;
    }
    if (y + height > window.innerHeight - 6)
    {
      y = window.innerHeight - 6 - height;
    }

    this.ctx.fillStyle = 'rgba(0,0,0,0.78)';
    this.ctx.fillRect(x, y, width, height);
    this.ctx.fillStyle = '#fff';
    this.ctx.textBaseline = 'top';
    this.ctx.fillText(text, x + padX, y + padY);
  }


  /* ===================== Click + selection ===================== */

  handleClick(event)
  {
    if (!this.lastDetections.length)
    {
      return;
    }

    const rect = this.overlay.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    let bestInside = null;
    let bestInsideDistance = Infinity;
    let nearest = null;
    let nearestDistance = Infinity;

    for (const detection of this.lastDetections)
    {
      const cssPoints = detection.corners.map(point => this.videoToCss(point.x, point.y));
      const center = this.centerOf(cssPoints);
      const distance = Math.hypot(center.x - clickX, center.y - clickY);
      const inflated = this.inflate(cssPoints, center, CodeScanner.HIT_PAD_PX);

      if (this.pointInPolygon(clickX, clickY, inflated))
      {
        if (distance < bestInsideDistance)
        {
          bestInside = detection;
          bestInsideDistance = distance;
        }
      }
      if (distance < nearestDistance)
      {
        nearest = detection;
        nearestDistance = distance;
      }
    }

    if (bestInside)
    {
      this.selectValue(bestInside.rawValue);
    }
    else if (nearest && nearestDistance < CodeScanner.HIT_NEAR_LIMIT_PX)
    {
      this.selectValue(nearest.rawValue);
    }
  }


  updateStatus(detections)
  {
    if (detections.length === 1)
    {
      this.setStatus('1 Code: ' + this.truncate(detections[0].rawValue, 32));
      if (detections[0].rawValue !== this.selectedValue)
      {
        this.selectValue(detections[0].rawValue);
      }
    }
    else if (detections.length > 1)
    {
      this.setStatus(detections.length + ' Codes — antippen');
    }
    else
    {
      this.setStatus('Suche Codes…');
    }
  }


  selectValue(value)
  {
    this.selectedValue = value;
    this.selectedValueEl.textContent = value;
    this.selectedCard.style.display = '';

    if (value !== this.emittedValue)
    {
      this.emittedValue = value;
      if (navigator.vibrate)
      {
        navigator.vibrate(40);
      }
      window.dispatchEvent(new CustomEvent('qr:selected', { detail: { value } }));
    }
  }


  clearSelection()
  {
    this.selectedValue = '';
    this.emittedValue  = '';
    this.selectedValueEl.textContent = '';
    this.selectedCard.style.display = 'none';
  }


  renderLiveList(detections)
  {
    const listKey = detections.map(detection => detection.rawValue).join('\x1f');
    if (listKey === this.lastListKey)
    {
      return;
    }
    this.lastListKey = listKey;
    this.liveCount.textContent = String(detections.length);

    if (!detections.length)
    {
      this.liveList.innerHTML = '<div class="empty">Keine Codes erkannt</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < detections.length; index++)
    {
      const detection = detections[index];
      const row = document.createElement('div');
      row.className = 'item';

      const badge = document.createElement('span');
      badge.className = 'idx';
      badge.textContent = String(index + 1);

      const text = document.createElement('span');
      text.className = 'txt';
      text.textContent = detection.rawValue;

      row.appendChild(badge);
      row.appendChild(text);
      fragment.appendChild(row);
    }
    this.liveList.innerHTML = '';
    this.liveList.appendChild(fragment);
  }


  /* ===================== Geometry ===================== */

  fitOverlay()
  {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width  = Math.floor(window.innerWidth  * dpr);
    this.overlay.height = Math.floor(window.innerHeight * dpr);
    this.overlay.style.width  = window.innerWidth  + 'px';
    this.overlay.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }


  // video coordinate -> CSS pixel on screen (accounts for object-fit: cover)
  videoToCss(videoX, videoY)
  {
    const videoWidth  = this.video.videoWidth  || 1;
    const videoHeight = this.video.videoHeight || 1;
    const screenWidth  = window.innerWidth;
    const screenHeight = window.innerHeight;
    const scale = Math.max(screenWidth / videoWidth, screenHeight / videoHeight);
    const offsetX = (screenWidth  - videoWidth  * scale) / 2;
    const offsetY = (screenHeight - videoHeight * scale) / 2;
    return {
      x: offsetX + videoX * scale,
      y: offsetY + videoY * scale
    };
  }


  centerOf(points)
  {
    let sumX = 0;
    let sumY = 0;
    for (const point of points)
    {
      sumX += point.x;
      sumY += point.y;
    }
    return { x: sumX / points.length, y: sumY / points.length };
  }


  // inflate the polygon radially around its center by `padding` CSS pixels
  inflate(points, center, padding)
  {
    return points.map(point =>
    {
      const deltaX = point.x - center.x;
      const deltaY = point.y - center.y;
      const length = Math.hypot(deltaX, deltaY) || 1;
      return {
        x: point.x + (deltaX / length) * padding,
        y: point.y + (deltaY / length) * padding
      };
    });
  }


  pointInPolygon(x, y, polygon)
  {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++)
    {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const crosses = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
      if (crosses)
      {
        inside = !inside;
      }
    }
    return inside;
  }


  /* ===================== Helpers ===================== */

  setStatus(text)
  {
    this.statusEl.textContent = text;
  }


  showFatal(message)
  {
    this.fatalMsg.textContent = message;
    this.fatalEl.classList.add('show');
  }


  truncate(text, max)
  {
    if (!text)
    {
      return '';
    }
    const flat = String(text).replace(/\s+/g, ' ');
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  }
}


new CodeScanner().start();
