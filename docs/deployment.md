# Deploy notnote with Docker

> notnote does not provide application-level authentication. Anyone who can reach the server can read and modify the complete graph. Keep the service private unless access control and authentication are provided by another trusted tool.

## 1. Requirements

- A Linux server with Docker Engine and the Docker Compose plugin.
- A file-based Markdown graph already present on the server.
- A copy of the notnote source tree.

Confirm Docker is available:

```bash
docker --version
docker compose version
```

## 2. Install notnote

Create the application directory:

```bash
sudo mkdir -p /opt/notnote
sudo chown "$USER":"$USER" /opt/notnote
```

Download and extract a release/source archive into `/opt/notnote`, or clone the repository:

```bash
git clone YOUR_REPOSITORY_URL /opt/notnote
```

Docker deployment files are kept in the `docker/` directory:

```bash
cd /opt/notnote/docker
cp .env.example .env
nano .env
```

Set the absolute graph path and the UID/GID of its owner:

```dotenv
NOTNOTE_GRAPH_PATH=/srv/notnote/graph
NOTNOTE_UID=1000
NOTNOTE_GID=1000
NOTNOTE_BIND_ADDRESS=127.0.0.1
NOTNOTE_PORT=4176
NOTNOTE_DOCKER_TARGET=runtime
```

Find the appropriate numeric IDs with:

```bash
id -u
id -g
```

The selected UID/GID must be able to create, replace, rename, and delete files inside the graph. Verify the graph permissions instead of making it world-writable:

```bash
ls -ld /srv/notnote/graph /srv/notnote/graph/pages /srv/notnote/graph/journals
```

Keep `.env` private:

```bash
chmod 600 .env
```

## 3. Build and start notnote

From `/opt/notnote/docker`:

```bash
docker compose up -d --build
```

Check the container and application health:

```bash
docker compose ps
docker compose logs --tail=100 notnote
curl --fail http://127.0.0.1:4176/api/graph/status
```

The status response should contain `"enabled":true`. By default, port `4176` is bound only to the server loopback interface. It can be reached from the server itself, but not directly from another device.

The default `runtime` image deliberately does not contain Git. To enable optional page history and Git snapshots, set `NOTNOTE_DOCKER_TARGET=runtime-git` and rebuild. The Git-enabled image only supplies the executable; the mounted graph must already be a repository, and credentials and configuration remain your responsibility.

The container uses:

- a read-only application filesystem;
- a writable bind mount only for the graph;
- the graph owner's UID/GID instead of container root;
- no Linux capabilities;
- `no-new-privileges`;
- a private temporary filesystem;
- automatic restart and a health check.

## 4. Remote access and authentication

No remote-access or authentication product is required when notnote is used only on the server itself. To use it from another device, choose a separate access mechanism appropriate for your environment and threat model.

Possible approaches include:

- a private VPN, such as [WireGuard](https://www.wireguard.com/) or [Tailscale](https://tailscale.com/), so only authorized devices can reach the service;
- an authenticated reverse proxy, such as [Caddy](https://caddyserver.com/docs/) or [NGINX](https://nginx.org/en/docs/), optionally combined with an identity provider;
- an identity-aware access gateway, such as [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) or another single sign-on solution;
- a managed or self-hosted tunnel proxy, such as [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or a comparable service, with an access policy enabled;
- SSH port forwarding for limited administrative or personal access, using [OpenSSH](https://www.openssh.com/).

These are examples rather than endorsed or complete procedures. Consult the official documentation for the selected tool and verify its security model before exposing notnote.

Whichever approach is chosen:

- require authentication before any notnote page or API endpoint is reachable;
- grant access only to intended users or devices;
- use TLS when traffic crosses an untrusted network;
- do not publish port `4176` directly to the internet;
- preserve the original `Host` header when an HTTP intermediary is used, because notnote enforces same-origin checks on writes;
- support long-lived Server-Sent Events on `/api/graph/events`, without response buffering or an overly short idle timeout.

A tool running directly on the Docker host can reach the default loopback endpoint at `http://127.0.0.1:4176`. A tool running in another container needs an appropriate Docker network connection and can then use `http://notnote:4176`. Some private-network solutions may instead require `NOTNOTE_BIND_ADDRESS` to be set to the address of a controlled VPN or private interface. Do not set it to `0.0.0.0` on an internet-facing host without an effective firewall and access controls. The exact integration depends on the selected tool and is intentionally left to its official documentation.

After configuring remote access, open the external address in a private browser window. Authentication must be requested before notnote is displayed. Then verify that you can create, edit, reload, and upload a test attachment without allowing unauthenticated access.

## 5. Install the PWA

PWA installation requires HTTPS, except on `localhost`:

- on iPhone or iPad, use Safari's **Share → Add to Home Screen**;
- on desktop, use the browser's install action.

Authentication and session expiry remain the responsibility of the selected access tool. If a session expires, open the remote address in the browser and authenticate again.

An authenticated PWA can retain an offline graph replica in browser IndexedDB. Protect each device with its operating-system lock and remove the site's data from lost or retired devices where possible.

## 6. Update notnote

For a Git installation:

```bash
cd /opt/notnote
git pull --ff-only
cd docker
docker compose up -d --build --remove-orphans
docker image prune -f
```

For an archive installation, back up `docker/.env` and the graph, replace the application source files, and run:

```bash
cd /opt/notnote/docker
docker compose up -d --build --remove-orphans
docker image prune -f
```

Then open notnote while online, close the PWA completely, and reopen it so the new Service Worker takes control.

## 7. Stop, restart, and inspect

Run these commands from `/opt/notnote/docker`:

```bash
# Restart
docker compose restart notnote

# Follow logs
docker compose logs -f notnote

# Stop without deleting the graph
docker compose down
```

`docker compose down` does not remove the host graph because it is a bind mount. Never add `-v` blindly to maintenance commands, and back up the graph independently of Docker.
