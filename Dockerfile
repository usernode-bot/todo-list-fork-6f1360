FROM node:22-alpine
WORKDIR /app
COPY --chown=1000:1000 package.json ./
RUN npm install --production
COPY --chown=1000:1000 . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
# Kubernetes runs app and preview pods with runAsNonRoot and supplies no
# runAsUser, so the image has to name one itself. It has to be NUMERIC: the
# kubelet resolves the user before the container starts and cannot verify a
# symbolic `USER node`, which it rejects the same way it rejects root. Without
# this line the base image's default is root and the pod never starts —
# `CreateContainerConfigError: container has runAsNonRoot and image will run
# as root`. The --chown above is the other half: it hands this user the app
# tree, so a path the app writes fails at build time here rather than at
# runtime in front of somebody. Matches the platform app template.
USER 1000:1000
CMD ["node", "server.js"]
