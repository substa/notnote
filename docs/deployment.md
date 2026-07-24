# Deploy notd with Docker and Pangolin

This setup runs notd as a hardened Docker container and leaves TLS and user authentication to Pangolin. The Python port is bound only to the server loopback interface; remote clients must pass through Pangolin.

## 1. Requirements

- A Linux server with Docker Engine and the Docker Compose plugin.
- A working Pangolin installation and a Newt site on the same server.
- A domain or subdomain managed by Pangolin, for example `notes.example.com`.
- A file-based Markdown graph already present on the server.
- A copy of the notd source tree. Git is optional and is not installed on the host by notd.

Confirm Docker is available:

```bash
docker --version
docker compose version
```

## 2. Install notd

Create the application directory:

```bash
sudo mkdir -p /opt/notd
sudo chown "$USER":"$USER" /opt/notd
```

Then either download a release/source archive from GitHub and extract it into `/opt/notd`, or clone the repository:

```bash
git clone YOUR_REPOSITORY_URL /opt/notd
```

Docker deployment files are kept together in one predictable directory:

```bash
cd /opt/notd/docker
```

The clone method requires you to [install Git](https://git-scm.com/downloads) separately. Git is not required when using an archive and is not required for editing, saving, offline synchronization, or backups.

Create the deployment configuration:

```bash
cp .env.example .env
nano .env
```

At minimum, set the absolute graph path and the UID/GID of its owner:

```dotenv
NOTD_GRAPH_PATH=/srv/notd/graph
NOTD_UID=1000
NOTD_GID=1000
NOTD_PORT=4176
PANGOLIN_NETWORK=pangolin
NOTD_DOCKER_TARGET=runtime
```

Find the appropriate numeric IDs with:

```bash
id -u
id -g
```

The selected UID/GID must be able to create, replace, rename, and delete files inside the graph. Verify the graph permissions instead of making it world-writable:

```bash
ls -ld /srv/notd/graph /srv/notd/graph/pages /srv/notd/graph/journals
```

Keep `.env` private:

```bash
chmod 600 .env
```

## 3. Share a Docker network with Newt

Create one private Docker network once:

```bash
docker network create pangolin
```

If it already exists, Docker reports an error that can be ignored. If your network has another name, place that name in `PANGOLIN_NETWORK`.

The Newt container and notd must both join this network. The persistent solution is to add the external network to the Compose file that runs Newt:

```yaml
services:
  newt:
    networks:
      - pangolin

networks:
  pangolin:
    external: true
    name: pangolin
```

Then recreate Newt with its own Compose project. For a quick test, an already running Newt container can be attached manually:

```bash
docker network connect pangolin NEWT_CONTAINER_NAME
```

A manual attachment may be lost if the Newt container is recreated, so update its Compose file for the final installation.

## 4. Build and start notd

From `/opt/notd/docker`:

```bash
docker compose up -d --build
```

Check container and application health:

```bash
docker compose ps
docker compose logs --tail=100 notd
curl --fail http://127.0.0.1:4176/api/graph/status
```

The status response should contain `"enabled":true`. The loopback binding is intended only for diagnostics from the server itself and is not reachable remotely.

The default `runtime` image deliberately does not contain Git. To enable optional page history and Git snapshots, set `NOTD_DOCKER_TARGET=runtime-git` and rebuild. The Git-enabled image only supplies the executable; the mounted graph must already be a repository, and credentials/configuration remain your responsibility. All non-Git features work identically with the default image.

The container uses:

- a read-only application filesystem;
- a writable bind mount only for the graph;
- the graph owner's UID/GID instead of relying on container root;
- no Linux capabilities;
- `no-new-privileges`;
- a private temporary filesystem;
- automatic restart and a health check.

## 5. Create the Pangolin resource

In Pangolin, create a resource associated with the Newt site on this server.

Use these values:

- **Public address:** your HTTPS hostname, such as `notes.example.com`;
- **Target/upstream:** `http://notd:4176`;
- **Protocol:** HTTP upstream, with HTTPS terminated by Pangolin;
- **Authentication:** required;
- **Access:** only your Pangolin user or a policy containing only that user.

The Docker service name `notd` resolves on the shared `pangolin` network. Do not use `127.0.0.1` as the target when Newt itself runs in a container: that address would refer to the Newt container.

Pangolin should preserve the original `Host` header. This is required by notd's same-origin write protection. Do not configure response buffering for the event-stream endpoint if your Pangolin version exposes such an option; `/api/graph/events` is a long-lived Server-Sent Events connection.

Open the public URL in a private browser window. Pangolin must request authentication before any notd page is shown. After login, confirm that you can:

1. open today's journal;
2. create and edit a test block;
3. reload and see the saved content;
4. upload a small attachment;
5. open the same graph from a second authenticated device.

## 6. Install the PWA

After authenticating through the public HTTPS URL:

- on iPhone or iPad, use Safari's **Share → Add to Home Screen**;
- on desktop, use the browser's install action.

Authentication remains managed by Pangolin. Each device signs in once according to Pangolin's session policy. If that session expires, open the public URL in the browser and authenticate again.

Remember that an authenticated PWA can retain an offline graph replica in browser IndexedDB. Protect each device with its operating-system lock and remove the site's data from lost or retired devices where possible.

## 7. Update notd

If the source was cloned with a separately installed Git client:

```bash
cd /opt/notd
git pull --ff-only
cd docker
docker compose up -d --build --remove-orphans
docker image prune -f
```

For an archive installation, download the new archive, verify that `docker/.env` and the graph are backed up, replace only the application source files in `/opt/notd`, and run:

```bash
cd /opt/notd/docker
docker compose up -d --build --remove-orphans
docker image prune -f
```

Then open notd while online, close the PWA completely, and reopen it so the new Service Worker takes control.

## 8. Stop, restart, and inspect

Run these commands from `/opt/notd/docker`:

```bash
# Restart
docker compose restart notd

# Follow logs
docker compose logs -f notd

# Stop without deleting the graph
docker compose down
```

`docker compose down` does not remove the host graph because it is a bind mount. Never add `-v` blindly to maintenance commands, and back up the graph independently of Docker.
