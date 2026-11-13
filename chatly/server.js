const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const THEMES = ['escuro', 'claro', 'roxo', 'oceano', 'floresta'];
const REACTS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.use(express.static(path.join(__dirname, 'public')));

// ----- Dados salvos em arquivo JSON -----
let db = { users: {}, servers: {}, dms: {}, sessions: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}), 300);
}

// ----- Estado em memória -----
const userSockets = new Map(); // usuário -> Set de ids de socket
const voiceRooms = new Map();  // sala de voz -> Map(socketId -> usuário)

const uid = () => crypto.randomBytes(6).toString('hex');
const clean = (t, max = 500) => String(t ?? '').trim().slice(0, max);
const dmKey = (a, b) => [a, b].sort().join('|');
const online = (u) => (userSockets.get(u)?.size || 0) > 0;
const hashPass = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const avatarOk = (a) =>
  typeof a === 'string' && a.length < 300000 && /^data:image\/(png|jpeg|webp);base64,/.test(a) ? a : '';

// ----- Salas de voz -----
function roomUsers(room) {
  const m = voiceRooms.get(room);
  return m ? [...new Set(m.values())] : [];
}

function leaveVoice(socket) {
  const room = socket.data.voice;
  if (!room) return;
  socket.data.voice = null;
  const m = voiceRooms.get(room);
  if (m) {
    m.delete(socket.id);
    m.forEach((_, sid) => io.to(sid).emit('user-left', { sid: socket.id }));
    if (!m.size) voiceRooms.delete(room);
  }
  pushAll();
}

// ----- Canais, salas e permissões -----
function findChannel(id) {
  for (const s of Object.values(db.servers)) {
    const c = s.channels.find((x) => x.id === id);
    if (c) return { s, c };
  }
  return null;
}

function parseRoom(room) {
  if (typeof room !== 'string') return null;
  if (room.startsWith('c:')) {
    const f = findChannel(room.slice(2));
    return f ? { kind: 'c', ...f } : null;
  }
  if (room.startsWith('d:')) {
    const parts = room.slice(2).split('|');
    return parts.length === 2 ? { kind: 'd', parts } : null;
  }
  return null;
}

// Só retorna a sala se o usuário tiver acesso a ela
function canUse(me, room) {
  const r = parseRoom(room);
  if (!r) return null;
  if (r.kind === 'c') return r.s.members.includes(me) ? r : null;
  if (!r.parts.includes(me)) return null;
  const other = r.parts.find((p) => p !== me);
  return db.users[me].friends.includes(other) ? r : null;
}

function messagesOf(r, room) {
  if (r.kind === 'c') return r.c.type === 'text' ? r.c.messages : null;
  const k = room.slice(2);
  db.dms[k] ||= { messages: [] };
  return db.dms[k].messages;
}

// ----- Estado enviado para cada usuário -----
function stateFor(me) {
  const u = db.users[me];
  const people = {};
  const add = (n) => { if (db.users[n]) people[n] = db.users[n].avatar || ''; };
  add(me);
  [...u.friends, ...u.incoming, ...u.outgoing].forEach(add);
  const mine = Object.values(db.servers).filter((s) => s.members.includes(me));
  mine.forEach((s) => s.members.forEach(add));

  return {
    me: { username: me, avatar: u.avatar || '', theme: u.theme || 'escuro' },
    people,
    friends: u.friends.map((n) => ({
      name: n,
      online: online(n),
      call: roomUsers(`d:${dmKey(me, n)}`).length > 0,
    })),
    incoming: u.incoming.slice(),
    outgoing: u.outgoing.slice(),
    servers: mine.map((s) => ({
      id: s.id,
      name: s.name,
      owner: s.owner,
      members: s.members.map((n) => ({ name: n, online: online(n) })),
      channels: s.channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        voice: c.type === 'voice' ? roomUsers(`c:${c.id}`) : [],
      })),
    })),
  };
}

function pushState(user) {
  const set = userSockets.get(user);
  if (!set || !db.users[user]) return;
  const st = stateFor(user);
  set.forEach((sid) => io.to(sid).emit('state', st));
}
const pushAll = () => [...userSockets.keys()].forEach(pushState);

function attach(socket, user) {
  if (socket.data.user && socket.data.user !== user) detach(socket);
  socket.data.user = user;
  if (!userSockets.has(user)) userSockets.set(user, new Set());
  userSockets.get(user).add(socket.id);
  pushAll();
}

function detach(socket) {
  leaveVoice(socket);
  if (socket.data.text) { socket.leave(socket.data.text); socket.data.text = null; }
  const user = socket.data.user;
  if (!user) return;
  socket.data.user = null;
  const set = userSockets.get(user);
  if (set) { set.delete(socket.id); if (!set.size) userSockets.delete(user); }
  pushAll();
}

// ----- Amizades -----
function dropRequest(a, b) {
  const A = db.users[a], B = db.users[b];
  if (!A || !B) return;
  A.incoming = A.incoming.filter((x) => x !== b);
  A.outgoing = A.outgoing.filter((x) => x !== b);
  B.incoming = B.incoming.filter((x) => x !== a);
  B.outgoing = B.outgoing.filter((x) => x !== a);
  save(); pushState(a); pushState(b);
}

function befriend(a, b) {
  const A = db.users[a], B = db.users[b];
  if (!A || !B) return;
  dropRequest(a, b);
  if (!A.friends.includes(b)) A.friends.push(b);
  if (!B.friends.includes(a)) B.friends.push(a);
  save(); pushState(a); pushState(b);
}

function unfriend(a, b) {
  const A = db.users[a], B = db.users[b];
  if (!A || !B) return;
  A.friends = A.friends.filter((x) => x !== b);
  B.friends = B.friends.filter((x) => x !== a);
  save(); pushState(a); pushState(b);
}

// ----- Conexões -----
io.on('connection', (socket) => {
  socket.data = { user: null, voice: null, text: null };

  // Só aceita o evento se o usuário estiver logado
  const on = (event, fn) => socket.on(event, (p, ack) => {
    const cb = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.user) return cb({ ok: false, error: 'Faça login primeiro.' });
    try {
      fn(p && typeof p === 'object' ? p : {}, cb, socket.data.user);
    } catch (err) {
      console.error(err);
      cb({ ok: false, error: 'Erro no servidor.' });
    }
  });

  // ----- Conta -----
  socket.on('register', (p, ack) => {
    p = p || {};
    ack = typeof ack === 'function' ? ack : () => {};
    const key = String(p.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(key)) return ack({ ok: false, error: 'Use de 3 a 20 letras, números, _ ou .' });
    if (String(p.password || '').length < 6) return ack({ ok: false, error: 'A senha precisa ter pelo menos 6 caracteres.' });
    if (db.users[key]) return ack({ ok: false, error: 'Esse nome já existe.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[key] = {
      username: key, salt, pass: hashPass(p.password, salt),
      avatar: '', theme: 'escuro', friends: [], incoming: [], outgoing: [],
    };
    startSession(socket, key, ack);
  });

  socket.on('login', (p, ack) => {
    p = p || {};
    ack = typeof ack === 'function' ? ack : () => {};
    const key = String(p.username || '').trim().toLowerCase();
    const u = db.users[key];
    const ok = u && crypto.timingSafeEqual(
      Buffer.from(hashPass(p.password, u.salt), 'hex'),
      Buffer.from(u.pass, 'hex')
    );
    if (!ok) return ack({ ok: false, error: 'Nome ou senha incorretos.' });
    startSession(socket, key, ack);
  });

  socket.on('resume', (p, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const key = db.sessions[p?.token];
    if (!key || !db.users[key]) return ack({ ok: false });
    attach(socket, key);
    ack({ ok: true });
  });

  socket.on('logout', (p, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    delete db.sessions[p?.token];
    save();
    detach(socket);
    ack({ ok: true });
  });

  on('set-profile', (p, cb, me) => {
    const u = db.users[me];
    if ('avatar' in p) u.avatar = avatarOk(p.avatar);
    if (THEMES.includes(p.theme)) u.theme = p.theme;
    save(); pushAll();
    cb({ ok: true });
  });

  // ----- Amigos -----
  on('friend-request', (p, cb, me) => {
    const t = String(p.username || '').trim().toLowerCase();
    const U = db.users;
    if (!U[t]) return cb({ ok: false, error: 'Usuário não encontrado.' });
    if (t === me) return cb({ ok: false, error: 'Você não pode se adicionar.' });
    if (U[me].friends.includes(t)) return cb({ ok: false, error: 'Vocês já são amigos.' });
    if (U[me].outgoing.includes(t)) return cb({ ok: false, error: 'Pedido já enviado.' });
    if (U[me].incoming.includes(t)) {
      befriend(me, t);
      return cb({ ok: true, msg: 'Pedido aceito! Vocês agora são amigos.' });
    }
    U[me].outgoing.push(t);
    U[t].incoming.push(me);
    save(); pushState(me); pushState(t);
    cb({ ok: true, msg: 'Pedido enviado!' });
  });

  on('friend-accept', (p, cb, me) => {
    if (!db.users[me].incoming.includes(p.username)) return cb({ ok: false, error: 'Pedido não encontrado.' });
    befriend(me, p.username);
    cb({ ok: true });
  });

  on('friend-decline', (p, cb, me) => { dropRequest(me, p.username); cb({ ok: true }); });
  on('friend-remove', (p, cb, me) => { unfriend(me, p.username); cb({ ok: true }); });

  // ----- Servidores e canais -----
  on('create-server', (p, cb, me) => {
    const id = uid();
    db.servers[id] = {
      id,
      name: clean(p.name, 40) || 'Servidor',
      owner: me,
      members: [me],
      channels: [
        { id: uid(), name: 'geral', type: 'text', messages: [] },
        { id: uid(), name: 'Sala', type: 'voice', messages: [] },
      ],
    };
    save(); pushState(me);
    cb({ ok: true, id });
  });

  on('join-server', (p, cb, me) => {
    const s = db.servers[p.id];
    if (!s) return cb({ ok: false, error: 'Servidor não encontrado.' });
    if (!s.members.includes(me)) {
      s.members.push(me);
      save();
      s.members.forEach((n) => pushState(n));
    }
    cb({ ok: true, id: p.id });
  });

  on('create-channel', (p, cb, me) => {
    const s = db.servers[p.serverId];
    if (!s || !s.members.includes(me)) return cb({ ok: false, error: 'Sem acesso.' });
    s.channels.push({
      id: uid(),
      name: clean(p.name, 40) || 'canal',
      type: p.type === 'voice' ? 'voice' : 'text',
      messages: [],
    });
    save();
    s.members.forEach((n) => pushState(n));
    cb({ ok: true });
  });

  // ----- Mensagens -----
  on('open-text', (p, cb, me) => {
    const r = canUse(me, p.room);
    const msgs = r && messagesOf(r, p.room);
    if (!msgs) return cb({ ok: false, error: 'Sem acesso a este chat.' });
    if (socket.data.text) socket.leave(socket.data.text);
    socket.data.text = p.room;
    socket.join(p.room);
    cb({ ok: true, messages: msgs });
  });

  on('send', (p, cb, me) => {
    const r = canUse(me, p.room);
    const msgs = r && messagesOf(r, p.room);
    if (!msgs) return cb({ ok: false, error: 'Sem acesso.' });
    const text = clean(p.text, 1000);
    if (!text) return cb({ ok: false, error: 'Mensagem vazia.' });
    const target = msgs.find((m) => m.id === p.replyTo);
    const msg = {
      id: uid(),
      author: me,
      text,
      time: Date.now(),
      replyTo: target ? { author: target.author, text: target.text.slice(0, 120) } : null,
      reactions: {},
    };
    msgs.push(msg);
    if (msgs.length > 300) msgs.shift();
    save();
    io.to(p.room).emit('message', { room: p.room, msg });
    cb({ ok: true });
  });

  on('react', (p, cb, me) => {
    const r = canUse(me, p.room);
    const msgs = r && messagesOf(r, p.room);
    const msg = msgs && msgs.find((m) => m.id === p.msgId);
    if (!msg || !REACTS.includes(p.emoji)) return cb({ ok: false });
    const list = msg.reactions[p.emoji] || [];
    const next = list.includes(me) ? list.filter((x) => x !== me) : [...list, me];
    if (next.length) msg.reactions[p.emoji] = next;
    else delete msg.reactions[p.emoji];
    save();
    io.to(p.room).emit('reaction', { room: p.room, msgId: p.msgId, reactions: msg.reactions });
    cb({ ok: true });
  });

  // ----- Voz -----
  on('join-voice', (p, cb, me) => {
    const r = canUse(me, p.room);
    if (!r || (r.kind === 'c' && r.c.type !== 'voice')) return cb({ ok: false, peers: [] });
    leaveVoice(socket);

    let m = voiceRooms.get(p.room);
    if (!m) { m = new Map(); voiceRooms.set(p.room, m); }
    const peerList = [...m.entries()].map(([sid, name]) => ({ sid, name }));

    // Avisa os participantes que já estão na sala
    m.forEach((_, sid) => io.to(sid).emit('peer-joined', { sid: socket.id, name: me }));

    // Chamada para amigo: toca na tela do outro quando ninguém está na sala
    if (r.kind === 'd' && !m.size) {
      r.parts.filter((x) => x !== me).forEach((u) =>
        userSockets.get(u)?.forEach((sid) => io.to(sid).emit('ring', { from: me, room: p.room }))
      );
    }

    m.set(socket.id, me);
    socket.data.voice = p.room;
    pushAll();
    cb({ ok: true, peers: peerList });
  });

  on('leave-voice', (p, cb) => { leaveVoice(socket); cb({ ok: true }); });

  // Só repassa sinal para quem está na mesma sala de voz
  on('signal', (p) => {
    const other = io.sockets.sockets.get(p.to);
    if (!socket.data.voice || !other || other.data.voice !== socket.data.voice) return;
    io.to(p.to).emit('signal', { from: socket.id, data: p.data });
  });

  socket.on('disconnect', () => detach(socket));

  function startSession(sock, key, ack) {
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = key;
    save();
    attach(sock, key);
    ack({ ok: true, token });
  }
});

server.listen(PORT, () => console.log(`Chatly rodando em http://localhost:${PORT}`));
