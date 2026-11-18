# Credits

## Software Outpost installs or runs

Each keeps its own licence. Outpost downloads them during setup or when you turn them on; it doesn't ship their code.

| Software | Used for | Licence |
|---|---|---|
| [Kiwix](https://kiwix.org) (`kiwix-serve`) | Library | GPL-3.0 |
| [Ollama](https://ollama.com) | Assistant | MIT |
| [Kolibri](https://learningequality.org/kolibri/) | Education | MIT |
| [MapLibre GL JS](https://maplibre.org) | Map viewer | BSD-3-Clause |
| [PMTiles](https://github.com/protomaps/PMTiles) and [Protomaps basemaps](https://protomaps.com) | Map files and styles | BSD-3-Clause |
| [OSRM](https://project-osrm.org) | Directions | BSD-2-Clause |
| [osmium-tool](https://osmcode.org/osmium-tool/) | Preparing road data | GPL-3.0 |
| [librtlsdr](https://osmocom.org/projects/rtl-sdr/wiki) (`rtl_fm`, `rtl_power`, `rtl_test`) | Radio receiver (optional) | GPL-2.0 |
| [dump1090-fa](https://github.com/flightaware/dump1090) | Planes on the map (optional) | GPL-2.0-or-later |
| [rtl_433](https://github.com/merbanan/rtl_433) | Nearby sensors (optional) | GPL-2.0-or-later |
| [Dire Wolf](https://github.com/wb2osz/direwolf) (`direwolf`) | APRS (optional) | GPL-2.0-or-later |
| [CyberChef](https://github.com/gchq/CyberChef) (GCHQ) | Tools (optional) | Apache-2.0 |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | QR codes | MIT |
| [Homebrew](https://brew.sh) | Installing Node, Ollama, OSRM, osmium and the radio tools | BSD-2-Clause |
| [File Browser](https://filebrowser.org), [Navidrome](https://www.navidrome.org) and the other apps on the Apps page | Optional apps | Listed on each app's card |
| Space Grotesk, Inter, JetBrains Mono | Interface fonts | SIL Open Font Licence 1.1 |
| Noto Sans, from [Protomaps basemaps-assets](https://github.com/protomaps/basemaps-assets) | Map place names (optional) | SIL Open Font Licence 1.1 |

## Hardware

- Radio: built and tested with the [RTL-SDR Blog V3](https://www.rtl-sdr.com/rtl-sdr-blog-v-3-dongles-user-guide/) USB receiver by RTL-SDR Blog ([datasheet](https://www.rtl-sdr.com/wp-content/uploads/2018/02/RTL-SDR-Blog-V3-Datasheet.pdf), [where to buy](https://www.rtl-sdr.com/buy-rtl-sdr-dvb-t-dongles/)). Outpost only receives with it; it never transmits.

## Libraries in Outpost's code

Installed with `npm install`; each keeps its own licence.

| Library | Used for | Licence |
|---|---|---|
| [Express](https://expressjs.com) | Web server | MIT |
| [unpdf](https://github.com/unjs/unpdf), with Mozilla's [PDF.js](https://mozilla.github.io/pdf.js/) | Reading text from PDFs | MIT, Apache-2.0 |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | Reading the Kiwix catalog | MIT |
| [@mapbox/vector-tile](https://github.com/mapbox/vector-tile-js) and [pbf](https://github.com/mapbox/pbf) | Reading map tiles for place search and nearest help | BSD-3-Clause |
| [esbuild](https://esbuild.github.io), [TypeScript](https://www.typescriptlang.org), [tsx](https://tsx.is) | Building and running the code | MIT, Apache-2.0, MIT |
| [Fontsource](https://fontsource.org) | Packaging the interface fonts | SIL Open Font Licence 1.1 |
| [mgrs](https://github.com/proj4js/mgrs) and [SunCalc](https://github.com/mourner/suncalc) | Checking coordinates and sun times in the tests | MIT, BSD-2-Clause |
| [Playwright](https://playwright.dev) (`playwright-core`) | Screenshots for the docs | Apache-2.0 |

## Content

- Books: Wikipedia and the other Kiwix titles keep their own licences (Wikipedia is CC BY-SA).
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL, credited on the map.
- Preparedness guides, kit lists and the Emergency "Do this now" cards: [Ready.gov](https://www.ready.gov) (FEMA), the cards in Outpost's own words.
- Ground-to-air signals: the survivors' visual code of ICAO Annex 12.
- First-aid cards: written in Outpost's own words from named government pages (Seattle Fire and Emergency Management, CDC, NIOSH), each card citing its source.
- Sunrise and sunset times: NOAA's published solar calculation method. The sun clock's hour lines use the standard horizontal-sundial formula.
- Road data for directions: OpenStreetMap extracts from [Geofabrik](https://download.geofabrik.de) (ODbL).
- Book catalog: the [Kiwix](https://library.kiwix.org) library catalog.
- Radio channel card: the ITU Radio Regulations, ICAO, Cospas-Sarsat and FCC rules, as named on the card.
- Airline names on Planes: airlines' ICAO three-letter designators.
- Unit converter: exact definitions from NIST SP 811.

## Inspiration

- Outpost was inspired by [Project N.O.M.A.D.](https://github.com/Crosstalk-Solutions/project-nomad) by Crosstalk Solutions ([projectnomad.us](https://www.projectnomad.us)), an offline knowledge and education server (Apache-2.0). Outpost is its own code and shares none of it.
- The radio views (planes, sensors, APRS, scanning and the call log) borrow ideas from [iNTERCEPT](https://github.com/smittix/intercept) by smittix, and run the same free command-line programs. No iNTERCEPT code is included.

Outpost's own code is under the [MIT License](LICENSE).
