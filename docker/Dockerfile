# GoatBot on your own machine: the app, a Hermes agent (the first bot) and the bots' screens,
# all in one container. The bots' screens are X displays inside it (COMPUTER=local), so no Orgo
# account is needed. See docs/run-on-your-pc.md.
#
#   docker compose up -d --build        (from the repository root)

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

# Desktop pieces for the screens: a virtual display, window manager, VNC for the live viewer, tools
# the screen dressing uses (server/box/), screenshots, fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssl procps supervisor \
      xvfb x11vnc xfwm4 xdotool wmctrl x11-utils x11-xserver-utils imagemagick \
      dbus dbus-x11 python3 python3-yaml python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
      xfce4-terminal fonts-inter fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# The bots' browser: Google Chrome on x86-64 PCs, Chromium elsewhere (e.g. Apple Silicon).
ARG TARGETARCH
RUN if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
      && rm -f /tmp/chrome.deb; \
    else \
      apt-get update && apt-get install -y --no-install-recommends chromium; \
    fi \
 && rm -rf /var/lib/apt/lists/*

# Hermes Agent. Its code lives in /opt/hermes-agent; its settings, memory and sign-ins in
# /root/.hermes, which is a volume so they survive rebuilds. The bots use Chrome above, so
# Hermes' own browser download is skipped.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
      | bash -s -- --non-interactive --skip-browser --dir /opt/hermes-agent
ENV PATH=/root/.local/bin:$PATH
RUN command -v hermes && hermes --help >/dev/null

# GoatBot itself.
WORKDIR /opt/goatbot
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && chmod +x server/box/*.sh server/box/*.py scripts/*.py docker/*.sh

COPY docker/supervisord.conf /etc/supervisor/conf.d/goatbot.conf
RUN ln -s /opt/goatbot/docker/sign-in-link.sh /usr/local/bin/goatbot-sign-in

EXPOSE 8787
ENTRYPOINT ["/opt/goatbot/docker/entrypoint.sh"]
