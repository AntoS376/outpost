# Setting up Outpost

Outpost turns a Mac into a small offline server. Once your books, maps and AI models are downloaded, it needs no internet at all. The Mac serves everything, and the people around it open Outpost in a web browser on their phones, tablets and computers.

This guide covers installing Outpost on the Mac, turning on sharing, getting everyone onto the same Wi-Fi (with or without a router), and finding your location.

## 1. What you need

- A Mac running macOS. Outpost is tested on Apple chip Macs (M1 and later); Intel Macs should work but aren't tested.
- Free disk space for what you download: a few GB for a starter set, and up to 100 GB or more for all of Wikipedia with pictures, big maps and several AI models.
- An internet connection **for setup only**: to install Outpost and download books, maps and models. After that, everything works offline.
- [Homebrew](https://brew.sh), the Mac's package installer. The setup script uses it.
- To share Outpost with other devices: a Wi-Fi network that the Mac and everyone else can join. It doesn't need internet. Part 4 explains the options.

## 2. Install Outpost on the Mac

1. On Outpost's GitHub page, open **Releases** and download **Outpost.zip**. Double-click it to unzip it.
2. In the new **Outpost** folder, double-click **Install Outpost.command**.
   - The first time, macOS says it can't check the file. Click **Done**, then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to "Install Outpost.command". Confirm, and enter your Mac password if asked.
3. A Terminal window opens and does the rest. If your Mac doesn't have Homebrew (a free tool that installs other programs), it asks before installing it; Homebrew asks for your Mac password, and Outpost never sees it. Then it installs what Outpost needs (Node, Ollama, kiwix-serve, pmtiles), copies Outpost to `~/Applications/Outpost`, and sets it to start every time you log in. This takes a few minutes.
4. When it's done, Outpost opens in your browser at **http://localhost:8080**. The first time, a setup wizard:
   - makes your account (the admin: you),
   - asks whether to share Outpost with devices on your Wi-Fi (you can change this later),
   - helps you choose books (a size of Wikipedia, and a level from Basic to Complete for topics like Health, Staying safe, and Food and farming), a map region and AI models, and shows how much space they need.

   You can skip the downloads and come back from Home.

**Comfortable with Terminal?** This one line does the same as steps 1 to 3:

```
curl -fsSL https://raw.githubusercontent.com/AntoS376/outpost/main/scripts/install.sh | bash
```

**Installing from the code instead** (for example **Code → Download ZIP**): put the folder somewhere like `~/Developer/outpost`, not `~/outpost` (macOS ignores upper and lower case, so that would be the same folder as your data folder `~/Outpost`, and setup refuses to run). Then run `./scripts/setup-mac.sh --pull-models` in that folder. Leave out `--pull-models` to choose AI models later.

Optional extras, each a single command in the same folder:

- `./scripts/fetch-map-assets.sh`: fonts, so maps show place names.
- `./scripts/fetch-cyberchef.sh`: CyberChef, a toolbox for encoding and decoding data.
- `./scripts/install-kolibri.sh`: Kolibri, for courses and exercises on the Education page.

Everything you download lives in the `Outpost` folder in your home folder (`~/Outpost`). Your settings are in `~/.config/outpost/env`.

## 3. Before you share: sign-in, sharing, power

### Turn on sign-in

While Outpost only runs on this Mac, nobody needs to sign in. Before other people can reach it, it needs accounts.

1. The setup wizard makes the first account, an admin (you). If you skipped it, open **Home → Accounts** and create it there.
2. Add an account for each person, as a **member**. Members can read, chat and keep their own notes, but can't change settings, download content or install apps.

Outpost refuses to share itself on the network until at least one account (or a password) exists.

### Turn on sharing

Outpost only answers this Mac until you turn sharing on. The easiest way is the **Wi-Fi** step of the setup wizard: choose **This Mac and devices on my Wi-Fi**, and Outpost restarts by itself after a few seconds.

To do it by hand instead:

1. In Terminal, open the settings file: `open -e ~/.config/outpost/env`
2. Add this line, then save: `OUTPOST_HOST="0.0.0.0"`
3. Restart Outpost:

```
launchctl kickstart -k gui/$(id -u)/com.outpost.server
```

**Home → Sharing** now shows the address other devices use, for example `http://192.168.1.20:8080`. The first time, macOS may ask whether to allow incoming connections for **node**: choose **Allow**.

Sharing also turns on Outpost's own **HTTPS** at port `8443` (for example `https://192.168.1.20:8443`). Phones need it to show their location on the map: see part 6. Outpost makes its own certificate for this, in `~/Outpost/tls`.

To stop sharing, remove that line and restart Outpost again.

### Keep the Mac awake

A sleeping Mac serves nobody.

- Plug it into power.
- Once sharing is on, tick **Keep this Mac awake while Outpost runs** in **Home → Sharing**. The screen can still turn off to save power. While it's on, the **Keep awake** light in Sharing blinks green.
- Or, in **System Settings → Battery** (on desktop Macs, **Energy**), turn on the option that prevents automatic sleeping while on power when the display is off. The wording differs a little between macOS versions.
- Or, while serving, run `caffeinate -s` in a Terminal window and leave it open.
- On a laptop, closing the lid puts the Mac to sleep. Keep it open.

## 4. Connect everyone: pick one way

The Mac and the other devices must be on the **same Wi-Fi network**. That network doesn't need internet. Choose whichever fits.

### Option A: an existing Wi-Fi router

At home, in an office or a shelter that has a Wi-Fi router, it works even if the internet is down, as long as the router has power.

1. Connect the Mac and every device to that Wi-Fi.
2. Use the address shown in **Home → Sharing**.

Tip: in the router's settings, give the Mac a fixed address (often called *DHCP reservation* or *static lease*), so the address never changes. Write it down or print it.

### Option B: a travel router (best for the field)

A pocket-sized Wi-Fi router (for example from GL.iNet, TP-Link or similar, around $30 to $40) creates a Wi-Fi network anywhere, with no internet. Many run from USB power, including the Mac's own port or a power bank.

1. Set the router up once, while you still have time: give its Wi-Fi a name and a password using its own setup page, and give the Mac a fixed address.
2. In the field: power the router, then connect the Mac and every device to its Wi-Fi.
3. Use the address shown in **Home → Sharing**.

This is the most reliable option: it reaches further than a Mac's Wi-Fi, and the address stays the same every time.

### Option C: the Mac makes its own Wi-Fi

macOS can create a Wi-Fi network itself with **Internet Sharing**:

1. Open **System Settings → General → Sharing**.
2. Click the **ⓘ** next to **Internet Sharing**.
3. Under **Share your connection from**, choose a connection, such as **Ethernet** or **Thunderbolt Bridge**. Under **To devices using**, turn on **Wi-Fi**.
4. Click **Wi-Fi Options**: set a network name, choose **WPA2/WPA3 Personal** security and a password.
5. Turn **Internet Sharing** on.
6. On every other device, join that Wi-Fi name. The Mac's address on this network is usually `192.168.2.1`; **Home → Sharing** shows the exact one.

Things to know:

- macOS is designed to share an internet connection, so it may refuse to turn this on when the connection it shares from isn't plugged in. If it refuses, try another choice under **Share your connection from**. If none works, use option B or D.
- This hasn't been tested with Outpost on every macOS version. Try it at home before you depend on it.
- While Internet Sharing is on, the Mac's Wi-Fi can't join other networks.
- The Mac's Wi-Fi reaches about one room or a small house.

### Option D: a phone's hotspot

A phone can create the Wi-Fi network with its **Personal Hotspot** or **Hotspot**.

- Many Android phones can do this with no mobile data or even no SIM card.
- iPhones usually need mobile service before they allow Personal Hotspot.
- The phone's battery drains fast. Keep it plugged in.

Connect the Mac and every other device to the hotspot, then use the address shown in **Home → Sharing**.

## 5. On each phone, tablet or computer

1. Join the same Wi-Fi as the Mac.
   The quickest way in: on the Mac, **Home → Sharing** shows a QR code (tap it to make it bigger). Scan it with the phone's camera; it opens Outpost's join page.
2. If the phone warns that the Wi-Fi has no internet, choose to **stay connected** (Android may ask *Use this network anyway?*).
3. **Turn off mobile data** if Outpost won't load. Some phones send everything over mobile data when the Wi-Fi has no internet.
4. Or open the browser and type the address exactly, with `http://` and `:8080`, for example `http://192.168.2.1:8080`. On iPhones and Macs, the Mac's name also works, like `http://my-mac.local:8080` (shown in **Home → Sharing**).
5. Sign in with the account the admin made for you.
6. Bookmark it, or use **Add to Home Screen**, so you don't need to type it again.

## 6. Knowing where you are

- **The Mac has no GPS.** It normally works out its location from nearby Wi-Fi networks, which needs the internet, so offline it usually can't tell where it is.
- **Phones have GPS, and GPS works offline.** It listens to satellites directly; no internet or phone signal is needed. It works best outdoors with a view of the sky.
- **Browsers only share your location with secure (HTTPS) sites**, so phones use Outpost's HTTPS address for this.

### Locate me on Outpost's map (once per phone)

1. On the phone, open `http://<the Mac's address>:8080/join`, for example `http://192.168.1.20:8080/join`. This page works before signing in.
2. Tap **Download the certificate** and trust it. The page shows the exact steps for iPhone and Android: on iPhone, install the profile in **Settings**, then turn it on under **General → About → Certificate Trust Settings**; on Android, search Settings for **CA certificate**.
3. Open the HTTPS address the page shows (port `8443`), sign in, and bookmark it.
4. On **Maps**, tap **Locate me** and allow location. A blue dot shows where you are, with a circle for how precise the fix is. Tap **Stop** to turn it off.

### The group map

While **Locate me** is on, tap **Share with group** to let everyone signed in to this Outpost see where you are. People who share appear on Maps as named dots, and in a list ("2 min ago", "350 m away"); tap a name to go to them. It's off until you turn it on, each time.

- Your position updates while you share, at least once a minute.
- It's kept in Outpost's memory only: never saved to disk, no history.
- It disappears when you tap **Stop**, leave the Maps page, or after 15 minutes without an update.

About the certificate: Outpost makes it on the Mac, and it is limited to local network addresses (like `192.168.x.x`) and `.local` names, so it can't be used to impersonate real websites. Its private key stays in `~/Outpost/tls`, readable only by your Mac account. If the Mac's address changes, Outpost renews its certificate by itself, and phones stay set up.

On the Mac itself, **Locate me** works at `http://localhost:8080`, but a Mac has no GPS, so without internet it usually can't find a position.

### Directions on Outpost's map

Outpost can give turn-by-turn directions by car, on foot or by bike on its own map, with no internet.

1. **Once, while online (an admin):** on **Maps**, under **Directions**, press **Add directions for this map**. Outpost suggests the regions of road data that cover your map, with their sizes; untick any you don't need, then press **Download and prepare**. It takes a few minutes and shows in **Transfers**. If Outpost says the tools are missing, run `brew install osrm-backend osmium-tool` in Terminal (the setup script installs them).
2. **Then, anyone:** fill in **From** and **To** (search a town, press **My location**, or press **Pick on map** and tap the map), choose **Car**, **Walk** or **Bike**. The route appears on the map with the distance, the time and each turn. Tap a turn to see it on the map.
3. On an **SOS** banner, or next to someone on the group map, **Directions** plans the way there from where you are.

Good to know: the turns are in English, there's no live traffic, and routes are only as good as OpenStreetMap's roads in your area, so check the way with your own eyes. To get newer roads, press **Update road data**.

### Other ways

- **Organic Maps** on the phone (in **Apps → Get for your devices**) shows your live position and gives turn-by-turn directions, completely offline. Download your region's map inside the app beforehand.
- **Read your coordinates and type them in.** The iPhone's **Compass** app shows your latitude and longitude; on Android, use a GPS or compass app. In Outpost, open **Emergency → Location**, type them, and press **Show on map**. That page also shows the position in other formats (such as MGRS) to read out over a radio.

### Calling for help on the network (SOS)

Press **Send SOS** on the red strip at the top of Home, or on **Emergency → Signal**. You can add a short message, such as "Injured at the north cabin". If your phone knows where you are (Locate me was on, or you allow it in the dialog on the HTTPS address), your position goes with it.

- Everyone signed in to this Outpost sees a red banner on top of every page, with an alarm sound, your name, your message, how long ago, and how far away you are when their position is known too.
- They can tap **Show on map** to go to you, and **I'm coming** to tell you. You see who is on the way.
- Tap **Cancel SOS** when you're safe. An admin can cancel any SOS. Otherwise it ends by itself after 2 hours.
- Phones and computers only play sounds after the page has been touched once. Keep Outpost open, and tap it once, on the devices that should ring.
- It's kept in Outpost's memory only, never saved to disk. It reaches people on this Outpost, not emergency services: call your local emergency number too if you can.

## 7. Day to day

- **Top bar:** on the left, whether Outpost is running, the Mac's battery and Wi-Fi; on the right, Help, Light/Dark, Settings and (for admins) Shutdown. The battery shows only on a Mac laptop: it turns green with a lightning bolt when plugged in and red below 20% on battery; point at it to see the time left.
- **Light or dark:** the switch in the top bar (next to Help: a half-filled circle for Auto, a sun for Light, a moon for Dark) goes Auto → Light → Dark. Auto follows the device's own setting. Each device remembers its own choice, and the map and the book reader follow it.
- **Docker apps (optional, admins):** to run ready-made apps from Docker images, install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev/download), then on **Apps → Docker apps** press **Turn on Docker apps** (Outpost saves it and restarts itself; if it isn't installed as a background service, quit and start it again). Then fill in the image, a short name and the ports, and press **Review the command**; nothing runs until you've read the exact command and chosen **Run it**. Each app opens on this Mac only, and sees only its own folder in `~/Outpost/containers`. Use images you trust.
- **Map colours:** on **Maps**, under **Your maps**, **Map colours** picks how the map looks: **Match Light/Dark** (the default), **Light**, **Dark**, **White**, **Grayscale** or **Black**. Each device remembers its own choice.
- **Calculator and unit converter:** on **Tools**. The calculator has Standard and Scientific modes and remembers your last calculations; the converter changes lengths, weights, temperatures, volumes, land area (including dunams), fuel economy and more. Both work with no internet.
- **See the GPU at work:** the Assistant page shows a live gauge of how busy the Mac's GPU is, the memory it uses, and whether the AI model runs fully on the GPU (fast) or partly on the processor (slower; try a smaller model). The number counts every app, not only the AI.
- **Shut down:** an admin can stop Outpost with **Shutdown** in the top bar (it asks first). It stops for everyone, along with the library reader, Education and apps, and stays off.
- **Start again:** on the Mac, double-click **Start Outpost.command** in the Outpost folder (it opens Outpost in the browser when it's ready), or log out and back in. If Outpost crashes rather than being shut down, it restarts by itself.
- **Back up:** copy the `~/Outpost` folder to another drive.
- **Security:** Outpost's normal address is plain HTTP; its HTTPS address (port 8443) is encrypted for devices that trust its certificate. Either way, use it on a Wi-Fi network you trust, and give that Wi-Fi a password.
- **Forgotten password:** an admin can set a new one in **Home → Accounts**.
- **Logs:** if something misbehaves, Outpost's log is at `~/Library/Logs/Outpost/outpost.log`.

## 8. Troubleshooting

If a phone can't open Outpost, check in this order:

1. Is the phone on the **same Wi-Fi** as the Mac?
2. Is the **address** right, with `http://` and `:8080`? Compare with **Home → Sharing** on the Mac; the address can change after the router restarts.
3. Is the Mac **awake** and is Outpost running? On the Mac, open http://localhost:8080.
4. Did you add `OUTPOST_HOST="0.0.0.0"` and restart Outpost? **Home → Sharing** says "Only this Mac can open Outpost" if not.
5. Is **mobile data** off on the phone?
6. Is the Mac's firewall blocking it? Check **System Settings → Network → Firewall**, and allow **node**. Outpost uses ports 8080 and 8443, and 8090 and 8453 for books, Education and apps (they open at their own address on purpose, so a book or app can't act as Outpost).
7. **Locate me** says location needs a secure connection? Open the `https://…:8443` address instead, after setting up the certificate at `/join`. The browser warns that the connection isn't private? The certificate isn't trusted yet on that phone: repeat step 2 of "Locate me on Outpost's map".

If Outpost won't start after a change to the settings file, check the log at `~/Library/Logs/Outpost/outpost.log`. The usual cause is turning on sharing before creating an account or password.
