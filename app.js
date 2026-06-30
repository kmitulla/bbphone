/* ===========================================================
   Babyphone – Logik
   -----------------------------------------------------------
   Hier passiert alles: Anmelden, Räume, Video senden/empfangen.
   Du musst hier normalerweise NICHTS ändern.
   Wichtige Einstellungen stehen ganz oben mit Kommentaren.
   =========================================================== */

/* ---------- Firebase aus dem Internet laden (ohne Build-Tool) ---------- */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
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
   2) WICHTIGE EINSTELLUNGEN
   =========================================================== */

// STUN hilft den Geräten, sich übers Internet zu finden.
// Im selben VPN brauchst du es oft nicht. Hier kannst du es abschalten:
//   true  = Googles öffentlichen STUN benutzen (Standard)
//   false = KEIN STUN (rein im VPN bleiben)
const NUTZE_STUN = true;
const STUN_SERVER = "stun:stun.l.google.com:19302";

// Wie alt darf ein liegengebliebener Verbindungs-Eintrag sein,
// bevor er beim Start automatisch gelöscht wird (in Minuten):
const ALTE_EINTRAEGE_LOESCHEN_NACH_MIN = 60;

/* Diese Funktion baut die WebRTC-Konfiguration zusammen. */
function rtcConfig() {
  return {
    iceServers: NUTZE_STUN ? [{ urls: STUN_SERVER }] : []
  };
}

/* ===========================================================
   3) Firebase starten
   =========================================================== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Anmeldung merken (wichtig fürs Handy am Babybett, das angemeldet bleiben soll)
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ===========================================================
   4) Kleine Helfer für die Bildschirme (Screens)
   =========================================================== */
const screens = {
  login: document.getElementById("login-screen"),
  home: document.getElementById("home-screen"),
  sender: document.getElementById("sender-screen"),
  receiver: document.getElementById("receiver-screen"),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function $(id) { return document.getElementById(id); }

/* Status-Text + Farbe setzen ("Verbunden" / "Verbinde…" / "Getrennt…") */
function setStatus(elId, text, kind) {
  const el = $(elId);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("connected", "connecting", "disconnected");
  if (kind) el.classList.add(kind);
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
  if (!email || !pass) {
    $("login-error").textContent = "Bitte E-Mail und Passwort eingeben.";
    return;
  }
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged (unten) wechselt automatisch zum Start-Bildschirm.
  } catch (err) {
    $("login-error").textContent = "Anmeldung fehlgeschlagen. E-Mail oder Passwort falsch?";
  } finally {
    $("login-btn").disabled = false;
  }
}

$("logout-btn").addEventListener("click", () => signOut(auth));

// Reagiert automatisch, wenn jemand an- oder abgemeldet ist.
onAuthStateChanged(auth, (user) => {
  if (user) {
    // Angemeldet -> Start-Bildschirm, außer ein Lesezeichen-Link will direkt starten.
    if (!handleUrlAutostart()) {
      showScreen("home");
    }
  } else {
    stopEverything();
    showScreen("login");
  }
});

/* ===========================================================
   6) Start-Bildschirm: Raumname + zwei Knöpfe
   =========================================================== */

// Letzten Raumnamen merken, damit man ihn nicht neu tippen muss.
const savedRoom = localStorage.getItem("babyphone_room");
if (savedRoom) $("room").value = savedRoom;

$("send-btn").addEventListener("click", () => beginSession("send"));
$("receive-btn").addEventListener("click", () => beginSession("receive"));

function getRoomName() {
  return $("room").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function beginSession(mode) {
  const room = getRoomName();
  if (!room) {
    alert("Bitte zuerst einen Raumnamen eingeben.");
    return;
  }
  localStorage.setItem("babyphone_room", room);
  if (mode === "send") startSender(room);
  else startReceiver(room);
}

/* Lesezeichen-Links:  ?room=kinderzimmer&mode=send  bzw.  mode=receive
   Wenn so ein Link geöffnet wird (und man ist angemeldet), startet es direkt. */
function handleUrlAutostart() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  const mode = params.get("mode");
  if (room && (mode === "send" || mode === "receive")) {
    $("room").value = room;
    const cleanRoom = getRoomName();
    localStorage.setItem("babyphone_room", cleanRoom);
    if (mode === "send") startSender(cleanRoom);
    else startReceiver(cleanRoom);
    return true;
  }
  return false;
}

/* ===========================================================
   7) Gemeinsame Werkzeuge für WebRTC
   =========================================================== */

// Hält ICE-Kandidaten zurück, bis die Gegenstelle bekannt ist (verhindert Fehler).
function attachCandidateBuffer(pc) {
  pc._pending = [];
  pc._remoteSet = false;
}
async function addRemoteCandidate(pc, cand) {
  if (pc._remoteSet) {
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
  } else {
    pc._pending.push(cand);
  }
}
async function flushCandidates(pc) {
  pc._remoteSet = true;
  for (const c of pc._pending) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
  }
  pc._pending = [];
}

// Eine Verbindung samt ihrer ICE-Listen aus Firestore löschen.
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

// Liegengebliebene alte Verbindungen aufräumen.
async function cleanupOldConnections(roomName) {
  try {
    const cutoff = Timestamp.fromMillis(Date.now() - ALTE_EINTRAEGE_LOESCHEN_NACH_MIN * 60 * 1000);
    const connsRef = collection(db, "rooms", roomName, "connections");
    const snap = await getDocs(query(connsRef, where("createdAt", "<", cutoff)));
    await Promise.all(snap.docs.map(d => deleteConnectionDoc(roomName, d.id)));
  } catch (e) {}
}

/* ===========================================================
   8) Bildschirm wach halten (Wake Lock)
   =========================================================== */
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (e) {}
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}
// Wenn das Handy kurz weg war und wieder da ist, Wake Lock erneut holen.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentSession) requestWakeLock();
});

/* ===========================================================
   9) SENDER (Handy am Babybett)
   =========================================================== */

// currentSession beschreibt, was gerade läuft. So können wir sauber aufräumen.
let currentSession = null;          // { mode, room }
let localStream = null;             // Kamera + Mikrofon
let senderPeers = new Map();        // connId -> RTCPeerConnection
let senderUnsub = null;             // Firestore-Listener stoppen
let currentFacing = "environment";  // "environment" = Rückkamera, "user" = Frontkamera

async function startSender(roomName) {
  currentSession = { mode: "send", room: roomName };
  showScreen("sender");
  setStatus("sender-status", "Kamera wird gestartet…", "connecting");
  document.querySelectorAll(".room-name-label").forEach(el => el.textContent = roomName);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacing },
      audio: true
    });
  } catch (e) {
    setStatus("sender-status", "Kein Zugriff auf Kamera/Mikro", "disconnected");
    alert("Bitte Kamera und Mikrofon erlauben. Danach die Seite neu laden.");
    return;
  }

  $("local-video").srcObject = localStream;
  await requestWakeLock();
  setStatus("sender-status", "Bereit, warte auf Eltern-Gerät…", "connecting");

  // Alte Reste aufräumen, dann auf Empfänger warten.
  await cleanupOldConnections(roomName);

  const connsRef = collection(db, "rooms", roomName, "connections");
  senderUnsub = onSnapshot(connsRef, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const data = change.doc.data();
      if (change.type === "added") {
        // Ein Empfänger hat sich gemeldet und hat noch kein Angebot -> Verbindung aufbauen.
        if (!data.offer && !senderPeers.has(change.doc.id)) {
          createSenderPeer(roomName, change.doc.id);
        }
      }
      if (change.type === "removed") {
        // Empfänger ist gegangen -> Verbindung schließen.
        closeSenderPeer(change.doc.id);
      }
    });
  });
}

async function createSenderPeer(roomName, connId) {
  const pc = new RTCPeerConnection(rtcConfig());
  attachCandidateBuffer(pc);
  senderPeers.set(connId, pc);

  // Eigenen Ton + Bild in die Verbindung legen.
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const connRef = doc(db, "rooms", roomName, "connections", connId);
  const callerCandidates = collection(connRef, "callerCandidates");

  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(callerCandidates, e.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    updateSenderOverallStatus();
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closeSenderPeer(connId);
    }
  };

  // Angebot (Offer) erstellen und in Firestore schreiben.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await updateDoc(connRef, { offer: { type: offer.type, sdp: offer.sdp } });

  // Auf die Antwort (Answer) des Empfängers warten.
  pc._unsubAnswer = onSnapshot(connRef, async (snap) => {
    const data = snap.data();
    if (data && data.answer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      await flushCandidates(pc);
    }
  });

  // ICE-Kandidaten des Empfängers entgegennehmen.
  pc._unsubCand = onSnapshot(collection(connRef, "calleeCandidates"), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === "added") addRemoteCandidate(pc, c.doc.data());
    });
  });
}

function closeSenderPeer(connId) {
  const pc = senderPeers.get(connId);
  if (!pc) return;
  try { pc._unsubAnswer && pc._unsubAnswer(); } catch (e) {}
  try { pc._unsubCand && pc._unsubCand(); } catch (e) {}
  try { pc.close(); } catch (e) {}
  senderPeers.delete(connId);
  updateSenderOverallStatus();
}

// Gesamtstatus des Senders aus allen Verbindungen ableiten.
function updateSenderOverallStatus() {
  let connected = 0;
  senderPeers.forEach(pc => {
    if (pc.connectionState === "connected") connected++;
  });
  if (connected > 0) {
    const txt = connected === 1 ? "Verbunden (1 Empfänger)" : `Verbunden (${connected} Empfänger)`;
    setStatus("sender-status", txt, "connected");
  } else {
    setStatus("sender-status", "Bereit, warte auf Eltern-Gerät…", "connecting");
  }
}

/* ----- Kamera umschalten (Front / Rück) ----- */
$("switch-camera-btn").addEventListener("click", switchCamera);
async function switchCamera() {
  if (!localStream) return;
  currentFacing = currentFacing === "environment" ? "user" : "environment";
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacing },
      audio: false
    });
    const newVideoTrack = newStream.getVideoTracks()[0];

    // In allen laufenden Verbindungen das Bild austauschen.
    senderPeers.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newVideoTrack);
    });

    // Lokale Vorschau aktualisieren.
    const oldVideoTrack = localStream.getVideoTracks()[0];
    if (oldVideoTrack) { localStream.removeTrack(oldVideoTrack); oldVideoTrack.stop(); }
    localStream.addTrack(newVideoTrack);
    $("local-video").srcObject = localStream;
  } catch (e) {
    alert("Kamera konnte nicht umgeschaltet werden.");
  }
}

/* ----- Bildschirm aus (Ton + Video laufen weiter) ----- */
$("screen-off-btn").addEventListener("click", () => {
  $("screen-off-curtain").classList.remove("hidden");
});
$("screen-off-curtain").addEventListener("click", () => {
  $("screen-off-curtain").classList.add("hidden");
});

/* ===========================================================
   10) EMPFÄNGER (Eltern-Gerät)
   =========================================================== */
let receiverPc = null;
let receiverConnId = null;
let receiverUnsubs = [];
let reconnectTimer = null;
let reconnecting = false;

async function startReceiver(roomName) {
  currentSession = { mode: "receive", room: roomName };
  showScreen("receiver");
  document.querySelectorAll(".room-name-label").forEach(el => el.textContent = roomName);
  $("receiver-placeholder").classList.remove("hidden");
  await requestWakeLock();
  connectReceiver(roomName);
}

async function connectReceiver(roomName) {
  setStatus("receiver-status", "Verbinde…", "connecting");

  const pc = new RTCPeerConnection(rtcConfig());
  attachCandidateBuffer(pc);
  receiverPc = pc;

  // Eingehendes Bild + Ton anzeigen.
  pc.ontrack = (e) => {
    $("remote-video").srcObject = e.streams[0];
    $("receiver-placeholder").classList.add("hidden");
    tryPlayRemote();
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") {
      setStatus("receiver-status", "Verbunden", "connected");
      $("receiver-placeholder").classList.add("hidden");
      reconnecting = false;
    } else if (st === "disconnected" || st === "failed") {
      setStatus("receiver-status", "Getrennt, versuche erneut…", "disconnected");
      scheduleReconnect(roomName);
    } else if (st === "closed") {
      // bewusst geschlossen – nichts tun
    }
  };

  // Eigenen Eintrag im Raum anlegen (meldet uns beim Sender an).
  const connsRef = collection(db, "rooms", roomName, "connections");
  let connRef;
  try {
    connRef = await addDoc(connsRef, { role: "receiver", createdAt: serverTimestamp() });
  } catch (e) {
    setStatus("receiver-status", "Getrennt, versuche erneut…", "disconnected");
    scheduleReconnect(roomName);
    return;
  }
  receiverConnId = connRef.id;

  const calleeCandidates = collection(connRef, "calleeCandidates");
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(calleeCandidates, e.candidate.toJSON());
  };

  // Auf das Angebot (Offer) des Senders warten und antworten.
  receiverUnsubs.push(onSnapshot(connRef, async (snap) => {
    const data = snap.data();
    if (data && data.offer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      await flushCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await updateDoc(connRef, { answer: { type: answer.type, sdp: answer.sdp } });
    }
  }));

  // ICE-Kandidaten des Senders entgegennehmen.
  receiverUnsubs.push(onSnapshot(collection(connRef, "callerCandidates"), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === "added") addRemoteCandidate(pc, c.doc.data());
    });
  }));
}

// Automatisch neu verbinden (mit kleiner Wartezeit).
function scheduleReconnect(roomName) {
  if (reconnecting || !currentSession || currentSession.mode !== "receive") return;
  reconnecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    await teardownReceiverConnection(roomName);
    if (currentSession && currentSession.mode === "receive") {
      connectReceiver(roomName);
    }
  }, 2500);
}

// Aktuelle Empfänger-Verbindung sauber abbauen (vor dem Neuaufbau).
async function teardownReceiverConnection(roomName) {
  receiverUnsubs.forEach(u => { try { u(); } catch (e) {} });
  receiverUnsubs = [];
  if (receiverConnId) {
    const id = receiverConnId;
    receiverConnId = null;
    deleteConnectionDoc(roomName, id);
  }
  if (receiverPc) {
    try { receiverPc.close(); } catch (e) {}
    receiverPc = null;
  }
}

/* ----- Ton/Video automatisch abspielen (Browser blockieren das manchmal) ----- */
async function tryPlayRemote() {
  const v = $("remote-video");
  try {
    await v.play();
    $("unmute-overlay").classList.add("hidden");
  } catch (e) {
    // Mit Ton blockiert -> erst stumm starten, dann Hinweis zum Antippen zeigen.
    v.muted = true;
    try { await v.play(); } catch (e2) {}
    $("unmute-overlay").classList.remove("hidden");
  }
}
$("unmute-overlay").addEventListener("click", () => {
  const v = $("remote-video");
  v.muted = false;
  v.volume = $("volume-slider").value / 100;
  $("unmute-overlay").classList.add("hidden");
  v.play().catch(() => {});
});

/* ----- Lautstärke-Regler ----- */
$("volume-slider").addEventListener("input", (e) => {
  const v = $("remote-video");
  const vol = e.target.value / 100;
  v.volume = vol;
  if (vol > 0) v.muted = false;     // beim Aufdrehen Stummschaltung lösen
});

/* ===========================================================
   11) Menü + Beenden
   =========================================================== */
document.querySelectorAll(".corner-btn").forEach(btn => {
  btn.addEventListener("click", () => $(btn.dataset.menu).classList.remove("hidden"));
});
document.querySelectorAll(".close-menu").forEach(btn => {
  btn.addEventListener("click", () => btn.closest(".menu-overlay").classList.add("hidden"));
});
document.querySelectorAll(".stop-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (confirm("Babyphone wirklich beenden?")) {
      stopEverything();
      showScreen("home");
    }
  });
});

/* Alles sauber stoppen und aufräumen. */
function stopEverything() {
  const room = currentSession ? currentSession.room : null;
  currentSession = null;

  // Menüs schließen
  document.querySelectorAll(".menu-overlay").forEach(m => m.classList.add("hidden"));
  $("screen-off-curtain").classList.add("hidden");
  $("unmute-overlay").classList.add("hidden");

  // Sender stoppen
  if (senderUnsub) { try { senderUnsub(); } catch (e) {} senderUnsub = null; }
  senderPeers.forEach((pc, id) => {
    if (room) deleteConnectionDoc(room, id);
    try { pc.close(); } catch (e) {}
  });
  senderPeers.clear();

  // Empfänger stoppen
  clearTimeout(reconnectTimer);
  reconnecting = false;
  receiverUnsubs.forEach(u => { try { u(); } catch (e) {} });
  receiverUnsubs = [];
  if (receiverConnId && room) deleteConnectionDoc(room, receiverConnId);
  receiverConnId = null;
  if (receiverPc) { try { receiverPc.close(); } catch (e) {} receiverPc = null; }

  // Kamera/Mikro freigeben
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  $("local-video").srcObject = null;
  $("remote-video").srcObject = null;

  releaseWakeLock();

  // URL-Parameter entfernen, damit ein Neuladen nicht sofort wieder startet.
  if (location.search) history.replaceState(null, "", location.pathname);
}

/* Beim Schließen/Wechseln der Seite versuchen, den eigenen Eintrag zu löschen. */
window.addEventListener("pagehide", () => {
  const room = currentSession ? currentSession.room : null;
  if (!room) return;
  if (receiverConnId) deleteConnectionDoc(room, receiverConnId);
  senderPeers.forEach((pc, id) => deleteConnectionDoc(room, id));
});
