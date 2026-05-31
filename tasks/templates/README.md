# Task triển khai cho AI Agents

Thư mục này chứa các file task để user chỉ cần ghi prompt, còn AI Agent tự lập checklist triển khai, tự đánh dấu tiến độ, và phải tuân thủ flow trong [CLAUDE.md](../CLAUDE.md).

## Cách dùng

1. Tạo file mới từ [task-template.md](task-template.md).
2. User chỉ điền phần `User prompt`.
3. Agent đọc prompt, tự bổ sung checklist ở phần `Checklist triển khai`.
4. Agent đánh dấu từng bước khi hoàn thành.
5. Trước khi trả lời cuối cùng, Agent phải cập nhật `.opushforce.message` đúng format trong [CLAUDE.md](../CLAUDE.md).

## Quy ước đặt tên file

Dùng format:

```text
YYYY-MM-DD-ten-task-ngan.md
```

Ví dụ:

```text
2026-05-12-them-caddy-auth.md
```

## Trạng thái checklist

```text
- [ ] Chưa làm
- [x] Đã xong
```

## Bắt buộc với Agent

- Không yêu cầu user tự viết checklist.
- Nếu thiếu thông tin để triển khai đúng, phải hỏi user xác nhận trước.
- Không đánh dấu `[x]` nếu bước chưa hoàn tất thật.
- Task chỉ hoàn tất khi `.opushforce.message` đã được cập nhật.
