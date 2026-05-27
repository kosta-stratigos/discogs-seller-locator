# Discogs Seller Locator

A static GitHub Pages app for finding Discogs marketplace sellers that have every requested release in stock.

## How It Works

1. Paste Discogs release, marketplace release, master, or listing links into the app.
2. Add a Discogs personal access token.
3. Scan the marketplace pages for each requested release.
4. Review sellers with complete matches first, then partial matches.

The app runs entirely in the browser. The token is sent only from the browser to the Discogs API and is not stored by the app.

Optional filters can narrow matches by seller rating, seller ship-from location, release/listing format, and maximum item price before shipping.

## Local Development

Open `index.html` directly in a browser, or serve the folder with any static file server.

Run the unit tests with:

```sh
npm test
```

## GitHub Pages

This repo is intentionally build-free. Configure GitHub Pages to serve the `main` branch from the repository root.

## API Notes

Discogs allows unauthenticated release lookups, but marketplace seller search requires an authenticated personal access token. The app uses the authenticated `/marketplace/search` endpoint for seller discovery and intersects sellers locally across requested releases.

Discogs is a trademark of Zink Media, LLC. This app uses the Discogs API and is not affiliated with Discogs.
