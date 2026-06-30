# 👶 Babyphone-Webapp

Eine einfache Webapp, die sich wie ein **Babyphone** anfühlt (nicht wie ein Videochat):

- Ein **altes Handy** liegt am Babybett und **sendet** Ton + Video.
- Ein oder mehrere **andere Geräte** gehen in denselben **Raum** und **empfangen**.
- Das Video läuft **direkt zwischen den Geräten** (Peer-to-Peer über WebRTC).
  Es geht **nicht** über einen Server.
- Gedacht für Geräte im **selben VPN-Netz** – darum ist **kein TURN-Server nötig**.

---

## Was kann die App?

- 🔐 **Anmelden** mit E-Mail + Passwort (über Firebase). Nutzer legst du selbst in der Firebase-Konsole an.
- 🏠 **Sichtbare Raumliste**: Beide Geräte tippen einfach denselben Raum an – kein Vertippen mehr.
- 🔗 **Lesezeichen-Links**: Ein Tipp genügt (z.B. `?room=kinderzimmer&mode=send`).
- 📱 **Als App speichern**: Eigenes App-Icon, lässt sich aufs iPhone-Startbild legen.
- 🖥️ **Empfangen** zeigt das Video groß und bildschirmfüllend.
- 🔊 **Großer Lautstärke-Regler** am Eltern-Gerät.
- 🎤 **Eltern können sprechen** (Knopf „Sprechen"), das Kind-Gerät gibt die Stimme aus.
- 📹 **Eltern-Video**: Eltern können ihre eigene Kamera anschalten, das Kind sieht sie eingeblendet.
- 🎛️ **Fernsteuerung vom Eltern-Gerät**: Video des Kind-Geräts an/aus, Videoqualität,
  ob das Eltern-Video beim Kind sichtbar ist, und die Lautstärke der Elternstimme am Kind-Gerät.
- 📊 **Videoqualität einstellbar** (Niedrig/Mittel/Hoch) – auch per Fernsteuerung, um Daten zu sparen.
- 🔄 **Alle Kameras wählbar** (z.B. alle iPhone-Kameras) + Schnell-Umschalter Front/Rück.
- 🚫 **Kein versehentliches Auflegen** – Beenden nur über das Menü (⚙︎ oben links) + Nachfrage.
- 🔁 **Automatisch neu verbinden**, wenn das WLAN kurz weg ist.
- ☀️ **Bildschirm bleibt an** (Wake Lock), solange die Babyphone-Ansicht offen ist.
- 🌙 **„Display aus"** am Babybett-Handy (schwarzer Bildschirm, Ton + Video laufen weiter, spart Akku).
- 👨‍👩‍👧 **Mehrere Eltern-Geräte** gleichzeitig im selben Raum möglich.
- 🟢 **Statusanzeige**: „Verbunden" / „Verbinde…" / „Getrennt, versuche erneut…".

> **Hinweis zur Anmeldung:** Beide Geräte müssen angemeldet sein, aber **nicht zwingend mit
> demselben Konto**. Wichtig ist nur derselbe **Raum**.

---

## Die Dateien

| Datei | Wozu |
|---|---|
| `index.html` | Die Seite selbst (Knöpfe, Video, Felder). |
| `styles.css` | Das Aussehen (dunkel, modern). |
| `app.js` | Die Logik (Anmelden, Räume, Video senden/empfangen, Fernsteuerung). |
| `firestore.rules` | Die Sicherheitsregeln für die Datenbank. |
| `manifest.json` + `icons/` | App-Icon und Name fürs Speichern auf dem Startbildschirm. |
| `README.md` | Diese Anleitung. |

Deine Firebase-Config steckt **schon eingesetzt** oben in `app.js`.

---

## So bedienst du es (Kurzfassung)

1. Beide Geräte **anmelden**.
2. Auf der Startseite einen **Raum anlegen** (Name eingeben → „+ Anlegen") oder in der **Raumliste** antippen.
3. **Babybett-Handy:** Raum wählen → **SENDEN**. **Eltern-Gerät:** denselben Raum → **EMPFANGEN**.

**Am Babybett (Kind-Gerät):**
- ⚙︎ oben links: **Kamera** auswählen (alle iPhone-Kameras) und **Videoqualität**.
- Unten: 🔄 Kamera (Front/Rück), 📷 Video an/aus, 🌙 Display aus (läuft weiter).

**Am Eltern-Gerät:**
- Unten Mitte: **Lautstärke-Regler**.
- 🎤 **Sprechen** antippen → das Kind hört eure Stimme (nochmal tippen = aus).
- 📹 **Mein Video** antippen → das Kind sieht eure Kamera eingeblendet.
- ⚙︎ **Steuern**: das Babybett fernsteuern – Video an/aus, Qualität (Daten sparen),
  euer Video beim Kind zeigen/verbergen, Lautstärke eurer Stimme am Kind-Gerät.

---

## Als App auf dem iPhone speichern

1. Öffne die App-Adresse in **Safari**.
2. Tippe unten auf **Teilen** (Quadrat mit Pfeil).
3. **„Zum Home-Bildschirm"** wählen → **Hinzufügen**.
4. Jetzt liegt das **Babyphone-Icon** auf dem Startbildschirm und öffnet wie eine echte App.

---

## Teil A: Firebase einrichten (einmalig)

Du hast schon ein Firebase-Projekt (`bbphone`). Es fehlen nur noch zwei Häkchen:

### A1) Anmeldung (E-Mail/Passwort) einschalten
1. Öffne die **Firebase-Konsole**: https://console.firebase.google.com/
2. Wähle dein Projekt **bbphone**.
3. Links auf **Build → Authentication** klicken, dann oben auf **Get started**.
4. Reiter **Sign-in method** → **Email/Password** anklicken → **Aktivieren** → **Speichern**.

### A2) Nutzer anlegen (das machst du selbst)
1. Immer noch in **Authentication** → Reiter **Users** → **Add user**.
2. E-Mail + Passwort eintragen → **Add user**.
3. Mit genau diesen Daten meldest du dich später in der App an.
   (Du kannst hier so viele Nutzer anlegen, wie du willst.)

### A3) Datenbank (Firestore) anlegen
1. Links auf **Build → Firestore Database** → **Create database**.
2. Wähle einen Standort (z.B. `eur3` / Europa) → **Next**.
3. Wähle **Start in production mode** → **Create**.
   (Keine Sorge wegen der Regeln – die setzen wir gleich richtig.)

### A4) Sicherheitsregeln einfügen
1. In **Firestore Database** oben auf den Reiter **Rules**.
2. Lösche den vorhandenen Text komplett.
3. Kopiere den **kompletten Inhalt der Datei `firestore.rules`** hinein.
   (Oder den Block unten in diesem README.)
4. Klicke auf **Publish**.

> Diese Regeln bedeuten: **Nur angemeldete Nutzer** dürfen lesen/schreiben.

### A5) Deine Webseite-Adresse erlauben (Authorized domains)
Damit das Anmelden auf GitHub Pages funktioniert:
1. **Authentication → Settings → Authorized domains**.
2. Prüfe, ob deine GitHub-Pages-Adresse dort steht. Wenn nicht: **Add domain**
   und deine Adresse eintragen, z.B. `deinname.github.io`.

---

## Die Sicherheitsregeln (zum Kopieren)

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    match /rooms/{room}/{document=**} {
      allow read, write: if request.auth != null;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**Wo einfügen:** Firebase-Konsole → **Firestore Database** → Reiter **Rules** → alten Text ersetzen → **Publish**.

---

## Teil B: Lokal testen (auf dem eigenen Computer)

Wichtig: Kamera/Mikro funktionieren nur über `https://` **oder** über `http://localhost`.
Einfach die Datei doppelklicken reicht meist **nicht**. Starte stattdessen einen kleinen lokalen Server:

**Wenn Python installiert ist (meist auf Mac/Linux dabei):**
1. Terminal/Eingabeaufforderung im Projektordner öffnen.
2. Befehl eingeben:
   ```
   python3 -m http.server 8000
   ```
3. Im Browser öffnen: `http://localhost:8000`

**Alternative mit Node.js:**
```
npx serve
```

Danach kannst du dich anmelden und einen Raum öffnen.
Zum echten Testen brauchst du aber **zwei Geräte** (siehe Test-Checkliste unten).

---

## Teil C: Zu GitHub hochladen und GitHub Pages aktivieren

### C1) Code ist schon im Branch
Die Dateien liegen im Branch `claude/baby-monitor-webapp-64z6j4`.
Du kannst diesen Branch über einen Pull Request in `main` zusammenführen –
**oder** GitHub Pages direkt aus diesem Branch veröffentlichen (siehe C2).

Falls du selbst pushen möchtest:
```
git add .
git commit -m "Babyphone-Webapp"
git push -u origin claude/baby-monitor-webapp-64z6j4
```

### C2) GitHub Pages einschalten
1. Öffne dein Repository auf **github.com**.
2. Oben auf **Settings** (Einstellungen).
3. Links auf **Pages**.
4. Bei **Source** wähle **Deploy from a branch**.
5. Bei **Branch** wähle deinen Branch (z.B. `main` oder `claude/baby-monitor-webapp-64z6j4`)
   und den Ordner **/ (root)** → **Save**.
6. Warte 1–2 Minuten. Oben erscheint dann ein Link wie:
   `https://deinname.github.io/bbphone/`
7. **Wichtig:** Diese Adresse muss in Firebase unter **Authorized domains** stehen (siehe A5),
   also z.B. `deinname.github.io`.

Fertig – diese Adresse ist deine Babyphone-App.

---

## Teil D: Lesezeichen-Links bauen (ein Tipp genügt)

Hänge an deine App-Adresse einfach den Raumnamen und den Modus an:

- **Senden (Babybett):**
  ```
  https://deinname.github.io/bbphone/?room=kinderzimmer&mode=send
  ```
- **Empfangen (Eltern):**
  ```
  https://deinname.github.io/bbphone/?room=kinderzimmer&mode=receive
  ```

Speichere diese Links als **Lesezeichen** oder lege sie als **Symbol auf dem Startbildschirm** ab
(im Handy-Browser: Teilen → „Zum Home-Bildschirm"). Dann reicht ein einziger Tipp.

- `room=` ist dein Raumname (frei wählbar, z.B. `kinderzimmer`). Beide Geräte müssen denselben benutzen.
- `mode=send` = das Gerät am Babybett. `mode=receive` = das Eltern-Gerät.
- Du musst trotzdem **einmal angemeldet** sein (danach bleibt die Anmeldung gespeichert).

---

## Teil E: STUN an-/abschalten (für VPN)

Ganz oben in `app.js` steht:

```js
const NUTZE_STUN = true;
```

- `true`  = Googles öffentlicher STUN wird benutzt (Standard, funktioniert fast überall).
- `false` = **kein** STUN. Nimm das, wenn du **rein im VPN** bleiben willst.

Nach einer Änderung die Datei speichern und neu hochladen (push).

---

## Test-Checkliste

Teste in dieser Reihenfolge:

### Schritt 1: Beide Geräte im selben WLAN
- [ ] Auf beiden Geräten die App-Adresse öffnen und **anmelden**.
- [ ] Auf einem Gerät einen **Raum anlegen** (z.B. `test`). Auf dem anderen erscheint er in der **Raumliste** – antippen.
- [ ] Gerät 1: **SENDEN** – Kamera + Mikro erlauben.
- [ ] Gerät 2: **EMPFANGEN** – Bild und Ton sollten erscheinen.
- [ ] Status zeigt **„Verbunden"**.
- [ ] **Lautstärke-Regler** testen.
- [ ] Falls „Tippen, um den Ton einzuschalten" erscheint: einmal antippen.

### Schritt 2: Funktionen prüfen
- [ ] **Kamera-Auswahl** (⚙︎) am Kind-Gerät – alle Kameras werden gelistet.
- [ ] **Kamera umschalten** (🔄 Front/Rück) am Kind-Gerät.
- [ ] **Videoqualität** umstellen (am Kind-Gerät und per Fernsteuerung am Eltern-Gerät).
- [ ] **🎤 Sprechen** am Eltern-Gerät – das Kind-Gerät zeigt „Eltern sprechen…" und gibt die Stimme aus.
- [ ] **📹 Mein Video** am Eltern-Gerät – das Kind-Gerät blendet das Eltern-Video ein.
- [ ] **⚙︎ Steuern**: Video des Kind-Geräts an/aus, Eltern-Video zeigen/verbergen, Lautstärke der Elternstimme.
- [ ] **„Display aus"** am Kind-Gerät – Ton/Video laufen beim Eltern-Gerät weiter.
- [ ] Eltern-Bildschirm geht **nicht** von selbst aus (Wake Lock).
- [ ] **Zweites Eltern-Gerät** dazu – beide sehen gleichzeitig das Bild.
- [ ] WLAN am Eltern-Gerät kurz aus/an – es verbindet sich **automatisch neu**.
- [ ] **Beenden** nur über das Menü (⚙︎ oben links) + Nachfrage.
- [ ] (iPhone) Über Safari **„Zum Home-Bildschirm"** – Icon erscheint, App öffnet im Vollbild.

### Schritt 3: Über VPN testen
- [ ] Beide Geräte ins **VPN** einbuchen (verschiedene Netze/Standorte sind ok).
- [ ] Test wie in Schritt 1 wiederholen.
- [ ] Falls es nicht verbindet: in `app.js` `NUTZE_STUN` auf `true` lassen
      (oder zum reinen VPN-Betrieb auf `false` testen), neu hochladen, erneut testen.

---

## Häufige Fragen

**Es verbindet nicht / bleibt bei „Verbinde…".**
- Sind beide im gleichen Raumnamen und angemeldet?
- Läuft das Sender-Gerät wirklich im Modus **SENDEN**?
- Steht deine Webadresse in Firebase unter **Authorized domains** (A5)?
- Sind die **Sicherheitsregeln** veröffentlicht (A4)?

**Kein Ton beim Empfänger.**
- Einmal auf den Bildschirm tippen (Browser blockieren Ton ohne Tippen).
- Lautstärke-Regler aufdrehen.

**Akku am Babybett-Handy schonen.**
- „Bildschirm aus" antippen. Ton + Video laufen weiter, der Bildschirm wird schwarz.

**Sicherheit.**
- Nur Personen mit einem von dir angelegten Login kommen rein.
- Das Video läuft direkt zwischen den Geräten, nicht über einen Server.
