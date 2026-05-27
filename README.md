# Discogs Seller Locator

A browser extension for finding Discogs marketplace sellers that have every requested release in your stack.

## How It Works

1. Browse Discogs normally.
2. Open an exact release page or master release page and click **Add to Seller Locator**.
3. Repeat for the other titles you want.
4. Open the extension popup and click **Find sellers**.
5. Review sellers with complete matches first, then partial matches.

The extension scans Discogs marketplace pages from your browser session and intersects sellers locally. Master releases are expanded through Discogs' public master versions API, then each selected version is scanned. It does not need a Discogs personal access token.

Optional filters can narrow matches by seller rating, ship-from text, maximum item price before shipping, pages per release, and versions per master.

## Install Locally

1. Clone or download this repository.
2. Open Chrome, Edge, or another Chromium browser.
3. Go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this repository folder.
6. Open a Discogs release page and use the floating **Add to Seller Locator** button.

## Development

Run the unit tests with:

```sh
npm test
```

## API Notes

The public Discogs API does not reliably expose global seller discovery for arbitrary release stacks from a static site. This extension works from Discogs pages in the browser instead, scanning marketplace HTML that the user can already access and computing seller overlap locally.

Discogs is a trademark of Zink Media, LLC. This app uses the Discogs API and is not affiliated with Discogs.
