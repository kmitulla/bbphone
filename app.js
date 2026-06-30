/* ===========================================================
   Babyphone – Logik (Zwei-Wege)
   -----------------------------------------------------------
   Kind-Gerät (Babybett)  = sendet Ton + Video.
   Eltern-Gerät           = empfängt; kann zusätzlich:
       - sprechen (Mikro), eigenes Video zeigen
       - das Kind-Gerät fernsteuern (Video an/aus, Qualität,
         eigenes Video sichtbar, Lautstärke der Elternstimme)
   Verbindung: WebRTC peer-to-peer. Signaling über Firestore.
   =========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, onSnapshot, serverTimestamp, query, where, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ===========================================================
   1) DEINE FIREBASE-CONFIG  (schon eingesetzt)
   =========================================================== */
const firebaseConfig = {
  apiKey: "AIzaSyBwB6_hAj1ILhye2j-O510zK-w6bjjlAzo",
  authDomain: "bbphone.firebaseapp.com",
  projectId: "bbphone",
  storageBucket: "bbphone.firebasestorage.app",
  messagingSenderId: "600269174182",
  appId: "1:600269174182:web:5b51b5590ed1950db9cb67"
};

/* ===========================================================
   2) EINSTELLUNGEN
   =========================================================== */

// STUN: true = Googles STUN benutzen (Standard). false = rein im VPN.
const NUTZE_STUN = true;
const STUN_SERVER = "stun:stun.l.google.com:19302";

// Alte, liegengebliebene Verbindungs-Einträge nach so vielen Minuten löschen:
const ALTE_EINTRAEGE_LOESCHEN_NACH_MIN = 60;

// Videoqualität-Stufen (Breite/Höhe/Bilder pro Sekunde):
const QUALITY = {
  low:    { width: 320,  height: 240, frameRate: 15 },
  medium: { width: 640,  height: 480, frameRate: 24 },
  high:   { width: 1280, height: 720, frameRate: 30 },
};

function rtcConfig() {
  return { iceServers: NUTZE_STUN ? [{ urls: STUN_SERVER }] : [] };
}

/* ===========================================================
   3) Firebase starten
   =========================================================== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ===========================================================
   4) Kleine Helfer
   =========================================================== */
const screens = {
  login: document.getElementById("login-screen"),
  home: document.getElementById("home-screen"),
  child: document.getElementById("child-screen"),
  parent: document.getElementById("parent-screen"),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}
function $(id) { return document.getElementById(id); }

function setStatus(elId, text, kind) {
  const el = $(elId); if (!el) return;
  el.textContent = text;
  el.classList.remove("connected", "connecting", "disconnected");
  if (kind) el.classList.add(kind);
}

// Standard-Fernsteuerung (Werte im Raum-Dokument):
function defaultControl() {
  return { childVideoEnabled: true, quality: "medium", showParentVideoOnChild: true, childVolume: 80 };
}

/* ===========================================================
   5) Anmelden / Abmelden
   =========================================================== */
$("login-btn").addEventListener("click", doLogin);
$("password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const email = $("email").value.trim();
  const pass = $("password").value;
  $("login-error").textContent = "";
  if (!email || !pass) { $("login-error").textContent = "Bitte E-Mail und Passwort eingeben."; return; }
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    $("login-error").textContent = "Anmeldung fehlgeschlagen. E-Mail oder Passwort falsch?";
  } finally {
    $("login-btn").disabled = false;
  }
}
$("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    startRoomListListener();
    if (!handleUrlAutostart()) showScreen("home");
  } else {
    stopRoomListListener();
    stopEverything();
    showScreen("login");
  }
});

/* ===========================================================
   6) Raumliste (sichtbare Räume zum Antippen)
   =========================================================== */
let roomListUnsub = null;

function startRoomListListener() {
  if (roomListUnsub) return;
  roomListUnsub = onSnapshot(collection(db, "rooms"), (snap) => {
    const list = $("room-list");
    const rooms = snap.docs.map(d => d.id).sort();
    list.innerHTML = "";
    if (rooms.length === 0) {
      list.innerHTML = '<p class="muted" id="room-empty">Noch keine Räume. Erstelle unten einen.</p>';
      return;
    }
    rooms.forEach(name => {
      const item = document.createElement("div");
      item.className = "room-item";
      item.innerHTML = `<span class="name">🚪 ${name}</span><button class="del" title="Raum löschen">🗑️</button>`;
      item.querySelector(".name").addEventListener("click", () => selectRoom(name, item));
      item.querySelector(".del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Raum "${name}" aus der Liste löschen?`)) deleteRoom(name);
      });
      list.appendChild(item);
    });
  });
}
function stopRoomListListener() { if (roomListUnsub) { roomListUnsub(); roomListUnsub = null; } }

function selectRoom(name, item) {
  $("room").value = name;
  document.querySelectorAll(".room-item").forEach(el => el.classList.remove("selected"));
  if (item) item.classList.add("selected");
}

async function ensureRoom(name) {
  // Raum-Dokument anlegen, falls es noch nicht existiert (mit Standard-Steuerung).
  await setDoc(doc(db, "rooms", name),
    { name, createdAt: serverTimestamp(), lastActive: serverTimestamp() },
    { merge: true });
  // Standardwerte nur setzen, wenn noch keine da sind:
  const ref = doc(db, "rooms", name);
  await setDoc(ref, { control: defaultControl() }, { merge: true }).catch(() => {});
}

async function deleteRoom(name) {
  try {
    const connsRef = collection(db, "rooms", name, "connections");
    const snap = await getDocs(connsRef);
    await Promise.all(snap.docs.map(d => deleteConnectionDoc(name, d.id)));
    await deleteDoc(doc(db, "rooms", name));
  } catch (e) {}
}

$("create-room-btn").addEventListener("click", async () => {
  const name = cleanRoomName($("room").value);
  if (!name) { alert("Bitte zuerst einen Raumnamen eingeben."); return; }
  $("room").value = name;
  await ensureRoom(name);
});

/* ===========================================================
   7) Start-Knöpfe + Lesezeichen-Links
   =========================================================== */
const savedRoom = localStorage.getItem("babyphone_room");
if (savedRoom) $("room").value = savedRoom;

$("send-btn").addEventListener("click", () => beginSession("send"));
$("receive-btn").addEventListener("click", () => beginSession("receive"));

function cleanRoomName(v) {
  return (v || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
}

async function beginSession(mode) {
  const room = cleanRoomName($("room").value);
  if (!room) { alert("Bitte zuerst einen Raum auswählen oder anlegen."); return; }
  localStorage.setItem("babyphone_room", room);
  await ensureRoom(room);
  if (mode === "send") startChild(room);
  else startParent(room);
}

function handleUrlAutostart() {
  const params = new URLSearchParams(location.search);
  const room = cleanRoomName(params.get("room") || "");
  const mode = params.get("mode");
  if (room && (mode === "send" || mode === "receive")) {
    localStorage.setItem("babyphone_room", room);
    ensureRoom(room).then(() => {
      if (mode === "send") startChild(room);
      else startParent(room);
    });
    return true;
  }
  return false;
}

/* ===========================================================
   8) WebRTC-Werkzeuge
   =========================================================== */
function attachCandidateBuffer(pc) { pc._pending = []; pc._remoteSet = false; }
async function addRemoteCandidate(pc, cand) {
  if (pc._remoteSet) { try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {} }
  else pc._pending.push(cand);
}
async function flushCandidates(pc) {
  pc._remoteSet = true;
  for (const c of pc._pending) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
  pc._pending = [];
}
async function deleteConnectionDoc(roomName, connId) {
  try {
    const connRef = doc(db, "rooms", roomName, "connections", connId);
    for (const sub of ["callerCandidates", "calleeCandidates"]) {
      const snap = await getDocs(collection(connRef, sub));
      await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
    }
    await deleteDoc(connRef);
  } catch (e) {}
}
async function cleanupOldConnections(roomName) {
  try {
    const cutoff = Timestamp.fromMillis(Date.now() - ALTE_EINTRAEGE_LOESCHEN_NACH_MIN * 60 * 1000);
    const connsRef = collection(db, "rooms", roomName, "connections");
    const snap = await getDocs(query(connsRef, where("createdAt", "<", cutoff)));
    await Promise.all(snap.docs.map(d => deleteConnectionDoc(roomName, d.id)));
  } catch (e) {}
}
// Sender für eine bestimmte Spur-Art (audio/video) finden.
function senderForKind(pc, kind) {
  const tx = pc.getTransceivers().find(t =>
    (t.receiver && t.receiver.track && t.receiver.track.kind === kind) ||
    (t.sender && t.sender.track && t.sender.track.kind === kind));
  return tx ? tx.sender : null;
}

/* ===========================================================
   9) Wake Lock (Bildschirm wach halten)
   =========================================================== */
let wakeLock = null;
async function requestWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentSession) requestWakeLock();
});

/* ===========================================================
   10) Gemeinsamer Zustand
   =========================================================== */
let currentSession = null;       // { mode, room }
let control = defaultControl();  // aktuelle Fernsteuer-Werte
let controlUnsub = null;

// Auf Änderungen der Fernsteuerung im Raum-Dokument hören.
function listenControl(roomName, onChange) {
  if (controlUnsub) controlUnsub();
  controlUnsub = onSnapshot(doc(db, "rooms", roomName), (snap) => {
    const data = snap.data();
    if (data && data.control) { control = { ...defaultControl(), ...data.control }; onChange(); }
  });
}
// Fernsteuerung ändern (vom Eltern-Gerät).
async function setControl(patch) {
  control = { ...control, ...patch };
  if (!currentSession) return;
  const dotted = {};
  for (const k in patch) dotted["control." + k] = patch[k];
  try { await updateDoc(doc(db, "rooms", currentSession.room), dotted); } catch (e) {}
}

/* ===========================================================
   11) KIND-GERÄT (Babybett) – sendet Ton + Video
   =========================================================== */
let localStream = null;            // Kamera + Mikro des Kind-Geräts
let childVideoTrack = null;        // die aktuelle Kamera-Spur
let childPeers = new Map();        // connId -> RTCPeerConnection
let childUnsub = null;
let currentDeviceId = null;        // gewählte Kamera (deviceId)
let currentFacing = "environment";

async function startChild(roomName) {
  currentSession = { mode: "send", room: roomName };
  showScreen("child");
  document.querySelectorAll(".room-name-label").forEach(el => el.textContent = "· " + roomName);
  setStatus("child-status", "Kamera wird gestartet…", "connecting");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacing, ...QUALITY[control.quality] },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) {
    setStatus("child-status", "Kein Zugriff auf Kamera/Mikro", "disconnected");
    alert("Bitte Kamera und Mikrofon erlauben, dann Seite neu laden.");
    return;
  }
  childVideoTrack = localStream.getVideoTracks()[0];
  $("local-video").srcObject = localStream;
  await requestWakeLock();
  await fillCameraList();

  // Kontrolle übernehmen / anwenden (Qualität, Video an/aus, …)
  $("child-quality-select").value = control.quality;
  listenControl(roomName, applyControlOnChild);

  setStatus("child-status", "Bereit, warte auf Eltern…", "connecting");
  await cleanupOldConnections(roomName);

  const connsRef = collection(db, "rooms", roomName, "connections");
  childUnsub = onSnapshot(connsRef, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const data = change.doc.data();
      if (change.type === "added" && !data.offer && !childPeers.has(change.doc.id)) {
        createChildPeer(roomName, change.doc.id);
      }
      if (change.type === "removed") closeChildPeer(change.doc.id);
    });
  });
}

async function createChildPeer(roomName, connId) {
  const pc = new RTCPeerConnection(rtcConfig());
  attachCandidateBuffer(pc);
  childPeers.set(connId, pc);

  // Zwei Zwei-Wege-Kanäle: Video und Audio (so können auch die Eltern senden,
  // ohne dass wir die Verbindung neu aushandeln müssen).
  const videoTx = pc.addTransceiver("video", { direction: "sendrecv", streams: [localStream] });
  const audioTx = pc.addTransceiver("audio", { direction: "sendrecv", streams: [localStream] });
  // Eigene Kamera/Mikro senden:
  try { await videoTx.sender.replaceTrack(control.childVideoEnabled ? childVideoTrack : null); } catch (e) {}
  try { await audioTx.sender.replaceTrack(localStream.getAudioTracks()[0]); } catch (e) {}

  // Eingehende Eltern-Spuren (Stimme + evtl. Video) anzeigen/abspielen:
  pc.ontrack = (e) => attachParentMedia(connId, e.streams[0]);

  const connRef = doc(db, "rooms", roomName, "connections", connId);
  const callerCandidates = collection(connRef, "callerCandidates");
  pc.onicecandidate = (e) => { if (e.candidate) addDoc(callerCandidates, e.candidate.toJSON()); };
  pc.onconnectionstatechange = () => {
    updateChildStatus();
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closeChildPeer(connId);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await updateDoc(connRef, { offer: { type: offer.type, sdp: offer.sdp } });

  pc._unsubAnswer = onSnapshot(connRef, async (snap) => {
    const data = snap.data();
    if (data && data.answer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      await flushCandidates(pc);
    }
  });
  pc._unsubCand = onSnapshot(collection(connRef, "calleeCandidates"), (snap) => {
    snap.docChanges().forEach((c) => { if (c.type === "added") addRemoteCandidate(pc, c.doc.data()); });
  });
}

function closeChildPeer(connId) {
  const pc = childPeers.get(connId);
  if (!pc) return;
  try { pc._unsubAnswer && pc._unsubAnswer(); } catch (e) {}
  try { pc._unsubCand && pc._unsubCand(); } catch (e) {}
  try { pc.close(); } catch (e) {}
  childPeers.delete(connId);
  removeParentMedia(connId);
  updateChildStatus();
}

function updateChildStatus() {
  let connected = 0;
  childPeers.forEach(pc => { if (pc.connectionState === "connected") connected++; });
  if (connected > 0) setStatus("child-status", connected === 1 ? "Verbunden (1 Empfänger)" : `Verbunden (${connected} Empfänger)`, "connected");
  else setStatus("child-status", "Bereit, warte auf Eltern…", "connecting");
}

/* Eltern-Medien auf dem Kind-Gerät (Stimme immer hörbar, Video je nach Einstellung) */
function attachParentMedia(connId, stream) {
  const pip = $("parent-pip");
  let el = pip.querySelector(`[data-conn="${connId}"]`);
  if (!el) {
    el = document.createElement("video");
    el.dataset.conn = connId;
    el.autoplay = true; el.playsInline = true;
    pip.appendChild(el);
  }
  el.srcObject = stream;
  el.volume = control.childVolume / 100;
  el.play().catch(() => {});
  // Reden die Eltern? (Audiospur vorhanden und nicht stumm)
  watchParentAudio(stream);
  refreshParentPip();
}
function removeParentMedia(connId) {
  const el = $("parent-pip").querySelector(`[data-conn="${connId}"]`);
  if (el) el.remove();
  refreshParentPip();
}
function refreshParentPip() {
  const pip = $("parent-pip");
  const hasVideo = [...pip.querySelectorAll("video")].some(v => {
    const s = v.srcObject; return s && s.getVideoTracks().some(t => t.readyState === "live" && !t.muted);
  });
  pip.classList.toggle("hidden", !(control.showParentVideoOnChild && hasVideo));
}
function watchParentAudio(stream) {
  const a = stream.getAudioTracks()[0];
  if (!a) return;
  const update = () => {
    const talking = !a.muted;
    $("parent-talking").classList.toggle("hidden", !talking);
  };
  a.onmute = update; a.onunmute = update; update();
  // PiP-Sichtbarkeit auch bei Video-Änderungen aktualisieren
  const v = stream.getVideoTracks()[0];
  if (v) { v.onmute = refreshParentPip; v.onunmute = refreshParentPip; }
}

/* Fernsteuerung auf dem Kind-Gerät anwenden */
async function applyControlOnChild() {
  if (!currentSession || currentSession.mode !== "send") return;
  // Video an/aus:
  for (const pc of childPeers.values()) {
    const s = senderForKind(pc, "video");
    if (s) { try { await s.replaceTrack(control.childVideoEnabled ? childVideoTrack : null); } catch (e) {} }
  }
  // Qualität:
  if (childVideoTrack) { try { await childVideoTrack.applyConstraints(QUALITY[control.quality]); } catch (e) {} }
  $("child-quality-select").value = control.quality;
  // Lautstärke der Eltern-Stimme:
  $("parent-pip").querySelectorAll("video").forEach(v => v.volume = control.childVolume / 100);
  // Eltern-Video sichtbar?
  refreshParentPip();
  // Knopf-Status "Video"
  $("child-video-toggle").classList.toggle("active", control.childVideoEnabled);
}

/* Kamera-Liste (auch alle iPhone-Kameras) füllen */
async function fillCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");
    const sel = $("child-camera-select");
    sel.innerHTML = "";
    cams.forEach((cam, i) => {
      const o = document.createElement("option");
      o.value = cam.deviceId;
      o.textContent = cam.label || `Kamera ${i + 1}`;
      sel.appendChild(o);
    });
    if (childVideoTrack) {
      const id = childVideoTrack.getSettings().deviceId;
      if (id) { sel.value = id; currentDeviceId = id; }
    }
  } catch (e) {}
}

// Kamera per Auswahl (Dropdown) wechseln
$("child-camera-select").addEventListener("change", (e) => switchCamera({ deviceId: e.target.value }));
// Schnell-Umschalter Front/Rück
$("child-cam-btn").addEventListener("click", () => {
  currentFacing = currentFacing === "environment" ? "user" : "environment";
  switchCamera({ facingMode: currentFacing });
});

async function switchCamera(videoConstraint) {
  if (!localStream) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoConstraint, ...QUALITY[control.quality] }, audio: false
    });
    const newTrack = newStream.getVideoTracks()[0];
    for (const pc of childPeers.values()) {
      const s = senderForKind(pc, "video");
      if (s && control.childVideoEnabled) { try { await s.replaceTrack(newTrack); } catch (e) {} }
    }
    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
    localStream.addTrack(newTrack);
    childVideoTrack = newTrack;
    $("local-video").srcObject = localStream;
    await fillCameraList();
  } catch (e) { alert("Kamera konnte nicht gewechselt werden."); }
}

// Kind: Video lokal an/aus (schreibt auch in die Fernsteuerung)
$("child-video-toggle").addEventListener("click", () => setControl({ childVideoEnabled: !control.childVideoEnabled }));
// Qualität lokal wählen
$("child-quality-select").addEventListener("change", (e) => setControl({ quality: e.target.value }));

// Bildschirm aus
$("screen-off-btn").addEventListener("click", () => $("screen-off-curtain").classList.remove("hidden"));
$("screen-off-curtain").addEventListener("click", () => $("screen-off-curtain").classList.add("hidden"));

/* ===========================================================
   12) ELTERN-GERÄT – empfängt; kann sprechen + eigenes Video
   =========================================================== */
let parentPc = null;
let parentConnId = null;
let parentUnsubs = [];
let reconnectTimer = null;
let reconnecting = false;
let parentMicStream = null;      // Mikro der Eltern (für Sprechen)
let parentCamStream = null;      // Kamera der Eltern (für eigenes Video)
let talkOn = false;
let parentVideoOn = false;

async function startParent(roomName) {
  currentSession = { mode: "receive", room: roomName };
  showScreen("parent");
  document.querySelectorAll(".room-name-label").forEach(el => el.textContent = "· " + roomName);
  $("parent-placeholder").classList.remove("hidden");
  await requestWakeLock();

  // Fernsteuer-Bedienelemente mit aktuellen Werten füllen + Änderungen hören
  listenControl(roomName, syncRemoteControlsUI);

  connectParent(roomName);
}

async function connectParent(roomName) {
  setStatus("parent-status", "Verbinde…", "connecting");
  const pc = new RTCPeerConnection(rtcConfig());
  attachCandidateBuffer(pc);
  parentPc = pc;

  pc.ontrack = (e) => {
    $("remote-video").srcObject = e.streams[0];
    $("parent-placeholder").classList.add("hidden");
    tryPlayRemote();
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") {
      setStatus("parent-status", "Verbunden", "connected");
      $("parent-placeholder").classList.add("hidden");
      reconnecting = false;
      // Falls Sprechen/Video schon aktiv waren: Spuren wieder einhängen.
      reattachParentTracks();
    } else if (st === "disconnected" || st === "failed") {
      setStatus("parent-status", "Getrennt, versuche erneut…", "disconnected");
      scheduleReconnect(roomName);
    }
  };

  const connsRef = collection(db, "rooms", roomName, "connections");
  let connRef;
  try { connRef = await addDoc(connsRef, { role: "parent", createdAt: serverTimestamp() }); }
  catch (e) { setStatus("parent-status", "Getrennt, versuche erneut…", "disconnected"); scheduleReconnect(roomName); return; }
  parentConnId = connRef.id;

  const calleeCandidates = collection(connRef, "calleeCandidates");
  pc.onicecandidate = (e) => { if (e.candidate) addDoc(calleeCandidates, e.candidate.toJSON()); };

  parentUnsubs.push(onSnapshot(connRef, async (snap) => {
    const data = snap.data();
    if (data && data.offer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      // Beide Kanäle auf "senden+empfangen" stellen, damit wir auch senden dürfen.
      pc.getTransceivers().forEach(t => { try { t.direction = "sendrecv"; } catch (e) {} });
      await flushCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await updateDoc(connRef, { answer: { type: answer.type, sdp: answer.sdp } });
    }
  }));
  parentUnsubs.push(onSnapshot(collection(connRef, "callerCandidates"), (snap) => {
    snap.docChanges().forEach((c) => { if (c.type === "added") addRemoteCandidate(pc, c.doc.data()); });
  }));
}

function scheduleReconnect(roomName) {
  if (reconnecting || !currentSession || currentSession.mode !== "receive") return;
  reconnecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    await teardownParentConnection(roomName);
    if (currentSession && currentSession.mode === "receive") connectParent(roomName);
  }, 2500);
}
async function teardownParentConnection(roomName) {
  parentUnsubs.forEach(u => { try { u(); } catch (e) {} });
  parentUnsubs = [];
  if (parentConnId) { const id = parentConnId; parentConnId = null; deleteConnectionDoc(roomName, id); }
  if (parentPc) { try { parentPc.close(); } catch (e) {} parentPc = null; }
}

/* ----- Ton automatisch starten (Browser blockieren das manchmal) ----- */
async function tryPlayRemote() {
  const v = $("remote-video");
  try { await v.play(); $("unmute-overlay").classList.add("hidden"); }
  catch (e) {
    v.muted = true; try { await v.play(); } catch (e2) {}
    $("unmute-overlay").classList.remove("hidden");
  }
}
$("unmute-overlay").addEventListener("click", () => {
  const v = $("remote-video");
  v.muted = false; v.volume = $("volume-slider").value / 100;
  $("unmute-overlay").classList.add("hidden");
  v.play().catch(() => {});
});
$("volume-slider").addEventListener("input", (e) => {
  const v = $("remote-video");
  v.volume = e.target.value / 100;
  if (e.target.value > 0) v.muted = false;
});

/* ----- Sprechen (Push-to-talk: tippen = an/aus) ----- */
$("talk-btn").addEventListener("click", toggleTalk);
async function toggleTalk() {
  talkOn = !talkOn;
  $("talk-btn").classList.toggle("active", talkOn);
  if (talkOn) {
    if (!parentMicStream) {
      try { parentMicStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { talkOn = false; $("talk-btn").classList.remove("active"); alert("Kein Zugriff aufs Mikrofon."); return; }
    }
    await sendParentTrack("audio", parentMicStream.getAudioTracks()[0]);
  } else {
    await sendParentTrack("audio", null);
  }
}

/* ----- Eigenes Video zeigen (Eltern -> Kind) ----- */
$("parent-video-btn").addEventListener("click", toggleParentVideo);
async function toggleParentVideo() {
  parentVideoOn = !parentVideoOn;
  $("parent-video-btn").classList.toggle("active", parentVideoOn);
  if (parentVideoOn) {
    if (!parentCamStream) {
      try { parentCamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", ...QUALITY[control.quality] } }); }
      catch (e) { parentVideoOn = false; $("parent-video-btn").classList.remove("active"); alert("Kein Zugriff auf die Kamera."); return; }
    }
    $("parent-self-video").srcObject = parentCamStream;
    $("parent-self-video").classList.remove("hidden");
    await sendParentTrack("video", parentCamStream.getVideoTracks()[0]);
  } else {
    $("parent-self-video").classList.add("hidden");
    await sendParentTrack("video", null);
  }
}

// Eine Eltern-Spur (audio/video) in die laufende Verbindung legen.
async function sendParentTrack(kind, track) {
  if (!parentPc) return;
  const s = senderForKind(parentPc, kind);
  if (s) { try { await s.replaceTrack(track); } catch (e) {} }
}
// Nach (Neu-)Verbindung Sprechen/Video wieder herstellen.
async function reattachParentTracks() {
  if (talkOn && parentMicStream) await sendParentTrack("audio", parentMicStream.getAudioTracks()[0]);
  if (parentVideoOn && parentCamStream) await sendParentTrack("video", parentCamStream.getVideoTracks()[0]);
}

/* ----- Fernsteuer-Bedienelemente (Menü) ----- */
$("rc-child-video").addEventListener("change", (e) => setControl({ childVideoEnabled: e.target.checked }));
$("rc-show-parent").addEventListener("change", (e) => setControl({ showParentVideoOnChild: e.target.checked }));
$("rc-quality").addEventListener("change", (e) => setControl({ quality: e.target.value }));
$("rc-child-volume").addEventListener("input", (e) => setControl({ childVolume: Number(e.target.value) }));

function syncRemoteControlsUI() {
  $("rc-child-video").checked = control.childVideoEnabled;
  $("rc-show-parent").checked = control.showParentVideoOnChild;
  $("rc-quality").value = control.quality;
  $("rc-child-volume").value = control.childVolume;
}

/* ===========================================================
   13) Menüs (Bottom-Sheets) + Beenden
   =========================================================== */
document.querySelectorAll("[data-open]").forEach(btn => {
  btn.addEventListener("click", () => $(btn.dataset.open).classList.remove("hidden"));
});
document.querySelectorAll(".close-sheet").forEach(btn => {
  btn.addEventListener("click", () => btn.closest(".sheet").classList.add("hidden"));
});
document.querySelectorAll(".sheet").forEach(sheet => {
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.classList.add("hidden"); });
});
document.querySelectorAll(".stop-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (confirm("Babyphone wirklich beenden?")) { stopEverything(); showScreen("home"); }
  });
});

function stopEverything() {
  const room = currentSession ? currentSession.room : null;
  currentSession = null;

  document.querySelectorAll(".sheet").forEach(m => m.classList.add("hidden"));
  $("screen-off-curtain").classList.add("hidden");
  $("unmute-overlay").classList.add("hidden");
  $("parent-talking").classList.add("hidden");
  $("parent-pip").innerHTML = "";

  if (controlUnsub) { try { controlUnsub(); } catch (e) {} controlUnsub = null; }

  // Kind stoppen
  if (childUnsub) { try { childUnsub(); } catch (e) {} childUnsub = null; }
  childPeers.forEach((pc, id) => { if (room) deleteConnectionDoc(room, id); try { pc.close(); } catch (e) {} });
  childPeers.clear();
  childVideoTrack = null;

  // Eltern stoppen
  clearTimeout(reconnectTimer); reconnecting = false;
  parentUnsubs.forEach(u => { try { u(); } catch (e) {} });
  parentUnsubs = [];
  if (parentConnId && room) deleteConnectionDoc(room, parentConnId);
  parentConnId = null;
  if (parentPc) { try { parentPc.close(); } catch (e) {} parentPc = null; }
  talkOn = false; parentVideoOn = false;
  $("talk-btn") && $("talk-btn").classList.remove("active");
  $("parent-video-btn") && $("parent-video-btn").classList.remove("active");
  $("parent-self-video").classList.add("hidden");

  // Medien freigeben
  [localStream, parentMicStream, parentCamStream].forEach(s => { if (s) s.getTracks().forEach(t => t.stop()); });
  localStream = parentMicStream = parentCamStream = null;
  $("local-video").srcObject = null;
  $("remote-video").srcObject = null;
  $("parent-self-video").srcObject = null;

  releaseWakeLock();
  if (location.search) history.replaceState(null, "", location.pathname);
}

window.addEventListener("pagehide", () => {
  const room = currentSession ? currentSession.room : null;
  if (!room) return;
  if (parentConnId) deleteConnectionDoc(room, parentConnId);
  childPeers.forEach((pc, id) => deleteConnectionDoc(room, id));
});
