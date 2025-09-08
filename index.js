(() => {
  const STORAGE_KEY = 'qr_scans_v1';
  const SCAN_AREA_FACTOR = 0.60;

  // Estado
  let scans = loadScans();
  let html5QrCode = null;
  let running = false;
  let lastText = null;

  // Motores y timers
  let useBarcodeDetector = true;
  let hadSuccessfulDecode = false;
  let fallbackTimer = null;

  // Cámaras disponibles / selección actual
  let devices = [];
  let currentCamIndex = 0;

  // Overlay (marco)
  let overlayEl = null;
  let overlayFlashTimer = null;

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
    btnFlip: document.getElementById('btn-flip'),
    dup: document.getElementById('dup'),
    camSel: document.getElementById('camera-select'),
    reader: document.getElementById('qr-reader'),
    fileInput: document.getElementById('file-input'),
    msg: document.getElementById('msg'),
  };

  // Utils
  function loadScans(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
  function saveScans(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(scans)); }
  function updateStats(){
    els.total.textContent = scans.length;
    els.unique.textContent = new Set(scans.map(s => s.value)).size;
    els.last.textContent = scans.length ? scans[0].value.slice(0,120) : '—';
  }
  function renderTable(){
    els.tbody.innerHTML = scans.map(s =>
      `<tr><td>${fmtDate(s.time)}</td><td class="code">${escapeHtml(s.value)}</td></tr>`
    ).join('');
  }
  function fmtDate(iso){ const d = new Date(iso), p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m])); }
  function setMsg(text, type = ''){ els.msg.textContent = text || ''; els.msg.className = type ? `msg ${type}` : 'msg'; }
  function ensureSecureContext(){
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return true;
    if (window.isSecureContext) return true;
    setMsg('Esta página debe servirse por HTTPS para usar la cámara.', 'error');
    els.btnStart.disabled = true; return false;
  }
  async function requestCameraPermissionOnce(){
    try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); s.getTracks().forEach(t => t.stop()); return true; }
    catch { setMsg('No se pudo obtener permiso de cámara. Revisa los permisos del navegador.', 'error'); return false; }
  }

  // ---- Marco de escaneo
  function ensureOverlay(){ if (!overlayEl){ overlayEl = document.createElement('div'); overlayEl.id = 'scan-overlay'; els.reader.appendChild(overlayEl); } resizeOverlay(); }
  function resizeOverlay(){ if (!overlayEl) return; const side = Math.floor(Math.min(els.reader.clientWidth, els.reader.clientHeight) * SCAN_AREA_FACTOR); overlayEl.style.width = side+'px'; overlayEl.style.height = side+'px'; }
  function overlayFlashOk(){ if (!overlayEl) return; overlayEl.classList.add('ok'); clearTimeout(overlayFlashTimer); overlayFlashTimer = setTimeout(() => overlayEl.classList.remove('ok'), 900); }

  // ---- Detección / almacenamiento
  function addScan(text){
    if(!els.dup.checked && scans.some(s => s.value === text)) return;
    const item = { time: new Date().toISOString(), value: text };
    scans.unshift(item); saveScans(); updateStats();
    const row = document.createElement('tr'); row.innerHTML = `<td>${fmtDate(item.time)}</td><td class="code">${escapeHtml(item.value)}</td>`; els.tbody.prepend(row);
    if('vibrate' in navigator) navigator.vibrate(30);
  }
  function toCSV(){ const rows = [['fecha','codigo'], ...scans.map(s => [fmtDate(s.time), s.value])]; const esc=v=>'"'+String(v).replace(/"/g,'""')+'"'; return '\ufeff'+rows.map(r=>r.map(esc).join(',')).join('\r\n'); }
  function downloadCSV(){ const blob = new Blob([toCSV()], { type: 'text/csv;charset=utf-8;' }); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`scans-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(url); a.remove();},0); }

  // ---- Gestión de cámaras
  function guessBackIndex(list){
    const i1 = list.findIndex(d => /back|rear|environment|trase|trasera/i.test(d.label || ''));
    if (i1 >= 0) return i1;
    if (list.length >= 2) return list.length - 1; // heurística habitual
    return 0;
  }

  async function listCameras(){
    try {
      let got = await Html5Qrcode.getCameras();
      const labelsEmpty = got.length && got.every(d => !d.label);
      if ((!got.length || labelsEmpty) && navigator.mediaDevices?.getUserMedia) {
        await requestCameraPermissionOnce();
        got = await Html5Qrcode.getCameras();
      }
      devices = got;

      els.camSel.innerHTML = '';
      devices.forEach((d,i) => {
        const opt = document.createElement('option'); opt.value = d.id; opt.textContent = d.label || `Cámara ${i+1}`; els.camSel.appendChild(opt);
      });

      currentCamIndex = guessBackIndex(devices);
      if (devices.length) els.camSel.value = devices[currentCamIndex].id;

      if(!devices.length){
        const opt = document.createElement('option'); opt.value=''; opt.textContent='No hay cámaras detectadas'; els.camSel.appendChild(opt);
        setMsg('No se detectan cámaras. Abre la web en el navegador del sistema y comprueba permisos.', 'error');
      } else { setMsg(''); }
    } catch(err){
      setMsg('Error al enumerar cámaras: ' + (err?.message || err), 'error');
    }
  }

  // ---- Construimos una lista de CANDIDATOS para forzar la trasera
  function buildPreferredSources(){
    const sources = [];
    // 1) facingMode exact environment (si el agente lo respeta)
    sources.push({ type: 'facing', value: { facingMode: { exact: 'environment' } }, why: 'facingMode exact environment' });
    // 2) deviceId que parece trasero
    if (devices.length) {
      const backIdx = guessBackIndex(devices);
      if (backIdx >= 0) sources.push({ type: 'device', value: { deviceId: { exact: devices[backIdx].id } }, why: `deviceId back guess (${devices[backIdx].label || 'sin etiqueta'})` });
    }
    // 3) resto de deviceIds (por si la heurística falla), probando del último al primero
    devices.slice().reverse().forEach(d => sources.push({ type: 'device', value: { deviceId: { exact: d.id } }, why: `deviceId fallback (${d.label || 'sin etiqueta'})` }));
    // 4) facingMode environment no exact (algunos navegadores lo mapean a trasera)
    sources.push({ type: 'facing', value: { facingMode: 'environment' }, why: 'facingMode environment' });
    // 5) último recurso: sin preferencia
    sources.push({ type: 'facing', value: { facingMode: 'user' }, why: 'fallback user (último recurso)' });
    return sources;
  }

  function buildScanConfig(){
    const qrbox = (viewW, viewH) => Math.floor(Math.min(viewW, viewH) * SCAN_AREA_FACTOR);
    return {
      fps: 15,
      qrbox,
      aspectRatio: 3/4,
      disableFlip: true,
      formatsToSupport: [ Html5QrcodeSupportedFormats.QR_CODE ],
      experimentalFeatures: useBarcodeDetector ? { useBarCodeDetectorIfSupported: true } : {},
      videoConstraints: {
        width: { ideal: 1280 }, height: { ideal: 720 },
        focusMode: "continuous", advanced: [{ focusMode: "continuous" }]
      },
      rememberLastUsedCamera: true
    };
  }

  function getCurrentVideoFacingInfo(){
    try {
      const video = els.reader.querySelector('video');
      const track = video?.srcObject?.getVideoTracks?.()[0];
      const settings = track?.getSettings?.() || {};
      const label = track?.label || '';
      return { facing: settings.facingMode || '', label };
    } catch { return { facing:'', label:'' }; }
  }

  async function tryStartSequence(){
    const config = buildScanConfig();
    const sources = buildPreferredSources();

    if(!html5QrCode) html5QrCode = new Html5Qrcode(els.reader.id);

    for (let i = 0; i < sources.length; i++){
      const cand = sources[i];
      try {
        await html5QrCode.start(cand.value, config, onScan, onScanFail);
        running = true;
        els.btnStart.disabled = true; els.btnStop.disabled = false;
        ensureOverlay();

        // ¿Se abrió frontal por error? Lo comprobamos y, si es así, paramos y probamos el siguiente.
        const info = getCurrentVideoFacingInfo();
        const looksFront = /user|front/i.test(info.facing || '') || /front/i.test(info.label || '');
        setMsg(`Cámara iniciada (${cand.why}) → track: ${info.label || 'sin etiqueta'} ${info.facing ? `[${info.facing}]` : ''}`);

        if (looksFront && i < sources.length - 1) {
          await stop(); // cerrar para intentar la siguiente
          continue;
        }

        // éxito: configuramos flip/select según el track actual
        updateCurrentIndexFromTrackLabel(info.label);
        scheduleEngineFallback();
        return; // salimos: ya estamos funcionando con trasera (o la mejor posible)
      } catch (err) {
        // Intento fallido → probamos el siguiente candidato
        if (i === sources.length - 1) {
          setMsg('No se pudo iniciar la cámara con ningún modo: ' + (err?.message || err), 'error');
        }
      }
    }
  }

  function updateCurrentIndexFromTrackLabel(label){
    if (!label) return;
    const idx = devices.findIndex(d => (d.label||'') === label);
    if (idx >= 0) { currentCamIndex = idx; els.camSel.value = devices[idx].id; }
  }

  function scheduleEngineFallback(){
    hadSuccessfulDecode = false;
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(async () => {
      if (!hadSuccessfulDecode && running) {
        setMsg('Sin detecciones. Probando motor alternativo…');
        useBarcodeDetector = !useBarcodeDetector;
        await restart();
      }
    }, 8000);
  }

  async function start(){
    if(running) return;
    if(!ensureSecureContext()) return;
    if (!navigator.mediaDevices?.getUserMedia) { setMsg('Tu navegador no permite usar la cámara. Usa Safari/Chrome.', 'error'); return; }
    await requestCameraPermissionOnce();
    await tryStartSequence();
  }

  async function stop(){
    clearTimeout(fallbackTimer);
    if(!running || !html5QrCode) return;
    try { await html5QrCode.stop(); } catch {}
    running = false; els.btnStart.disabled = false; els.btnStop.disabled = true; setMsg('Cámara detenida.');
  }

  async function restart(){ await stop(); await start(); }

  function onScan(decodedText){
    hadSuccessfulDecode = true; overlayFlashOk();
    if(decodedText && decodedText !== lastText){
      addScan(decodedText); lastText = decodedText;
      setTimeout(() => { lastText = null; }, 1200);
    }
  }
  function onScanFail(){ /* silencioso */ }

  // Fallback: subir imagen
  if (els.fileInput) {
    els.fileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if(!file) return;
      if (running) await stop();
      try {
        if(!html5QrCode) html5QrCode = new Html5Qrcode(els.reader.id);
        if (typeof html5QrCode.scanFileV2 === 'function') {
          const r = await html5QrCode.scanFileV2(file, true);
          hadSuccessfulDecode = true; overlayFlashOk(); addScan(r.decodedText || String(r));
        } else {
          const t = await html5QrCode.scanFile(file, true);
          hadSuccessfulDecode = true; overlayFlashOk(); addScan(t);
        }
        setMsg('Decodificado desde foto.', 'ok');
      } catch (err) {
        setMsg('No se pudo decodificar la imagen: ' + (err?.message || err), 'error');
      } finally { ev.target.value = ''; }
    });
  }

  // Eventos UI
  els.btnStart.addEventListener('click', start);
  els.btnStop.addEventListener('click', stop);
  els.btnExport.addEventListener('click', downloadCSV);
  els.btnClear.addEventListener('click', () => { if(confirm('¿Seguro que quieres borrar TODOS los escaneos?')){ scans = []; saveScans(); renderTable(); updateStats(); } });
  els.btnRefresh.addEventListener('click', listCameras);
  // Flip: rota al siguiente device y reinicia
  if (els.btnFlip) els.btnFlip.addEventListener('click', async () => {
    if (devices.length <= 1) { setMsg('Sólo hay una cámara disponible.', 'error'); return; }
    currentCamIndex = (currentCamIndex + 1) % devices.length;
    els.camSel.value = devices[currentCamIndex].id;
    await restart();
  });
  // Cambio manual en selector
  els.camSel.addEventListener('change', async () => {
    const id = els.camSel.value;
    const idx = devices.findIndex(d => d.id === id);
    if (idx >= 0) currentCamIndex = idx;
    if (running) await restart();
  });

  // Redimensionar overlay cuando cambie tamaño/orientación
  window.addEventListener('resize', resizeOverlay);
  window.addEventListener('orientationchange', () => setTimeout(resizeOverlay, 100));

  // Arranque
  renderTable(); updateStats(); listCameras();
  window.addEventListener('pagehide', stop);
})();
