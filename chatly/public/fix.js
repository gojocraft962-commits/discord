/* Correção: vídeo preto na chamada e botão para reconectar o vídeo */

function frameReady(v) {
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
}

// Mostra o vídeo só quando ele está realmente chegando; senão mostra o avatar
function refreshCam(tile) {
  const v = tile.querySelector('video');
  const a = tile.querySelector('.avslot');
  const track = tile._track;
  const show = !!tile._want && !!track && !track.muted && track.readyState === 'live' && frameReady(v);
  if (v) v.style.display = show ? 'block' : 'none';
  if (a) a.style.display = show ? 'none' : 'flex';
}

function applyRemote(sid) {
  const m = remoteMedia.get(sid) || { cam: false, screen: false };
  const cam = document.getElementById('c-' + sid);
  if (cam) {
    cam._want = !!m.cam;
    refreshCam(cam);
  }
  const scr = document.getElementById('s-' + sid);
  if (scr) scr.hidden = !m.screen;
}

function remoteTile(sid, screen) {
  const id = (screen ? 's-' : 'c-') + sid;
  let tile = document.getElementById(id);
  if (tile) return tile;
  const name = peerNames.get(sid) || 'Pessoa';
  tile = document.createElement('div');
  tile.id = id;
  tile.className = 'tile' + (screen ? ' screen' : '');
  tile.dataset.peer = sid;
  tile.hidden = screen;
  tile.innerHTML = '<video autoplay playsinline></video>' +
    (screen ? '' : `<div class="avslot" style="display:flex">${av(name, 'av big')}</div>`) +
    `<span class="lbl">${esc(name)}${screen ? ' · tela' : ''}</span>`;
  $('#grid').appendChild(tile);
  return tile;
}

function makePeer(sid) {
  const pc = new RTCPeerConnection(RTC);
  const tx = {
    audio: pc.addTransceiver('audio', { direction: 'sendrecv' }),
    cam: pc.addTransceiver('video', { direction: 'sendrecv' }),
    screen: pc.addTransceiver('video', { direction: 'sendrecv' }),
  };
  const p = { pc, tx, els: [], pending: [] };
  peers.set(sid, p);
  attachLocal(p);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: sid, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    if (voiceRoom && voiceRoom.startsWith('d:') && typeof startTimer === 'function') startTimer();

    if (e.track.kind === 'audio') {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.dataset.peer = sid;
      a.muted = deaf;
      a.srcObject = new MediaStream([e.track]);
      document.body.appendChild(a);
      a.play().catch(() => {});
      p.els.push(a);
      return;
    }

    const screen = e.transceiver === tx.screen;
    const tile = remoteTile(sid, screen);
    const v = tile.querySelector('video');
    v.srcObject = new MediaStream([e.track]);
    v.play().catch(() => {});
    if (!screen) tile._track = e.track;

    const update = () => {
      if (screen) tile.hidden = !((remoteMedia.get(sid) || {}).screen);
      else refreshCam(tile);
    };
    e.track.addEventListener('unmute', update);
    e.track.addEventListener('mute', update);
    e.track.addEventListener('ended', update);
    v.addEventListener('playing', update);
    v.addEventListener('resize', update);
    applyRemote(sid);
  };

  return p;
}

// Refaz a conexão com uma pessoa. Quem tem o id menor é quem chama, para evitar duas ofertas.
function reconnectPeer(sid) {
  const p = peers.get(sid);
  if (p) {
    p.pc.close();
    p.els.forEach((el) => el.remove());
    peers.delete(sid);
  }
  document.querySelectorAll(`[data-peer="${sid}"]`).forEach((el) => el.remove());
  if (socket.id < sid) callPeer(sid);
}

function reconnectAll() {
  if (!voiceRoom) return;
  [...peers.keys()].forEach((sid) => {
    socket.emit('signal', { to: sid, data: { reset: true } });
    reconnectPeer(sid);
  });
  toast('Reconectando o vídeo…', 'OK', () => {});
}

socket.on('signal', ({ from, data }) => {
  if (data && data.reset) reconnectPeer(from);
});

setInterval(() => {
  document.querySelectorAll('.tile[id^="c-"]').forEach(refreshCam);
}, 1000);

{
  const ctrl = document.getElementById('controls');
  if (ctrl) {
    const b = document.createElement('button');
    b.className = 'ctl';
    b.title = 'Reconectar vídeo';
    b.textContent = '🔄';
    b.onclick = reconnectAll;
    ctrl.insertBefore(b, ctrl.querySelector('.hang'));
  }
}
