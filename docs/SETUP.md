# Setting up Outpost

Outpost turns a Mac into a small offline server. Once your books, maps and AI models are downloaded, it needs no internet at all. The Mac serves everything, and the people around it open Outpost in a web browser on their phones, tablets and computers.

This guide covers installing Outpost on the Mac, turning on sharing, getting everyone onto the same Wi-Fi (with or without a router), and finding your location.

## 1. What you need

- A Mac running macOS. Outpost is tested on Apple chip Macs (M1 and later); Intel Macs should work but aren't tested.
- Free disk space for what you download: a few GB for a starter set, and up to 100 GB or more for all of Wikipedia with pictures, big maps and several AI models.
- An internet connection **for setup only**: to install Outpost and download books, maps and models. After that, everything works offline.
- [Homebrew](https://brew.sh), the Mac's package installer. The setup script uses it.
- Optional: an RTL-SDR USB radio receiver (Outpost is set up for the [RTL-SDR Blog V3](https://www.rtl-sdr.com/rtl-sdr-blog-v-3-dongles-user-guide/)) to listen to AM, shortwave, CB, walkie-talkie, marine, weather and FM radio, and to see planes, nearby weather sensors and radio amateurs (APRS) on a map (see part 7).
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

Optional extras, each a single command in the same folder (an admin can also install map fonts, CyberChef and Kolibri with a button in Outpost):

- `./scripts/fetch-map-assets.sh`: fonts, so maps show place names. Or click **Install map fonts** on the Maps page.
- `./scripts/fetch-cyberchef.sh`: CyberChef, a toolbox for encoding and decoding data. Or click **Install** on the Tools page.
- `./scripts/install-kolibri.sh`: Kolibri, for courses and exercises on the Education page. Or click **Install Kolibri** there.

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
6. Add Outpost to the home screen, so it opens like an app with Outpost's tower icon and you don't need to type the address again. The join page shows the same steps.
   - **iPhone and iPad (Safari):** tap **Share** (the square with an arrow), then **Add to Home Screen**, keep the name **Outpost**, and tap **Add**.
   - **Android (Chrome):** tap the **⋮** menu, then **Add to Home screen** or **Install app**, then **Install**. Chrome installs it as an app only over Outpost's secure `https://…:8443` address (set up on the join page); over plain `http://` it adds a shortcut.
   - **Mac:** in Safari, **File → Add to Dock…**; in Chrome, **⋮ → Cast, save and share → Install page as app**.

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

### Who's safe, numbers and help nearby

- **Who's safe** (Emergency → Signal): tap **I'm safe**, **I need help** or **I'm on my way**, with a note if you like. Everyone signed in sees each other's status and who hasn't checked in yet. Kept in memory only; a status goes away after a day.
- **Numbers** (Emergency → Numbers): add the police, ambulance and fire numbers for the country you are in, and anyone else to call. On a phone, tap one to call it. They're saved to your account.
- **Nearest help** (Emergency → Location): hospitals, clinics, pharmacies, police and fire stations within 10 km of the position shown, from your offline map, with **Directions**. Places can move or close, so call ahead if you can.
- **First aid** has **Do this now** cards (earthquake, fire, flood, explosions) and an **incident log**: note what happened and when, and show or print it for whoever takes over.
- **Sun clock** (Emergency → Location, under Sun): a dial drawn for where you are, with steps to set it up from a stick and its shadow.

### Voice messages

Short voice messages for everyone on this Outpost, like a walkie-talkie that remembers. Open **Voice** (under Be ready; on phones, **More → Voice**), or use the green **Voice channel** band on Home (under Emergency SOS: who is listening, what is new, and **Hold to talk**).

- Tap **Turn on voice** once and allow the microphone. Do this each time you open Outpost: browsers only allow the microphone and sound after a tap.
- Hold the button (or the space bar on a computer, on Voice or Home), talk, and let go to send. Slide your finger off before letting go to cancel. Up to 60 seconds.
- New messages from others play by themselves while voice is on. If you missed some, Voice in the menu (and **More** on phones) shows a red count; open Voice and tap **Play new**.
- It needs the secure address on phones (`https://…:8443`, set up on the join page). Messages are kept for 24 hours, on this Mac only.

## 7. Radio (optional)

With an RTL-SDR USB receiver plugged into the Mac (Outpost is set up for the **RTL-SDR Blog V3**, about $35 with its antenna kit: [user guide](https://www.rtl-sdr.com/rtl-sdr-blog-v-3-dongles-user-guide/), [where to buy](https://www.rtl-sdr.com/buy-rtl-sdr-dvb-t-dongles/)), the **Radio** page can listen to AM, shortwave, CB, walkie-talkie, marine, weather and FM radio, show planes and radio amateurs (APRS) on a map, and read nearby weather sensors. It only ever receives; nothing is transmitted. The receiver does one job at a time: **Listen**, **Planes**, **Sensors** or **APRS**, chosen at the top of the Receiver box.

### Listening

Outpost becomes a radio scanner everyone can hear. Open **Radio** (under Be ready; on phones, **More → Radio**).

- The first time, an admin taps **Install the radio tools**, while online. It installs four free programs from Homebrew (about 25 MB): `librtlsdr` for listening, `dump1090-fa` for planes, `rtl_433` for sensors and `direwolf` for APRS.
- Plug the receiver straight into a USB port on the Mac. A USB-C display or HDMI adapter often doesn't pass it through, and the page then says **No RTL-SDR found**.
- Pick a band (AM radio, shortwave, CB, PMR446, FRS/GMRS, marine, NOAA weather, airband, FM radio) and turn the knob, or type a frequency. Tap **Listen on this device**. Raise **Squelch** to silence the hiss between calls (AM radio and shortwave start with it off, so weak stations aren't muted).
- Tap **Name this** under the channel to give a station a name everyone sees, such as "City FM".
- Tap **Record** while listening to keep up to a minute of what you hear under **Calls heard**.
- You can leave the Radio page and keep listening: a small bar at the bottom of every page shows what's playing, with **Stop**.
- In **Your list**, a channel written as a frequency (462.6500) or a channel name (CB 19, GMRS 17, PMR 3, Marine 16) gets a **Listen** button.
- On USB and LSB the knob moves 1 kHz at a time, since those modes need fine tuning to sound right.
- **AM radio and shortwave** (below 24 MHz) work differently on the RTL-SDR: there is no scan there, and the small antenna hears little. A long wire (5 to 10 m, outdoors or along a window) clipped to the antenna input hears far more, and AM radio carries furthest at night.
- Tap **Scan** to see which channels have a signal right now: green bars are active. Tap a bar to tune to it. Anyone listening hears a second's gap while it scans.
- Tap **Auto-scan** to let Outpost hunt for you: it jumps to whichever channel has someone talking, stays until they stop, then keeps looking. It misses the first second or two of each call. Turning the knob stops it.
- **Calls heard** keeps every call the receiver picked up (with squelch on) for 24 hours. Play one back, or tap **Share to Voice** to send it to everyone on the Voice channel. Recording radio traffic isn't allowed everywhere; check before you share.
- There is one receiver: when anyone tunes, everyone listening hears the new channel. It only receives, never transmits. Close any other radio program (such as iNTERCEPT) first, because only one program can use the receiver at a time.
- To hand the receiver to another program, an admin flips the **On / Off** switch next to the status lamp to **Off**. Outpost then leaves it completely alone until it's switched back **On**.
- Check the law where you are: listening to some services (for example police or phone calls) is not allowed everywhere.

### Planes on the map

The same RTL-SDR receiver can show the aircraft flying around you on Outpost's map, with no internet: their name, height and direction.

- Set both antenna rods to about **7 cm**, stand the antenna **upright**, and put it **by a window**, as high as you can. With the long rods used for FM radio, or deep indoors, it may hear no planes at all.
- Open **Radio**, tap **Planes** (next to **Listen**), then **Start planes**. The first time, an admin is asked to install the free planes decoder (Homebrew's `dump1090-fa`).
- Under the button, Outpost says how many messages a minute the antenna hears. If it says it hears nothing, move the antenna before waiting longer.
- An admin taps **Set receiver location**, then the map where the antenna is. The map then shows rings at 50, 100 and 200 km, and each plane's distance and direction from you.
- Planes appear within a minute, coloured by height (see the legend), with a short trail behind them. Tap a plane, or a flight in the list, for its airline, height, speed and distance. A red label is a plane signalling an emergency.
- Planes heard whose position hasn't come through yet are listed under the list.
- While planes are on, the receiver can't listen or scan. Tap **Stop planes** to give it back to Listen.

### Nearby sensors

The same receiver can read the wireless sensors around you: weather stations, outdoor thermometers, rain gauges and the like. That's local weather with no internet, yours or a neighbour's.

- Open **Radio**, tap **Sensors**, then **Start sensors**. Keep **433.92 MHz** in Europe, Africa and the Middle East (868 MHz is also used in Europe, 915 MHz in the Americas).
- Sensors send every 30 to 60 seconds, so give it a few minutes. Each one gets a card with its latest readings; **Battery low** shows when it says so.
- Passing cars' tyre-pressure sensors are only counted, never listed, so nobody can use Outpost to track a car. Remotes and doorbells are counted, not shown.
- For the best reach, set the antenna rods to about **17 cm** each, by a window. Planes and sensors take turns with listening: starting one pauses the others.

### APRS: radio amateurs on the map

APRS is how licensed radio amateurs share where they are, the weather and short messages, all on one frequency. Hilltop relays (digipeaters) pass it on, so stations far away can come through. Listening needs no licence.

- Open **Radio**, tap **APRS**, then **Start APRS**. Keep **144.800 MHz** in Europe, Africa and the Middle East (North America uses 144.390).
- Stations appear on the map and in the list with what they are (car, house, weather station…), their latest message and how far away they are (once an admin has set the receiver location under Planes).
- Stations send every few minutes; where APRS is little used it can stay quiet for a long time.
- For the best reach, set the antenna rods to about **50 cm** each, upright, by a window or higher. Outpost only listens: it never transmits.

## 8. Day to day

- **Finding your way:** on a computer, the menu on the left groups the pages under Know, Ask and find, Be ready and Keep, with the red SOS bar on top. On a phone, the bar at the bottom has Home, Library, Chat, Maps, SOS and **More**; More opens everything else, plus Transfers and your account.
- **Choosing the AI model:** on the **Assistant** page, pick the model at the top. `llama3.2:3b` gives good answers on most Macs; smaller models answer faster but less well. Each device remembers its own pick, so choose once on each phone.
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

## 9. Troubleshooting

If a phone can't open Outpost, check in this order:

1. Is the phone on the **same Wi-Fi** as the Mac?
2. Is the **address** right, with `http://` and `:8080`? Compare with **Home → Sharing** on the Mac; the address can change after the router restarts.
3. Is the Mac **awake** and is Outpost running? On the Mac, open http://localhost:8080.
4. Did you add `OUTPOST_HOST="0.0.0.0"` and restart Outpost? **Home → Sharing** says "Only this Mac can open Outpost" if not.
5. Is **mobile data** off on the phone?
6. Is the Mac's firewall blocking it? Check **System Settings → Network → Firewall**, and allow **node**. Outpost uses ports 8080 and 8443, and 8090 and 8453 for books, Education and apps (they open at their own address on purpose, so a book or app can't act as Outpost).
7. **Locate me** says location needs a secure connection? Open the `https://…:8443` address instead, after setting up the certificate at `/join`. The browser warns that the connection isn't private? The certificate isn't trusted yet on that phone: repeat step 2 of "Locate me on Outpost's map".

If the radio doesn't work:

1. **No RTL-SDR found**? Plug the receiver straight into the Mac. A USB-C display or HDMI adapter's port often doesn't pass it through. If macOS asks whether to allow the accessory, choose **Allow**.
2. **In use elsewhere**? Another program has the receiver (for example iNTERCEPT or SDR++). Quit it, or use the receiver's **On / Off** switch to hand it over on purpose.
3. **Busy with planes, sensors or APRS**? The receiver does one job at a time: tap **Stop** on that view first.
4. **Nothing heard** on planes, sensors or APRS? It's nearly always the antenna: rods about 7 cm for planes, 17 cm for sensors and 50 cm for APRS, upright, by a window and as high as you can.

If Outpost won't start after a change to the settings file, check the log at `~/Library/Logs/Outpost/outpost.log`. The usual cause is turning on sharing before creating an account or password.
