# ================================================================
#  services/9router/Dockerfile
#  Wrapper image around decolua/9router:<tag>.
#
#  Mục đích:
#    - Pin version 9router theo build arg NINE_ROUTER_VERSION_TAG
#    - Thêm `wget` để Docker healthcheck dùng được
#      (image upstream alpine không kèm sẵn).
#    - Giữ nguyên ENTRYPOINT + CMD upstream (chạy node server.js
#      qua /entrypoint.sh để fix quyền data volume).
#
#  Build args:
#    NINE_ROUTER_VERSION_TAG  — tag image trên Docker Hub.
#                               Mặc định: "latest" (decolua/9router:latest).
#                               Ví dụ:   "0.4.46" (decolua/9router:0.4.46).
#
#  Compose mỗi version pass build arg riêng:
#    build:
#      context: ./services/9router
#      args:
#        NINE_ROUTER_VERSION_TAG: ${NINE_ROUTER_IMAGE_TAG_LATEST:-latest}
# ================================================================

# syntax=docker/dockerfile:1.7
ARG NINE_ROUTER_VERSION_TAG=latest
FROM decolua/9router:${NINE_ROUTER_VERSION_TAG}

# Re-declare ARG sau FROM để dùng được trong LABEL.
ARG NINE_ROUTER_VERSION_TAG=latest

LABEL org.opencontainers.image.title="dockerstack-ninerouter" \
      org.opencontainers.image.description="9Router wrapper image — multi-version stack" \
      org.opencontainers.image.source="https://github.com/decolua/9router" \
      org.opencontainers.image.version="${NINE_ROUTER_VERSION_TAG}"

USER root

# Image upstream chạy alpine; thêm wget + curl để healthcheck/diagnostic
# hoạt động ổn định. Giữ apk cache sạch để image nhỏ.
RUN apk --no-cache add wget curl ca-certificates \
  && update-ca-certificates 2>/dev/null || true

# Đảm bảo thư mục data tồn tại với đúng owner; image upstream đã có sẵn,
# chỉ tạo lại idempotent để chắc chắn khi DATA_DIR override.
RUN mkdir -p /app/data /app/data-home \
  && chown -R node:node /app/data /app/data-home

# KHÔNG override ENTRYPOINT/CMD/USER:
#   - Upstream ENTRYPOINT="/entrypoint.sh" tự switch sang user node
#     và chown /app/data ở runtime (su-exec).
#   - Upstream CMD=["node","server.js"].
# Để USER root ở build time là OK vì /entrypoint.sh sẽ drop privilege.
