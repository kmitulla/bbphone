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
  eco:    { width: 320,  height: 240, frameRate: 10 },   // Akku-Sparmodus
};
// Aktive Qualität des Kind-Geräts (Akku-Sparmodus überstimmt die Wahl):
function activeQuality() {
  return control.ecoChild ? QUALITY.eco : QUALITY[control.quality];
}

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

/* ===========================================================
   SVG-Icons (iOS-Stil, keine Emojis)
   =========================================================== */
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${inner}</svg>`;
const ICON = {
  moon: SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  broadcast: SVG('<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><path d="M5 17a8 8 0 0 1 0-10M19 7a8 8 0 0 1 0 10M8 14a4 4 0 0 1 0-4M16 10a4 4 0 0 1 0 4"/>'),
  eye: SVG('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
  flip: SVG('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  video: SVG('<rect x="1" y="5" width="15" height="14" rx="3"/><path d="M23 7l-7 5 7 5V7z"/>'),
  mic: SVG('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  sliders: SVG('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  rotate: SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  "volume-low": SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  "volume-high": SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  trash: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  door: SVG('<path d="M3 21h18"/><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none"/>'),
  person: SVG('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  leave: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  "wifi-off": SVG('<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>'),
  eco: SVG('<path d="M5 18H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.19M15 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3.19"/><line x1="23" y1="13" x2="23" y2="11"/><polyline points="11 6 7 12 13 12 9 18"/>'),
  activity: SVG('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
};
function injectIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    const name = el.getAttribute("data-icon");
    if (ICON[name]) el.innerHTML = ICON[name];
  });
}
injectIcons();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
let roomCameras = [];   // vom Kind-Gerät gemeldete Kameras (für die Fernsteuerung)

/* Ton-Freischaltung: iPhone erlaubt Ton-Wiedergabe erst nach einem Tipp. */
let sharedAudioCtx = null;
function unlockMedia() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume();
    const o = sharedAudioCtx.createOscillator(), g = sharedAudioCtx.createGain();
    g.gain.value = 0.00001; o.connect(g); g.connect(sharedAudioCtx.destination);
    o.start(); o.stop(sharedAudioCtx.currentTime + 0.03);
  } catch (e) {}
}

/* ===========================================================
   4b) Eigener Dialog (statt System-confirm/alert)
   =========================================================== */
let dialogResolve = null;
function showDialog({ title, text = "", okLabel = "OK", cancelLabel = "Abbrechen", danger = false, showCancel = true }) {
  return new Promise((resolve) => {
    // Falls schon ein Dialog offen ist: den alten sauber auflösen.
    if (dialogResolve) { dialogResolve(false); }
    dialogResolve = resolve;
    $("dialog-title").textContent = title;
    $("dialog-text").textContent = text;
    $("dialog-text").classList.toggle("hidden", !text);
    const ok = $("dialog-ok");
    ok.textContent = okLabel;
    ok.classList.toggle("btn-danger", danger);
    ok.classList.toggle("btn-primary", !danger);
    $("dialog-cancel").classList.toggle("hidden", !showCancel);
    $("dialog-cancel").textContent = cancelLabel;
    $("app-dialog").classList.remove("hidden");
  });
}
function closeDialog(result) {
  $("app-dialog").classList.add("hidden");
  if (dialogResolve) { dialogResolve(result); dialogResolve = null; }
}
const showConfirm = (opts) => showDialog({ danger: true, ...opts });
const showAlert = (title, text) => showDialog({ title, text, showCancel: false, danger: false });
$("dialog-ok").addEventListener("click", () => closeDialog(true));
$("dialog-cancel").addEventListener("click", () => closeDialog(false));
$("app-dialog").addEventListener("click", (e) => { if (e.target === $("app-dialog")) closeDialog(false); });

function setStatus(elId, text, kind) {
  const el = $(elId); if (!el) return;
  el.textContent = text;
  el.classList.remove("connected", "connecting", "disconnected");
  if (kind) el.classList.add(kind);
}

// Standard-Fernsteuerung (Werte im Raum-Dokument):
function defaultControl() {
  return { childVideoEnabled: true, quality: "medium", showParentVideoOnChild: true, childVolume: 80, cameraId: "", screenOff: false, ecoChild: false };
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
  try {
    if (user) {
      startRoomListListener();
      // Immer zuerst die sichtbare Übersicht zeigen (nie ein schwarzer Bildschirm).
      showScreen("home");
      // Bei einem Lesezeichen-Link erscheint darüber ein großer "Starten"-Knopf.
      handleUrlAutostart();
    } else {
      stopRoomListListener();
      stopEverything();
      showScreen("login");
    }
  } catch (e) {
    // Im Zweifel auf einer sichtbaren Seite landen.
    showScreen(user ? "home" : "login");
  }
});

/* ===========================================================
   6) Raumliste (sichtbare Räume zum Antippen)
   =========================================================== */
let roomListUnsub = null;
let roomPresenceUnsubs = [];

function startRoomListListener() {
  if (roomListUnsub) return;
  roomListUnsub = onSnapshot(collection(db, "rooms"), (snap) => {
    const list = $("room-list");
    const rooms = snap.docs.map(d => d.id).sort();
    // alte Anwesenheits-Beobachter lösen
    roomPresenceUnsubs.forEach(u => { try { u(); } catch (e) {} });
    roomPresenceUnsubs = [];
    list.innerHTML = "";
    if (rooms.length === 0) {
      list.innerHTML = '<p class="muted" id="room-empty">Noch keine Räume. Erstelle unten einen.</p>';
      return;
    }
    rooms.forEach(name => {
      const item = document.createElement("div");
      item.className = "room-item";
      item.innerHTML = `<span class="name"><span class="ic" data-icon="door"></span> ${name}</span><span class="room-badge"></span><button class="del" title="Raum löschen">${ICON.trash}</button>`;
      injectIcons(item);
      item.querySelector(".name").addEventListener("click", () => selectRoom(name, item));
      item.querySelector(".del").addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await showConfirm({
          title: `Raum „${name}“ löschen?`,
          text: "Der Raum wird für alle Geräte aus der Liste entfernt.",
          okLabel: "Löschen"
        });
        if (ok) deleteRoom(name);
      });
      list.appendChild(item);
      // Anwesenheit pro Raum live anzeigen
      const u = onSnapshot(collection(db, "rooms", name, "presence"), (psnap) => {
        const c = countPresence(psnap.docs);
        const badge = item.querySelector(".room-badge");
        if (!badge) return;
        const parts = [];
        if (c.childrenCount > 0) parts.push(`<span class="on">${ICON.broadcast} aktiv</span>`);
        if (c.parentsCount > 0) parts.push(`${ICON.eye} ${c.parentsCount}`);
        badge.innerHTML = parts.join(" &nbsp; ");
      });
      roomPresenceUnsubs.push(u);
    });
  });
}
function stopRoomListListener() {
  if (roomListUnsub) { roomListUnsub(); roomListUnsub = null; }
  roomPresenceUnsubs.forEach(u => { try { u(); } catch (e) {} });
  roomPresenceUnsubs = [];
}

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
  if (!name) { showAlert("Raumname fehlt", "Bitte zuerst einen Raumnamen eingeben."); return; }
  $("room").value = name;
  await ensureRoom(name);
});

/* ===========================================================
   7) Start-Knöpfe + Lesezeichen-Links
   =========================================================== */
const savedRoom = localStorage.getItem("babyphone_room");
if (savedRoom) $("room").value = savedRoom;

$("send-btn").addEventListener("click", () => { unlockMedia(); beginSession("send"); });
$("receive-btn").addEventListener("click", () => { unlockMedia(); beginSession("receive"); });

function cleanRoomName(v) {
  return (v || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
}

async function beginSession(mode) {
  const room = cleanRoomName($("room").value);
  if (!room) { showAlert("Kein Raum gewählt", "Bitte zuerst einen Raum auswählen oder anlegen."); return; }
  localStorage.setItem("babyphone_room", room);
  await ensureRoom(room);
  if (mode === "send") startChild(room);
  else startParent(room);
}

let pendingStart = null;   // gemerkter Lesezeichen-Start (room + mode)

function handleUrlAutostart() {
  const params = new URLSearchParams(location.search);
  const room = cleanRoomName(params.get("room") || "");
  const mode = params.get("mode");
  if (room && (mode === "send" || mode === "receive")) {
    showStartGate(room, mode);
    return true;
  }
  return false;
}

let gatePresenceUnsub = null;

// Start-Tor zeigen: EIN bewusster Tipp – wichtig, damit das iPhone
// danach Kamera/Mikrofon bzw. den Ton erlaubt (sonst schwarzer Bildschirm).
// Zeigt außerdem an, wer schon im Raum ist.
function showStartGate(room, mode) {
  pendingStart = { room, mode };
  $("start-gate-text").textContent =
    (mode === "send" ? "Senden" : "Empfangen") + " · Raum: " + room;
  $("start-gate-btn").textContent =
    mode === "send" ? "Senden starten" : "Empfangen starten";
  $("start-gate-presence").textContent = "";
  if (gatePresenceUnsub) { try { gatePresenceUnsub(); } catch (e) {} }
  gatePresenceUnsub = onSnapshot(collection(db, "rooms", room, "presence"), (snap) => {
    const c = countPresence(snap.docs);
    const parts = [];
    if (c.childrenCount > 0) parts.push("Babybett ist aktiv: " + escapeHtml(c.children.join(", ")));
    if (c.parentsCount > 0) parts.push(escapeHtml(c.parents.join(", ")) + " (Eltern)");
    $("start-gate-presence").textContent = parts.length ? parts.join("  ·  ") : "Noch niemand im Raum.";
  });
  $("start-gate").classList.remove("hidden");
}
function hideStartGate() {
  if (gatePresenceUnsub) { try { gatePresenceUnsub(); } catch (e) {} gatePresenceUnsub = null; }
  $("start-gate").classList.add("hidden");
}

$("start-gate-btn").addEventListener("click", async () => {
  if (!pendingStart) return;
  unlockMedia();
  const { room, mode } = pendingStart;
  pendingStart = null;
  hideStartGate();
  localStorage.setItem("babyphone_room", room);
  await ensureRoom(room);
  if (mode === "send") startChild(room);
  else startParent(room);
});
$("start-gate-home").addEventListener("click", () => {
  pendingStart = null;
  hideStartGate();
  if (location.search) history.replaceState(null, "", location.pathname);
  showScreen("home");
});

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
  // Hintergrund-Ton: AudioContext am Leben halten (so gut es das System erlaubt).
  if (bgAudio && sharedAudioCtx && sharedAudioCtx.state === "suspended") sharedAudioCtx.resume().catch(() => {});
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
    if (!data) return;
    if (data.control) control = { ...defaultControl(), ...data.control };
    if (Array.isArray(data.cameras)) roomCameras = data.cameras;
    onChange();
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
   10b) Anwesenheit – wer ist gerade als Kind/Eltern im Raum?
   =========================================================== */
// Stabile Geräte-Kennung, damit keine Karteileichen übrig bleiben.
let myDeviceId = localStorage.getItem("babyphone_device_id");
if (!myDeviceId) {
  myDeviceId = "d" + Math.random().toString(36).slice(2, 12);
  localStorage.setItem("babyphone_device_id", myDeviceId);
}

let presenceUnsub = null;
let presenceTimer = null;
const PRESENCE_FRISCH_MS = 45000;   // so lange gilt ein Eintrag als "anwesend"

// Eigene Anwesenheit melden (mit regelmäßigem "Herzschlag") + Raum beobachten.
async function startPresence(room, role) {
  stopPresenceHeartbeat();
  const ref = doc(db, "rooms", room, "presence", myDeviceId);
  const name = (auth.currentUser && auth.currentUser.email) ? auth.currentUser.email.split("@")[0] : "Gerät";
  const beat = () => setDoc(ref, { role, name, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
  await beat();
  presenceTimer = setInterval(beat, 20000);
  presenceUnsub = onSnapshot(collection(db, "rooms", room, "presence"), (snap) => {
    updatePresenceUI(countPresence(snap.docs));
  });
}
function stopPresenceHeartbeat() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  if (presenceUnsub) { try { presenceUnsub(); } catch (e) {} presenceUnsub = null; }
}
function stopPresence(room) {
  stopPresenceHeartbeat();
  if (room) deleteDoc(doc(db, "rooms", room, "presence", myDeviceId)).catch(() => {});
}

// Frische Anwesenheits-Einträge nach Rolle sammeln (mit Namen).
function countPresence(docs) {
  const now = Date.now();
  const children = [], parents = [], otherParents = [];
  docs.forEach(d => {
    const data = d.data();
    const ts = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : now;
    if (now - ts > PRESENCE_FRISCH_MS) return;        // veraltet -> ignorieren
    const nm = data.name || "Gerät";
    if (data.role === "send") children.push(nm);
    else if (data.role === "receive") { parents.push(nm); if (d.id !== myDeviceId) otherParents.push(nm); }
  });
  return {
    children, parents, otherParents,
    childrenCount: children.length, parentsCount: parents.length, otherParentsCount: otherParents.length
  };
}

// Anwesenheit im laufenden Betrieb anzeigen (mit Namen).
function updatePresenceUI(c) {
  if (!currentSession) return;
  if (currentSession.mode === "send") {
    const el = $("child-presence");
    const txt = c.parentsCount > 0 ? escapeHtml(c.parents.join(", ")) : "Noch keine Eltern";
    el.innerHTML = `<span class="who">${ICON.eye} ${txt}</span>`;
    el.classList.remove("hidden");
  } else {
    const el = $("parent-presence");
    const childTxt = c.childrenCount > 0 ? escapeHtml(c.children.join(", ")) : "Babybett wartet…";
    let html = `<span class="who"><span class="on">${ICON.broadcast}</span> ${childTxt}</span>`;
    if (c.otherParentsCount > 0) html += `<span class="who">${ICON.eye} ${escapeHtml(c.otherParents.join(", "))}</span>`;
    el.innerHTML = html;
    el.classList.remove("hidden");
  }
  renderPresenceList(c);
}

// Volle Namensliste (im Eltern-Menü).
function renderPresenceList(c) {
  const box = $("presence-list");
  if (!box) return;
  const rows = [];
  c.children.forEach(n => rows.push(`<div class="presence-row">${ICON.person}<span class="who-name">${escapeHtml(n)}</span><span class="who-tag child">Babybett</span></div>`));
  c.parents.forEach(n => rows.push(`<div class="presence-row">${ICON.person}<span class="who-name">${escapeHtml(n)}</span><span class="who-tag parent">Eltern</span></div>`));
  box.innerHTML = rows.length ? rows.join("") : '<span class="muted">Noch niemand im Raum.</span>';
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
      video: { facingMode: currentFacing, ...activeQuality() },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) {
    currentSession = null;
    showAlert("Kein Zugriff auf Kamera/Mikrofon",
      "Bitte am iPhone erlauben (Einstellungen → Safari → Kamera/Mikrofon) und dann erneut auf „Senden“ tippen.");
    showScreen("home");
    return;
  }
  childVideoTrack = localStream.getVideoTracks()[0];
  $("local-video").srcObject = localStream;
  await requestWakeLock();
  await fillCameraList();

  // Kontrolle übernehmen / anwenden (Qualität, Video an/aus, …)
  $("child-quality-select").value = control.quality;
  listenControl(roomName, applyControlOnChild);
  startPresence(roomName, "send");

  setStatus("child-status", "Bereit, warte auf Eltern…", "connecting");
  await cleanupOldConnections(roomName);

  const connsRef = collection(db, "rooms", roomName, "connections");
  childUnsub = onSnapshot(connsRef, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const data = change.doc.data();
      if (change.type === "added" && !data.offer && !childPeers.has(change.doc.id)) {
        createChildPeer(roomName, change.doc.id);
      }
      if (change.type === "added" || change.type === "modified") {
        // Expliziter Eltern-Status (Video an? Sprechen an? Bild gewünscht?).
        // Zuverlässiger als die mute-Ereignisse, die Safari oft nicht meldet.
        connFlags.set(change.doc.id, { video: data.parentVideo, talking: data.parentTalking, wantVideo: data.wantVideo });
        applyControlOnChild();
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
  // Eigene Kamera/Mikro senden (Eltern im Akku-Sparmodus bekommen kein Bild):
  const flags = connFlags.get(connId) || {};
  const giveVideo = control.childVideoEnabled && flags.wantVideo !== false;
  try { await videoTx.sender.replaceTrack(giveVideo ? childVideoTrack : null); } catch (e) {}
  try { await audioTx.sender.replaceTrack(localStream.getAudioTracks()[0]); } catch (e) {}

  // Eingehende Eltern-Spuren (Stimme + evtl. Video) anzeigen/abspielen:
  pc.ontrack = (e) => attachParentTrack(connId, e.track);

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
  connFlags.delete(connId);
  removeParentTile(connId);
  updateChildStatus();
}

function updateChildStatus() {
  let connected = 0;
  childPeers.forEach(pc => { if (pc.connectionState === "connected") connected++; });
  if (connected > 0) setStatus("child-status", connected === 1 ? "Verbunden (1 Empfänger)" : `Verbunden (${connected} Empfänger)`, "connected");
  else setStatus("child-status", "Bereit, warte auf Eltern…", "connecting");
}

/* ===== Eltern-Medien auf dem Kind-Gerät: große Bühne + Splitscreen =====
   Wichtig: wir hängen die EINZELNE Spur (e.track) an einen eigenen Stream pro
   Verbindung. So funktioniert es zuverlässig, auch wenn die Eltern Video erst
   später dazuschalten (replaceTrack ohne Neuverhandlung). */
const parentTiles = new Map();   // connId -> { stream, el }   (nur Video)
const connFlags = new Map();     // connId -> { video, talking }  (expliziter Eltern-Status)
let childAudioStream = null;     // alle Eltern-Stimmen in einem Stream (zuverlässige Wiedergabe)

function attachParentTrack(connId, track) {
  if (track.kind === "audio") {
    // Stimme: in EIN Audio-Element. So spielt der Ton zuverlässig (auch wenn kein Video an ist).
    if (!childAudioStream) { childAudioStream = new MediaStream(); $("parent-audio").srcObject = childAudioStream; }
    if (!childAudioStream.getTracks().some(t => t.id === track.id)) childAudioStream.addTrack(track);
    $("parent-audio").volume = control.childVolume / 100;
    playChildAudio();
  } else {
    // Video: eigene Kachel pro Verbindung (stumm – der Ton läuft über parent-audio).
    let entry = parentTiles.get(connId);
    if (!entry) {
      const stream = new MediaStream();
      const el = document.createElement("video");
      el.className = "parent-tile empty";
      el.autoplay = true; el.playsInline = true; el.muted = true; el.dataset.conn = connId;
      el.srcObject = stream;
      $("parent-stage").appendChild(el);
      entry = { stream, el };
      parentTiles.set(connId, entry);
    }
    if (!entry.stream.getTracks().some(t => t.id === track.id)) entry.stream.addTrack(track);
    entry.el.play().catch(() => {});
  }
  // Bei Änderung (Video an/aus, Sprechen) Bühne neu rechnen.
  track.onunmute = updateParentStage;
  track.onmute = updateParentStage;
  track.onended = updateParentStage;
  updateParentStage();
}
function removeParentTile(connId) {
  const entry = parentTiles.get(connId);
  if (entry) { try { entry.el.remove(); } catch (e) {} parentTiles.delete(connId); }
  updateParentStage();
}
// Eltern-Ton abspielen; klappt der Autostart nicht, Hinweis zum Antippen zeigen.
function playChildAudio() {
  const a = $("parent-audio");
  a.muted = false;
  a.volume = control.childVolume / 100;
  a.play().then(() => $("child-unmute").classList.add("hidden"))
          .catch(() => $("child-unmute").classList.remove("hidden"));
}
function tileHasLiveVideo(entry) {
  return entry.stream.getVideoTracks().some(t => t.readyState === "live" && !t.muted);
}
function anyParentTalking() {
  // Bevorzugt den expliziten Status aus Firestore (zuverlässig);
  // die mute-Heuristik nur als Rückfall für ältere Eltern-Geräte.
  let hasFlag = false, talking = false;
  connFlags.forEach(f => {
    if (typeof f.talking === "boolean") { hasFlag = true; if (f.talking) talking = true; }
  });
  if (hasFlag) return talking;
  if (!childAudioStream) return false;
  return childAudioStream.getAudioTracks().some(t => t.readyState === "live" && !t.muted);
}
// Bühne zeichnen: jede Verbindung mit aktivem Eltern-Video bekommt eine Kachel (Splitscreen).
function updateParentStage() {
  const stage = $("parent-stage");
  let active = 0;
  parentTiles.forEach((entry, connId) => {
    const flags = connFlags.get(connId) || {};
    // Explizit "Video aus" gemeldet -> Kachel sicher verbergen (kein Standbild).
    // Im Akku-Sparmodus des Kind-Geräts gar kein Eltern-Video decodieren.
    const show = control.showParentVideoOnChild && !control.ecoChild && flags.video !== false && tileHasLiveVideo(entry);
    entry.el.classList.toggle("empty", !show);
    if (show) active++;
  });
  stage.className = "parent-stage" + (active ? " tiles-" + Math.min(active, 4) : "");
  if (active === 0) stage.classList.add("hidden");
  if (childAudioStream) $("parent-audio").volume = control.childVolume / 100;
  $("parent-talking").classList.toggle("hidden", !anyParentTalking());
}

// Tippen auf den Hinweis schaltet den Ton frei.
$("child-unmute").addEventListener("click", () => {
  unlockMedia();
  const a = $("parent-audio"); a.muted = false;
  a.play().catch(() => {});
  $("child-unmute").classList.add("hidden");
});

/* Fernsteuerung auf dem Kind-Gerät anwenden */
async function applyControlOnChild() {
  if (!currentSession || currentSession.mode !== "send") return;
  // Kamera per Fernsteuerung wechseln (falls die Eltern eine andere wählen):
  if (control.cameraId && childVideoTrack && childVideoTrack.getSettings().deviceId !== control.cameraId) {
    await switchCamera({ deviceId: control.cameraId }, false);
  }
  // Video an/aus – pro Verbindung: Eltern im Akku-Sparmodus bekommen kein Bild.
  for (const [connId, pc] of childPeers) {
    const s = senderForKind(pc, "video");
    const flags = connFlags.get(connId) || {};
    const give = control.childVideoEnabled && flags.wantVideo !== false;
    if (s) { try { await s.replaceTrack(give ? childVideoTrack : null); } catch (e) {} }
  }
  // Qualität (im Akku-Sparmodus stark reduziert):
  if (childVideoTrack) { try { await childVideoTrack.applyConstraints(activeQuality()); } catch (e) {} }
  $("child-quality-select").value = control.quality;
  // Bildschirm an/aus (auch fernsteuerbar): schwarzer Vorhang, alles läuft weiter.
  $("screen-off-curtain").classList.toggle("hidden", !control.screenOff);
  // Akku-Sparmodus-Knopf
  $("child-eco-btn").classList.toggle("active", !!control.ecoChild);
  // Eltern-Bühne (Lautstärke + Sichtbarkeit) aktualisieren:
  updateParentStage();
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
    // Kameraliste in den Raum schreiben, damit die Eltern sie fernsteuern können.
    if (currentSession && currentSession.mode === "send") {
      const list = cams.map((c, i) => ({ id: c.deviceId, label: c.label || `Kamera ${i + 1}` }));
      setDoc(doc(db, "rooms", currentSession.room), { cameras: list }, { merge: true }).catch(() => {});
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

async function switchCamera(videoConstraint, publish = true) {
  if (!localStream) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoConstraint, ...activeQuality() }, audio: false
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
    // gewählte Kamera in die Fernsteuerung schreiben (damit Eltern es sehen)
    if (publish) {
      const id = childVideoTrack.getSettings().deviceId;
      if (id) setControl({ cameraId: id });
    }
  } catch (e) { showAlert("Kamera", "Die Kamera konnte nicht gewechselt werden."); }
}

// Kind: Video lokal an/aus (schreibt auch in die Fernsteuerung)
$("child-video-toggle").addEventListener("click", () => setControl({ childVideoEnabled: !control.childVideoEnabled }));
// Qualität lokal wählen
$("child-quality-select").addEventListener("change", (e) => setControl({ quality: e.target.value }));

// Bildschirm aus/an: sofort lokal umschalten UND in die Fernsteuerung schreiben,
// damit die Eltern den Zustand sehen und ihn ebenfalls schalten können.
$("screen-off-btn").addEventListener("click", () => {
  $("screen-off-curtain").classList.remove("hidden");
  setControl({ screenOff: true });
});
$("screen-off-curtain").addEventListener("click", () => {
  $("screen-off-curtain").classList.add("hidden");
  setControl({ screenOff: false });
});

// Akku-Sparmodus am Kind-Gerät: Bild klein + wenige Bilder/Sekunde,
// Bildschirm dunkel, kein Eltern-Video decodieren. Ton läuft normal weiter.
$("child-eco-btn").addEventListener("click", () => {
  const on = !control.ecoChild;
  $("child-eco-btn").classList.toggle("active", on);
  $("screen-off-curtain").classList.toggle("hidden", !on);
  setControl({ ecoChild: on, screenOff: on });
});

/* ===========================================================
   12) ELTERN-GERÄT – empfängt; kann sprechen + eigenes Video
   =========================================================== */
let parentPc = null;
let parentConnId = null;
let parentConnRef = null;        // eigenes Verbindungsdokument (für Status-Meldungen)
let parentUnsubs = [];
let reconnectTimer = null;
let reconnecting = false;
let parentMicStream = null;      // Mikro der Eltern (für Sprechen)
let parentCamStream = null;      // Kamera der Eltern (für eigenes Video)
let talkOn = false;
let parentVideoOn = false;
let parentEco = false;           // Akku-Sparmodus der Eltern: nur Ton, kein Videobild

/* ----- Screensaver: statt eingefrorenem Standbild -----
   Sobald kein LIVE-Videobild mehr ankommt (Video aus, Verbindung weg,
   Senden beendet), legt sich ein animierter Nacht-Bildschirm über das Video. */
let ssClockTimer = null;
function updateScreensaverClock() {
  $("ss-clock").textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
function showScreensaver(text, audioLive) {
  $("ss-text").textContent = text;
  $("ss-audio").classList.toggle("hidden", !audioLive);
  updateScreensaverClock();
  if (!ssClockTimer) ssClockTimer = setInterval(updateScreensaverClock, 5000);
  $("parent-screensaver").classList.remove("hidden");
}
function hideScreensaver() {
  if (ssClockTimer) { clearInterval(ssClockTimer); ssClockTimer = null; }
  $("parent-screensaver").classList.add("hidden");
}
/* Frame-Watchdog: Safari meldet mute/unmute nicht zuverlässig. Deshalb prüfen
   wir zusätzlich, ob wirklich neue Videobilder ankommen. Bleiben die Bilder
   aus, gilt das Video als eingefroren -> Screensaver statt Standbild. */
let lastFrameTs = 0;            // Zeitpunkt des letzten empfangenen Videobildes
let frameWatchArmed = false;
let viewStateTimer = null;      // regelmäßige Zustandsprüfung
function armFrameWatch() {
  const v = $("remote-video");
  if (typeof v.requestVideoFrameCallback !== "function") { lastFrameTs = Infinity; return; } // alte Browser: Heuristik reicht
  if (frameWatchArmed) return;
  frameWatchArmed = true;
  const loop = () => { lastFrameTs = Date.now(); v.requestVideoFrameCallback(loop); };
  v.requestVideoFrameCallback(loop);
}
function framesFresh() {
  return lastFrameTs === Infinity || (Date.now() - lastFrameTs) < 2500;
}

// Zustand prüfen: Gibt es gerade ein echtes, laufendes Videobild?
function updateParentViewState() {
  const inReceive = currentSession && currentSession.mode === "receive";
  const stream = inReceive ? $("remote-video").srcObject : null;
  const connected = !!(parentPc && parentPc.connectionState === "connected");
  // Deutliches Warn-Banner bei Verbindungsverlust (nachdem schon einmal verbunden war).
  $("conn-lost").classList.toggle("hidden", !(inReceive && stream && !connected));
  if (!inReceive || !stream) { hideScreensaver(); return; }   // noch nie verbunden -> Platzhalter läuft
  if (meterOn) startAudioMeter();   // Pegel-Anzeige (nach-)starten, sobald ein Stream da ist
  const videoLive = stream.getVideoTracks().some(t => t.readyState === "live" && !t.muted) && framesFresh();
  const audioLive = stream.getAudioTracks().some(t => t.readyState === "live" && !t.muted);
  if (connected && parentEco) { showScreensaver("Akku-Sparmodus – nur Ton", audioLive); return; }
  if (connected && videoLive) { hideScreensaver(); return; }
  if (!connected) showScreensaver("Verbindung zum Babybett verloren", false);
  else if (!control.childVideoEnabled) showScreensaver("Video ist ausgeschaltet", audioLive);
  else showScreensaver("Warte auf Videobild…", audioLive);
}

async function startParent(roomName) {
  currentSession = { mode: "receive", room: roomName };
  showScreen("parent");
  document.querySelectorAll(".room-name-label").forEach(el => el.textContent = "· " + roomName);
  $("parent-placeholder").classList.remove("hidden");
  await requestWakeLock();

  // Fernsteuer-Bedienelemente mit aktuellen Werten füllen + Änderungen hören
  listenControl(roomName, syncRemoteControlsUI);
  startPresence(roomName, "receive");
  remoteRotation = 0; applyRotation();
  $("rc-bg-audio").checked = bgAudio;

  // Frame-Watchdog + regelmäßige Prüfung (fängt eingefrorene Bilder ab,
  // auch wenn der Browser keine mute-Ereignisse liefert).
  lastFrameTs = 0;
  armFrameWatch();
  clearInterval(viewStateTimer);
  viewStateTimer = setInterval(updateParentViewState, 1500);

  // Audiopegel-Anzeige (gemerkte Einstellung) + Knopf-Zustände
  setMeterVisible();
  $("parent-eco-btn").classList.toggle("active", parentEco);

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
    // Live-Zustand der Spur beobachten (Video an/aus -> Screensaver statt Standbild).
    e.track.onmute = updateParentViewState;
    e.track.onunmute = updateParentViewState;
    e.track.onended = updateParentViewState;
    updateParentViewState();
    if (meterOn) startAudioMeter();
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
    updateParentViewState();
  };

  const connsRef = collection(db, "rooms", roomName, "connections");
  let connRef;
  try {
    connRef = await addDoc(connsRef, {
      role: "parent", createdAt: serverTimestamp(),
      parentTalking: talkOn, parentVideo: parentVideoOn, wantVideo: !parentEco
    });
  }
  catch (e) { setStatus("parent-status", "Getrennt, versuche erneut…", "disconnected"); scheduleReconnect(roomName); return; }
  parentConnId = connRef.id;
  parentConnRef = connRef;

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
  parentConnRef = null;
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

/* ----- Audiopegel-Anzeige (rechts, sehr empfindlich) -----
   Beruhigung: Auch wenn sich im Bild nichts bewegt, sieht man am zuckenden
   Pegel, dass die Übertragung lebt. Reagiert schon auf leises Rauschen. */
const METER_SEGMENTS = 12;
let meterOn = localStorage.getItem("babyphone_meter") !== "0";
let meterSource = null, meterAnalyser = null, meterBuf = null;
let meterStream = null, meterRaf = null, meterLevel = 0;

function setMeterVisible() {
  $("meter-col").classList.toggle("hidden", !meterOn);
  $("meter-toggle").classList.toggle("active", meterOn);
}
$("meter-toggle").addEventListener("click", () => {
  unlockMedia();
  meterOn = !meterOn;
  localStorage.setItem("babyphone_meter", meterOn ? "1" : "0");
  setMeterVisible();
  if (meterOn) startAudioMeter(); else stopMeterLoop();
});

function startAudioMeter() {
  if (!currentSession || currentSession.mode !== "receive") return;
  const stream = $("remote-video").srcObject;
  if (!stream || stream.getAudioTracks().length === 0) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume().catch(() => {});
    if (meterStream !== stream) {
      try { if (meterSource) meterSource.disconnect(); } catch (e) {}
      meterStream = stream;
      meterSource = sharedAudioCtx.createMediaStreamSource(stream);
      meterAnalyser = sharedAudioCtx.createAnalyser();
      meterAnalyser.fftSize = 1024;
      meterAnalyser.smoothingTimeConstant = 0.55;
      meterSource.connect(meterAnalyser);   // NICHT an die Ausgabe (sonst Doppel-Ton)
      meterBuf = new Float32Array(meterAnalyser.fftSize);
    }
    if (!meterRaf) meterLoop();
  } catch (e) {}
}
function meterLoop() {
  meterRaf = requestAnimationFrame(meterLoop);
  if (!meterAnalyser || !meterOn) return;
  let rms = 0;
  if (meterAnalyser.getFloatTimeDomainData) {
    meterAnalyser.getFloatTimeDomainData(meterBuf);
    for (let i = 0; i < meterBuf.length; i++) rms += meterBuf[i] * meterBuf[i];
    rms = Math.sqrt(rms / meterBuf.length);
  } else {
    const b = new Uint8Array(meterAnalyser.fftSize);
    meterAnalyser.getByteTimeDomainData(b);
    for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; rms += v * v; }
    rms = Math.sqrt(rms / b.length);
  }
  // Sehr empfindliche Skala: -75 dB (leisestes Rauschen) bis -25 dB (laut).
  const db = 20 * Math.log10(rms || 1e-8);
  const target = Math.max(0, Math.min(1, (db + 75) / 50));
  meterLevel = Math.max(target, meterLevel * 0.92);   // schnell rauf, sanft runter
  const lit = Math.round(meterLevel * METER_SEGMENTS);
  const segs = $("meter-col").children;
  for (let i = 0; i < segs.length; i++) segs[i].classList.toggle("lit", i < lit);
}
function stopMeterLoop() {
  if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
  meterLevel = 0;
  const segs = $("meter-col").children;
  for (let i = 0; i < segs.length; i++) segs[i].classList.remove("lit");
}
function stopAudioMeter() {
  stopMeterLoop();
  try { if (meterSource) meterSource.disconnect(); } catch (e) {}
  meterSource = null; meterAnalyser = null; meterStream = null; meterBuf = null;
}

/* ----- Display des Kind-Geräts fernschalten (Dock-Knopf) ----- */
$("parent-screen-btn").addEventListener("click", () => {
  const off = !control.screenOff;
  $("parent-screen-btn").classList.toggle("active", off);
  setControl({ screenOff: off });
});

/* ----- Akku-Sparmodus der Eltern: nur Ton, kein Videobild -----
   Meldet dem Kind-Gerät "kein Bild für mich" (spart Funk + Akku auf beiden
   Seiten, andere Eltern sehen weiter zu) und zeigt den dunklen Nachthimmel
   mit Uhr und Audiopegel. */
$("parent-eco-btn").addEventListener("click", () => {
  parentEco = !parentEco;
  $("parent-eco-btn").classList.toggle("active", parentEco);
  publishParentState();
  updateParentViewState();
});

/* ----- Sprechen (Push-to-talk: tippen = an/aus) -----
   Zuverlässigkeit: Die Mikro-Spur wird EINMAL angehängt und bleibt am Sender.
   An/Aus schaltet nur track.enabled um (kein An-/Abhängen der Spur mehr –
   das war auf dem iPhone die Hauptursache für "Sprechen geht nicht"). */
$("talk-btn").addEventListener("click", toggleTalk);
async function toggleTalk() {
  unlockMedia();
  talkOn = !talkOn;
  $("talk-btn").classList.toggle("active", talkOn);
  if (talkOn && !parentMicStream) {
    try { parentMicStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { talkOn = false; $("talk-btn").classList.remove("active"); showAlert("Mikrofon", "Kein Zugriff auf das Mikrofon."); return; }
  }
  if (parentMicStream) {
    const track = parentMicStream.getAudioTracks()[0];
    track.enabled = talkOn;                 // aus = Stille senden (stabil, kein Umbau)
    await sendParentTrack("audio", track);  // sicherstellen, dass die Spur hängt
  }
  publishParentState();
}

/* ----- Eigenes Video zeigen (Eltern -> Kind) ----- */
$("parent-video-btn").addEventListener("click", toggleParentVideo);
async function toggleParentVideo() {
  parentVideoOn = !parentVideoOn;
  $("parent-video-btn").classList.toggle("active", parentVideoOn);
  if (parentVideoOn) {
    if (!parentCamStream) {
      try { parentCamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", ...QUALITY[control.quality] } }); }
      catch (e) { parentVideoOn = false; $("parent-video-btn").classList.remove("active"); showAlert("Kamera", "Kein Zugriff auf die Kamera."); publishParentState(); return; }
    }
    $("parent-self-video").srcObject = parentCamStream;
    $("parent-self-video").classList.remove("hidden");
    await sendParentTrack("video", parentCamStream.getVideoTracks()[0]);
  } else {
    $("parent-self-video").classList.add("hidden");
    await sendParentTrack("video", null);
    // Kamera wirklich freigeben (Kameralicht aus, Akku sparen).
    if (parentCamStream) { parentCamStream.getTracks().forEach(t => t.stop()); parentCamStream = null; }
    $("parent-self-video").srcObject = null;
  }
  publishParentState();
}

// Eine Eltern-Spur (audio/video) in die laufende Verbindung legen.
async function sendParentTrack(kind, track) {
  if (!parentPc) return;
  const s = senderForKind(parentPc, kind);
  if (s) { try { await s.replaceTrack(track); } catch (e) {} }
}
// Eigenen Status (Sprechen/Video) ins Verbindungsdokument schreiben.
// Das Kind-Gerät blendet damit Kachel + "Eltern sprechen…" zuverlässig ein/aus.
async function publishParentState() {
  if (!parentConnRef) return;
  try { await updateDoc(parentConnRef, { parentTalking: talkOn, parentVideo: parentVideoOn, wantVideo: !parentEco }); } catch (e) {}
}
// Nach (Neu-)Verbindung Sprechen/Video wieder herstellen.
async function reattachParentTracks() {
  if (parentMicStream) {
    const track = parentMicStream.getAudioTracks()[0];
    track.enabled = talkOn;
    await sendParentTrack("audio", track);
  }
  if (parentVideoOn && parentCamStream) await sendParentTrack("video", parentCamStream.getVideoTracks()[0]);
  publishParentState();
}

/* ----- Fernsteuer-Bedienelemente (Menü) ----- */
$("rc-child-video").addEventListener("change", (e) => setControl({ childVideoEnabled: e.target.checked }));
$("rc-show-parent").addEventListener("change", (e) => setControl({ showParentVideoOnChild: e.target.checked }));
$("rc-eco-child").addEventListener("change", (e) => setControl({ ecoChild: e.target.checked }));
$("rc-quality").addEventListener("change", (e) => setControl({ quality: e.target.value }));
$("rc-child-volume").addEventListener("input", (e) => setControl({ childVolume: Number(e.target.value) }));
$("rc-camera").addEventListener("change", (e) => setControl({ cameraId: e.target.value }));

function syncRemoteControlsUI() {
  updateParentViewState();
  $("rc-child-video").checked = control.childVideoEnabled;
  $("rc-show-parent").checked = control.showParentVideoOnChild;
  $("rc-eco-child").checked = !!control.ecoChild;
  $("parent-screen-btn").classList.toggle("active", !!control.screenOff);
  $("rc-quality").value = control.quality;
  $("rc-child-volume").value = control.childVolume;
  // Kamera-Auswahl (vom Kind gemeldete Kameras) füllen
  const sel = $("rc-camera");
  sel.innerHTML = '<option value="">Standard-Kamera</option>' +
    roomCameras.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("");
  sel.value = control.cameraId || "";
}

/* ----- Bild drehen (nur für die eigene Eltern-Ansicht) ----- */
let remoteRotation = 0;
$("rotate-btn").addEventListener("click", () => {
  remoteRotation = (remoteRotation + 90) % 360;
  applyRotation();
});
function applyRotation() {
  const v = $("remote-video");
  v.style.right = "auto"; v.style.bottom = "auto";
  v.style.top = "50%"; v.style.left = "50%";
  v.style.transform = `translate(-50%, -50%) rotate(${remoteRotation}deg)`;
  if (remoteRotation === 90 || remoteRotation === 270) {
    v.style.width = "100vh"; v.style.height = "100vw";
  } else {
    v.style.width = "100vw"; v.style.height = "100vh";
  }
}

/* ----- Hintergrund-Ton (experimentell) -----
   Hinweis: Auf dem iPhone unterbindet das System Hintergrund-Ton von Webseiten
   weitgehend. Auf Android/Desktop läuft der Ton oft ohnehin weiter. Wir halten
   nur den Audio-Kanal „wach" – ohne doppelten Ton-Pfad (sonst Echo/Doppel-Ton). */
let bgAudio = localStorage.getItem("babyphone_bg_audio") === "1";
$("rc-bg-audio").addEventListener("change", (e) => {
  bgAudio = e.target.checked;
  localStorage.setItem("babyphone_bg_audio", bgAudio ? "1" : "0");
  if (bgAudio) unlockMedia();
});

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
// Raum verlassen: eigener Dialog als Sicherheitsfrage (keine System-Meldung).
async function askLeaveRoom() {
  const mode = currentSession && currentSession.mode;
  const ok = await showConfirm({
    title: "Raum wirklich verlassen?",
    text: mode === "send"
      ? "Die Übertragung vom Babybett wird beendet."
      : "Die Verbindung zum Babybett wird beendet.",
    okLabel: "Verlassen"
  });
  if (ok) { stopEverything(); showScreen("home"); }
}
document.querySelectorAll(".stop-btn, [data-exit]").forEach(btn => {
  btn.addEventListener("click", askLeaveRoom);
});

function stopEverything() {
  const room = currentSession ? currentSession.room : null;
  currentSession = null;

  document.querySelectorAll(".sheet").forEach(m => m.classList.add("hidden"));
  hideScreensaver();
  stopAudioMeter();
  clearInterval(viewStateTimer); viewStateTimer = null;
  lastFrameTs = 0;
  parentEco = false;
  $("parent-eco-btn").classList.remove("active");
  $("parent-screen-btn").classList.remove("active");
  $("child-eco-btn").classList.remove("active");
  $("conn-lost").classList.add("hidden");
  $("screen-off-curtain").classList.add("hidden");
  $("unmute-overlay").classList.add("hidden");
  $("parent-talking").classList.add("hidden");
  hideStartGate();
  pendingStart = null;
  $("parent-stage").innerHTML = "";
  $("parent-stage").classList.add("hidden");
  parentTiles.clear();
  childAudioStream = null;
  $("parent-audio").srcObject = null;
  $("child-unmute").classList.add("hidden");
  $("child-presence").classList.add("hidden");
  $("parent-presence").classList.add("hidden");

  // Drehung zurücksetzen
  remoteRotation = 0;
  $("remote-video").style.cssText = "";

  if (controlUnsub) { try { controlUnsub(); } catch (e) {} controlUnsub = null; }
  stopPresence(room);

  // Kind stoppen
  if (childUnsub) { try { childUnsub(); } catch (e) {} childUnsub = null; }
  childPeers.forEach((pc, id) => { if (room) deleteConnectionDoc(room, id); try { pc.close(); } catch (e) {} });
  childPeers.clear();
  connFlags.clear();
  childVideoTrack = null;

  // Eltern stoppen
  clearTimeout(reconnectTimer); reconnecting = false;
  parentUnsubs.forEach(u => { try { u(); } catch (e) {} });
  parentUnsubs = [];
  if (parentConnId && room) deleteConnectionDoc(room, parentConnId);
  parentConnId = null;
  parentConnRef = null;
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
  deleteDoc(doc(db, "rooms", room, "presence", myDeviceId)).catch(() => {});
});
