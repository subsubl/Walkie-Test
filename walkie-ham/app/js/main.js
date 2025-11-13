// Walkie-Talkie HAM - plain JS implementation (responsive, OFF-AIR loopback)
(function(){
  // DOM
  const statusEl = document.getElementById('status');
  const peerLed = document.getElementById('peerLed');
  const playLed = document.getElementById('playLed');
  const connStatus = document.getElementById('connStatus');
  const onAir = document.getElementById('onAir');
  const night = document.getElementById('night');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlayText');

  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const clearBtn = document.getElementById('clearBtn');

  const ptt = document.getElementById('ptt');
  const micGain = document.getElementById('micGain');
  const outGain = document.getElementById('outGain');
  const micNeedle = document.getElementById('micNeedle');
  const outNeedle = document.getElementById('outNeedle');

  // Whiteboard
  const canvas = document.getElementById('whiteboard');
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let currentStroke = null;
  let history = [];
  let redoStack = [];

  function resizeCanvas(){
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    redraw();
  }
  window.addEventListener('resize', resizeCanvas);
  // initial size
  function initCanvasSize(){
    canvas.style.height = Math.max(220, window.innerHeight * 0.45) + 'px';
    resizeCanvas();
  }
  initCanvasSize();

  function getPosFromEvent(e){
    const rect = canvas.getBoundingClientRect();
    if(e.touches && e.touches.length) {
      return [e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top];
    } else {
      return [e.clientX - rect.left, e.clientY - rect.top];
    }
  }

  function startDrawing(e){
    drawing = true;
    redoStack = [];
    currentStroke = { id: Date.now() + '-' + Math.random(), color: selectedColor, size: selectedSize, points: [] };
    moveDrawing(e);
  }
  function moveDrawing(e){
    if(!drawing) return;
    e.preventDefault();
    const pos = getPosFromEvent(e);
    currentStroke.points.push({ x: pos[0], y: pos[1] });
    redraw();
  }
  function stopDrawing(){
    if(!drawing) return;
    drawing = false;
    if(currentStroke && currentStroke.points.length){
      history.push(currentStroke);
      sendNetwork(`DRAW:${JSON.stringify({ type:'stroke', payload: currentStroke })}`);
      currentStroke = null;
      updateUndoRedo();
    }
  }

  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', moveDrawing);
  window.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('touchstart', startDrawing, { passive:false });
  canvas.addEventListener('touchmove', moveDrawing, { passive:false });
  window.addEventListener('touchend', stopDrawing);

  function redraw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    // draw history
    history.forEach(s => drawStroke(s));
    // current
    if(currentStroke) drawStroke(currentStroke);
  }
  function drawStroke(stroke){
    if(!stroke || !stroke.points || !stroke.points.length) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for(let i=1;i<stroke.points.length;i++){
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }

  undoBtn.addEventListener('click', ()=>{
    if(history.length===0) return;
    redoStack.push(history.pop());
    redraw();
    updateUndoRedo();
    sendNetwork('DRAW:'+JSON.stringify({ type:'undo' }));
  });
  redoBtn.addEventListener('click', ()=>{
    if(redoStack.length===0) return;
    history.push(redoStack.pop());
    redraw();
    updateUndoRedo();
    sendNetwork('DRAW:'+JSON.stringify({ type:'redo' }));
  });
  clearBtn.addEventListener('click', ()=>{
    history = [];
    redoStack = [];
    redraw();
    updateUndoRedo();
    sendNetwork('DRAW:'+JSON.stringify({ type:'clear' }));
  });

  function updateUndoRedo(){
    undoBtn.disabled = history.length===0;
    redoBtn.disabled = redoStack.length===0;
  }
  updateUndoRedo();

  // Color and size
  let selectedColor = '#FFFFFF';
  let selectedSize = 4;

  // Palette UI
  const palette = ['#FFFFFF','#ff453a','#ff9f0a','#ffd60a','#32d74b','#0a84ff','#5e5ce6','#bf5af2'];
  const paletteContainer = document.querySelector('.palette');
  palette.forEach(c=>{
    const b = document.createElement('button');
    b.style.backgroundColor = c;
    b.className = 'w-8 h-8 rounded border border-black';
    b.title = c;
    b.addEventListener('click', ()=> { selectedColor = c; });
    paletteContainer.appendChild(b);
  });

  // AUDIO
  let audioContext = null;
  let micStream = null;
  let scriptNode = null;
  let micGainNode = null;
  let outGainNode = null;
  let micAnalyser = null;
  let outAnalyser = null;
  let isRecording = false;
  let offlineBuffer = [];
  let recordedChunks = []; // for current PTT recording

  async function initAudio(){
    if(audioContext) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new (window.AudioContext||window.webkitAudioContext)({ sampleRate:16000 });
      const source = audioContext.createMediaStreamSource(micStream);
      scriptNode = audioContext.createScriptProcessor(4096,1,1);
      micAnalyser = audioContext.createAnalyser(); micAnalyser.fftSize=256;
      outAnalyser = audioContext.createAnalyser(); outAnalyser.fftSize=256;
      micGainNode = audioContext.createGain();
      outGainNode = audioContext.createGain();

      // Mute monitoring path: source -> micGain -> micAnalyser -> scriptNode -> mute -> destination
      const muteNode = audioContext.createGain(); muteNode.gain.setValueAtTime(0,audioContext.currentTime);
      source.connect(micGainNode);
      micGainNode.connect(micAnalyser);
      micAnalyser.connect(scriptNode);
      scriptNode.connect(muteNode);
      muteNode.connect(audioContext.destination);

      // Playback path: outGain -> outAnalyser -> destination
      outGainNode.connect(outAnalyser);
      outAnalyser.connect(audioContext.destination);

      scriptNode.onaudioprocess = (ev)=> {
        if(!isRecording) return;
        const input = ev.inputBuffer.getChannelData(0);
        const b64 = encodePcm16(input);
        recordedChunks.push(b64);
        // live-send when ON-AIR
        if(onAir.checked){
          sendNetwork('AUDIO:'+b64);
        } else {
          // when OFF-AIR, buffer locally (for loopback)
          offlineBuffer.push(b64);
        }
        // update mic VU
        const db = calculateDb(input);
        setVu(micNeedle, db);
      };
      return true;
    } catch(e){
      console.error('Audio init error', e);
      return false;
    }
  }

  function calculateDb(float32Array){
    let sum=0;
    for(let i=0;i<float32Array.length;i++){ const v=float32Array[i]; sum += v*v; }
    const rms = Math.sqrt(sum/float32Array.length);
    if(rms===0) return -60;
    return Math.max(-60, 20*Math.log10(rms));
  }
  function setVu(el, db){
    const clamped = Math.max(-60, Math.min(0, db));
    const rotation = (clamped + 60)/60 * 90 - 45;
    el.style.transform = `rotate(${rotation}deg)`;
  }

  function encodePcm16(float32Array){
    const l = float32Array.length;
    const int16 = new Int16Array(l);
    for(let i=0;i<l;i++){
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s<0 ? s*0x8000 : s*0x7FFF;
    }
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function decodeBase64ToInt16(b64){
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for(let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  async function playPcmBase64Chunks(chunks){
    if(!audioContext) audioContext = new (window.AudioContext||window.webkitAudioContext)();
    if(audioContext.state==='suspended') await audioContext.resume();
    if(!outGainNode) outGainNode = audioContext.createGain();
    // combine arrays
    let total = 0;
    const arrays = chunks.map(c=>decodeBase64ToInt16(c));
    arrays.forEach(a=> total += a.length);
    const floatArr = new Float32Array(total);
    let offset=0;
    arrays.forEach(a=>{
      for(let i=0;i<a.length;i++){
        floatArr[offset+i] = a[i] / 32768.0;
      }
      offset += a.length;
    });
    // create audio buffer and play through outGainNode (prevents mic feedback)
    const buf = audioContext.createBuffer(1, floatArr.length, 16000);
    buf.getChannelData(0).set(floatArr);
    const src = audioContext.createBufferSource();
    src.buffer = buf;
    src.connect(outGainNode);
    outGainNode.connect(audioContext.destination);
    // animate play LED and VU
    playLed.className = 'led led-amber';
    setVu(outNeedle, -10);
    return new Promise((resolve)=>{
      src.onended = ()=>{
        playLed.className = 'led led-off';
        setVu(outNeedle, -60);
        resolve();
      };
      src.start();
    });
  }

  // PTT handlers — start/stop recording, OFF-AIR loopback playback
  ptt.addEventListener('mousedown', async ()=>{
    if(isRecording) return;
    const ok = await initAudio();
    if(!ok){ statusEl.textContent = 'Mic denied'; return; }
    // Reset recordedChunks for this PTT session
    recordedChunks = [];
    isRecording = true;
    statusEl.textContent = onAir.checked ? 'Transmitting...' : 'Recording...';
    ptt.classList.add('active');
  });
  ptt.addEventListener('mouseup', async ()=>{
    if(!isRecording) return;
    isRecording = false;
    ptt.classList.remove('active');
    statusEl.textContent = 'Processing...';
    // If OFF-AIR, immediately play back the recordedChunks as loopback (echo)
    if(!onAir.checked && recordedChunks.length){
      try {
        await playPcmBase64Chunks(recordedChunks);
      } catch(e){
        console.error('Playback error', e);
      }
    }
    statusEl.textContent = 'Ready';
  });
  // touch support
  ptt.addEventListener('touchstart', (e)=>{ e.preventDefault(); ptt.dispatchEvent(new MouseEvent('mousedown')); });
  ptt.addEventListener('touchend', (e)=>{ e.preventDefault(); ptt.dispatchEvent(new MouseEvent('mouseup')); });

  micGain.addEventListener('input', ()=>{
    const v = micGain.value/100;
    if(micGainNode) micGainNode.gain.setValueAtTime(v, audioContext.currentTime || 0);
  });
  outGain.addEventListener('input', ()=>{
    const v = outGain.value/100;
    if(outGainNode) outGainNode.gain.setValueAtTime(v, audioContext.currentTime || 0);
  });

  // NETWORK (Spixi)
  function safeSpixiSend(data){
    if(typeof SpixiAppSdk !== 'undefined' && SpixiAppSdk.sendNetworkData){
      SpixiAppSdk.sendNetworkData(data);
    } else {
      console.log('No Spixi SDK - would send:', data);
    }
  }
  function sendNetwork(data){ safeSpixiSend(data); }

  // handle incoming network
  if(typeof SpixiAppSdk !== 'undefined'){
    SpixiAppSdk.onNetworkData = (sender, data) => handleIncomingNetwork({ senderAddress: sender, data });
    SpixiAppSdk.onInit = (sessionId, userAddresses) => {
      statusEl.textContent = 'Ready';
      connStatus.textContent = userAddresses.length > 1 ? 'ON-AIR' : 'OFF-AIR';
      if(userAddresses.length > 1) peerLed.className = 'led led-green'; else peerLed.className = 'led led-off';
      // request history if joining late
      if(userAddresses.length > 1){
        sendNetwork('DRAW:WHITEBOARD:GET_HISTORY');
      }
      // fireOnLoad if present
      if(typeof SpixiAppSdk.fireOnLoad === 'function') SpixiAppSdk.fireOnLoad();
    };
    if(typeof SpixiAppSdk.fireOnLoad === 'function') SpixiAppSdk.fireOnLoad();
  } else {
    statusEl.textContent = 'Ready (No Spixi SDK)';
  }

  function handleIncomingNetwork(obj){
    const data = obj.data || obj;
    if(typeof data !== 'string') return;
    if(data.startsWith('DRAW:')){
      const payload = data.substring(5);
      try{
        const action = JSON.parse(payload);
        switch(action.type){
          case 'stroke': history.push(action.payload); redraw(); updateUndoRedo(); break;
          case 'undo': if(history.length){ redoStack.push(history.pop()); redraw(); updateUndoRedo(); } break;
          case 'redo': if(redoStack.length){ history.push(redoStack.pop()); redraw(); updateUndoRedo(); } break;
          case 'clear': history=[]; redoStack=[]; redraw(); updateUndoRedo(); break;
          case 'WHITEBOARD:GET_HISTORY': safeSpixiSend('DRAW:WHITEBOARD:HISTORY:'+JSON.stringify(history)); break;
        }
      }catch(e){
        if(payload.startsWith('WHITEBOARD:HISTORY:')){
          const hist = payload.substring('WHITEBOARD:HISTORY:'.length);
          try{ const h = JSON.parse(hist); history = h; redraw(); updateUndoRedo(); }catch(e){}
        }
      }
    } else if(data.startsWith('AUDIO:')){
      const b64 = data.substring(6);
      statusEl.textContent = 'Receiving...';
      // play on output
      playPcmBase64Chunks([b64]).then(()=> { statusEl.textContent = 'Ready'; });
    } else if(data === 'PRESENCE:PING'){
      safeSpixiSend('PRESENCE:PONG');
    } else if(data === 'PRESENCE:PONG'){
      peerLed.className = 'led led-green';
      setTimeout(()=>{ peerLed.className = 'led led-off'; }, 5000);
    } else if(data.startsWith('DRAW:WHITEBOARD:HISTORY:')){
      try{
        const hist = JSON.parse(data.substring('DRAW:WHITEBOARD:HISTORY:'.length));
        history = hist;
        redraw();
        updateUndoRedo();
      }catch(e){}
    }
  }

  // presence pinging when onAir checked
  let presenceInterval = null;
  onAir.addEventListener('change', ()=>{
    if(onAir.checked){
      connStatus.textContent = 'ON-AIR';
      presenceInterval = setInterval(()=> safeSpixiSend('PRESENCE:PING'), 3000);
    } else {
      connStatus.textContent = 'OFF-AIR';
      clearInterval(presenceInterval);
      presenceInterval = null;
    }
  });

  // night mode
  night.addEventListener('change', ()=>{
    if(night.checked) document.documentElement.classList.add('night-mode'); else document.documentElement.classList.remove('night-mode');
  });

  // expose testing helper
  window.__spixi_app_stub_incoming = handleIncomingNetwork;

  statusEl.textContent = 'Ready';
})();