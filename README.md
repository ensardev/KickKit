# KickKit

A Chrome extension that enhances your [Kick.com](https://kick.com) experience with channel tracking, live notifications, chat filters, and multi-stream support.

---

## Features

### Channel Tracker
- Add any Kick channel and track its live status in real time
- Browser badge shows the number of live channels at a glance
- Desktop notifications when a channel goes live (with Do Not Disturb hours)
- Per-channel notification toggle

### Groups
- Organize channels into custom groups
- Filter the channel list by group tab

### Chat Filters *(injected directly into kick.com)*
- **Word filter** — hide or blur messages containing specific words (whole-word mode, Unicode/Turkish safe)
- **User filter** — hide or blur messages from specific usernames
- **Bot command filter** — hide messages starting with `!`
- **Emoji/emote spam filter** — hide or blur messages with 5+ emotes/emojis
- **Filter mode toggle** — choose between *Hide* (remove entirely) or *Blur* (blur with hover-to-reveal)
- **Keyword highlight** — highlight messages that match keywords with a green accent border
- **Font size control** — adjust chat font size (10–20px)
- **Timestamp toggle** — show or hide message timestamps
- **Compact mode** — reduce spacing between chat messages
- Settings panel accessible via a gear button injected next to the Kick chat input

### In-Page Buttons
- **Add to List button** — adds the current channel to your KickKit list directly from the channel page, with group selection support
- Syncs instantly with the popup when channels are added or removed

### Multi-Stream
- Watch multiple Kick channels simultaneously in a single tab
- 5 layout options: Solo, Side-by-Side, Triple, 2×2 Grid, Focus
- Per-stream fullscreen and close controls
- Live badge and viewer count on each stream (hover to reveal)
- Session is saved and restored automatically

---

## Installation

KickKit is not yet published on the Chrome Web Store. Install it in developer mode:

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `kickkit` folder
6. The KickKit icon will appear in your toolbar

---

## Usage

1. Click the **KickKit icon** in the toolbar to open the popup
2. Type a Kick channel slug (e.g. `rugashen`) and click **Add**
3. KickKit will start polling the channel status and notify you when it goes live
4. Visit any kick.com channel page — the gear button and **Add to List** button will appear automatically
5. Open **Multi** from the popup toolbar to launch the multi-stream viewer

---

## Notes

- Poll interval minimum is 30 seconds to avoid rate limiting
- Avatar URLs are stored in `chrome.storage.local` (not synced) to stay within the 100KB sync quota
- The service worker uses `chrome.alarms` to prevent the MV3 30-second idle sleep

---

## License

MIT

---

Made by [ensardev](https://ensar.dev) · [Extensions](https://extensions.ensar.dev)
