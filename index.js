(() => {
  const STORAGE_KEY = 'qr_scans_v1';

  // ----- Estado -----
  let scans = loadScans();
  let html5QrCode = null;
  let running = false;
  let lastText = null;

  // Alternancia de motores: primero probamos con BarcodeDetector si está soportado,
  // y si no detecta nada en 8s, reiniciamos con el motor JS de la librería.
  let useBarcodeDetector = true;
  let hadSuccessfulDecode = false;
  let fallbackTimer = null;

  const els = {
    total: document.getElementById('stat-total'),
    unique: document.getElementById('stat-unique'),
    last: document.getElementById('stat-last'),
    tbody: document.getElementById('tbody'),
    btnStart: document.getElementById('btn-start'),
    btnStop: document.getElementById('btn-stop'),
    btnExport: document.getElementById('btn-export'),
    btnClear: document.getElementById('btn-clear'),
    btnRefresh: document.getElementById('btn-refresh'),
    dup: document.getElementById('dup'),
    camSel: document.getElementById('camera-select'),
    reader: document.getElementById('qr-reader'),
    fileInput: document.getElementById('file-input'),
    msg: document.getElementById('msg'),
  };

  // ===== Utilidades =====
  function loadScans(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch(e){ return []; }
  }
  function saveScans(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(scans)); }

  function updateStats(){
    els.total.textContent = scans.length;
    const uniq = new Set(scans.map(s => s.value)).size;
    els.unique.textContent = uniq;
    els.last.textContent = scans.length ? scans[0].value.slice(0,120) : '—';
  }

  function renderTable(){
    els.tbody.innerHTML = scans.map(s =>
      `<tr><td>${fmtDate(s.time)}</td><td class="code">${escapeHtml(s.value)}</td></tr>`
    ).join('');
  }

  function fmtDate(iso){
    try {
      const d = new Date(iso);
      const pad = n => String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch(e){ return iso; }
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
  }

  function setMsg(text, type = ''){
    els.msg.textContent = text || '';
    els.msg.className = type ? `msg ${type}` : 'msg';
  }

  function ensureSecureContext(){
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return true;
    if (window.isSecureContext) return true;
    setMsg('Esta página debe servirse por HTTPS para usar la cámara.', 'error');
    els.btnStart.disabled = true;
    return false;
  }

  function isIOS(){
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async function requestCameraPermissionOnce(){
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      s.getTracks().forEach(t => t.stop());
      return true;
    } catch (e) {
      setMsg('No se pudo obtener permiso de cámara. Revisa los permisos del navegador.', 'error');
      return false;
    }
  }

  // ===== Lógica de escaneos =====
  function addScan(text){
    const allowDup = els.dup.checked;
    if(!allowDup){
      const exists = scans.some(s => s.value === text);
      if(exists) return;
    }
    const item = { time: new Date().toISOString(), value: text };
    scans.unshift(item);
    saveScans();
    updateStats();
    const row = document.createElement('tr');
    row.innerHTML = `<td>${fmtDate(item.time)}</td><td class="code">${escapeHtml(item.value)}</td>`;
    els.tbody.prepend(row);
    if('vibrate' in navigator) navigator.vibrate(30);
  }

  function toCSV(){
    const rows = [['fecha','codigo'], ...scans.map(s => [fmtDate(s.time), s.value])];
    const esc = v => '"' + String(v).replace(/"/g,'""') + '"';
    const csv = rows.map(r => r.map(esc).join(',')).join('\r\n');
    return '\ufeff' + csv; // BOM para Excel
  }

  function downloadCSV(){
    const csv = toCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    a.href = url; a.download = `scans-${stamp}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  async function listCameras(){
    try {
      let devices = await Html5Qrcode.getCameras();
      const labelsEmpty = devices.length && devices.every(d => !d.label);

      if ((!devices.length || labelsEmpty) && navigator.mediaDevices?.getUserMedia) {
        await requestCameraPermissionOnce();
        devices = await Html5Qrcode.getCameras();
      }

      els.camSel.innerHTML = '';
      devices.forEach((d,i) => {
        const opt = document.createElement('option');
        const label = d.label || `Cámara ${i+1}`;
        opt.value = d.id; opt.textContent = label;
        els.camSel.appendChild(opt);
      });

      const back = devices.find(d => /back|rear|trase|environment/i.test(d.label || ''));
      if(back) els.camSel.value = back.id;

      if(devices.length === 0){
        const opt = document.createElement('option');
        opt.value=''; opt.textContent='No hay cámaras detectadas';
        els.camSel.appendChild(opt);
        setMsg('No se detectan cámaras. Abre la web en Safari/Chrome del sistema y comprueba permisos.', 'error');
      } else {
        setMsg(isIOS() ? 'Consejo iOS: usa Safari y revisa Ajustes > Safari > Cámara.' : '');
      }
    } catch(err){
      setMsg('Error al enumerar cámaras: ' + (err?.message || err), 'error');
    }
  }

  // Construye el config con preferencias que mejoran la detección
  function buildScanConfig(){
    const SCAN_AREA_FACTOR = 0.60; // 60% del lado corto
    const qrbox = (viewW, viewH) => Math.floor(Math.min(viewW, viewH) * SCAN_AREA_FACTOR);

    return {
      fps: 15,
      qrbox,
      aspectRatio: 3/4,
      disableFlip: true, // evita espejado que confunde al detector
      formatsToSupport: [ Html5QrcodeSupportedFormats.QR_CODE ],
      experimentalFeatures: useBarcodeDetector ? { useBarCodeDetectorIfSupported: true } : {},
      // Subimos resolución y pedimos foco continuo si el navegador lo soporta
      videoConstraints: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        focusMode: "continuous",
        advanced: [{ focusMode: "continuous" }]
      },
      rememberLastUsedCamera: true
    };
  }

  async function start(){
    if(running) return;
    if(!ensureSecureContext()) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMsg('Tu navegador no permite usar la cámara (posible navegador dentro de app). Usa Safari/Chrome.', 'error');
      return;
    }

    // iOS: pedir permiso proactivamente mejora los labels y el enfoque inicial
    await requestCameraPermissionOnce();

    const deviceId = els.camSel.value || undefined;
    if(!html5QrCode) {
      html5QrCode = new Html5Qrcode(els.reader.id /* verbose: false */);
    }

    const config = buildScanConfig();
    const source = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' };

    try {
      hadSuccessfulDecode = false;
      await html5QrCode.start(source, config, onScan, onScanFail);
      running = true;
      els.btnStart.disabled = true;
      els.btnStop.disabled = false;
      setMsg(useBarcodeDetector
        ? 'Cámara iniciada (motor nativo). Apunta a un QR.'
        : 'Cámara iniciada (motor alternativo). Apunta a un QR.'
      );

      // Si en 8s no hay ningún decode, cambiamos de motor automáticamente
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(async () => {
        if (!hadSuccessfulDecode && running) {
          setMsg('Sin detecciones. Probando motor alternativo…');
          useBarcodeDetector = !useBarcodeDetector;
          await restart();
        }
      }, 8000);

    } catch(err){
      setMsg('No se pudo iniciar la cámara: ' + (err?.message || err), 'error');
    }
  }

  async function stop(){
    clearTimeout(fallbackTimer);
    if(!running || !html5QrCode) return;
    try { await html5QrCode.stop(); } catch(_){}
    running = false;
    els.btnStart.disabled = false;
    els.btnStop.disabled = true;
    setMsg('Cámara detenida.');
  }

  async function restart(){
    await stop();
    await start();
  }

  function onScan(decodedText){
    hadSuccessfulDecode = true;
    if(decodedText && decodedText !== lastText){
      addScan(decodedText);
      lastText = decodedText;
      setTimeout(() => { lastText = null; }, 1200);
    }
  }
  function onScanFail(){ /* silencioso por frame fallido */ }

  // ===== Fallback: subir imagen y decodificar =====
  if (els.fileInput) {
    els.fileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if(!file) return;

      if (running) await stop();

      try {
        if(!html5QrCode) html5QrCode = new Html5Qrcode(els.reader.id);
        if (typeof html5QrCode.scanFileV2 === 'function') {
          const result = await html5QrCode.scanFileV2(file, /*showImage=*/true);
          hadSuccessfulDecode = true;
          addScan(result.decodedText || String(result));
        } else {
          const text = await html5QrCode.scanFile(file, /*showImage=*/true);
          hadSuccessfulDecode = true;
          addScan(text);
        }
        setMsg('Decodificado desde foto.', 'ok');
      } catch (err) {
        setMsg('No se pudo decodificar la imagen: ' + (err?.message || err), 'error');
      } finally {
        ev.target.value = '';
      }
    });
  }

  // ===== Eventos UI =====
  els.btnStart.addEventListener('click', start);
  els.btnStop.addEventListener('click', stop);
  els.btnExport.addEventListener('click', downloadCSV);
  els.btnClear.addEventListener('click', () => {
    if(confirm('¿Seguro que quieres borrar TODOS los escaneos guardados?')){
      scans = []; saveScans(); renderTable(); updateStats();
    }
  });
  els.btnRefresh.addEventListener('click', listCameras);

  // Arranque
  renderTable(); updateStats(); listCameras();

  // Limpieza al salir
  window.addEventListener('pagehide', stop);
})();
