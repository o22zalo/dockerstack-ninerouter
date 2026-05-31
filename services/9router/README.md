# services/9router — 9Router wrapper image

Wrapper image dùng cho stack **dockerstack-ninerouter**. Mỗi phiên bản 9Router
(latest, v0.4.46, …) build từ chính thư mục này với một build arg khác nhau.

## Vì sao cần wrapper?

Image upstream `decolua/9router:<tag>` đã đầy đủ runtime. Wrapper chỉ thêm:

- `wget` + `curl` để Docker healthcheck dùng được (`wget -qO- /api/health`).
- `ca-certificates` cập nhật để TLS outbound ổn định.
- LABEL OCI để dễ trace version trong stack.

## Build arg

| Arg | Mặc định | Mô tả |
| --- | --- | --- |
| `NINE_ROUTER_VERSION_TAG` | `latest` | Tag image trên Docker Hub `decolua/9router:<tag>`. |

## Build thử thủ công

```bash
docker build \
  --build-arg NINE_ROUTER_VERSION_TAG=0.4.46 \
  -t dockerstack-ninerouter/9router:0.4.46 \
  ./services/9router
```

## Cấu trúc data

| Path container | Mô tả |
| --- | --- |
| `/app/data` | DATA_DIR mặc định — chứa `db/data.sqlite`, certs, logs, runtime configs |
| `/app/data-home` | Symlink target cho `/root/.9router` (fallback path). |

Stack mount `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data` → `/app/data` cho
mỗi phiên bản (slug ví dụ `latest`, `v0446`).

## Health endpoint

`GET /api/health` → `{ "ok": true }` (HTTP 200).

Healthcheck dùng:

```sh
wget -qO- http://localhost:${PORT}/api/health || exit 1
```

## Liên kết

- Source: <https://github.com/decolua/9router>
- Hub: <https://hub.docker.com/r/decolua/9router>
- Versions: <https://www.npmjs.com/package/9router?activeTab=versions>
