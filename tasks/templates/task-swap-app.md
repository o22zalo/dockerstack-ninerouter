# Task: Swap App — Triển khai app mới thay thế `services/app`

## Mục đích

Template này dùng khi user clone repo thành thư mục mới, rồi nhờ AI Agent triển khai một app mới thay thế `services/app` hiện tại.
Luồng làm việc tuân thủ cấu trúc [task-template.md](task-template.md).

---

## User prompt

> Triển khai dự án 9router theo tài liệu của repo này: https://github.com/decolua/9router, 
 - không clone source về triển khai, mà triển khai theo hướng command line, ví dụ: 
```
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```
```9router.env
# 9Router environment contract
# This file reflects actual runtime usage in the current codebase.

# Required
JWT_SECRET=change-me-to-a-long-random-secret
INITIAL_PASSWORD=change-me
DATA_DIR=/var/lib/9router

# Recommended runtime variables
PORT=20128
NODE_ENV=production

# Recommended security and ops variables
API_KEY_SECRET=endpoint-proxy-api-key-secret
MACHINE_ID_SALT=endpoint-proxy-salt
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false

# Cloud sync variables
# Must point to this running instance so internal sync jobs can call /api/sync/cloud.
# Server-side preferred variables:
BASE_URL=http://localhost:20128
CLOUD_URL=https://9router.com
# Backward-compatible/public variables:
NEXT_PUBLIC_BASE_URL=http://localhost:20128
NEXT_PUBLIC_CLOUD_URL=https://9router.com

# Optional outbound proxy variables for upstream provider calls
# Lowercase variants are also supported: http_proxy, https_proxy, all_proxy, no_proxy
# HTTP_PROXY=http://127.0.0.1:7890
# HTTPS_PROXY=http://127.0.0.1:7890
# ALL_PROXY=socks5://127.0.0.1:7890
# NO_PROXY=localhost,127.0.0.1

# Currently unused by application runtime (kept as reference)
# INSTANCE_NAME=9router
```
  - Danh sách phiên bản: https://www.npmjs.com/package/9router?activeTab=versions

> Mục tiêu cụ thể: 
- Có thể chạy nhiều phiên bản 9router: latest, v0.4.46, có thể mở rộng nhiều phiên bản hơn. Triển khai trước 2 phiên bản là latest
- Mỗi phiên bản sẽ có cấu hình thư mục data và các config riêng
- Tổ chức .env với prefix là `NINE_ROUTER_`, có một env chung, nếu có env riêng theo phiên bản, thì mỗi phiên bản sẽ lấy theo phiên bản, fallback lại env chung
- Áp dụng tất cả env mà 9router hỗ trợ, có giá trị mặc định, thay đổi khi cần, có ENABLE theo từng phiên bản
Ví dụ:  
```
//Cấu hình chung
NINE_ROUTER_JWT_SECRET=change-me-to-a-long-random-secret
//Phiên bản latest
NINE_ROUTER_ENABLE_LATEST=true
NINE_ROUTER_PORT_LATEST=3000
NINE_ROUTER_DATA_DIR_LATEST=./data-9router-latest
//Phiên bản v.0.4.46
NINE_ROUTER_ENABLE_V0446=true
NINE_ROUTER_PORT_V0446=3000
NINE_ROUTER_DATA_DIR_V0446=./data-9router-v0446
```
- Viết tài liệu để khi thêm một phiên bản mới, hoặc cấu hình phiên bản trong .env, thì docker tự động triển khai các services kèm theo (có thể hướng theo chạy các cmd theo env để triển khai động được nhiều phiên bản)
- Url truy cập bên ngoài cũng sẽ theo phiên bản, ví dụ: latest: latest.{{DOMAIN}}, v0446.{{DOMAIN}} (theo cấu trúc cloudflared trong .env.example)

> Đổi tên tất cả file, dịch vụ, docs  trong repo này theo: `dockerstack-ninerouter`
> Các truy cập 9router này bỏ qua auth của tinyauth, sẽ auth bằng app của 9router

### Spec 1 — App mô tả

> Triển khai dockerstack-ninerouter multi version

### Spec 2 — Source code

> Source code app mới sẽ thay thế toàn bộ thư mục `services/app`.
>
> - Đường dẫn source gốc: `<path-to-source>`
> - Cách chuyển: copy toàn bộ source vào `services/app/` (xóa nội dung cũ trước)
> - Có Dockerfile riêng không? (Có / Không — nếu không, Agent tự tạo)

### Spec 3 — Docker Compose (`compose.apps.yml`)

> Mô tả thay đổi cho `compose.apps.yml`:
>
> - Runtime: `<node|python|go|java|rust|prebuilt-image|other>`
> - Delivery: `<build|image>`
> - Image (nếu Delivery=image): `<registry/image:tag>`
> - Build context (nếu Delivery=build): `./services/app`
> - Internal port (APP_PORT): `<number>`
> - Health path: `<path>` (ví dụ `/health`, `/api/health`, `/`)
> - Build args cần thêm: `<KEY1, KEY2, ...>` hoặc `không`
> - Environment vars cần thêm: `<KEY1, KEY2, ...>` hoặc `không`
> - Volumes cần mount: `<container_path1:host_path1, ...>` hoặc `dùng mặc định`
> - Auth: `<protected-by-tinyauth|public|app-internal-auth|custom>`
> - Depends on: `<litestream-restore|tinyauth|không>`

### Spec 4 — ENV mới (`.env.example`)

> Liệt kê các biến ENV mới cần thêm vào `.env.example`.
>
> **Yêu cầu bắt buộc khi liệt kê:**
>
> - Mỗi biến **phải có comment** diễn giải rõ mục đích, ảnh hưởng khi thay đổi.
> - Nếu biến có **tập giá trị cố định** → comment **toàn bộ giá trị hợp lệ** kèm tác dụng từng giá trị.
> - Nếu giá trị cần **lấy từ web** (API key, secret, token…) → ghi rõ **link** và **hướng dẫn ngắn** cách lấy.
>
> **Ví dụ format:**
>
> ```dotenv
> # Môi trường chạy ứng dụng.
> # Giá trị hợp lệ:
> #   development  → bật hot-reload, log verbose, tắt cache
> #   staging      → giống production nhưng dùng DB test
> #   production   → tắt debug, bật cache, gửi error lên Sentry
> APP_ENV=development
>
> # Cấp độ log output.
> # Giá trị hợp lệ: error | warn | info | debug | trace
> #   error  → chỉ lỗi nghiêm trọng
> #   warn   → lỗi + cảnh báo
> #   info   → thêm sự kiện chính (mặc định production)
> #   debug  → thêm luồng xử lý nội bộ
> #   trace  → toàn bộ, rất verbose
> LOG_LEVEL=info
>
> # Secret key dùng để ký JWT token.
> # Lấy tại: https://your-auth-provider.com/dashboard → Settings → API Keys
> # Hướng dẫn: Đăng nhập → chọn project → Copy "Secret Key"
> # KHÔNG commit giá trị thật lên Git.
> MY_APP_SECRET=change-me
> ```
>
> Nếu không có ENV mới: ghi `"Không cần thêm ENV mới."`

### Spec 5 — SQLite / Litestream

> KHÔNG DÙNG
>
> - Không dùng SQLite → bỏ qua
> - Có dùng SQLite → cung cấp:
>   - DB file ENV: `<LITESTREAM_APP_DB_FILE>`
>   - Container path: `<ví dụ /data/app/app.db>`
>   - S3 path ENV: `<LITESTREAM_APP_S3_PATH>`

### Spec 6 — Thông tin bổ sung

> Ghi bất kỳ yêu cầu đặc biệt nào khác (cron, worker, sidecar, v.v.)
> Nếu không có: ghi "Không."

---

## Thông tin cần xác nhận

Agent điền mục này nếu prompt thiếu dữ liệu cần thiết để triển khai đúng.

- [ ] Không cần hỏi thêm
- [ ] Cần hỏi user trước khi làm

Câu hỏi cần xác nhận:

- ***

## Checklist triển khai

Agent tự tạo checklist từ các Spec ở trên, rồi đánh dấu khi từng bước hoàn tất.

### Phase 0 — Đọc hiểu & xác nhận

- [ ] Đọc yêu cầu user và xác định phạm vi thay đổi
- [ ] Kiểm tra rule bắt buộc trong `AGENTS.md`
- [ ] Đọc `AGENT_APP_SWAP.md` — nắm invariants (**section 2**) VÀ common failure patterns (**section 4**)
- [ ] Xác nhận đủ 6 Spec — nếu thiếu, hỏi user trước khi làm

### Phase 1 — Chuẩn bị source code

- [ ] Xóa toàn bộ nội dung `services/app/` (giữ thư mục)
- [ ] Copy source code app mới vào `services/app/`
- [ ] Kiểm tra / tạo `services/app/Dockerfile` phù hợp runtime mới
- [ ] Kiểm tra `.dockerignore` trong `services/app/` (tạo nếu cần)

### Phase 2 — Cập nhật compose.apps.yml

- [ ] Sửa `compose.apps.yml` theo Spec 3 (image/build, port, env, volumes, labels, healthcheck)
- [ ] Giữ đúng invariants từ `AGENT_APP_SWAP.md` section 2:
  - Service name vẫn là `app`
  - Container name vẫn là `main-app`
  - Network vẫn là `app_net`
  - `APP_PORT` là source of truth cho port
  - `HEALTH_PATH` dùng trong healthcheck — phải là endpoint thật trả HTTP 200
  - Healthcheck: `wget -qO- http://localhost:${APP_PORT}${HEALTH_PATH} || exit 1`
  - Caddy labels dùng env vars, không hard-code domain/port
  - `restart: unless-stopped` phải có
  - `depends_on: litestream-restore + tinyauth` phải có
- [ ] Auth labels: giữ đủ 4 label `forward_auth` theo invariant 27:
  - `caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}`
  - `caddy.forward_auth.uri=/api/auth/caddy`
  - `caddy.forward_auth.header_up=X-Forwarded-Proto https`
  - `caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups`
- [ ] Nếu app dùng SSE/WebSocket: thêm `caddy.reverse_proxy.flush_interval=-1`
- [ ] Nếu bỏ auth (Spec 3 = public): bỏ `forward_auth` labels, giữ `reverse_proxy` labels

### Phase 3 — Cập nhật .env.example

- [ ] Thêm ENV mới theo Spec 4 vào section `APPLICATION` trong `.env.example`
- [ ] Mỗi ENV mới phải có comment rõ ràng: mục đích, giá trị hợp lệ, link lấy giá trị (nếu cần)
- [ ] Cập nhật `APP_IMAGE`, `APP_PORT`, `HEALTH_PATH` nếu khác mặc định
- [ ] Xóa ENV cũ không còn dùng

### Phase 4 — SQLite / Litestream (nếu Spec 5 = có)

**Bắt buộc hoàn thành TẤT CẢ items trong checklist section 4a của AGENT_APP_SWAP.md:**

- [ ] `services/litestream/litestream.yml`: thêm DB entry với exact container path (ví dụ `/data/app/my.db`)
- [ ] `docker-compose/compose.auth.yml` — service `litestream-restore` volumes: thêm `- ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/data:/data/app`
- [ ] `docker-compose/compose.auth.yml` — service `litestream` volumes: thêm cùng volume entry như trên
- [ ] `.env.example`: thêm `LITESTREAM_APP_DB_FILE`, `LITESTREAM_APP_S3_PATH`; update `LITESTREAM_REPLICATE_DBS=tinyauth,app`
- [ ] `services/litestream/entrypoint.sh`: xác nhận có case `*,app,*` gọi `restore_db "app" "/data/app/${LITESTREAM_APP_DB_FILE:-app.db}"`
- [ ] `compose.apps.yml`: xác nhận `depends_on.litestream-restore.condition: service_completed_successfully`

### Phase 5 — Rclone compatibility check

- [ ] Xác nhận tất cả app data volumes nằm dưới `${DOCKER_VOLUMES_ROOT}` (nếu không → rclone sẽ KHÔNG backup)
- [ ] Nếu app tạo volumes mới ngoài `${DOCKER_VOLUMES_ROOT}` → di chuyển vào hoặc ghi chú rõ ràng

### Phase 6 — Cập nhật docs & validate

- [ ] Cập nhật `docs/services/app.md` mô tả app mới
- [ ] Cập nhật `docs/services/litestream.md` nếu có thay đổi Litestream
- [ ] Chạy `npm run dockerapp-validate:env`
- [ ] Chạy `npm run dockerapp-validate:compose`
- [ ] Cập nhật `docker-compose/scripts/validate-env.js` nếu có ENV mới cần validate

### Phase 7 — Hoàn tất

- [ ] Kiểm tra lại toàn bộ thay đổi phù hợp yêu cầu
- [ ] Đối chiếu lại tất cả failure patterns trong `AGENT_APP_SWAP.md` section 4 — đảm bảo không rơi vào pattern nào
- [ ] Cập nhật `.opushforce.message` đúng format trong `AGENTS.md`
- [ ] Trả lời user ngắn gọn kèm danh sách file đã chỉnh

---

## File liên quan — Danh sách file mà Agent có thể đọc/chỉnh

Tham chiếu từ `AGENT_APP_SWAP.md` section 3 (Default Editable Files):

| File                                     | Hành động                 | Ghi chú                        |
| ---------------------------------------- | ------------------------- | ------------------------------ |
| `services/app/**`                        | Xóa cũ + thay source mới  | Thư mục chính của app          |
| `services/app/Dockerfile`                | Tạo mới / sửa             | Dockerfile phù hợp runtime     |
| `compose.apps.yml`                       | Sửa                       | Service `app` definition       |
| `.env.example`                           | Sửa                       | Thêm/sửa ENV mới               |
| `docker-compose/compose.auth.yml`        | Sửa (nếu cần)             | Litestream volumes, Tinyauth   |
| `services/litestream/litestream.yml`     | Sửa (nếu app dùng SQLite) | Thêm DB replica config         |
| `services/litestream/entrypoint.sh`      | Sửa (nếu app dùng SQLite) | Restore gate                   |
| `docker-compose/scripts/validate-env.js` | Sửa (nếu ENV mới)         | Validation rules               |
| `docker-compose/compose.rclone.yml`      | Sửa (nếu cần)             | Rclone sync config             |
| `services/rclone/rclone.conf.example`    | Sửa (nếu remote thay đổi) | Remote storage template        |
| `services/rclone/entrypoint.sh`          | Sửa (nếu sync logic đổi)  | Rclone sync loop script        |
| `docs/services/app.md`                   | Sửa                       | Tài liệu app mới               |
| `docs/services/litestream.md`            | Sửa (nếu cần)             | Tài liệu Litestream            |
| `docs/services/tinyauth.md`             | Sửa (nếu auth thay đổi)   | Tài liệu Tinyauth              |
| `docs/services/rclone.md`               | Sửa (nếu cần)             | Tài liệu Rclone                |

Agent cập nhật thêm file đã đọc/chỉnh vào đây:

- ***

## Kết quả kiểm tra

Agent ghi command đã chạy hoặc lý do không chạy.

- `npm run dockerapp-validate:env` →
- `npm run dockerapp-validate:compose` →

---

## Ghi chú cho lần sau

Chỉ ghi thông tin hữu ích trực tiếp cho task này, không thay cho memory dài hạn.

-
