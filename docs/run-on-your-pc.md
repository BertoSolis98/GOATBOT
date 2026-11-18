# Run GoatBot on your own PC (no Orgo)

GoatBot normally gives each bot a screen on an Orgo cloud computer. With `COMPUTER=local` the
"computer" is a Docker container on your own PC instead: the app, a Hermes agent (your first bot)
and every bot's screen run inside it. You then open GoatBot from any of your devices, such as a
laptop, through Tailscale.

```
 MacBook (browser) ──Tailscale──▶  Windows PC
                                    └─ Docker container
                                        ├─ GoatBot app        :8787
                                        ├─ Hermes (first bot) :8642, screen :99
                                        ├─ more bots          screens :100, :101 …
                                        └─ Chrome, desktop, VNC per screen
```

What you trade for not paying Orgo: the bots only run while the PC is on, and they use its memory.
Each bot is a desktop plus Chrome, roughly 1.5–2 GB. On a 16 GB PC, run **2 bots**.

## 1. Windows: WSL2 and Docker Desktop

1. Open PowerShell **as administrator** and run `wsl --install`. Restart when it asks. It installs
   Ubuntu; open it once from the Start menu and pick a username and password.
2. Give Linux (and so Docker) enough memory. WSL2 takes half your RAM by default. In Windows, create
   the file `C:\Users\<you>\.wslconfig` with:

   ```ini
   [wsl2]
   memory=11GB
   swap=4GB
   ```

   Then run `wsl --shutdown` in PowerShell so it takes effect.
3. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). In its settings,
   check that **Use the WSL 2 based engine** is on, and under *Resources → WSL integration* turn
   it on for Ubuntu.

## 2. Start GoatBot

In the **Ubuntu** terminal (keeping the files inside Linux makes Docker much faster):

```bash
git clone https://github.com/BertoSolis98/GOATBOT.git goatbot
cd goatbot
cp docker/goatbot.env.example docker/goatbot.env
nano docker/goatbot.env      # put your email in ALLOWED_EMAILS, and your keys
docker compose up -d --build # the first build takes 10–20 minutes
```

`docker compose logs -f` shows what it is doing. When the app is up,
`curl -s localhost:8787/api/health` answers `{"ok":true,...}`.

**Sign in.** Google sign-in is not set up in this mode, so make a one-time link:

```bash
docker compose exec goatbot goatbot-sign-in you@example.com
```

Open the link it prints (within 15 minutes) on the PC, at `http://localhost:8787`.

**Pick the model.** Open your first bot, then **Engine** in its details panel. Choose a provider
and model there, or **Sign in to a subscription**, which opens a terminal on the bot's screen. If
you put `ANTHROPIC_API_KEY` in the env file, the bots already have it.

## 3. Open it from your MacBook: Tailscale

Tailscale puts your devices on a private network, so the Mac can reach the PC from anywhere
without opening anything to the internet.

1. Install [Tailscale](https://tailscale.com/download) on the **PC** (the Windows app) and on the
   **MacBook**, and sign in with the same account on both.
2. On the PC, in PowerShell: `tailscale serve --bg 8787`. Then `tailscale serve status` shows the
   address, like `https://my-pc.tail1234.ts.net`. Only your own devices can open it.
3. Put that address in `docker/goatbot.env` as `APP_URL` and `SERVER_URL`, then
   `docker compose up -d` again. Make a new sign-in link and open it on the Mac.

Do **not** forward port 8787 on your router or make it public. Anyone who reaches the app can
drive your bots, and through them your PC's container.

## Everyday use

| To | Run (in the `goatbot` folder, Ubuntu terminal) |
|---|---|
| Stop it | `docker compose stop` |
| Start it again | `docker compose start` |
| See logs | `docker compose logs -f` |
| Update after `git pull` | `docker compose up -d --build` |
| Get a shell inside | `docker compose exec goatbot bash` |
| Delete everything, data included | `docker compose down -v` |

Your data lives in two Docker volumes (`hermes` and `goatbot`), so stopping, updating or rebuilding
keeps your bots, their memory, sign-ins and files. Only `down -v` deletes them.

## What is different from Orgo

- **Screens** are X displays inside the container (`server/box/hq-display.sh`, `server/src/local-desktop.ts`).
  The live viewer, screenshots and taking control work the same.
- **Sandboxed by the container.** The bots can run commands, but only inside it; they cannot see
  your Windows files. The [approval gate](../README.md#approvals) still asks before commands, code,
  opening sites and screen control.
- **Only while the PC is on.** Routines scheduled while it sleeps do not run.
- **How many bots** is set by `MAX_BOTS` in the env file (up to 4). Your RAM is the real limit.
