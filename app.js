'use strict';

// Para redes muito restritas, adicione um servidor TURN aqui.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];
const SCREEN_BITRATE = 4_000_000;
const RETRY_MS = 3000;

const $ = (id) => document.getElementById(id);
const ui = {
  login: $('login'),
  form: $('login-form'),
  password: $('password'),
  loginError: $('login-error'),
  room: $('room'),
  status: $('status'),
  roomCode: $('room-code'),
  stage: $('stage'),
  screen: $('screen-video'),
  placeholder: $('placeholder'),
  localCam: $('local-cam'),
  remoteCam: $('remote-cam'),
  mic: $('btn-mic'),
  cam: $('btn-cam'),
  share: $('btn-share'),
  fullscreen: $('btn-fullscreen'),
  leave: $('btn-leave'),
};

let roomId = null;
let peer = null;
let partner = null; // DataConnection com a outra pessoa
let localStream = null;
let screenStream = null; // a tela que eu compartilho
let remoteScreen = null; // a tela que a outra pessoa compartilha
let outgoingScreen = null;
let retryTimer = null;

// ---------- Entrar / sair ----------

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  ui.loginError.textContent = '';
  if (!navigator.mediaDevices?.getUserMedia) {
    ui.loginError.textContent = 'Abra o site pelo link https para usar câmera e microfone.';
    return;
  }
  try {
    localStream = await getLocalMedia();
  } catch {
    ui.loginError.textContent = 'Permita o acesso à câmera e ao microfone para entrar.';
    return;
  }
  roomId = await hashRoomId(ui.password.value);
  ui.password.value = '';
  // Os dois devem ver o mesmo código; se for diferente, as senhas não batem.
  ui.roomCode.textContent = roomId.slice(5, 9).toUpperCase();
  ui.localCam.srcObject = localStream;
  ui.cam.disabled = localStream.getVideoTracks().length === 0;
  ui.cam.setAttribute('aria-pressed', String(!ui.cam.disabled));
  ui.mic.setAttribute('aria-pressed', 'true');
  ui.login.hidden = true;
  ui.room.hidden = false;
  connect();
});

ui.leave.addEventListener('click', () => leave());
window.addEventListener('beforeunload', () => peer?.destroy());

function leave(message = '') {
  clearTimeout(retryTimer);
  stopShare();
  roomId = null;
  partner = null;
  peer?.destroy();
  peer = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  remoteScreen = null;
  renderStage();
  ui.remoteCam.srcObject = null;
  ui.remoteCam.hidden = true;
  ui.room.hidden = true;
  ui.login.hidden = false;
  ui.loginError.textContent = message;
}

async function getLocalMedia() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
      audio,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw err;
    return navigator.mediaDevices.getUserMedia({ audio }); // sem câmera
  }
}

// A senha nunca sai do navegador: só o hash vira o ID da sala.
async function hashRoomId(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stef:' + password));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'stef-' + hex.slice(0, 32);
}

// ---------- Conexão ----------

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const options = { config: { iceServers: ICE_SERVERS } };
    const p = id ? new Peer(id, options) : new Peer(options);
    const onError = (err) => {
      p.destroy();
      reject(err);
    };
    p.once('error', onError);
    p.once('open', () => {
      p.off('error', onError);
      resolve(p);
    });
  });
}

// Quem chega primeiro registra o ID da sala e vira anfitrião; o segundo conecta nele.
async function connect() {
  clearTimeout(retryTimer);
  partner = null;
  peer?.destroy();
  peer = null;
  setStatus('Conectando…');

  let p;
  let isHost = true;
  try {
    p = await openPeer(roomId);
  } catch (err) {
    if (err.type !== 'unavailable-id') return onPeerError(err);
    isHost = false;
    try {
      p = await openPeer();
    } catch (err2) {
      return onPeerError(err2);
    }
  }
  if (!roomId) return p.destroy(); // saiu enquanto conectava

  peer = p;
  p.on('connection', onIncomingConnection);
  p.on('call', onIncomingCall);
  p.on('error', onPeerError);
  p.on('disconnected', () => {
    if (!p.destroyed) p.reconnect();
  });

  if (isHost) {
    setStatus('Aguardando a outra pessoa entrar…');
  } else {
    acceptPartner(p.connect(roomId, { reliable: true }), false);
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, RETRY_MS);
}

function onPeerError(err) {
  if (ui.room.hidden) return;
  switch (err.type) {
    case 'peer-unavailable': // anfitrião saiu; tentar de novo (talvez viremos o anfitrião)
      setStatus('Procurando a outra pessoa…');
      return scheduleRetry();
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      setStatus('Sem conexão com o servidor. Tentando de novo…');
      return scheduleRetry();
    case 'browser-incompatible':
      return leave('Este navegador não suporta chamadas de vídeo. Use Chrome ou Edge.');
    default:
      setStatus('Erro: ' + (err.message || err.type));
  }
}

function onIncomingConnection(conn) {
  if (partner?.open) {
    conn.on('open', () => {
      conn.send({ type: 'full' });
      setTimeout(() => conn.close(), 500);
    });
    return;
  }
  partner?.close();
  acceptPartner(conn, true);
}

function acceptPartner(conn, isHost) {
  partner = conn;
  conn.on('open', () => {
    setStatus('Conectado');
    if (!isHost) startCamCall();
    sendScreen();
  });
  conn.on('data', onMessage);
  conn.on('close', () => {
    if (partner === conn) onPartnerLeft(isHost);
  });
}

function onPartnerLeft(isHost) {
  partner = null;
  outgoingScreen?.close();
  outgoingScreen = null;
  remoteScreen = null;
  renderStage();
  ui.remoteCam.srcObject = null;
  ui.remoteCam.hidden = true;
  if (isHost) {
    setStatus('A outra pessoa saiu. Aguardando…');
  } else {
    setStatus('O anfitrião saiu. Reconectando…');
    scheduleRetry();
  }
}

function onMessage(msg) {
  if (msg?.type === 'full') leave('Sala cheia: já tem duas pessoas nesta sala.');
  if (msg?.type === 'screen-stop') {
    remoteScreen = null;
    renderStage();
  }
}

// ---------- Chamadas de mídia ----------

function startCamCall() {
  const call = peer.call(partner.peer, localStream, { metadata: { kind: 'cam' } });
  showRemoteCam(call);
}

function onIncomingCall(call) {
  if (call.peer !== partner?.peer) return call.close();
  if (call.metadata?.kind === 'screen') {
    call.answer(undefined, { sdpTransform: stereoOpus });
    call.on('stream', (stream) => {
      remoteScreen = stream;
      renderStage();
    });
    call.on('close', () => {
      if (remoteScreen !== call.remoteStream) return;
      remoteScreen = null;
      renderStage();
    });
  } else {
    call.answer(localStream);
    showRemoteCam(call);
  }
}

function showRemoteCam(call) {
  call.on('stream', (stream) => {
    ui.remoteCam.srcObject = stream;
    ui.remoteCam.hidden = false;
  });
}

// Quem compartilha vê no palco a mesma imagem que a outra pessoa recebe.
function renderStage() {
  const stream = remoteScreen ?? screenStream;
  if (ui.screen.srcObject !== stream) ui.screen.srcObject = stream;
  ui.screen.muted = !remoteScreen; // na própria tela o som já sai da aba original
  ui.screen.hidden = !stream;
  ui.placeholder.hidden = Boolean(stream);
}

// ---------- Compartilhar tela ----------

ui.share.addEventListener('click', async () => {
  if (screenStream) return stopShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true, // não captura a voz da outra pessoa tocando nesta aba
      },
      systemAudio: 'include',
      suppressLocalAudioPlayback: false,
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') setStatus('Não foi possível compartilhar a tela: ' + err.message);
    return;
  }
  const [video] = screenStream.getVideoTracks();
  video.contentHint = 'motion';
  video.addEventListener('ended', stopShare);
  ui.share.setAttribute('aria-pressed', 'true');
  ui.share.textContent = 'Parar de compartilhar';
  renderStage();
  if (screenStream.getAudioTracks().length === 0) {
    setStatus('Compartilhando sem áudio. Para ter som, marque "Compartilhar áudio" (Chrome/Edge).');
  }
  sendScreen();
});

function sendScreen() {
  if (!screenStream || !partner?.open) return;
  outgoingScreen?.close();
  outgoingScreen = peer.call(partner.peer, screenStream, {
    metadata: { kind: 'screen' },
    sdpTransform: stereoOpus,
  });
  limitBitrate(outgoingScreen, SCREEN_BITRATE);
}

function stopShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  outgoingScreen?.close();
  outgoingScreen = null;
  if (partner?.open) partner.send({ type: 'screen-stop' });
  ui.share.setAttribute('aria-pressed', 'false');
  ui.share.textContent = 'Compartilhar tela';
  renderStage();
}

// Áudio do filme em estéreo e com mais qualidade (o padrão do WebRTC é voz mono).
function stereoOpus(sdp) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} .*`), (line) =>
    line.includes('stereo=1') ? line : `${line};stereo=1;sprop-stereo=1;maxaveragebitrate=256000`);
}

function limitBitrate(call, bps) {
  const pc = call.peerConnection;
  if (!pc) return;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState !== 'connected') return;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bps;
      sender.setParameters(params).catch(() => {});
    }
  });
}

// ---------- Controles ----------

ui.mic.addEventListener('click', () => toggleTracks(localStream?.getAudioTracks(), ui.mic));
ui.cam.addEventListener('click', () => toggleTracks(localStream?.getVideoTracks(), ui.cam));

function toggleTracks(tracks, button) {
  if (!tracks?.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach((t) => (t.enabled = enabled));
  button.setAttribute('aria-pressed', String(enabled));
}

ui.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else ui.stage.requestFullscreen?.();
});

function setStatus(text) {
  ui.status.textContent = text;
}
