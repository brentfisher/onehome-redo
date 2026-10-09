# OneHome big-screen viewer

A landscape, cast-friendly way to look through a OneHome saved search: large type, full-screen photos, one tap per photo.

![Photo viewer in landscape](docs/viewer.png)

![List of homes](docs/list.png)

## Run it

```sh
node server.js
```

No install step. It prints two addresses: one for this Mac, and one to open on your phone. The phone address can change when the Mac rejoins Wi-Fi; the terminal prints the current one each time. Use `PORT=4000 node server.js` for a different port (the default is 3210).

If the phone can't connect:

- Put the phone and the Mac on the same Wi-Fi, and not a guest network.
- If macOS asks whether `node` may accept incoming connections, choose Allow (System Settings → Network → Firewall).

While casting, set the phone's Auto-Lock to Never (iPhone: Settings → Display & Brightness → Auto-Lock) so the screen doesn't sleep mid-slideshow. The page can't keep the phone awake by itself over a plain `http://` address.

## Use it

- Tap a home to open its photos.
- Tap the right or left side of the screen (or swipe) for the next or previous photo. Going past the last photo moves to the next home.
- Swipe up or down, or use **Prev home** / **Next home**, to change homes.
- Tap the middle of the photo to hide or show the controls.
- **All photos** shows every photo for the home; **Details** shows the facts and description; **Play** runs a slideshow.
- With a keyboard: arrow keys, Space (play), `i` (details), `g` (all photos), `f` (full screen), Esc (back).

On iPhone, Safari keeps its toolbars on screen. To get rid of them, use Share → **Add to Home Screen** and open it from the icon.

## Using a different link

Tap **Change link** and paste the whole OneHome address from your agent's email. You can also take the OneHome link and swap `https://portal.onehome.com/en-US/properties/list` for this server's address, keeping everything from `?token=` on.

The link is saved in `config.json` next to `server.js`. That file is git-ignored: a link grants access to that search, so treat it like the email it came from. On first run there is no link yet, and the page asks you to paste one.

## How it works

`server.js` exchanges the link's token for a OneHome session, reads the saved search and its homes, and passes photos through at `/img/<home>/<n>` (OneHome's own photo addresses expire after 30 minutes, so the server renews them as needed). It only reads; it never marks homes as viewed, liked or disliked.

## Run it in Docker

```sh
docker compose up -d --build
```

Then open `http://<address of the Docker machine>:3210` on your phone. The address the container prints in its log is its own internal one, so use the host machine's address instead.

Without Compose:

```sh
docker build -t onehome-bigscreen .
docker run -d --name onehome -p 3210:3210 -v onehome-data:/data --restart unless-stopped onehome-bigscreen
```

A link pasted through **Change link** is saved to `/data/config.json` in the `onehome-data` volume, so it survives rebuilds. The image itself contains no link; paste one the first time you open the page.
