FROM mcr.microsoft.com/devcontainers/typescript-node:1-20-bullseye

RUN apt-get update && apt-get install -y \   
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm-dev \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# sudo service dbus start
