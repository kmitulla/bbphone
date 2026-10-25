/* ===========================================================
   Babyphone – Logik (Zwei-Wege)
   -----------------------------------------------------------
   Kind-Gerät (Babybett)  = sendet Ton + Video.
   Eltern-Gerät           = empfängt; kann zusätzlich:
       - sprechen (Mikro), eigenes Video zeigen
       - das Kind-Gerät fernsteuern (Kamera, Video an/aus,
         Qualität, Eltern-Video sichtbar, Lautstärke)
   Verbindung: WebRTC peer-to-peer. Signaling + Fernsteuerung
   über Firestore.

   Datenmodell in Firestore:
     rooms/{raum}                   control (Fernsteuerung), cameras,
                                    childState (was das Kind gerade macht),
                                    sender (welches Gerät gerade sendet)
     rooms/{raum}/presence/{id}     Wer ist da (mit Herzschlag)
     rooms/{raum}/connections/{id}  Eine Verbindung Eltern <-> Kind
        …/callerCandidates          Netzwerk-Adressen vom Kind
        …/calleeCandidates          Netzwerk-Adressen der Eltern

   Ablauf einer Verbindung:
     1. Eltern legen ein connections-Dokument an.
     2. Das Kind sieht es, baut die Verbindung und schreibt ein "offer".
     3. Die Eltern antworten mit einer "answer" -> verbunden.
     Bricht etwas ab, löschen die Eltern ihr Dokument und legen
     ein neues an. Das Kind räumt veraltete Dokumente selbst weg.
   =========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, serverTimestamp, writeBatch, enableNetwork, disableNetwork
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

// STUN: true = öffentliche STUN-Server benutzen (Standard). false = rein im VPN.
const NUTZE_STUN = true;
const STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

// Optional: eigener TURN-Server (z.B. "coturn" auf deinem eigenen Server).
// Hilft, wenn die Geräte in verschiedenen Netzen OHNE VPN sind (z.B. Mobilfunk).
// Leer lassen = aus. Beispiel:
//   urls: ["turn:turn.meinserver.de:3478?transport=udp", "turn:turn.meinserver.de:3478?transport=tcp"],
//   username: "babyphone", credential: "geheimes-passwort"
const TURN = { urls: [], username: "", credential: "" };

// Videoqualität-Stufen (Bildgröße, Bilder pro Sekunde, maximale Datenrate):
const QUALITY = {
  low:    { width: 320,  height: 240, frameRate: 15, maxBitrate: 150000 },
  medium: { width: 640,  height: 480, frameRate: 24, maxBitrate: 600000 },
  high:   { width: 1280, height: 720, frameRate: 30, maxBitrate: 2000000 },
};

// Mikrofon: Echo-Unterdrückung ist nötig, damit die Elternstimme nicht zurückhallt.
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// Zeiten (Millisekunden bzw. Sekunden)
const PRESENCE_BEAT_MS = 20000;            // Herzschlag "ich bin da"
const PRESENCE_FRESH_MS = 50000;           // so lange gilt ein Eintrag als anwesend
const PRESENCE_DELETE_MS = 6 * 3600 * 1000; // uralte Einträge aufräumen
const CHILD_PEER_TIMEOUT_MS = 30000;       // Kind: Verbindung muss nach 30 s stehen
const CHILD_DISCONNECT_CLEANUP_MS = 10000; // Kind: abgerissene Verbindung aufräumen
const PARENT_CONNECT_TIMEOUT_MS = 20000;   // Eltern: nach dem Angebot 20 s Zeit
const PARENT_OFFER_WAIT_MS = 10000;        // Eltern: Babybett da, aber kein Angebot -> neu
const DISCONNECT_GRACE_MS = 4000;          // kurze Aussetzer abwarten
const STALL_RECONNECT_S = 6;               // so lange gar keine Daten -> neu verbinden
const NO_AUDIO_WARN_S = 5;                 // so lange kein Ton -> Warnung

function rtcConfig() {
  const iceServers = [];
  if (NUTZE_STUN) iceServers.push({ urls: STUN_SERVERS });
  if (TURN.urls && TURN.urls.length) {
    iceServers.push({ urls: TURN.urls, username: TURN.username, credential: TURN.credential });
  }
  return { iceServers };
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
const $ = (id) => document.getElementById(id);

const screens = {
  splash: $("splash-screen"),
  login: $("login-screen"),
  home: $("home-screen"),
  child: $("child-screen"),
  parent: $("parent-screen"),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, fallback) {
  return Promise.race([Promise.resolve(promise), sleep(ms).then(() => fallback)]).catch(() => fallback);
}
function randomId(len = 12) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, b => (b % 36).toString(36)).join("");
}
function log(...args) { console.warn("[Babyphone]", ...args); }
function quiet(p) { return Promise.resolve(p).catch(e => { log(e); }); }
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { last = Date.now(); fn(...args); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { last = Date.now(); fn(...lastArgs); }, wait);
  };
}
// Windows-11-Schieberegler: Füllung in Akzentfarbe bis zum Regler.
function setRangeFill(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  el.style.setProperty("--p", ((Number(el.value) - min) / (max - min) * 100) + "%");
}
document.addEventListener("input", (e) => { if (e.target.classList && e.target.classList.contains("range")) setRangeFill(e.target); });
function stopStream(s) { if (s) s.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); }
function getMedia(constraints) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error("getUserMedia fehlt (nur über https:// oder localhost möglich)");
    e.name = "NotSupportedError";
    return Promise.reject(e);
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* Eigener Dialog im Windows-11-Stil (statt der grauen System-Popups). Liefert true/false. */
let dialogResolve = null;
function showDialog({ title, text = "", okLabel = "OK", cancelLabel = "Abbrechen", danger = false, showCancel = true }) {
  if (dialogResolve) closeDialog(false);
  $("dialog-title").textContent = title;
  $("dialog-text").textContent = text;
  $("dialog-ok").textContent = okLabel;
  $("dialog-ok").className = "btn " + (danger ? "btn-danger" : "btn-accent");
  $("dialog-cancel").textContent = cancelLabel;
  $("dialog-cancel").classList.toggle("hidden", !showCancel);
  $("dialog").classList.remove("hidden");
  console.info("[Dialog] " + title + ": " + text.replace(/\n+/g, " "));
  return new Promise(resolve => { dialogResolve = resolve; });
}
function closeDialog(result) {
  $("dialog").classList.add("hidden");
  const r = dialogResolve; dialogResolve = null;
  if (r) r(result);
}
$("dialog-ok").addEventListener("click", () => closeDialog(true));
$("dialog-cancel").addEventListener("click", () => closeDialog(false));
const showConfirm = (title, text, okLabel, danger = true) => showDialog({ title, text, okLabel, danger });
const showAlert = (title, text) => showDialog({ title, text, showCancel: false });

function setStatus(elId, text, kind) {
  const el = $(elId); if (!el) return;
  el.textContent = text;
  el.classList.remove("connected", "connecting", "disconnected", "warning");
  if (kind) el.classList.add(kind);
}
function setRoomLabels(room) {
  document.querySelectorAll(".room-name-label").forEach(el => { el.textContent = "· " + room; });
}

/* ===========================================================
   SVG-Icons (iOS-Stil, keine Emojis)
   =========================================================== */
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${inner}</svg>`;
const ICON = {
  moon: SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  broadcast: SVG('<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><path d="M5 17a8 8 0 0 1 0-10M19 7a8 8 0 0 1 0 10M8 14a4 4 0 0 1 0-4M16 10a4 4 0 0 1 0 4"/>'),
  eye: SVG('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
  flip: SVG('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  video: SVG('<rect x="1" y="5" width="15" height="14" rx="3"/><path d="M23 7l-7 5 7 5V7z"/>'),
  "video-off": SVG('<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  mic: SVG('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  sliders: SVG('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  rotate: SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  "volume-low": SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  "volume-high": SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
  "volume-off": SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
  trash: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  door: SVG('<path d="M3 21h18"/><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none"/>'),
  "mic-off": SVG('<line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
  leaf: SVG('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'),
  leave: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  battery: SVG('<rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><polyline points="11 8.5 8 12 12 12 9 15.5"/>'),
  add: SVG('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  chevron: SVG('<polyline points="9 6 15 12 9 18"/>'),
  info: SVG('<circle cx="12" cy="12" r="9.5"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>'),
  person: SVG('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
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

// Stabile Geräte-Kennung (bleibt auf diesem Gerät gleich).
const DEVICE_ID = (() => {
  let id = store.get("babyphone_device_id");
  if (!id) { id = "d" + randomId(10); store.set("babyphone_device_id", id); }
  return id;
})();

function myName() {
  const u = auth.currentUser;
  return (u && u.email) ? u.email.split("@")[0] : "Gerät";
}

// iPhone/iPad: Die Lautstärke von Medien lässt sich per Code NICHT ändern
// (nur mit den Tasten). Das prüfen wir, statt einen wirkungslosen Regler zu zeigen.
const CAN_SET_VOLUME = (() => {
  try { const a = document.createElement("audio"); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01; }
  catch (e) { return false; }
})();

/* Ton-Freischaltung: iPhone erlaubt Ton erst nach einem echten Tipp. */
let audioCtx = null;
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) { audioCtx = new Ctx(); audioCtx.onstatechange = () => voiceFallbackIfNeeded(); }
    if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    g.gain.value = 0.0001; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.05);
  } catch (e) {}
}
// Medien-Elemente im Tipp einmal "anstoßen" -> später darf das iPhone sie mit Ton abspielen.
function primeMediaElements(els) {
  els.forEach(el => { try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} });
}

/* Bildschirm wach halten */
let wakeLock = null;
async function requestWakeLock() {
  if (!session || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  if (wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
      if (session && document.visibilityState === "visible") setTimeout(requestWakeLock, 1000);
    });
  } catch (e) { log("WakeLock", e); }
}
function releaseWakeLock() {
  const lock = wakeLock; wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

/* Firestore-Pfade */
const roomRef = (room) => doc(db, "rooms", room);
const presenceCol = (room) => collection(db, "rooms", room, "presence");
const connsCol = (room) => collection(db, "rooms", room, "connections");
const connRef = (room, id) => doc(db, "rooms", room, "connections", id);

function ensureRoom(room) {
  return quiet(setDoc(roomRef(room), { name: room, lastActive: serverTimestamp() }, { merge: true }));
}

// Standard-Fernsteuerung (Werte im Raum-Dokument, Feld "control"):
function defaultControl() {
  return {
    childVideoEnabled: true,      // Kamera-Bild des Babybetts wird gesendet
    childAudioEnabled: true,      // Mikrofon des Babybetts ist an
    powerSave: false,             // Stromsparmodus: Display schwarz + weniger Bilder pro Sekunde
    quality: "medium",
    showParentVideoOnChild: true,
    childVolume: 80,              // Lautstärke der Elternstimme am Babybett (0–100)
    cameraId: "",
  };
}
// Qualität unter Berücksichtigung des Stromsparmodus.
function effectiveQuality() {
  const q = QUALITY[control.quality] || QUALITY.medium;
  if (!control.powerSave) return q;
  return { width: q.width, height: q.height, frameRate: Math.min(q.frameRate, 10), maxBitrate: Math.min(q.maxBitrate, 250000) };
}
const qualityKey = () => control.quality + (control.powerSave ? "+strom" : "");

/* ===========================================================
   5) Anmelden / Abmelden
   =========================================================== */
let session = null;     // laufendes Babyphone: { mode: "send"|"receive", room, id }
const isChild = () => !!session && session.mode === "send";
const isParent = () => !!session && session.mode === "receive";

$("login-form").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });

async function doLogin() {
  const email = $("email").value.trim();
  const pass = $("password").value;
  $("login-error").textContent = "";
  if (!email || !pass) { $("login-error").textContent = "Bitte E-Mail und Passwort eingeben."; return; }
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    $("password").value = "";
  } catch (err) {
    $("login-error").textContent = loginErrorText(err);
  } finally {
    $("login-btn").disabled = false;
  }
}
function loginErrorText(err) {
  const c = (err && err.code) || "";
  if (c === "auth/network-request-failed") return "Keine Internetverbindung. Bitte erneut versuchen.";
  if (c === "auth/too-many-requests") return "Zu viele Versuche. Bitte kurz warten.";
  if (c === "auth/invalid-email") return "Die E-Mail-Adresse ist ungültig.";
  if (c === "auth/user-disabled") return "Dieses Konto ist gesperrt.";
  if (c === "auth/operation-not-allowed") return "E-Mail-Anmeldung ist in Firebase nicht eingeschaltet.";
  return "Anmeldung fehlgeschlagen. E-Mail oder Passwort falsch?";
}

$("logout-btn").addEventListener("click", () => { quiet(signOut(auth)); });

let urlHandled = false;
onAuthStateChanged(auth, (user) => {
  if (user) {
    $("user-line").textContent = "Angemeldet als " + (user.email || "Gerät");
    startRoomList();
    if (!session) showScreen("home");
    if (!urlHandled) { urlHandled = true; handleUrlAutostart(); }
  } else {
    stopRoomList();
    stopSession();
    showScreen("login");
  }
});

/* ===========================================================
   6) Raumliste (sichtbare Räume zum Antippen)
   =========================================================== */
const roomItems = new Map();   // name -> { el, docs, unsub }
let roomListUnsub = null;
let roomListTimer = null;

function startRoomList() {
  if (roomListUnsub) return;
  roomListUnsub = onSnapshot(collection(db, "rooms"), (snap) => {
    $("room-error").classList.add("hidden");
    const names = snap.docs.map(d => d.id).sort((a, b) => a.localeCompare(b));
    // Weggefallene Räume entfernen
    for (const [name, it] of roomItems) {
      if (!names.includes(name)) { try { it.unsub(); } catch (e) {} it.el.remove(); roomItems.delete(name); }
    }
    // Neue anlegen, Reihenfolge herstellen (bestehende Einträge bleiben erhalten -> kein Flackern)
    const list = $("room-list");
    names.forEach(name => list.appendChild((roomItems.get(name) || createRoomItem(name)).el));
    $("room-empty").classList.toggle("hidden", names.length > 0);
    markSelectedRoom();
  }, (err) => {
    log("Raumliste", err);
    const el = $("room-error");
    el.textContent = err && err.code === "permission-denied"
      ? "Keine Berechtigung. Sind die Firestore-Regeln veröffentlicht?"
      : "Raumliste konnte nicht geladen werden. Neuer Versuch…";
    el.classList.remove("hidden");
    stopRoomList();
    setTimeout(() => { if (auth.currentUser) startRoomList(); }, 5000);
  });
  // Anwesenheit veraltet auch ohne neue Daten -> regelmäßig neu anzeigen
  roomListTimer = setInterval(() => roomItems.forEach(renderRoomBadge), 15000);
}
function stopRoomList() {
  if (roomListUnsub) { try { roomListUnsub(); } catch (e) {} roomListUnsub = null; }
  clearInterval(roomListTimer); roomListTimer = null;
  roomItems.forEach(it => { try { it.unsub(); } catch (e) {} it.el.remove(); });
  roomItems.clear();
}

function createRoomItem(name) {
  const el = document.createElement("div");
  el.className = "room-item settings-card";
  el.innerHTML = '<span class="card-icon" data-icon="door"></span><span class="card-text"><span class="name card-title"></span><span class="room-badge card-sub"></span></span>' +
    '<button type="button" class="del" title="Raum löschen" aria-label="Raum löschen"><span data-icon="trash"></span></button>';
  el.querySelector(".name").textContent = name;
  injectIcons(el);
  el.addEventListener("click", () => selectRoom(name));
  el.querySelector(".del").addEventListener("click", (e) => { e.stopPropagation(); deleteRoom(name); });
  const it = { name, el, docs: [], unsub: () => {} };
  it.unsub = onSnapshot(presenceCol(name), (snap) => { it.docs = snap.docs; renderRoomBadge(it); }, (err) => log("Anwesenheit", err));
  roomItems.set(name, it);
  return it;
}
function renderRoomBadge(it) {
  const c = readPresence(it.docs);
  const parts = [];
  if (c.children.length) parts.push('<span class="dot on"></span>Babybett aktiv');
  if (c.parents.length) parts.push(c.parents.length === 1 ? "1 Eltern-Gerät" : c.parents.length + " Eltern-Geräte");
  it.el.querySelector(".room-badge").innerHTML = parts.length ? parts.join(" · ") : '<span class="dot"></span>Niemand da';
}

function selectRoom(name) {
  $("room").value = name;
  store.set("babyphone_room", name);
  markSelectedRoom();
}
function markSelectedRoom() {
  const cur = cleanRoomName($("room").value);
  roomItems.forEach((it, name) => it.el.classList.toggle("selected", name === cur));
}
$("room").addEventListener("input", markSelectedRoom);

async function deleteRoom(name) {
  const it = roomItems.get(name);
  const c = readPresence(it ? it.docs : []);
  if (c.children.length || c.parents.length) {
    showAlert("Raum wird benutzt", `Im Raum „${name}“ sind gerade Geräte aktiv.\nBitte dort zuerst beenden.`);
    return;
  }
  if (!(await showConfirm("Raum löschen?", `Der Raum „${name}“ wird aus der Liste entfernt.`, "Löschen"))) return;
  try {
    const conns = await getDocs(connsCol(name));
    await Promise.all(conns.docs.map(d => deleteConnDoc(name, d.id)));
    const pres = await getDocs(presenceCol(name));
    await Promise.all(pres.docs.map(d => deleteDoc(d.ref)));
    await deleteDoc(roomRef(name));
    if (cleanRoomName($("room").value) === name) $("room").value = "";
  } catch (e) {
    log(e);
    toast("Löschen hat nicht geklappt. Internet da?");
  }
}

$("create-room-btn").addEventListener("click", () => {
  const name = cleanRoomName($("room").value);
  if (!name) { toast("Bitte zuerst einen Raumnamen eingeben."); $("room").focus(); return; }
  ensureRoom(name);
  selectRoom(name);
  toast(`Raum „${name}“ ist bereit.`);
});

function cleanRoomName(v) {
  return (v || "").trim().toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/* ===========================================================
   7) Start-Knöpfe + Lesezeichen-Links
   =========================================================== */
const savedRoom = store.get("babyphone_room");
if (savedRoom) $("room").value = savedRoom;

$("send-btn").addEventListener("click", () => startFromHome("send"));
$("receive-btn").addEventListener("click", () => startFromHome("receive"));

function startFromHome(mode) {
  const room = cleanRoomName($("room").value);
  if (!room) { toast("Bitte zuerst einen Raum antippen oder anlegen."); return; }
  $("room").value = room;
  launch(mode, room);
}

// Muss direkt im Tipp laufen: das iPhone erlaubt Ton/Kamera nur nach einem echten Tipp.
function launch(mode, room) {
  if (session) return;
  unlockAudio();
  if (mode === "receive") primeMediaElements([$("remote-audio"), $("remote-video")]);
  store.set("babyphone_room", room);
  if (mode === "send") startChild(room);
  else startParent(room);
}

let pendingStart = null;    // gemerkter Lesezeichen-Start (room + mode)
let gatePresenceUnsub = null;

function handleUrlAutostart() {
  const params = new URLSearchParams(location.search);
  const room = cleanRoomName(params.get("room") || "");
  const mode = params.get("mode");
  if (room && (mode === "send" || mode === "receive")) showStartGate(room, mode);
}

// Start-Tor: EIN bewusster Tipp (sonst blockiert das iPhone Kamera/Ton).
function showStartGate(room, mode) {
  pendingStart = { room, mode };
  $("start-gate-text").textContent = (mode === "send" ? "Senden" : "Empfangen") + " · Raum: " + room;
  $("start-gate-btn").textContent = mode === "send" ? "Senden starten" : "Empfangen starten";
  $("start-gate-presence").textContent = "";
  if (gatePresenceUnsub) { try { gatePresenceUnsub(); } catch (e) {} }
  gatePresenceUnsub = onSnapshot(presenceCol(room), (snap) => {
    const c = readPresence(snap.docs);
    const parts = [];
    if (c.children.length) parts.push("Babybett ist aktiv: " + c.children.map(x => x.name).join(", "));
    if (c.parents.length) parts.push(c.parents.map(x => x.name).join(", ") + " (Eltern)");
    $("start-gate-presence").textContent = parts.length ? parts.join("  ·  ") : "Noch niemand im Raum.";
  }, (err) => log(err));
  $("start-gate").classList.remove("hidden");
}
function hideStartGate() {
  if (gatePresenceUnsub) { try { gatePresenceUnsub(); } catch (e) {} gatePresenceUnsub = null; }
  $("start-gate").classList.add("hidden");
}
$("start-gate-btn").addEventListener("click", () => {
  if (!pendingStart) return;
  const { room, mode } = pendingStart;
  pendingStart = null;
  hideStartGate();
  $("room").value = room;
  launch(mode, room);
});
$("start-gate-home").addEventListener("click", () => {
  pendingStart = null;
  hideStartGate();
  if (location.search) history.replaceState(null, "", location.pathname);
  showScreen("home");
});

/* ===========================================================
   8) Raum-Dokument (Fernsteuerung) + Anwesenheit
   =========================================================== */
let roomData = {};               // zuletzt gelesenes Raum-Dokument
let control = defaultControl();  // aktuelle Fernsteuer-Werte
let roomUnsub = null;

function listenRoom(room, onChange) {
  stopRoomListener();
  roomUnsub = onSnapshot(roomRef(room), (snap) => {
    if (!session || session.room !== room) return;
    roomData = snap.exists() ? (snap.data() || {}) : {};
    control = { ...defaultControl(), ...(roomData.control || {}) };
    if (!QUALITY[control.quality]) control.quality = "medium";
    onChange(snap);
  }, (err) => {
    log("Raum", err);
    setTimeout(() => { if (session && session.room === room) listenRoom(room, onChange); }, 3000);
  });
}
function stopRoomListener() {
  if (roomUnsub) { try { roomUnsub(); } catch (e) {} roomUnsub = null; }
}

// Fernsteuerung ändern. Mit merge werden nur die genannten Werte geändert,
// alle anderen bleiben erhalten (früher wurde beim Betreten alles zurückgesetzt).
function setControl(patch) {
  if (!session) return;
  control = { ...control, ...patch };
  quiet(setDoc(roomRef(session.room), { control: patch }, { merge: true }));
}

const presence = { ref: null, timer: null, refresh: null, unsub: null, docs: [] };

function startPresence(room, role) {
  stopPresence(null);
  const ref = doc(db, "rooms", room, "presence", `${DEVICE_ID}_${role}`);
  presence.ref = ref;
  const beat = () => quiet(setDoc(ref, { role, name: myName(), device: DEVICE_ID, session: session ? session.id : "", updatedAt: serverTimestamp() }));
  beat();
  presence.timer = setInterval(beat, PRESENCE_BEAT_MS);
  presence.unsub = onSnapshot(presenceCol(room), (snap) => {
    presence.docs = snap.docs;
    cleanupOldPresence(snap.docs);
    onPresenceChange();
  }, (err) => log("Anwesenheit", err));
  presence.refresh = setInterval(onPresenceChange, 10000);
}
function stopPresence(room) {
  clearInterval(presence.timer); clearInterval(presence.refresh);
  presence.timer = presence.refresh = null;
  if (presence.unsub) { try { presence.unsub(); } catch (e) {} presence.unsub = null; }
  if (room && presence.ref) quiet(deleteDoc(presence.ref));
  presence.ref = null;
  presence.docs = [];
}
function cleanupOldPresence(docs) {
  const now = Date.now();
  docs.forEach(d => {
    const data = d.data({ serverTimestamps: "estimate" }) || {};
    const ts = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : now;
    if (now - ts > PRESENCE_DELETE_MS) quiet(deleteDoc(d.ref));
  });
}

// Frische Anwesenheits-Einträge nach Rolle sammeln.
function readPresence(docs) {
  const now = Date.now();
  const children = [], parents = [];
  (docs || []).forEach(d => {
    const data = d.data({ serverTimestamps: "estimate" }) || {};
    const ts = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : now;
    if (now - ts > PRESENCE_FRESH_MS) return;       // veraltet -> ignorieren
    const e = { name: data.name || "Gerät", device: data.device || "", session: data.session || "" };
    if (data.role === "send") children.push(e);
    else if (data.role === "receive") parents.push(e);
  });
  return { children, parents };
}
function senderOnline() { return readPresence(presence.docs).children.length > 0; }

async function findOtherSender(room) {
  const snap = await withTimeout(getDocs(presenceCol(room)), 3000, null);
  if (!snap) return null;
  const other = readPresence(snap.docs).children.find(c => c.device !== DEVICE_ID);
  return other ? other.name : null;
}

function onPresenceChange() {
  if (isParent()) {
    updateParentPresenceUI();
    updateParentWaiting();
    syncRemoteControlsUI();
  }
}

/* ===========================================================
   9) WebRTC-Werkzeuge
   =========================================================== */
// "p" ist ein Objekt mit { pc, pending, remoteSet }. Kandidaten, die vor der
// Gegenseiten-Beschreibung ankommen, werden gesammelt und später eingespielt.
function addCandidate(p, cand) {
  if (!p.pc) return;
  if (!p.remoteSet) { p.pending.push(cand); return; }
  p.pc.addIceCandidate(cand).catch(e => log("ICE", e));
}
async function flushCandidates(p) {
  const pc = p.pc;
  p.remoteSet = true;
  const list = p.pending; p.pending = [];
  for (const c of list) { try { await pc.addIceCandidate(c); } catch (e) { log("ICE", e); } }
}
function candidateData(c) {
  const j = c.toJSON ? c.toJSON() : c;
  return {
    candidate: j.candidate || "",
    sdpMid: j.sdpMid === undefined ? null : j.sdpMid,
    sdpMLineIndex: j.sdpMLineIndex === undefined ? null : j.sdpMLineIndex,
    usernameFragment: j.usernameFragment === undefined ? null : j.usernameFragment,
  };
}
function closePc(pc) {
  if (!pc) return;
  pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null;
  try { pc.close(); } catch (e) {}
}
// Sender für eine Spur-Art (audio/video) finden.
function senderOf(pc, kind) {
  if (!pc) return null;
  const tx = pc.getTransceivers().find(t => !t.stopped && t.receiver && t.receiver.track && t.receiver.track.kind === kind);
  return tx ? tx.sender : null;
}
async function deleteConnDoc(room, id) {
  const ref = connRef(room, id);
  try {
    const batch = writeBatch(db);
    for (const sub of ["callerCandidates", "calleeCandidates"]) {
      const snap = await getDocs(collection(ref, sub));
      snap.forEach(d => batch.delete(d.ref));
    }
    batch.delete(ref);
    await batch.commit();
  } catch (e) {
    log("Aufräumen", e);
    quiet(deleteDoc(ref));
  }
}

/* ===========================================================
   10) KIND-GERÄT (Babybett) – sendet Ton + Video
   =========================================================== */
const child = {
  stream: null, audio: null, video: null, hasVideo: false,
  cameraId: "", facing: "environment",
  cameras: [], camerasKey: "",
  peers: new Map(),            // connId -> Verbindung zu einem Eltern-Gerät
  connUnsub: null,
  queue: Promise.resolve(),    // Kamera/Steuerung nacheinander abarbeiten (nie parallel)
  applied: { videoOn: null, quality: null },
  cameraAttempt: null, cameraError: false,
  stateKey: "",
  micRetry: null,
};

function childEnqueue(fn) {
  child.queue = child.queue.then(() => (isChild() ? fn() : null)).catch(e => log(e));
  return child.queue;
}
function videoSendTrack() { return (control.childVideoEnabled && child.video) ? child.video : null; }
// Video für ein bestimmtes Eltern-Gerät (im Akku-Sparmodus der Eltern: keins).
function peerVideoTrack(p) { return p.wantVideo === false ? null : videoSendTrack(); }

async function startChild(room) {
  const my = session = { mode: "send", room, id: "s" + randomId(10) };
  requestWakeLock();
  roomData = {};
  Object.assign(child, { cameraAttempt: null, cameraError: false, stateKey: "", camerasKey: "", applied: { videoOn: null, quality: null } });
  showScreen("child");
  setRoomLabels(room);
  setStatus("child-status", "Kamera wird gestartet…", "connecting");

  // Sendet in diesem Raum schon ein anderes Gerät?
  const other = await findOtherSender(room);
  if (session !== my) return;
  if (other && !(await showConfirm("Babybett übernehmen?", `In diesem Raum sendet schon „${other}“.\nSoll dieses Gerät übernehmen? Das andere hört dann auf zu senden.`, "Übernehmen", false))) {
    stopSession(); showScreen("home"); return;
  }

  // Gespeicherte Fernsteuer-Werte laden (Qualität, Kamera, Video an/aus).
  const snap = await withTimeout(getDoc(roomRef(room)), 4000, null);
  if (session !== my) return;
  const data = (snap && snap.exists()) ? (snap.data() || {}) : {};
  control = { ...defaultControl(), ...(data.control || {}) };
  if (!QUALITY[control.quality]) control.quality = "medium";

  const stream = await openChildMedia();
  if (session !== my) { stopStream(stream); return; }
  if (!stream) { stopSession(); showScreen("home"); return; }
  setChildStream(stream);
  child.applied = { videoOn: control.childVideoEnabled, quality: qualityKey() };

  quiet(setDoc(roomRef(room), {
    name: room, lastActive: serverTimestamp(),
    sender: { session: my.id, device: DEVICE_ID, name: myName(), since: serverTimestamp() },
  }, { merge: true }));
  await refreshCameraList();
  if (session !== my) return;

  listenRoom(room, onChildRoom);
  startPresence(room, "send");
  updateChildUI();
  publishChildState();
  if (!("wakeLock" in navigator)) toast("Achtung: Dieses Gerät kann das Display nicht wach halten. Bitte die automatische Sperre ausschalten.", 8000);

  updateChildStatus();
  child.connUnsub = listenConnections(room);
}

async function openChildMedia() {
  const q = effectiveQuality();
  const size = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } };
  const tries = [];
  if (control.cameraId) tries.push({ audio: AUDIO_CONSTRAINTS, video: { deviceId: { exact: control.cameraId }, ...size } });
  tries.push({ audio: AUDIO_CONSTRAINTS, video: { facingMode: { ideal: child.facing }, ...size } });
  tries.push({ audio: AUDIO_CONSTRAINTS, video: true });
  let lastErr = null, denied = false;
  for (const c of tries) {
    try { return await getMedia(c); }
    catch (e) {
      lastErr = e; log("Kamera/Mikro", e);
      if (e.name === "NotAllowedError" || e.name === "SecurityError" || e.name === "NotSupportedError") { denied = e.name !== "NotSupportedError"; break; }
    }
  }
  // Ohne Kamera wenigstens den Ton senden (das Wichtigste beim Babyphone).
  if (!lastErr || lastErr.name !== "NotSupportedError") {
    try {
      const s = await getMedia({ audio: AUDIO_CONSTRAINTS });
      toast("Kamera nicht verfügbar – es wird nur Ton gesendet.", 6000);
      return s;
    } catch (e) { lastErr = e; if (e.name === "NotAllowedError") denied = true; }
  }
  showAlert(denied ? "Kein Zugriff" : "Kamera/Mikrofon geht nicht", denied
    ? "Kein Zugriff auf Kamera/Mikrofon.\nBitte erlauben (iPhone: Einstellungen → Safari → Kamera bzw. Mikrofon → Erlauben) und dann erneut SENDEN tippen."
    : "Kamera/Mikrofon konnte nicht gestartet werden.\n(" + ((lastErr && (lastErr.message || lastErr.name)) || "Fehler") + ")");
  return null;
}

function setChildStream(stream) {
  child.stream = stream;
  child.audio = stream.getAudioTracks()[0] || null;
  child.video = stream.getVideoTracks()[0] || null;
  child.hasVideo = !!child.video;
  if (child.audio) child.audio.enabled = control.childAudioEnabled !== false;
  child.cameraId = "";
  if (child.video) {
    const s = child.video.getSettings();
    child.cameraId = s.deviceId || "";
    if (s.facingMode) child.facing = s.facingMode;
  }
  watchChildTrack(child.audio);
  watchChildTrack(child.video);
  showLocalPreview();
}
function showLocalPreview() {
  const v = $("local-video");
  v.srcObject = null;
  v.srcObject = child.stream;
  v.play().catch(() => {});
}
// Endet eine Spur unerwartet (z.B. Anruf, iPhone im Hintergrund), wird sie neu gestartet.
function watchChildTrack(track) {
  if (!track) return;
  track.onended = () => {
    if (isChild() && (track === child.audio || track === child.video)) childEnqueue(recoverChildMedia);
  };
}

// Eine Spur austauschen – lokal und in allen laufenden Verbindungen (ohne Neuverhandlung).
async function swapChildTrack(kind, track) {
  const old = kind === "audio" ? child.audio : child.video;
  if (old && old !== track) {
    old.onended = null;
    try { child.stream.removeTrack(old); } catch (e) {}
    try { old.stop(); } catch (e) {}
  }
  if (track) { child.stream.addTrack(track); watchChildTrack(track); }
  if (track && kind === "audio") track.enabled = control.childAudioEnabled !== false;
  if (kind === "audio") child.audio = track;
  else { child.video = track; child.hasVideo = !!track; }
  for (const p of child.peers.values()) {
    const s = senderOf(p.pc, kind);
    if (s) await quiet(s.replaceTrack(kind === "video" ? peerVideoTrack(p) : track));
  }
  if (kind === "video") showLocalPreview();
}

async function recoverChildMedia() {
  if (!isChild() || !child.stream) return;
  if (!child.audio || child.audio.readyState === "ended") {
    try {
      const s = await getMedia({ audio: AUDIO_CONSTRAINTS });
      if (!isChild()) { stopStream(s); return; }
      await swapChildTrack("audio", s.getAudioTracks()[0]);
      toast("Mikrofon läuft wieder.");
    } catch (e) {
      log("Mikro neu starten", e);
      setStatus("child-status", "Mikrofon unterbrochen!", "warning");
      // Im Vordergrund nach kurzer Zeit erneut versuchen (z.B. nach einem Anruf).
      clearTimeout(child.micRetry);
      child.micRetry = setTimeout(() => {
        if (isChild() && document.visibilityState === "visible") childEnqueue(recoverChildMedia);
      }, 10000);
      return;
    }
  }
  if (child.video && child.video.readyState === "ended") {
    await switchCamera(child.cameraId ? { deviceId: child.cameraId } : { facing: child.facing }, false);
  }
  updateChildStatus();
}

// Kamera wechseln. target = { deviceId } oder { facing: "user"|"environment" }.
// local = true, wenn am Kind-Gerät selbst gewählt (dann auch in die Fernsteuerung schreiben).
async function switchCamera(target, local) {
  if (!isChild() || !child.stream) return false;
  const q = effectiveQuality();
  const size = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } };
  const prevId = child.cameraId, prevFacing = child.facing;

  // Alte Kamera zuerst freigeben – viele Android-Handys können nur eine Kamera gleichzeitig öffnen.
  if (child.video) {
    const old = child.video;
    old.onended = null;
    try { child.stream.removeTrack(old); } catch (e) {}
    try { old.stop(); } catch (e) {}
    child.video = null;
  }

  const tries = [];
  if (target.deviceId) tries.push({ deviceId: { exact: target.deviceId }, ...size });
  if (target.facing) tries.push({ facingMode: { exact: target.facing }, ...size });
  if (prevId) tries.push({ deviceId: { exact: prevId }, ...size });   // zurück zur alten
  tries.push({ facingMode: { ideal: prevFacing }, ...size });
  tries.push(true);

  let track = null;
  for (const c of tries) {
    try {
      const s = await getMedia({ video: c });
      track = s.getVideoTracks()[0] || null;
      if (track) break;
    } catch (e) { log("Kamera", e); }
  }
  if (!isChild()) { if (track) track.stop(); return false; }

  await swapChildTrack("video", track);
  let ok = false;
  if (track) {
    const s = track.getSettings();
    child.cameraId = s.deviceId || "";
    if (s.facingMode) child.facing = s.facingMode;
    ok = target.deviceId ? child.cameraId === target.deviceId
       : (s.facingMode ? s.facingMode === target.facing : child.cameraId !== prevId);
  } else {
    child.cameraId = "";
  }
  child.cameraError = !ok;
  await refreshCameraList();
  if (local && child.cameraId) { child.cameraAttempt = null; setControl({ cameraId: child.cameraId }); }
  updateChildUI();
  publishChildState();
  if (!track) toast("Kamera konnte nicht gestartet werden – es wird nur Ton gesendet.", 5000);
  else if (!ok) toast(target.facing ? "Keine andere Kamera gefunden." : "Diese Kamera ließ sich nicht öffnen.");
  return ok;
}

/* Kamera-Liste (auch alle iPhone-Kameras) füllen + an die Eltern melden */
async function refreshCameraList() {
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput"); }
  catch (e) { log(e); }
  child.cameras = devs.filter(d => d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `Kamera ${i + 1}` }));
  const sel = $("child-camera-select");
  sel.innerHTML = "";
  if (!child.cameras.length) sel.appendChild(new Option("Keine Kamera gefunden", ""));
  child.cameras.forEach(c => sel.appendChild(new Option(c.label, c.id)));
  sel.value = child.cameraId || "";
  const key = JSON.stringify(child.cameras);
  if (isChild() && key !== child.camerasKey) {
    child.camerasKey = key;
    quiet(setDoc(roomRef(session.room), { cameras: child.cameras }, { merge: true }));
  }
}

$("child-camera-select").addEventListener("change", (e) => {
  const id = e.target.value;
  if (isChild() && id && id !== child.cameraId) childEnqueue(() => switchCamera({ deviceId: id }, true));
});
$("child-cam-btn").addEventListener("click", () => {
  if (!isChild()) return;
  childEnqueue(() => switchCamera({ facing: child.facing === "user" ? "environment" : "user" }, true));
});
$("child-video-toggle").addEventListener("click", () => {
  if (!isChild()) return;
  if (!child.hasVideo) { toast("Keine Kamera aktiv – es wird nur Ton gesendet."); return; }
  setControl({ childVideoEnabled: !control.childVideoEnabled });
  childEnqueue(applyControlOnChild);
});
$("child-quality-select").addEventListener("change", (e) => {
  if (!isChild()) return;
  setControl({ quality: e.target.value });
  childEnqueue(applyControlOnChild);
});

// Display aus (schwarzer Vorhang, alles läuft weiter)
// Stromsparmodus (auch von den Eltern fernsteuerbar). Antippen des schwarzen Bildschirms beendet ihn.
$("screen-off-btn").addEventListener("click", () => {
  if (!isChild()) return;
  setControl({ powerSave: true });
  childEnqueue(applyControlOnChild);
});
$("screen-off-curtain").addEventListener("click", () => {
  if (!isChild()) return;
  setControl({ powerSave: false });
  childEnqueue(applyControlOnChild);
});
$("child-mic-toggle").addEventListener("click", () => {
  if (!isChild()) return;
  setControl({ childAudioEnabled: control.childAudioEnabled === false });
  childEnqueue(applyControlOnChild);
});

function onChildRoom(snap) {
  if (!isChild()) return;
  if (!snap.exists()) {
    // Raum-Dokument fehlt (z.B. in der Konsole gelöscht) -> wieder eintragen.
    child.camerasKey = ""; child.stateKey = "";
    quiet(setDoc(roomRef(session.room), {
      name: session.room, lastActive: serverTimestamp(), cameras: child.cameras,
      sender: { session: session.id, device: DEVICE_ID, name: myName(), since: serverTimestamp() },
    }, { merge: true }));
    return;
  }
  const snd = roomData.sender;
  if (snd && snd.session && snd.session !== session.id) {
    // Ein anderes Gerät hat das Senden übernommen.
    const who = snd.name || "ein anderes Gerät";
    stopSession();
    showScreen("home");
    showAlert("Senden beendet", `In diesem Raum sendet jetzt „${who}“.\nDieses Gerät hat das Senden beendet.`);
    return;
  }
  childEnqueue(applyControlOnChild);
}
function isCurrentSender() {
  const snd = roomData.sender;
  return !snd || !snd.session || snd.session === session.id;
}

/* Fernsteuerung auf dem Kind-Gerät anwenden – nur was sich wirklich geändert hat. */
async function applyControlOnChild() {
  if (!isChild() || !child.stream) return;
  // 1) Kamera (von den Eltern gewählt). Jede Wahl wird nur EINMAL versucht -> keine Endlosschleife.
  const want = control.cameraId;
  if (want && want !== child.cameraId && want !== child.cameraAttempt && child.cameras.some(c => c.id === want)) {
    child.cameraAttempt = want;
    await switchCamera({ deviceId: want }, false);
    if (!isChild()) return;
  }
  // 2) Video an/aus
  if (child.applied.videoOn !== control.childVideoEnabled) {
    child.applied.videoOn = control.childVideoEnabled;
    for (const p of child.peers.values()) {
      const s = senderOf(p.pc, "video");
      if (s) await quiet(s.replaceTrack(peerVideoTrack(p)));
    }
  }
  // 3) Mikrofon an/aus. "enabled = false" sendet Stille weiter -> die Verbindung bleibt stabil.
  if (child.audio) child.audio.enabled = control.childAudioEnabled !== false;
  // 4) Qualität + Stromsparmodus (Kamera-Auflösung, Bilder pro Sekunde, maximale Datenrate)
  if (child.applied.quality !== qualityKey()) {
    child.applied.quality = qualityKey();
    const q = effectiveQuality();
    if (child.video) await quiet(child.video.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } }));
    for (const p of child.peers.values()) await applySenderQuality(p.pc);
  }
  updateChildUI();
  updateParentStage();
  publishChildState();
}

async function applySenderQuality(pc) {
  const q = effectiveQuality();
  const s = senderOf(pc, "video");
  if (!s || !s.getParameters || !s.setParameters) return;
  try {
    const params = s.getParameters();
    if (!params.encodings || !params.encodings.length) return;
    params.encodings.forEach(e => { e.maxBitrate = q.maxBitrate; });
    await s.setParameters(params);
  } catch (e) { log("Datenrate", e); }
}

// Dem Eltern-Gerät melden, was das Kind-Gerät gerade WIRKLICH tut.
function publishChildState() {
  if (!isChild()) return;
  const st = {
    session: session.id,
    cameraId: child.cameraId || "",
    cameraError: !!child.cameraError,
    hasVideo: !!child.hasVideo,
    videoOn: !!(child.hasVideo && control.childVideoEnabled),
    audioOn: !!(child.audio && control.childAudioEnabled !== false),
    powerSave: !!control.powerSave,
    quality: control.quality,
    childVolume: control.childVolume,
  };
  const key = JSON.stringify(st);
  if (key === child.stateKey) return;
  child.stateKey = key;
  quiet(setDoc(roomRef(session.room), { childState: { ...st, updatedAt: serverTimestamp() } }, { merge: true }));
}

function updateChildUI() {
  if (!isChild()) return;
  const on = control.childVideoEnabled && child.hasVideo;
  const btn = $("child-video-toggle");
  btn.classList.toggle("active", on);
  btn.querySelector(".lbl").textContent = on ? "Video an" : "Video aus";
  const mic = $("child-mic-toggle");
  mic.classList.toggle("active", control.childAudioEnabled !== false);
  mic.querySelector(".lbl").textContent = control.childAudioEnabled !== false ? "Mikro an" : "Mikro aus";
  mic.querySelector(".ic").innerHTML = control.childAudioEnabled !== false ? ICON.mic : ICON["mic-off"];
  $("screen-off-btn").classList.toggle("active", !!control.powerSave);
  $("child-quality-select").value = control.quality;
  const sel = $("child-camera-select");
  if (child.cameraId && document.activeElement !== sel) sel.value = child.cameraId;
  const videoOff = !child.hasVideo || !control.childVideoEnabled;
  const micOff = control.childAudioEnabled === false;
  const info = videoOff && micOff ? "Video aus · Mikro aus"
    : !child.hasVideo ? "Keine Kamera – nur Ton"
    : videoOff ? "Video aus – Eltern hören nur Ton"
    : micOff ? "Mikro aus – Eltern hören nichts" : "";
  $("child-info").textContent = info;
  $("child-info").classList.toggle("hidden", !info);
}

function updateChildStatus() {
  if (!isChild()) return;
  if (!child.audio || child.audio.readyState === "ended") { setStatus("child-status", "Mikrofon unterbrochen!", "warning"); return; }
  const peers = [...child.peers.values()];
  const conn = peers.filter(p => p.pc.connectionState === "connected");
  if (conn.length) {
    const names = [...new Set(conn.map(p => p.name))].join(", ");
    setStatus("child-status", "Verbunden mit " + names, "connected");
  } else if (peers.length) {
    setStatus("child-status", "Eltern verbinden sich…", "connecting");
  } else {
    setStatus("child-status", "Bereit – warte auf Eltern…", "connecting");
  }
}

/* ----- Verbindungen zu den Eltern ----- */
function listenConnections(room) {
  return onSnapshot(connsCol(room), (snap) => {
    if (!isChild() || session.room !== room) return;
    snap.docChanges().forEach(handleConnChange);
  }, (err) => {
    log("Verbindungen", err);
    setTimeout(() => {
      if (isChild() && session.room === room) child.connUnsub = listenConnections(room);
    }, 3000);
  });
}

function handleConnChange(ch) {
  const id = ch.doc.id;
  if (ch.type === "removed") { closeChildPeer(id, null); return; }
  const data = ch.doc.data() || {};
  const p = child.peers.get(id);
  if (p) { onPeerDoc(p, data); return; }
  if (data.role !== "parent") return;
  if (!data.offer) {
    if (isCurrentSender()) createChildPeer(id, data);
    return;
  }
  // Angebot vorhanden, aber nicht von dieser Sitzung -> veraltet (z.B. nach Neustart).
  // Löschen: Die Eltern merken das sofort und bauen neu auf.
  quiet(deleteConnDoc(session.room, id));
}

async function createChildPeer(id, data) {
  if (!child.stream) return;
  const room = session.room;
  const ref = connRef(room, id);
  const pc = new RTCPeerConnection(rtcConfig());
  const p = {
    id, ref, pc, pending: [], remoteSet: false, offered: false, answered: false, closed: false,
    name: data.name || "Eltern", talk: !!data.talk, video: !!data.video, wantVideo: data.wantVideo !== false,
    audioEl: null, tile: null, blocked: false, timer: null, unsubs: [],
  };
  child.peers.set(id, p);

  try {
    // Zwei Zwei-Wege-Kanäle: Video und Audio. So können die Eltern später
    // sprechen/Video zeigen, ohne dass neu verhandelt werden muss.
    pc.addTransceiver(peerVideoTrack(p) || "video", { direction: "sendrecv", streams: [child.stream] });
    pc.addTransceiver(child.audio || "audio", { direction: "sendrecv", streams: [child.stream] });

    pc.ontrack = (e) => attachParentTrack(p, e.track);
    pc.onicecandidate = (e) => {
      if (e.candidate && !p.closed) quiet(setDoc(doc(collection(ref, "callerCandidates")), candidateData(e.candidate)));
    };
    pc.onconnectionstatechange = () => {
      if (p.closed) return;
      const st = pc.connectionState;
      if (st === "connected") { clearTimeout(p.timer); p.timer = null; applySenderQuality(pc); }
      if (st === "failed") { closeChildPeer(id, room); return; }
      // Abgerissen (z.B. Eltern-Handy neu geladen): nach kurzer Zeit aufräumen.
      // Lebt das Eltern-Gerät noch, baut es von sich aus eine neue Verbindung auf.
      if (st === "disconnected") {
        clearTimeout(p.timer);
        p.timer = setTimeout(() => {
          if (!p.closed && pc.connectionState !== "connected") closeChildPeer(id, room);
        }, CHILD_DISCONNECT_CLEANUP_MS);
      }
      updateChildStatus();
    };
    p.unsubs.push(onSnapshot(collection(ref, "calleeCandidates"), (snap) => {
      snap.docChanges().forEach(c => { if (c.type === "added") addCandidate(p, c.doc.data()); });
    }, (err) => log("ICE", err)));
    // Kommt keine Verbindung zustande: aufräumen. Die Eltern versuchen es dann neu.
    p.timer = setTimeout(() => {
      if (!p.closed && pc.connectionState !== "connected") closeChildPeer(id, room);
    }, CHILD_PEER_TIMEOUT_MS);

    const offer = await pc.createOffer();
    if (p.closed) return;
    await pc.setLocalDescription(offer);
    if (p.closed) return;
    p.offered = true;
    // updateDoc (statt setDoc): schlägt fehl, wenn die Eltern das Dokument schon gelöscht haben.
    await updateDoc(ref, { offer: { type: offer.type, sdp: offer.sdp }, offerSession: session.id, senderName: myName() });
  } catch (e) {
    log("Angebot", e);
    // Dokument löschen -> die Eltern merken es sofort und versuchen es neu.
    closeChildPeer(id, room);
  }
  updateChildStatus();
}

function onPeerDoc(p, data) {
  if (data.answer && p.offered && !p.answered) {
    p.answered = true;
    p.pc.setRemoteDescription(data.answer)
      .then(() => flushCandidates(p))
      .catch(e => { log("Antwort", e); if (session) closeChildPeer(p.id, session.room); });
  }
  const wantVideo = data.wantVideo !== false;
  if (wantVideo !== p.wantVideo) {
    p.wantVideo = wantVideo;
    const s = senderOf(p.pc, "video");
    if (s) quiet(s.replaceTrack(peerVideoTrack(p)));
  }
  const talk = !!data.talk, video = !!data.video, name = data.name || "Eltern";
  if (talk !== p.talk || video !== p.video || name !== p.name) {
    p.talk = talk; p.video = video; p.name = name;
    if (talk) playParentAudio(p);
    updateParentStage();
    updateChildStatus();
  }
}

function closeChildPeer(id, deleteFromRoom) {
  const p = child.peers.get(id);
  if (!p) return;
  p.closed = true;
  child.peers.delete(id);
  clearTimeout(p.timer);
  p.unsubs.forEach(u => { try { u(); } catch (e) {} });
  closePc(p.pc);
  if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
  if (p.tile) { p.tile.srcObject = null; p.tile.remove(); }
  if (deleteFromRoom) quiet(deleteConnDoc(deleteFromRoom, id));
  updateParentStage();
  updateChildStatus();
}

/* ===== Eltern-Medien auf dem Kind-Gerät =====
   Pro Eltern-Gerät ein eigenes Audio-Element (mehrere Stimmen in EINEM
   Element spielen manche Browser nicht ab) und eine eigene Video-Kachel. */
function attachParentTrack(p, track) {
  if (p.closed) return;
  if (track.kind === "audio") {
    if (!p.audioEl) {
      const a = document.createElement("audio");
      a.autoplay = true;
      a.setAttribute("playsinline", "");
      $("parent-audios").appendChild(a);
      p.audioEl = a;
    }
    p.audioEl.srcObject = new MediaStream([track]);
    playParentAudio(p);
  } else {
    if (!p.tile) {
      const v = document.createElement("video");
      v.className = "parent-tile empty";
      v.autoplay = true; v.muted = true; v.playsInline = true;
      v.setAttribute("playsinline", "");
      $("parent-stage").appendChild(v);
      p.tile = v;
    }
    p.tile.srcObject = new MediaStream([track]);
    p.tile.play().catch(() => {});
  }
  updateParentStage();
}
function playParentAudio(p) {
  const a = p.audioEl;
  if (!a || !a.srcObject) return;
  a.muted = false;
  const pr = a.play();
  if (pr && pr.then) {
    pr.then(() => { p.blocked = false; updateParentStage(); })
      .catch(e => { if (e && e.name === "NotAllowedError") { p.blocked = true; updateParentStage(); } });
  }
}
// Bühne zeichnen: jedes Eltern-Gerät mit aktivem Video bekommt eine Kachel (Splitscreen).
function updateParentStage() {
  if (!isChild()) return;
  const stage = $("parent-stage");
  let shown = 0;
  const talkers = [];
  let blocked = false;
  child.peers.forEach(p => {
    const vis = !!(control.showParentVideoOnChild && p.video && p.tile);
    if (p.tile) p.tile.classList.toggle("empty", !vis);
    if (vis) shown++;
    if (p.talk) { talkers.push(p.name); if (p.blocked) blocked = true; }
  });
  stage.className = "parent-stage" + (shown ? " tiles-" + Math.min(shown, 4) : " hidden");
  const names = [...new Set(talkers)];
  $("parent-talking-text").textContent = names.length ? names.join(", ") + (names.length > 1 ? " sprechen…" : " spricht…") : "";
  $("parent-talking").classList.toggle("hidden", !talkers.length);
  $("child-unmute").classList.toggle("hidden", !blocked);
  // Stromsparmodus: schwarzer Bildschirm – außer die Eltern zeigen gerade ihr Video.
  $("screen-off-curtain").classList.toggle("hidden", !(control.powerSave && shown === 0));
}
// Tippen auf den Hinweis schaltet den Ton frei.
$("child-unmute").addEventListener("click", () => {
  unlockAudio();
  child.peers.forEach(p => playParentAudio(p));
  $("child-unmute").classList.add("hidden");
});

/* ===========================================================
   11) ELTERN-GERÄT – empfängt; kann sprechen + eigenes Video
   =========================================================== */
const par = {
  pc: null, ref: null, connId: null, unsubs: [],
  pending: [], remoteSet: false, offerHandled: false, seenDoc: false, createdAt: 0,
  connected: false, everConnected: false, attempt: 0,
  timers: { reconnect: null, grace: null, connect: null, offer: null, stats: null },
  stats: { bytes: -1, audioBytes: -1, stall: 0, audioStall: 0, sawBytes: false, sawAudio: false, energy: null, dur: null },
  noAudio: false,
  mic: null, cam: null, talkTrack: null, voice: null, talkOn: false, videoOn: false, busyTalk: false, busyVideo: false,
  rotation: 0, muted: false,
  eco: false, videoFrozen: false,
};

function startParent(room) {
  session = { mode: "receive", room, id: "s" + randomId(10) };
  requestWakeLock();
  roomData = {};
  control = defaultControl();
  Object.assign(par, { attempt: 0, everConnected: false, connected: false, noAudio: false, muted: false });
  showScreen("parent");
  setRoomLabels(room);
  par.rotation = Number(store.get("babyphone_rot_" + room)) || 0;
  par.eco = store.get("babyphone_parent_eco") === "1";
  par.videoFrozen = false;
  updateEcoUI();
  applyRotation();
  initVolumeUI();
  updateTalkUI();
  updateParentVideoUI();
  showPlaceholder(true);
  ensureRoom(room);
  listenRoom(room, onParentRoom);
  startPresence(room, "receive");
  connectParent();
}

function connectParent() {
  if (!isParent()) return;
  const room = session.room;
  teardownParentConn(room);
  const pc = new RTCPeerConnection(rtcConfig());
  const ref = doc(connsCol(room));
  Object.assign(par, {
    pc, ref, connId: ref.id, pending: [], remoteSet: false,
    offerHandled: false, seenDoc: false, createdAt: Date.now(), connected: false,
  });

  pc.ontrack = (e) => { if (pc === par.pc) onParentTrack(e); };
  pc.onconnectionstatechange = () => { if (pc === par.pc) onParentPcState(); };
  pc.onicecandidate = (e) => {
    if (e.candidate && pc === par.pc) quiet(setDoc(doc(collection(ref, "calleeCandidates")), candidateData(e.candidate)));
  };

  quiet(setDoc(ref, {
    role: "parent", device: DEVICE_ID, session: session.id, name: myName(),
    talk: par.talkOn, video: par.videoOn, wantVideo: !par.eco, createdAt: serverTimestamp(),
  }));
  par.unsubs.push(onSnapshot(ref, (snap) => onParentConnDoc(pc, snap), (err) => {
    log("Verbindung", err);
    if (pc === par.pc) scheduleReconnect(1000);
  }));
  par.unsubs.push(onSnapshot(collection(ref, "callerCandidates"), (snap) => {
    if (pc !== par.pc) return;
    snap.docChanges().forEach(c => { if (c.type === "added") addCandidate(par, c.doc.data()); });
  }, (err) => log("ICE", err)));
  par.timers.offer = setInterval(checkOfferWait, 3000);
  updateParentWaiting();
}

function teardownParentConn(room) {
  const t = par.timers;
  clearTimeout(t.reconnect); t.reconnect = null;
  clearTimeout(t.grace); clearTimeout(t.connect); clearInterval(t.offer);
  stopStatsWatch();
  par.unsubs.forEach(u => { try { u(); } catch (e) {} });
  par.unsubs = [];
  if (par.connId && room) quiet(deleteConnDoc(room, par.connId));
  closePc(par.pc);
  par.pc = null; par.ref = null; par.connId = null; par.connected = false;
}

// Babybett ist da, schickt aber kein Angebot -> Dokument neu anlegen.
function checkOfferWait() {
  if (!isParent() || !par.pc || par.offerHandled || par.timers.reconnect) return;
  if (senderOnline() && Date.now() - par.createdAt > PARENT_OFFER_WAIT_MS) scheduleReconnect(0);
}

function onParentConnDoc(pc, snap) {
  if (pc !== par.pc) return;
  if (!snap.exists()) {
    // Das Kind hat unser Dokument gelöscht (z.B. Babybett neu gestartet) -> neu verbinden.
    if (par.seenDoc) scheduleReconnect(0);
    return;
  }
  par.seenDoc = true;
  const data = snap.data() || {};
  if (data.offer && !par.offerHandled) {
    par.offerHandled = true;
    handleOffer(pc, data.offer);
  }
}

async function handleOffer(pc, offer) {
  try {
    await pc.setRemoteDescription(offer);
    if (pc !== par.pc) return;
    await flushCandidates(par);
    // Beide Kanäle auf "senden+empfangen", damit wir sprechen / Video zeigen können.
    pc.getTransceivers().forEach(t => { try { t.direction = "sendrecv"; } catch (e) {} });
    await attachParentSendTracks(pc);
    const answer = await pc.createAnswer();
    if (pc !== par.pc) return;
    await pc.setLocalDescription(answer);
    if (pc !== par.pc) return;
    quiet(updateDoc(par.ref, { answer: { type: answer.type, sdp: answer.sdp } }));
    setStatus("parent-status", "Verbinde…", "connecting");
    clearTimeout(par.timers.connect);
    par.timers.connect = setTimeout(() => {
      if (pc === par.pc && pc.connectionState !== "connected") scheduleReconnect(0);
    }, PARENT_CONNECT_TIMEOUT_MS);
  } catch (e) {
    log("Angebot annehmen", e);
    if (pc === par.pc) scheduleReconnect(1000);
  }
}

function onParentTrack(e) {
  const t = e.track;
  if (t.kind === "video") {
    const v = $("remote-video");
    v.srcObject = new MediaStream([t]);
    v.play().catch(() => {});
  } else {
    $("remote-audio").srcObject = new MediaStream([t]);
    playRemoteAudio();
  }
}

function onParentPcState() {
  const st = par.pc.connectionState;
  if (st === "connected") {
    clearTimeout(par.timers.grace); clearTimeout(par.timers.connect);
    par.connected = true; par.everConnected = true; par.attempt = 0;
    setStatus("parent-status", "Verbunden", "connected");
    showPlaceholder(false);
    startStatsWatch();
    playRemoteAudio();
    $("remote-video").play().catch(() => {});
  } else {
    par.connected = false;
    stopStatsWatch();
    if (st === "disconnected") {
      setStatus("parent-status", "Verbindung gestört – warte…", "disconnected");
      showPlaceholder(true);
      clearTimeout(par.timers.grace);
      par.timers.grace = setTimeout(() => {
        if (isParent() && par.pc && par.pc.connectionState !== "connected") scheduleReconnect(0);
      }, DISCONNECT_GRACE_MS);
    } else if (st === "failed") {
      scheduleReconnect(0);
    }
  }
  updateVideoOff();
}

// Neu verbinden – mit wachsender Pause bei wiederholten Fehlern (0,3 s … 6 s).
function scheduleReconnect(minDelay) {
  if (!isParent() || par.timers.reconnect) return;
  const backoff = par.attempt === 0 ? 300 : Math.min(1000 * Math.pow(2, par.attempt - 1), 6000);
  par.attempt++;
  par.connected = false;
  stopStatsWatch();
  par.timers.reconnect = setTimeout(() => {
    par.timers.reconnect = null;
    connectParent();
  }, Math.max(minDelay || 0, backoff));
  showPlaceholder(true);
  setStatus("parent-status", "Verbinde neu…", "disconnected");
}

/* ----- Wächter: fließen wirklich Daten? (+ Lautstärke-Anzeige) -----
   Manchmal meldet eine Verbindung "verbunden", obwohl nichts mehr ankommt.
   Dann wird neu verbunden. Fehlt nur der Ton, gibt es eine Warnung. */
function startStatsWatch() {
  stopStatsWatch();
  const pc = par.pc;
  Object.assign(par.stats, { bytes: -1, audioBytes: -1, stall: 0, audioStall: 0, sawBytes: false, sawAudio: false, energy: null, dur: null, frames: -1, frameStall: 0 });
  par.videoFrozen = false;
  par.timers.stats = setInterval(() => pollStats(pc), 1000);
}
function stopStatsWatch() {
  clearInterval(par.timers.stats); par.timers.stats = null;
  setNoAudio(false);
  $("level-meter").classList.add("hidden");
}
async function pollStats(pc) {
  if (pc !== par.pc || !par.connected) return;
  let report;
  try { report = await pc.getStats(); } catch (e) { return; }
  if (pc !== par.pc || !par.connected) return;
  let bytes = 0, audioBytes = 0, energy = null, dur = null, frames = 0;
  report.forEach(s => {
    if (s.type !== "inbound-rtp") return;
    const kind = s.kind || s.mediaType;
    bytes += s.bytesReceived || 0;
    if (kind === "video") frames += s.framesDecoded || 0;
    if (kind === "audio") {
      audioBytes += s.bytesReceived || 0;
      if (typeof s.totalAudioEnergy === "number" && typeof s.totalSamplesDuration === "number") {
        energy = s.totalAudioEnergy; dur = s.totalSamplesDuration;
      }
    }
  });
  const st = par.stats;
  if (bytes > st.bytes) { if (bytes > 0) st.sawBytes = true; st.bytes = bytes; st.stall = 0; }
  else if (st.sawBytes && ++st.stall >= STALL_RECONNECT_S) { log("Keine Daten mehr – verbinde neu"); scheduleReconnect(0); return; }

  if (audioBytes > st.audioBytes) { if (audioBytes > 0) st.sawAudio = true; st.audioBytes = audioBytes; st.audioStall = 0; }
  else if (st.sawAudio) st.audioStall++;
  setNoAudio(st.sawAudio && st.audioStall >= NO_AUDIO_WARN_S);

  if (energy !== null && st.energy !== null && dur > st.dur) {
    showLevel(Math.sqrt(Math.max(0, energy - st.energy) / (dur - st.dur)));
  }
  st.energy = energy; st.dur = dur;

  // Bild eingefroren, obwohl Video an sein sollte? -> Nachtansicht statt Standbild.
  const cs = roomData.childState || {};
  const videoExpected = !par.eco && control.childVideoEnabled && cs.hasVideo !== false;
  if (!videoExpected || frames > st.frames) { st.frameStall = 0; st.frames = frames; } else st.frameStall++;
  const frozen = videoExpected && st.frameStall >= 4;
  if (frozen !== par.videoFrozen) { par.videoFrozen = frozen; updateVideoOff(); }
  else if (!$("video-off").classList.contains("hidden")) updateNightView();
}
function showLevel(rms) {
  const meter = $("level-meter");
  meter.classList.remove("hidden");
  const dB = rms > 0 ? 20 * Math.log10(rms) : -100;
  const bars = Math.max(0, Math.min(5, Math.round((dB + 60) / 10)));
  meter.querySelectorAll("i").forEach((b, i) => b.classList.toggle("on", i < bars));
}
function setNoAudio(on) {
  if (par.noAudio === on) return;
  par.noAudio = on;
  if (!isParent() || !par.connected) return;
  if (on) setStatus("parent-status", "Verbunden – aber kein Ton!", "warning");
  else setStatus("parent-status", "Verbunden", "connected");
}

/* ----- Platzhalter / Hinweise ----- */
function showPlaceholder(on) {
  const ph = $("parent-placeholder");
  ph.classList.toggle("hidden", !on);
  // Nach einer ersten Verbindung halbtransparent: das letzte Bild ist eingefroren, nicht live.
  ph.classList.toggle("dim", on && par.everConnected);
  if (on) updateParentWaiting();
}
function updateParentWaiting() {
  if (!isParent() || par.connected) return;
  const online = senderOnline();
  $("parent-placeholder-text").textContent = online
    ? (par.everConnected ? "Verbindung wird wiederhergestellt…" : "Verbinde mit dem Babybett…")
    : par.everConnected
      ? "Das Babybett ist nicht erreichbar.\nIst die App am Babybett-Handy noch offen und das Display an?\nSobald es wieder da ist, verbindet sich alles von selbst."
      : `Das Babybett ist noch nicht da.\nAm Handy beim Baby den Raum „${session.room}“ öffnen und SENDEN tippen.`;
  if (!par.timers.reconnect && (!par.pc || par.pc.connectionState !== "disconnected")) {
    setStatus("parent-status", online ? "Verbinde…" : "Warte auf Babybett…", "connecting");
  }
}
function updateVideoOff() {
  if (!isParent()) return;
  const cs = roomData.childState || {};
  let txt = "";
  if (par.connected) {
    if (par.eco) txt = "Akku sparen – nur Ton";
    else if (cs.hasVideo === false) txt = "Keine Kamera am Babybett – nur Ton";
    else if (!control.childVideoEnabled) txt = "Video ist aus – nur Ton";
    else if (par.videoFrozen) txt = "Kein Live-Bild";
  }
  $("video-off-text").textContent = txt;
  $("video-off").classList.toggle("hidden", !txt);
  if (txt) updateNightView();
  // Kleine Hinweise oben: Mikrofon aus / Stromsparmodus
  const infos = [];
  if (control.childAudioEnabled === false) infos.push("Mikrofon am Babybett ist AUS");
  if (control.powerSave) infos.push("Stromsparmodus");
  $("parent-info").textContent = infos.join(" · ");
  $("parent-info").classList.toggle("hidden", !infos.length);
  $("parent-info").classList.toggle("warn", control.childAudioEnabled === false);
}

function updateNightView() {
  $("night-clock").textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const audioLive = par.connected && !par.noAudio && control.childAudioEnabled !== false;
  $("night-audio").classList.toggle("hidden", !audioLive);
}

function updateParentPresenceUI() {
  const c = readPresence(presence.docs);
  const others = c.parents.filter(x => x.device !== DEVICE_ID);
  const el = $("parent-presence");
  const childTxt = c.children.length ? escapeHtml(c.children.map(x => x.name).join(", ")) : "Babybett offline";
  let html = `<span class="who"><span class="${c.children.length ? "on" : "off"}">${ICON.broadcast}</span> ${childTxt}</span>`;
  if (others.length) html += `<span class="who">${ICON.eye} ${escapeHtml(others.map(x => x.name).join(", "))}</span>`;
  el.innerHTML = html;
  el.classList.remove("hidden");

  const rows = [];
  c.children.forEach(x => rows.push(`<div class="presence-row">${ICON.person}<span class="who-name">${escapeHtml(x.name)}</span><span class="who-tag child">Babybett</span></div>`));
  c.parents.forEach(x => rows.push(`<div class="presence-row">${ICON.person}<span class="who-name">${escapeHtml(x.name)}${x.device === DEVICE_ID ? " (dieses Gerät)" : ""}</span><span class="who-tag parent">Eltern</span></div>`));
  $("presence-list").innerHTML = rows.length ? rows.join("") : '<span class="muted">Noch niemand im Raum.</span>';
}

/* ----- Ton der Eltern-Seite ----- */
function playRemoteAudio() {
  const a = $("remote-audio");
  if (!isParent() || !a.srcObject) return;
  a.muted = par.muted;
  if (CAN_SET_VOLUME) a.volume = Number($("volume-slider").value) / 100;
  const p = a.play();
  if (p && p.then) {
    p.then(() => $("unmute-overlay").classList.add("hidden"))
     .catch(e => { if (e && e.name === "NotAllowedError" && isParent()) $("unmute-overlay").classList.remove("hidden"); });
  }
}
// Hält das System die Wiedergabe an (z.B. nach Mikrofon-Zugriff am iPhone) -> weiterspielen.
$("remote-audio").addEventListener("pause", () => {
  if (isParent() && $("remote-audio").srcObject) setTimeout(playRemoteAudio, 400);
});
$("unmute-overlay").addEventListener("click", () => {
  unlockAudio();
  $("unmute-overlay").classList.add("hidden");
  playRemoteAudio();
  $("remote-video").play().catch(() => {});
});

function initVolumeUI() {
  const v = Number(store.get("babyphone_volume") || 100);
  $("volume-slider").value = isNaN(v) ? 100 : v;
  setRangeFill($("volume-slider"));
  $("volume-row").classList.toggle("no-slider", !CAN_SET_VOLUME);
  updateMuteUI();
}
$("volume-slider").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  store.set("babyphone_volume", String(v));
  const a = $("remote-audio");
  if (CAN_SET_VOLUME) a.volume = v / 100;
  if (v > 0 && par.muted) setMuted(false);
});
$("mute-btn").addEventListener("click", () => setMuted(!par.muted));
function setMuted(m) {
  par.muted = m;
  $("remote-audio").muted = m;
  updateMuteUI();
  if (!m) playRemoteAudio();
}
function updateMuteUI() {
  const btn = $("mute-btn");
  btn.classList.toggle("muted", par.muted);
  btn.querySelector(".vol-icon").innerHTML = par.muted ? ICON["volume-off"] : ICON["volume-high"];
}

/* ----- Sprechen (tippen = an, nochmal tippen = aus) ----- */
$("talk-btn").addEventListener("click", toggleTalk);
async function toggleTalk() {
  if (!isParent() || par.busyTalk) return;
  par.busyTalk = true;
  try {
    unlockAudio();
    if (!par.talkOn) {
      let s;
      try { s = await getMedia({ audio: AUDIO_CONSTRAINTS }); }
      catch (e) { log(e); showAlert("Kein Mikrofon", "Kein Zugriff aufs Mikrofon.\nBitte in den Einstellungen erlauben."); return; }
      if (!isParent()) { stopStream(s); return; }
      par.mic = s; par.talkOn = true;
      par.talkTrack = await makeVoiceTrack(s.getAudioTracks()[0]);
    } else {
      par.talkOn = false;
    }
    updateTalkUI();
    await setParentSendTrack("audio", par.talkOn ? par.talkTrack : null);
    // Mikrofon wirklich freigeben, wenn nicht gesprochen wird (Datenschutz + iPhone-Lautstärke).
    if (!par.talkOn) { stopVoice(); stopStream(par.mic); par.mic = null; par.talkTrack = null; }
    publishParentFlags();
    playRemoteAudio();   // iPhone: Wiedergabe nach Mikrofon-Zugriff wieder anwerfen
  } finally {
    par.busyTalk = false;
  }
}
/* Lautstärke der Elternstimme am Babybett: wird HIER (beim Sprechen) eingestellt.
   So funktioniert sie auch, wenn das Babybett ein iPhone ist (dort ist die
   Lautstärke per Webseite gesperrt). Klappt WebAudio nicht, wird das Mikrofon
   direkt gesendet (dann eben ohne Lautstärke-Regelung, aber nie stumm). */
const voiceGainValue = () => Math.max(0, Math.min(100, Number(control.childVolume) || 0)) / 80;
async function makeVoiceTrack(micTrack) {
  try {
    unlockAudio();
    if (!audioCtx || !audioCtx.createMediaStreamDestination) return micTrack;
    if (audioCtx.state !== "running") await withTimeout(audioCtx.resume(), 800, null);
    if (audioCtx.state !== "running") return micTrack;
    const src = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
    const gain = audioCtx.createGain();
    gain.gain.value = voiceGainValue();
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(gain); gain.connect(dest);
    par.voice = { src, gain, dest, mic: micTrack };
    return dest.stream.getAudioTracks()[0] || micTrack;
  } catch (e) {
    log("Stimme", e);
    return micTrack;
  }
}
function stopVoice() {
  const v = par.voice; par.voice = null;
  if (!v) return;
  try { v.src.disconnect(); v.gain.disconnect(); } catch (e) {}
  v.dest.stream.getTracks().forEach(t => t.stop());
}
function updateVoiceGain() {
  if (par.voice) par.voice.gain.gain.value = voiceGainValue();
}
// Hält das System den Audio-Kontext an (iPhone im Hintergrund), direkt das Mikrofon senden.
function voiceFallbackIfNeeded() {
  if (!par.talkOn || !par.voice || !audioCtx || audioCtx.state === "running") return;
  const mic = par.voice.mic;
  stopVoice();
  par.talkTrack = mic;
  setParentSendTrack("audio", mic);
}

function updateTalkUI() {
  $("talk-btn").classList.toggle("active", par.talkOn);
  $("talk-btn").querySelector(".lbl").textContent = par.talkOn ? "Spricht…" : "Sprechen";
}

/* ----- Eigenes Video zeigen (Eltern -> Kind) ----- */
$("parent-video-btn").addEventListener("click", toggleParentVideo);
async function toggleParentVideo() {
  if (!isParent() || par.busyVideo) return;
  par.busyVideo = true;
  try {
    if (!par.videoOn) {
      let s;
      try { s = await getMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20 } } }); }
      catch (e) { log(e); showAlert("Keine Kamera", "Kein Zugriff auf die Kamera.\nBitte in den Einstellungen erlauben."); return; }
      if (!isParent()) { stopStream(s); return; }
      par.cam = s; par.videoOn = true;
      $("parent-self-video").srcObject = s;
      $("parent-self-video").play().catch(() => {});
    } else {
      par.videoOn = false;
    }
    updateParentVideoUI();
    await setParentSendTrack("video", par.videoOn && par.cam ? par.cam.getVideoTracks()[0] : null);
    if (!par.videoOn) { stopStream(par.cam); par.cam = null; $("parent-self-video").srcObject = null; }
    publishParentFlags();
    if (par.videoOn && !control.showParentVideoOnChild) toast("Hinweis: „Mein Video beim Kind zeigen“ ist im Menü ausgeschaltet.", 5000);
    playRemoteAudio();
  } finally {
    par.busyVideo = false;
  }
}
function updateParentVideoUI() {
  $("parent-video-btn").classList.toggle("active", par.videoOn);
  $("parent-self-video").classList.toggle("hidden", !par.videoOn);
}

async function setParentSendTrack(kind, track) {
  const s = senderOf(par.pc, kind);
  if (s) await quiet(s.replaceTrack(track));
}
async function attachParentSendTracks(pc) {
  const a = senderOf(pc, "audio"), v = senderOf(pc, "video");
  if (a) await quiet(a.replaceTrack(par.talkOn ? par.talkTrack : null));
  if (v) await quiet(v.replaceTrack(par.videoOn && par.cam ? par.cam.getVideoTracks()[0] : null));
}
// Dem Kind-Gerät mitteilen, ob gerade gesprochen / Video gezeigt wird.
function publishParentFlags() {
  if (par.ref) quiet(updateDoc(par.ref, { talk: par.talkOn, video: par.videoOn, wantVideo: !par.eco }));
}

/* ----- Fernsteuerung (Menü) ----- */
// Schnell-Schalter (Kacheln): jede Kachel schaltet einen Wert der Fernsteuerung um.
document.querySelectorAll(".qs-tile[data-ctl]").forEach(tile => {
  tile.addEventListener("click", () => {
    const key = tile.dataset.ctl;
    setControl({ [key]: !control[key] });
    syncRemoteControlsUI();
    updateVideoOff();
  });
});
$("rc-quality").addEventListener("change", (e) => setControl({ quality: e.target.value }));
$("rc-camera").addEventListener("change", (e) => { if (e.target.value) setControl({ cameraId: e.target.value }); });
const sendChildVolume = throttle((v) => setControl({ childVolume: v }), 400);
$("rc-child-volume").addEventListener("input", (e) => {
  $("rc-volume-value").textContent = e.target.value + " %";
  sendChildVolume(Number(e.target.value));
});
$("rc-child-volume").addEventListener("change", (e) => setControl({ childVolume: Number(e.target.value) }));

function onParentRoom() {
  syncRemoteControlsUI();
  updateVideoOff();
  updateVoiceGain();
}

let lastCamerasKey = "";
function syncRemoteControlsUI() {
  if (!isParent()) return;
  const active = document.activeElement;
  // Elemente, die gerade bedient werden, nicht überschreiben (sonst springt der Regler).
  const setIfIdle = (el, prop, val) => { if (el !== active) el[prop] = val; };
  document.querySelectorAll(".qs-tile[data-ctl]").forEach(tile => {
    const on = !!control[tile.dataset.ctl];
    tile.classList.toggle("on", on);
    tile.setAttribute("aria-pressed", on ? "true" : "false");
  });
  setIfIdle($("rc-quality"), "value", control.quality);
  setIfIdle($("rc-child-volume"), "value", control.childVolume);
  setRangeFill($("rc-child-volume"));
  $("rc-volume-value").textContent = control.childVolume + " %";

  const cs = roomData.childState || {};
  const cams = Array.isArray(roomData.cameras) ? roomData.cameras : [];
  const sel = $("rc-camera");
  const key = JSON.stringify(cams);
  if (key !== lastCamerasKey && sel !== active) {
    lastCamerasKey = key;
    sel.innerHTML = "";
    if (!cams.length) sel.appendChild(new Option("Keine Kameras gemeldet", ""));
    cams.forEach(c => sel.appendChild(new Option(c.label || "Kamera", c.id)));
  }
  const want = cams.some(c => c.id === control.cameraId) ? control.cameraId : (cs.cameraId || "");
  if (sel !== active && cams.some(c => c.id === want)) sel.value = want;
  sel.disabled = !cams.length;


  // Rückmeldung: Ist die Einstellung am Kind-Gerät angekommen?
  const el = $("rc-state");
  el.classList.remove("ok", "warn");
  if (!senderOnline()) {
    el.textContent = "Babybett ist offline – Änderungen gelten, sobald es wieder da ist.";
    el.classList.add("warn");
  } else if (cs.hasVideo === false) {
    el.textContent = "Am Babybett läuft keine Kamera – es wird nur Ton gesendet.";
    el.classList.add("warn");
  } else {
    const camPending = control.cameraId && cams.some(c => c.id === control.cameraId) && cs.cameraId !== control.cameraId;
    const pending = cs.quality !== control.quality || cs.videoOn !== !!control.childVideoEnabled ||
      cs.audioOn !== (control.childAudioEnabled !== false) || cs.powerSave !== !!control.powerSave ||
      cs.childVolume !== control.childVolume || camPending;
    if (camPending && cs.cameraError) { el.textContent = "Diese Kamera ließ sich am Babybett nicht öffnen."; el.classList.add("warn"); }
    else if (pending) el.textContent = "Wird übertragen…";
    else { el.textContent = "✓ Babybett ist auf dem aktuellen Stand."; el.classList.add("ok"); }
  }
}

/* ----- Akku sparen (Eltern): nur Ton, das Babybett schickt diesem Gerät kein Bild ----- */
$("parent-eco-btn").addEventListener("click", () => {
  if (!isParent()) return;
  par.eco = !par.eco;
  store.set("babyphone_parent_eco", par.eco ? "1" : "0");
  updateEcoUI();
  publishParentFlags();
  updateVideoOff();
  toast(par.eco ? "Akku sparen: nur Ton, kein Bild." : "Bild ist wieder an.");
});
function updateEcoUI() {
  $("parent-eco-btn").classList.toggle("active", par.eco);
}

/* ----- Bild drehen (nur für die eigene Eltern-Ansicht, wird pro Raum gemerkt) ----- */
$("rotate-btn").addEventListener("click", () => {
  if (!isParent()) return;
  par.rotation = (par.rotation + 90) % 360;
  store.set("babyphone_rot_" + session.room, String(par.rotation));
  applyRotation();
});
function applyRotation() {
  const v = $("remote-video"), wrap = $("remote-wrap");
  const r = par.rotation;
  if (!r) { v.style.cssText = ""; return; }
  const W = wrap.clientWidth || window.innerWidth, H = wrap.clientHeight || window.innerHeight;
  const side = r === 90 || r === 270;
  v.style.cssText = `inset:auto;left:50%;top:50%;width:${side ? H : W}px;height:${side ? W : H}px;` +
    `transform:translate(-50%,-50%) rotate(${r}deg);`;
}
window.addEventListener("resize", () => { if (isParent()) applyRotation(); });

/* ===========================================================
   12) Menüs (Bottom-Sheets) + Beenden
   =========================================================== */
document.querySelectorAll("[data-open]").forEach(btn => {
  btn.addEventListener("click", () => {
    $(btn.dataset.open).classList.remove("hidden");
    if (btn.dataset.open === "parent-menu") { updateParentPresenceUI(); syncRemoteControlsUI(); }
  });
});
document.querySelectorAll(".close-sheet").forEach(btn => {
  btn.addEventListener("click", () => btn.closest(".sheet").classList.add("hidden"));
});
document.querySelectorAll(".sheet").forEach(sheet => {
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.classList.add("hidden"); });
});
// Beenden über das Menü oder den Verlassen-Knopf oben rechts – immer mit Nachfrage.
document.querySelectorAll(".stop-btn, [data-exit]").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!session) return;
    const text = isChild() ? "Das Babybett hört auf zu senden." : "Du hörst und siehst das Babybett dann nicht mehr.";
    if (await showConfirm("Raum verlassen?", text, "Verlassen")) { stopSession(); showScreen("home"); }
  });
});

function stopSession() {
  const s = session;
  session = null;
  hideStartGate();
  pendingStart = null;
  document.querySelectorAll(".sheet").forEach(m => m.classList.add("hidden"));
  ["screen-off-curtain", "unmute-overlay", "child-unmute", "parent-talking", "child-info", "parent-info",
   "video-off", "parent-presence", "level-meter", "parent-self-video"].forEach(id => $(id).classList.add("hidden"));
  closeDialog(false);
  if (!s) return;

  stopRoomListener();
  stopPresence(s.room);

  // Kind stoppen
  if (child.connUnsub) { try { child.connUnsub(); } catch (e) {} child.connUnsub = null; }
  [...child.peers.keys()].forEach(id => closeChildPeer(id, s.mode === "send" ? s.room : null));
  clearTimeout(child.micRetry);
  stopStream(child.stream);
  child.stream = child.audio = child.video = null;
  child.hasVideo = false;
  $("parent-stage").innerHTML = "";
  $("parent-stage").className = "parent-stage hidden";
  $("parent-audios").innerHTML = "";
  $("local-video").srcObject = null;

  // Eltern stoppen
  teardownParentConn(s.room);
  stopVoice();
  stopStream(par.mic); stopStream(par.cam);
  par.mic = par.cam = null; par.talkTrack = null;
  par.talkOn = par.videoOn = false;
  updateTalkUI();
  updateParentVideoUI();
  $("remote-video").srcObject = null;
  $("remote-video").style.cssText = "";
  $("remote-audio").srcObject = null;
  $("parent-self-video").srcObject = null;

  roomData = {};
  control = defaultControl();
  releaseWakeLock();
  if (location.search) history.replaceState(null, "", location.pathname);
}

/* ===========================================================
   13) Hintergrund, Netzwechsel, Schließen
   =========================================================== */
// Firestore nach Netzwechsel/Standby sofort neu verbinden lassen (statt bis zu 1 Min. zu warten).
let lastKick = 0;
function kickFirestore() {
  if (Date.now() - lastKick < 10000) return;
  lastKick = Date.now();
  disableNetwork(db).then(() => enableNetwork(db)).catch(e => log(e));
}

let hiddenSince = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenSince = Date.now(); return; }
  const away = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = 0;
  if (away > 15000) kickFirestore();
  if (!session) return;
  requestWakeLock();
  if (isChild()) {
    childEnqueue(recoverChildMedia);
    $("local-video").play().catch(() => {});
    child.peers.forEach(p => { if (p.talk) playParentAudio(p); });
  }
  if (isParent()) {
    if (audioCtx && audioCtx.state !== "running") audioCtx.resume().catch(() => {});
    playRemoteAudio();
    $("remote-video").play().catch(() => {});
    const st = par.pc ? par.pc.connectionState : "closed";
    if (st === "failed" || st === "closed") scheduleReconnect(0);
  }
});

window.addEventListener("online", () => {
  kickFirestore();
  if (isParent() && !par.connected) scheduleReconnect(0);
});

// Aus dem Zurück-Cache wiederhergestellt -> sauber neu laden.
window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });

// Beim Schließen: eigene Einträge entfernen (einzelne Schreibvorgänge, damit es noch rausgeht).
window.addEventListener("pagehide", () => {
  if (!session) return;
  const room = session.room;
  if (par.connId) quiet(deleteDoc(connRef(room, par.connId)));
  child.peers.forEach((p, id) => quiet(deleteDoc(connRef(room, id))));
  if (presence.ref) quiet(deleteDoc(presence.ref));
});

// Zur Fehlersuche in der Browser-Konsole: babyphoneDebug.info()
window.babyphoneDebug = {
  info() {
    return {
      session, control, roomData,
      child: { peers: [...child.peers.values()].map(p => ({ id: p.id, name: p.name, state: p.pc.connectionState, talk: p.talk, video: p.video })), cameraId: child.cameraId, hasVideo: child.hasVideo },
      parent: { connId: par.connId, state: par.pc ? par.pc.connectionState : null, connected: par.connected, attempt: par.attempt, talkOn: par.talkOn, videoOn: par.videoOn, eco: par.eco, videoFrozen: par.videoFrozen, voiceGain: par.voice ? par.voice.gain.gain.value : null },
    };
  },
};
