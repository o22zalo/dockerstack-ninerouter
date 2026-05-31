# Cloudflared service (`docker-compose/compose.core.yml`)

## Vai trò
- Mở tunnel từ Cloudflare Edge vào cụm docker nội bộ.
- Không cần public trực tiếp port app ra Internet.

## Cấu hình chính
- Image: `cloudflare/cloudflared:latest`
- Command: `tunnel --config /etc/cloudflared/config.yml run`
- Volumes:
  - `./cloudflared/config.yml:/etc/cloudflared/config.yml:ro`
  - `./cloudflared/credentials.json:/etc/cloudflared/credentials.json:ro`

## Điều kiện bắt buộc
- File `cloudflared/config.yml` phải tồn tại.
- File `cloudflared/credentials.json` phải tồn tại.
- Trong `config.yml`, các ingress hostname phải map đúng về `http://caddy:80`.

## Checklist cấu hình Cloudflare
1. Tạo tunnel trong Zero Trust.
2. Lấy credentials file.
3. Cấu hình ingress hostnames.
4. Tạo/kiểm tra DNS records cho các hostname app/ops.
5. Nếu bật Deploy Code, thêm hostname `deploy.${DOMAIN}` trỏ về `http://caddy:80`.

## Lỗi thường gặp
- Sai tunnel ID hoặc credentials không khớp -> tunnel không connect.
- Thiếu rule ingress catch-all -> cloudflared trả 404 ở edge.
